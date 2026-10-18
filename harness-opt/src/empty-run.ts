import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEvokBoundedExec } from "./adapters/evok-sandbox";
import { runRound, type ReviewVerdict, type RoundHandlers, type SubmitReceipt } from "./orchestrator";
import { HeldOutVault } from "./modules/probe";
import type { SandboxExec } from "./modules/runner";
import { RecordingScheduler } from "./pi/subagents-port";
import { emptyParts, type HarnessConfig, type TaskRef, type TraceRecord } from "./types";

export interface EmptyRunOptions {
  readonly out: string;
  readonly modelId?: string;
  readonly handlers?: Partial<RoundHandlers>;
  readonly exec?: SandboxExec;
  readonly tts?: "passed" | "not-run" | "failed";
  readonly heldOutScore?: number | null;
  readonly liveSubmit?: boolean;
  readonly selectorId?: string;
  readonly consultEvok?: () => { readonly ok: boolean; readonly refusedGateIds: readonly string[] };
  readonly devTasks?: readonly TaskRef[];
  readonly heldOutTasks?: readonly TaskRef[];
}

const PRIOR_TRACE: TraceRecord = {
  taskId: "seed",
  reward: 0.4,
  tokens: 20,
  failed: true,
  labels: ["idle-loop"],
  raw: "seed trace: the loop repeated a read without writing the answer",
};

/**
 * One local round with fixture roles.
 * The candidate clears the staged dev gate. The evidence gate then refuses
 * because TTS was not run and held-out was not observed. Live submit stays off.
 */
export function runEmpty(options: EmptyRunOptions) {
  mkdirSync(options.out, { recursive: true });
  const taskPath = "dev/t1.txt";
  mkdirSync(join(options.out, "dev"), { recursive: true });
  writeFileSync(join(options.out, "dev", "t1.txt"), "dev task fixture\n");
  writeFileSync(join(options.out, "held-out-sealed.txt"), "not for the proposer\n");

  const modelId = options.modelId ?? "deepseek-v4.1-flash";
  const incumbent: HarnessConfig = {
    id: "base",
    modelId,
    parts: {
      ...emptyParts(),
      "agent-loop": { maxSteps: 8 },
    },
    search: { samples: 1, selfChecks: 0, retries: 0 },
  };
  const scheduler = new RecordingScheduler();
  const inner: SandboxExec = options.exec ?? ((call) => ({
    trace: {
      taskId: call.task.id,
      reward: 0.8,
      tokens: 30,
      failed: false,
      labels: [],
      raw: `dev trace for ${call.task.id} sample ${call.sampleIndex}`,
    },
  }));
  const handlers = fixtureHandlers(options.handlers);
  const result = runRound({
    root: options.out,
    incumbent,
    baseline: { devScore: 40, tokens: 40, attributionComplete: true },
    priorTraces: [PRIOR_TRACE],
    devTasks: options.devTasks ?? [{ id: "t1", split: "dev", path: taskPath }],
    heldOut: new HeldOutVault(options.heldOutTasks ?? [{ id: "h1", split: "held-out", path: "held-out-sealed.txt" }]),
    exec: createEvokBoundedExec(options.out, inner),
    handlers,
    scheduler,
    selectorId: options.selectorId,
    tts: options.tts,
    heldOutScore: options.heldOutScore,
    liveSubmit: options.liveSubmit,
    consultEvok: options.consultEvok,
    tokenBudget: 10_000,
  });
  return { ...result, visits: scheduler.visits };
}

function fixtureHandlers(overrides: Partial<RoundHandlers> | undefined): RoundHandlers {
  const base: RoundHandlers = {
    gapFinder: () => ({
      gaps: [{
        id: "g1",
        failureClass: "idle-loop",
        summary: "the loop rereads the task and never writes an answer",
        traceIds: ["seed"],
      }],
    }),
    innovator: () => ({
      part: "agent-loop",
      motivation: "stop the idle reread by capping steps and requiring a write",
      expectedFailureClass: "idle-loop",
      changes: { maxSteps: 4, requireWrite: true },
      search: { samples: 1 },
    }),
    reviewer: ({ decision }): ReviewVerdict => ({
      accept: decision.accept,
      reason: decision.reason,
      criterionId: decision.criterionId,
    }),
    reportWriter: ({ observation, config, tts, heldOutScore }) => ({
      modelId: config.modelId,
      config,
      devScore: observation.score.devScore,
      tokens: observation.score.tokens,
      changeNote: "cap agent-loop steps so an idle reread cannot continue",
      traceIndex: observation.traces.map((trace) => trace.taskId),
      tts,
      heldOutScore,
    }),
    submitter: ({ live }): SubmitReceipt => live
      ? {
          ok: false,
          mode: "live",
          submitted: false,
          detail: "live playground submit stays unwired in this skeleton",
        }
      : {
          ok: true,
          mode: "dry-run",
          submitted: false,
          detail: "dry-run seam acknowledged; live playground submit is not called",
        },
  };
  return { ...base, ...overrides };
}
