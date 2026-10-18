import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxBoundary } from "../../src/execution/security-boundary";
import { writeRoleFile, writeRoleJson } from "./artifacts";
import { Budget } from "./budget";
import { writeRunState } from "../bin/record";
import { FIXED_MODEL_ID } from "./fixed-model";
import { Lineage, Node } from "./lineage";
import { HeldOutVault } from "./modules/probe";
import { GreedySelector } from "./modules/selector";
import { Orchestrator, type EvidencePack, type Proposal, type ReviewInput, type Roles, type SubmitReceipt } from "./orchestrator";
import type { DryRunStatus } from "./playground-dry-run";
import { parseGapReport, parsePatchFile, renderGapsMarkdown } from "./schemas";
import { emptyParts, type HarnessConfig, type TaskRef } from "./types";

export interface EmptyRunOptions {
  readonly out: string;
  readonly modelId?: string;
  readonly heldout?: number;
  readonly ttsBaseline?: number;
  readonly baseHeldout?: number;
  readonly day?: string;
  readonly dryRun?: DryRunStatus;
  readonly milestoneHeldOut?: Readonly<Record<string, number>>;
  readonly devTasks?: readonly TaskRef[];
  readonly heldOutTasks?: readonly TaskRef[];
  readonly roles?: Partial<Roles>;
}

export interface EmptyRunResult {
  readonly bestId: string;
  readonly submit: boolean;
  readonly heldout: number | null;
  readonly selector: string;
  readonly phase: string;
  readonly childStatus: string;
  readonly liveSubmitCalled: boolean;
  readonly failedChecks: readonly string[];
}

const SECRET_HELD_OUT = "sealed-held-out-body";

/**
 * One local step with fixture roles. Scores stay in [0, 1].
 * The submit gate sees a held-out number that is below the TTS baseline,
 * so `submit` is false and nothing is posted to the playground.
 */
