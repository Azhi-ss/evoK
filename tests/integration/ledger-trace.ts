/**
 * Ledger trace-equivalence harness (PRD §6; #253/#254).
 *
 * Every later restructuring stage must be **behaviourally equivalent** for the
 * same simulated input, not merely green. This harness captures that input's
 * full observable trace in one comparable value:
 *
 *   the event sequence and its key payloads · content digests · artifact
 *   provenance · usage attribution (runs and decisions) · the final Mission
 *   state · the published Research Memory — with timestamps normalized.
 *
 * `traceDigest` makes it a single number a test can pin, exactly like
 * `src/memory/digests.test.ts` pins the seven memory digests. Pins are computed
 * at the review base BEFORE the change and are never updated to match new code:
 * a changed pin is a behaviour change and must be justified as one.
 *
 * NOT captured: the per-intent execution receipt. It is durable state on the
 * intent record rather than a ledger event, so an additive receipt field (the
 * Stage 3 environment digest, #256) cannot reach this trace. A change to what a
 * receipt *asserts* about an existing event still has to be justified, not
 * assumed away by this exclusion.
 *
 * NOTE: this is Mission-side test infrastructure, not the execution harness of
 * PRD §4 Stage 3. It deliberately drives the real controller, because that is
 * what must stay equivalent; the import-boundary rule "harness never imports
 * mission" applies to `src/harness/**` once that directory exists.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestValue } from "../../src/execution/security-boundary";
import {
  baselineResultPath,
  loadMissionRecord,
  resumeAuthorizedMission,
  startAuthorizedMission,
  type BaselineEvaluator,
  type MissionRecord,
  type StartAuthorization,
  type StartMissionOptions,
} from "../../src/mission/mission-start";
import { saveMissionDraft, type MissionDraft } from "../../src/mission/mission-draft";
import type { DirectorInput, MissionDirector } from "../../src/mission/mission-director";
import type { EvokResources } from "../../src/evok-resources";
import type { PiAgentRuntime } from "../../src/execution/pi-agent-runtime";
import { loadActiveResearchMemorySnapshot, researchMemoryStoreFor } from "../../src/memory";

export const LEDGER_TRACE_SCHEMA = "evok.ledger-trace/v1";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TEMP_WORKSPACE = /(?:evok-[a-z]+-[^/\\]*|\/var\/folders\/[^\s"]+|\/tmp\/[^\s"]+)/g;
/** Keys the harness DROPS: they are timestamps, not behaviour. */
const TIME_KEYS = new Set(["at", "measuredAt", "createdAt", "updatedAt", "dispatchedAt", "finishedAt", "since", "retrievedAt"]);

/**
 * Normalize one value for comparison: timestamps (keys and ISO strings) and the
 * per-attempt temp workspace paths are the only things that differ between two
 * identical runs.
 */
