import { writeRoleFile, writeRoleJson } from "./artifacts";
import { Budget } from "./budget";
import { readContained } from "./containment";
import { LOCAL_MODEL_ID } from "./fixed-model";
import { createExecutor, type HarnessExecutor } from "./modules/executor";
import { applyPatch } from "./modules/proposer";
import { DelegationError, schemaFor, type DelegationValue, type RoleDelegate } from "./pi/delegate";
import { writeStageReport } from "./reports";
import { parseGapReport, parsePatchFile, renderGapsMarkdown } from "./schemas";
import { forcedReviewVerdict, type EvidencePack, type Proposal, type ReviewInput, type Roles, type SubmitReceipt } from "./orchestrator";
import { traceRelPath } from "./traces";
import { ATTRIBUTION_LABELS, emptyParts, HARNESS_PARTS, type HarnessConfig, type HarnessParts, type SearchGenes, type TaskRef } from "./types";

const LABEL_LIST = ATTRIBUTION_LABELS.join(", ");
const PART_LIST = HARNESS_PARTS.join(", ");

export const GAP_FINDER_TASK = `Read traces and return gaps with id, failureClass, summary, traceIds. failureClass must be exactly one of: ${LABEL_LIST}.`;

export const INNOVATOR_TASK_PREFIX = `Write one patch. part must be exactly one of: ${PART_LIST}. expectedFailureClass must be exactly one of: ${LABEL_LIST}. Required fields are part, motivation, expectedFailureClass, and summary.`;

export const REVIEWER_TASK_PREFIX = "Return one JSON object. accept is a boolean. reason is a string.";

/** Task text names the milestone state so a missing read is not described as a drop. */
export function reviewerTask(input: ReviewInput): string {
  const state = input.heldOutState === "unread"
    ? "状态 unread：没读到里程碑。拒绝理由必须写没读到，不能写成下跌。"
    : input.heldOutState === "fell"
      ? "状态 fell：读到了，且 held-out 相对父节点下跌。拒绝理由必须写下跌。"
      : "状态 held：读到了，且没有下跌。拒绝理由不能写成下跌或没读到。";
  return `${REVIEWER_TASK_PREFIX} Child dev ${input.child.devMean ?? "unread"} parent dev ${input.parent.devMean ?? "unread"}. ${state} devRoseHeldOutFell=${input.devRoseHeldOutFell}.`;
}

/**
 * Roles whose outputs are parsed. Gap finder, innovator, and reviewer-gate
 * go through the pi-subagents delegation events. The runner goes through
 * HarnessExecutor and writes a trace that includes steps.
 */