export function runEmpty(options: EmptyRunOptions): EmptyRunResult {
  mkdirSync(options.out, { recursive: true });
  const state = join(options.out, "state");
  const modelId = options.modelId ?? FIXED_MODEL_ID;
  const milestoneHeldOut = options.milestoneHeldOut ?? {
    "candidates/base/config.json": 0.5,
    "candidates/c1/config.json": 0.55,
  };
  const base: HarnessConfig = {
    id: "base",
    modelId,
    parts: { ...emptyParts(), "agent-loop": { maxSteps: 8 } },
    search: { samples: 1, selfChecks: 0, retries: 0 },
  };
  writeCandidate(options.out, "base", { ...base, fixtureScore: 0.4, tokens: 20 });
  writeFileSync(join(options.out, "sealed-note.txt"), `${SECRET_HELD_OUT}\n`);
  const heldOut = new HeldOutVault(options.heldOutTasks ?? [{
    id: "h1",
    split: "held-out",
    path: "sealed-note.txt",
  }]);
  void options.devTasks;
  void heldOut.size;

  const lineage = new Lineage(state);
  lineage.put(new Node({
    id: "base",
    parentId: null,
    configPath: "candidates/base/config.json",
    status: "evaluated",
    devScores: [0.4],
    stage: "full",
  }));

  const boundary = new SandboxBoundary({
    root: options.out,
    network: "none",
    allowBash: false,
    allowedTools: ["read"],
  });
  let liveSubmitCalled = false;
  const fixture: Roles = {
    gapFinder: () => {
      const gaps = parseGapReport({
        gaps: [{
          id: "g1",
          failureClass: "idle-loop",
          summary: "the loop rereads the task and never writes an answer",
          traceIds: ["seed"],
        }],
      });
      writeRoleJson(options.out, "gap-finder", "gaps.json", gaps);
      writeRoleFile(options.out, "gap-finder", "gaps.md", renderGapsMarkdown(gaps));
      return gaps as unknown as Record<string, unknown>;
    },
    innovator: (_parent, gaps, tried) => {
      const blob = JSON.stringify({ gaps, tried });
      if (blob.includes(SECRET_HELD_OUT) || blob.includes("heldOut") || blob.includes("held-out")) {
        throw new Error("innovator saw held-out material");
      }
      const config = {
        id: "c1",
        modelId,
        fixtureScore: 0.8,
        tokens: 30,
        parts: { ...emptyParts(), "agent-loop": { maxSteps: 4, requireWrite: true } },
        search: { samples: 1, selfChecks: 0, retries: 1 },
      };
      writeRoleJson(options.out, "innovator", "candidates/c1/config.json", config);
      const patch = parsePatchFile({
        part: "agent-loop",
        motivation: "stop the idle reread by capping steps and requiring a write",
        expectedFailureClass: "idle-loop",
        summary: "cap idle reread and require a write",
        changes: { maxSteps: 4, requireWrite: true },
      });
      writeRoleJson(options.out, "innovator", "patch.json", patch);
      const proposal: Proposal = {
        summary: patch.summary,
        configPath: "candidates/c1/config.json",
        tokens: 30,
      };
      return proposal;
    },
    runner: (configPath, subset) => {
      const abs = boundary.assertPath(configPath, "read");
      const config = JSON.parse(readFileSync(abs, "utf8")) as { fixtureScore?: number };
      const score = config.fixtureScore ?? 0.5;
      writeRoleJson(options.out, "runner", "traces/t1.json", {
        taskId: "t1",
        reward: score,
        tokens: 30,
        failed: false,
        labels: [],
      });
      return subset === "dev_full" ? [score, score] : [score];
    },
    reviewer: (input: ReviewInput) => {
      const accept = !input.devRoseHeldOutFell
        && (input.child.devMean ?? 0) >= (input.parent.devMean ?? 0) - 0.01;
      const verdict = {
        accept,
        reason: input.devRoseHeldOutFell
          ? "dev rose and held-out fell relative to the parent"
          : accept ? "keep-better" : "below parent",
      };
      writeRoleJson(options.out, "reviewer-gate", "review.json", verdict);
      return verdict;
    },
    reportWriter: ({ child }): EvidencePack => {
      const pack: EvidencePack = {
        modelId,
        changeNote: child.patchSummary || "cap the idle reread",
        traceIndex: ["t1"],
        devScore: child.devMean ?? 0,
        configPath: child.configPath,
      };
      writeRoleJson(options.out, "report-writer", "evidence_pack/pack.json", pack);
      writeRoleFile(options.out, "report-writer", "evidence_pack/change-note.md", pack.changeNote);
      return pack;
    },
    submitter: (): SubmitReceipt => {
      liveSubmitCalled = false;
      const receipt: SubmitReceipt = {
        ok: true,
        submitted: false,
        mode: "dry-run",
        detail: "evidence gate is green; live playground submit is off",
      };
      writeRoleJson(options.out, "submitter", "submit-receipt.json", receipt);
      return receipt;
    },
  };
  const roles: Roles = { ...fixture, ...options.roles };
  const orchestrator = new Orchestrator(lineage, roles, new GreedySelector(), new Budget(), {
    ids: () => "c1",
    heldOutAtMilestone: (configPath) => {
      const score = milestoneHeldOut[configPath];
      if (typeof score !== "number") throw new Error(`held-out milestone missing for ${configPath}`);
      return score;
    },
  });
  const phase = orchestrator.step();
  const traceReady = readFileSync(join(options.out, "traces", "t1.json"), "utf8").includes("t1");
  let noteReady = false;
  try {
    noteReady = readFileSync(join(options.out, "evidence_pack", "change-note.md"), "utf8").trim() !== "";
  } catch {
    noteReady = false;
  }
  const gate = orchestrator.submitGate({
    heldoutEval: () => options.heldout ?? 0.1,
    ttsBaseline: options.ttsBaseline ?? 0.5,
    baseHeldout: options.baseHeldout ?? 0.4,
    day: options.day ?? "2026-10-18",
    modelId,
    tracePackComplete: traceReady,
    changeNotePresent: noteReady,
    tokenBudget: 10_000,
    tokensSpent: orchestrator.budget.usedTokens,
    dryRun: () => ({
      status: options.dryRun ?? "unsupported",
      detail: options.dryRun === "passed"
        ? "playground submit --dry-run succeeded"
        : "not-run: playground submit --dry-run is unsupported; fail-closed",
    }),
  });
  const child = lineage.nodes.get("c1");
  writeRunState(state, {
    phase,
    selector: "GreedySelector",
    bestId: lineage.best().id,
    submit: gate.submit,
    childStatus: child?.status ?? "missing",
    liveSubmitCalled,
    failed: gate.checks.filter((check) => !check.ok).map((check) => check.id),
  });
  writeRoleFile(options.out, "orchestrator", "state/schedule.log", phase);
  return {
    bestId: lineage.best().id,
    submit: gate.submit,
    heldout: gate.heldout,
    selector: "GreedySelector",
    phase,
    childStatus: child?.status ?? "missing",
    liveSubmitCalled,
    failedChecks: gate.checks.filter((check) => !check.ok).map((check) => check.id),
  };
}

function writeCandidate(root: string, id: string, body: unknown): void {
  const dir = join(root, "candidates", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(body, null, 2)}\n`);
}