export function normalizeTraceValue(value: unknown): unknown {
  if (typeof value === "string") return ISO.test(value) ? "<timestamp>" : value.replace(TEMP_WORKSPACE, "<workspace>");
  if (Array.isArray(value)) return value.map(normalizeTraceValue);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (TIME_KEYS.has(key)) continue;
    out[key] = normalizeTraceValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Everything one simulated start made observable. */
export interface LedgerTrace {
  readonly schema: typeof LEDGER_TRACE_SCHEMA;
  /** Authorization evidence: every ledger event, in order, payloads kept. */
  readonly events: readonly { readonly type: string; readonly detail?: unknown }[];
  /** Per-Run identity and provenance (which Run, which attempt, which refs). */
  readonly runs: readonly Record<string, unknown>[];
  readonly budget: unknown;
  readonly reserved: number;
  /** Metering attribution: intake, one line per Run, one line per decision. */
  readonly usage: unknown;
  readonly decisions: readonly unknown[];
  readonly experiments: readonly unknown[];
  readonly final: unknown;
  /** Artifact content addressing: snapshot files and the result record. */
  readonly artifacts: readonly { readonly runId: string; readonly files: Record<string, string>; readonly result?: Record<string, unknown> }[];
  readonly memory?: unknown;
}

export interface TraceScenario {
  readonly missionId: string;
  readonly draft?: MissionDraft;
  /** Artifact values this simulated Run writes, in Run order. */
  readonly values: readonly number[];
  readonly authorization?: StartAuthorization;
  readonly reserveCost?: number;
  readonly budgetTotal?: number;
}

export function traceDraft(args: TraceScenario): MissionDraft {
  return {
    schemaVersion: 1,
    id: args.missionId,
    status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the project" },
    evaluation: { method: "file-answer-deterministic", metric: "answer in [0,1]" },
    constraints: { permissions: ["isolated-workspace-write", "read-project"], hardRules: ["no external submission"] },
    budget: { total: args.budgetTotal ?? 1, units: "model-USD", note: "bounded trace scenario" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [],
    decisions: [],
    sources: [],
    plan: {
      baselineHypothesis: "a deterministic file-producing baseline is measurable",
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt in the run workspace with value 0.4" }],
    },
    usage: { tokens: { input: 11, output: 7, total: 18 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...(args.draft ?? {}),
  } as MissionDraft;
}

const ZERO_USAGE = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const traceEvaluator: BaselineEvaluator = {
  id: "file-answer-deterministic",
  version: "1",
  async evaluate(snapshot) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing"] };
    return { ok: true, score: Number(raw.split(/\r?\n/, 1)[0]?.trim()) };
  },
};

/** One simulated Run per scripted value; fails if the controller over-dispatches. */
function traceRuntime(values: readonly number[]): (workspaceRoot: string) => PiAgentRuntime {
  let index = 0;
  return () => {
    const value = values[index++];
    return {
      execute: async (request: { workspace: { path: string } }) => {
        if (value === undefined) throw new Error("trace scenario: unexpected extra Run");
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(request.workspace.path, { recursive: true });
        await writeFile(join(request.workspace.path, "answer.txt"), `${value}\n`);
        return {
          sessionId: `trace-session-${index}`,
          workspace: request.workspace.path,
          events: [],
          ledger: [],
          usage: {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
          },
          stopReason: "stop",
        };
      },
    } as unknown as PiAgentRuntime;
  };
}

/** One bounded propose-then-stop decision script over the measured history. */
class TraceDirector implements MissionDirector {
  readonly id = "trace-director";
  async decide(input: DirectorInput) {
    const last = input.observations[input.observations.length - 1];
    if (input.observations.length >= 2) {
      return {
        proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "one bounded Experiment is enough", stopReason: "bounded trace scenario complete" } as never,
        sessionId: "trace-director-2",
        usage: ZERO_USAGE,
      };
    }
    return {
      proposal: {
        stateVersion: input.stateVersion,
        action: "investigate",
        rationale: last === undefined ? "no confirmed observation survived recovery" : `act on the last observation (${last.runId})`,
        task: { objective: "push the measured answer toward 0.9", expectedOutputs: ["answer.txt"] },
        expectedCost: 0.0001,
        ...(last === undefined ? {} : { basedOn: [last.runId] }),
      } as never,
      sessionId: "trace-director-1",
      usage: ZERO_USAGE,
    };
  }
}

async function collectSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files[rel] = await readFile(join(dir, entry.name), "utf8");
    }
  };
  await walk(root, "");
  return files;
}

/** Capture everything the durable record made observable, normalized. */
export async function captureRecordTrace(projectRoot: string, missionId: string): Promise<LedgerTrace> {
  const record = await loadMissionRecord(projectRoot, missionId);
  return normalizeTrace(await traceOfRecord(projectRoot, missionId, record));
}

/** Capture everything one simulated start made observable. */
export async function captureStartTrace(projectRoot: string, scenario: TraceScenario): Promise<LedgerTrace> {
  const draft = await saveMissionDraft(projectRoot, traceDraft(scenario));
  const options: StartMissionOptions = {
    projectRoot,
    missionId: draft.id,
    authorization: scenario.authorization ?? { requested: true, token: "/start", missionSelector: "displayed", source: "user" },
    resolver: (() => {
      throw new Error("the trace runtime never resolves a model");
    }) as unknown as StartMissionOptions["resolver"],
    resources: { readRoots: [], skillFiles: [] } as unknown as EvokResources,
    evaluator: traceEvaluator,
    budgetUnits: "model-USD",
    reserveCost: scenario.reserveCost ?? 0.0001,
    director: new TraceDirector(),
    runtimeFactory: traceRuntime(scenario.values),
  };
  await startAuthorizedMission(options);
  return captureRecordTrace(projectRoot, draft.id);
}

/**
 * Capture a RESUME: the same durable-fact comparison, over the recovery entry
 * point (`resumeAuthorizedMission`), which Stage 1 also rewired onto
 * `PreparedRun`.
 */
