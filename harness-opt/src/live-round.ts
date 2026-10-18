import { writeRoleFile, writeRoleJson } from "./artifacts";
import { Budget } from "./budget";
import { LOCAL_MODEL_ID } from "./fixed-model";
import { createExecutor, type HarnessExecutor } from "./modules/executor";
import { schemaFor, type RoleDelegate } from "./pi/delegate";
import { writeStageReport } from "./reports";
import { parseGapReport, parsePatchFile, renderGapsMarkdown } from "./schemas";
import type { EvidencePack, Proposal, ReviewInput, Roles, SubmitReceipt } from "./orchestrator";
import type { TaskRef } from "./types";

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
      const delegated = await options.delegate({
        agent: "gap-finder",
        task: "Read traces and return gaps with id, failureClass, summary, traceIds.",
        schema: schemaFor("gap-finder"),
      });
      options.budget.usedTokens += delegated.tokens;
      const gaps = parseGapReport(delegated.value);
      writeRoleJson(options.root, "gap-finder", "gaps.json", gaps);
      writeRoleFile(options.root, "gap-finder", "gaps.md", renderGapsMarkdown(gaps));
      return gaps as unknown as Record<string, unknown>;
    },
    innovator: async (_parent, gaps, tried) => {
      const delegated = await options.delegate({
        agent: "innovator",
        task: `Write one patch. Gaps: ${JSON.stringify(gaps)}. Already tried: ${tried.join(",")}`,
        schema: schemaFor("innovator"),
      });
      const patch = parsePatchFile(delegated.value);
      const config = {
        id: candidateId,
        modelId: LOCAL_MODEL_ID,
        parts: { "agent-loop": patch.changes, context: {}, memory: {}, toolchain: {}, skills: {} },
        search: { samples: 1, selfChecks: 0, retries: 0 },
      };
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
        writeRoleJson(options.root, "runner", `traces/${trace.taskId}.json`, trace);
        scores.push(trace.reward);
      }
      return scores;
    },
    reviewer: async (input: ReviewInput) => {
      const delegated = await options.delegate({
        agent: "reviewer-gate",
        task: `Child dev ${input.child.devMean ?? "unread"} parent dev ${input.parent.devMean ?? "unread"}. devRoseHeldOutFell=${input.devRoseHeldOutFell}. Return accept and reason.`,
        schema: schemaFor("reviewer-gate"),
      });
      options.budget.usedTokens += delegated.tokens;
      const value = delegated.value as { accept?: unknown; reason?: unknown };
      if (typeof value.accept !== "boolean" || typeof value.reason !== "string") {
        throw new Error("reviewer-gate output is missing accept or reason");
      }
      const verdict = { accept: value.accept, reason: value.reason };
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

export function stageWriter(root: string, round: number): (stage: string, output: unknown, explanation: string) => void {
  return (stage, output, explanation) => {
    writeStageReport(root, { round, stage, output, explanation });
  };
}