export function liveRoles(options: {
  readonly root: string;
  readonly round: number;
  readonly delegate: RoleDelegate;
  readonly executor?: HarnessExecutor;
  readonly tasks: readonly TaskRef[];
  readonly budget: Budget;
  readonly candidateId?: string;
}): Roles {
  const executor = options.executor ?? createExecutor("sample");
  const candidateId = options.candidateId ?? "c1";
  return {
    gapFinder: async () => {
      const delegated = await delegateOrCharge(options, {
        agent: "gap-finder",
        task: GAP_FINDER_TASK,
        schema: schemaFor("gap-finder"),
      });
      options.budget.usedTokens += delegated.tokens;
      const gaps = parseGapReport(delegated.value);
      writeRoleJson(options.root, "gap-finder", "gaps.json", gaps);
      writeRoleFile(options.root, "gap-finder", "gaps.md", renderGapsMarkdown(gaps));
      return gaps as unknown as Record<string, unknown>;
    },
    innovator: async (parent, gaps, tried) => {
      const delegated = await delegateOrCharge(options, {
        agent: "innovator",
        task: `${INNOVATOR_TASK_PREFIX} Gaps: ${JSON.stringify(gaps)}. Already tried: ${tried.join(",")}`,
        schema: schemaFor("innovator"),
      });
      let patch: ReturnType<typeof parsePatchFile>;
      try {
        patch = parsePatchFile(delegated.value);
      } catch (error) {
        options.budget.usedTokens += delegated.tokens;
        throw error;
      }
      const config = { ...applyPatch(readParentConfig(options.root, parent.configPath), patch), id: candidateId };
      writeRoleJson(options.root, "innovator", `candidates/${candidateId}/config.json`, config);
      writeRoleJson(options.root, "innovator", "patch.json", patch);
      const proposal: Proposal = {
        summary: patch.summary,
        configPath: `candidates/${candidateId}/config.json`,
        tokens: delegated.tokens,
      };
      return proposal;
    },
    runner: async (configPath, subset) => {
      const tasks = subset === "dev_small" ? options.tasks.slice(0, 1) : options.tasks;
      if (tasks.length === 0) throw new Error("runner has no dev tasks");
      const scores: number[] = [];
      for (const task of tasks) {
        const trace = await executor.run(task, configPath);
        options.budget.usedTokens += trace.tokens;
        writeRoleJson(options.root, "runner", traceRelPath(configPath, trace.taskId), trace);
        scores.push(trace.reward);
      }
      return scores;
    },
    reviewer: async (input: ReviewInput) => {
      const delegated = await delegateOrCharge(options, {
        agent: "reviewer-gate",
        task: reviewerTask(input),
        schema: schemaFor("reviewer-gate"),
      });
      options.budget.usedTokens += delegated.tokens;
      const value = delegated.value as { accept?: unknown; reason?: unknown };
      if (typeof value.accept !== "boolean" || typeof value.reason !== "string") {
        throw new Error("reviewer-gate output is missing accept or reason");
      }
      const verdict = forcedReviewVerdict(input) ?? { accept: value.accept, reason: value.reason };
      writeRoleJson(options.root, "reviewer-gate", "review.json", verdict);
      return verdict;
    },
    reportWriter: ({ child }): EvidencePack => {
      const pack: EvidencePack = {
        modelId: LOCAL_MODEL_ID,
        changeNote: child.patchSummary || "require a write after the failed check",
        traceIndex: options.tasks.map((task) => task.id),
        devScore: child.devMean ?? 0,
        configPath: child.configPath,
      };
      writeRoleJson(options.root, "report-writer", "evidence_pack/pack.json", pack);
      writeRoleFile(options.root, "report-writer", "evidence_pack/change-note.md", pack.changeNote);
      return pack;
    },
    submitter: (): SubmitReceipt => {
      const receipt: SubmitReceipt = {
        ok: true,
        submitted: false,
        mode: "dry-run",
        detail: "evidence gate is green; live playground submit is off",
      };
      writeRoleJson(options.root, "submitter", "submit-receipt.json", receipt);
      return receipt;
    },
  };
}

function readParentConfig(root: string, configPath: string): HarnessConfig {
  let raw: string;
  try {
    raw = readContained(root, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`parent config is missing: ${configPath}`);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`parent config is missing: ${configPath}`);
  }
  if (!isRecord(parsed) || typeof parsed.modelId !== "string" || parsed.modelId === "" || !isRecord(parsed.parts) || !isRecord(parsed.search)) {
    throw new Error(`parent config is missing: ${configPath}`);
  }
  const search = parsed.search;
  if (typeof search.samples !== "number" || typeof search.selfChecks !== "number" || typeof search.retries !== "number") {
    throw new Error(`parent config is missing: ${configPath}`);
  }
  const genes: SearchGenes = { samples: search.samples, selfChecks: search.selfChecks, retries: search.retries };
  const parts = { ...emptyParts(), ...parsed.parts } as HarnessParts;
  return {
    id: typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : "parent",
    modelId: parsed.modelId,
    parts,
    search: genes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function delegateOrCharge(
  options: { readonly delegate: RoleDelegate; readonly budget: Budget },
  input: { readonly agent: string; readonly task: string; readonly schema: Record<string, unknown> },
): Promise<DelegationValue> {
  try {
    return await options.delegate(input);
  } catch (error) {
    if (error instanceof DelegationError) options.budget.usedTokens += error.tokens;
    throw error;
  }
}

export function stageWriter(root: string, round: number): (stage: string, output: unknown, explanation: string) => void {
  return (stage, output, explanation) => {
    writeStageReport(root, { round, stage, output, explanation });
  };
}