export async function captureResumeTrace(projectRoot: string, scenario: TraceScenario): Promise<LedgerTrace> {
  const draft = await saveMissionDraft(projectRoot, traceDraft(scenario));
  await writeFile(join(projectRoot, ".evok", "missions", draft.id, "mission.json"), JSON.stringify(interruptedRecord(draft), null, 2), "utf8");
  await resumeAuthorizedMission({
    projectRoot,
    missionId: draft.id,
    authorization: { requested: true, token: "/resume", missionSelector: "displayed", source: "user" },
    resolver: (() => {
      throw new Error("the trace runtime never resolves a model");
    }) as unknown as StartMissionOptions["resolver"],
    resources: { readRoots: [], skillFiles: [] } as unknown as EvokResources,
    evaluator: traceEvaluator,
    budgetUnits: "model-USD",
    reserveCost: scenario.reserveCost ?? 0.0001,
    director: new TraceDirector(),
    runtimeFactory: traceRuntime(scenario.values),
  });
  return captureRecordTrace(projectRoot, draft.id);
}

/**
 * A durable interrupted record with no surviving Run: reconciliation confirms
 * nothing, so the resume exercises the recovery-then-loop path itself.
 */
function interruptedRecord(draft: MissionDraft): Record<string, unknown> {
  const at = "2026-09-11T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: draft.id,
    status: "interrupted",
    objective: draft.objective,
    contract: { objective: draft.objective, expectedOutputs: draft.outputs, evaluationMethod: draft.evaluation.method, metric: draft.evaluation.metric, hardRules: draft.constraints.hardRules ?? [] },
    budget: { total: draft.budget.total, units: draft.budget.units, consumed: draft.usage.cost.total, remaining: draft.budget.total - draft.usage.cost.total },
    reserved: 0,
    usage: { intake: { tokens: { ...draft.usage.tokens }, cost: { ...draft.usage.cost } }, runs: [] },
    runs: {},
    history: [],
    stateVersion: 1,
    tasks: draft.plan.tasks.map((task) => ({ ...task, source: "intake" })),
    permissions: draft.constraints.permissions ?? [],
    stopConditions: draft.stopConditions,
    modelTier: "default",
    researchMemoryMode: "real",
    decisions: [],
    experiments: [],
    stopReason: "user interruption",
    createdAt: at,
    updatedAt: at,
  };
}

async function traceOfRecord(projectRoot: string, missionId: string, record: MissionRecord): Promise<LedgerTrace> {
  const artifacts: { runId: string; files: Record<string, string>; result?: Record<string, unknown> }[] = [];
  for (const runId of Object.keys(record.runs).sort()) {
    const files = await collectSnapshot(join(projectRoot, ".evok", "missions", missionId, "runs", runId, "snapshot")).catch(() => ({}));
    const result = await readFile(baselineResultPath(projectRoot, missionId, runId), "utf8").then(
      (raw) => JSON.parse(raw) as Record<string, unknown>,
      () => undefined,
    );
    artifacts.push({ runId, files, ...(result === undefined ? {} : { result }) });
  }

  const active = await loadActiveResearchMemorySnapshot(
    researchMemoryStoreFor(join(projectRoot, ".evok", "missions", missionId, "memory")),
  ).catch(() => undefined);

  return {
    schema: LEDGER_TRACE_SCHEMA,
    events: record.history.map((event) => ({ type: event.type, ...(event.detail ? { detail: event.detail } : {}) })),
    runs: Object.entries(record.runs).map(([runId, run]) => ({
      runId,
      intentId: run.intentId,
      attempt: run.attempt,
      status: run.status,
      model: run.model?.id,
      hasSessionId: run.sessionId !== undefined,
      snapshotRef: run.snapshotRef,
      resultRef: run.resultRef,
      researchMemory: run.researchMemory,
      error: run.error,
    })),
    budget: record.budget,
    reserved: record.reserved,
    usage: record.usage,
    decisions: record.decisions ?? [],
    experiments: record.experiments ?? [],
    final: {
      status: record.status,
      stopReason: record.stopReason,
      stateVersion: record.stateVersion,
      baselineRunId: record.baselineRunId,
      baseline: record.baseline,
      researchMemory: record.researchMemory,
      tasks: record.tasks,
      permissions: record.permissions,
      researchMemoryMode: record.researchMemoryMode,
      modelTier: record.modelTier,
    },
    artifacts,
    ...(active === undefined
      ? {}
      : { memory: { snapshotId: active.snapshotId, digest: active.digest, cardIds: active.cards.map((card) => card.cardId) } }),
  };
}

/** Apply `normalizeTraceValue` to a whole trace, keeping the canonical order. */
function normalizeTrace(trace: LedgerTrace): LedgerTrace {
  return normalizeTraceValue(trace) as LedgerTrace;
}

/** One number a test can pin: the normalized trace's content digest. */
export function traceDigest(trace: LedgerTrace): string {
  return digestValue(trace);
}
