/**
 * The controller's FINALIZE stage (PRD §4 Stage 4; #253/#257).
 *
 * After a Run has executed and been independently measured, its outcome becomes
 * Mission state here and nowhere else: the baseline record, the Experiment
 * trail entry (scientific Negative Evidence vs. an operational outcome), the
 * state-version advance, the advisory direction-concentration review, and the
 * derived Research Memory projection.
 *
 * It never executes, never measures and never decides what to try next. The
 * directed order inside `refreshResearchMemory` is load-bearing and preserved:
 * the authoritative record is persisted FIRST, so a failed derivation can never
 * lose a measured Run.
 */
import type { AttemptOutcome } from "./run-dispatch";
import type { DirectorAction } from "./mission-director";
import {
  configurationLabel,
  withEvent,
  ZERO_USAGE,
  type BaselineMeasurement,
  type BaselineResultRecord,
  type ExperimentTrailEntry,
  type MissionRecord,
  type MissionTaskRecord,
  type StartMissionOutcome,
} from "./mission-start";
import type { AgentRuntimeResult } from "../pi-agent-runtime";
import { classifyRunOutcome } from "../evidence/run-outcome";
import { projectDecisionAccountability } from "./decision-accountability";
import type { DraftPlanTask } from "./mission-draft";

export interface FinalizationPorts {
  readonly projectRoot: string;
  readonly now: () => string;
  readonly persist: (projectRoot: string, record: MissionRecord) => Promise<void>;
  /** Persist the authoritative record, then project/publish derived memory. */
  readonly refreshResearchMemory: (record: MissionRecord) => Promise<MissionRecord>;
}

/**
 * What finalizing the baseline leaves the controller to do: keep looping, or
 * terminate truthfully (a Mission without a Director has nothing left to do
 * after its baseline).
 */
export type BaselineFinalization =
  | { readonly kind: "continue"; readonly record: MissionRecord }
  | { readonly kind: "measured-without-director"; readonly record: MissionRecord }
  | { readonly kind: "failed-without-director"; readonly record: MissionRecord; readonly error: string };

/**
 * Adopt the baseline attempt into the record. A failed baseline DISPATCH is an
 * operational outcome the Director can act on and is never scientific Negative
 * Evidence, so the trail keeps `ok: false` + the error and no refutation marker
 * (#213).
 */
export async function finalizeBaselineRun(
  record: MissionRecord,
  args: {
    readonly outcome: AttemptOutcome;
    readonly runId: string;
    readonly baselineTask: DraftPlanTask;
    readonly hasDirector: boolean;
  },
  ports: FinalizationPorts,
): Promise<BaselineFinalization> {
  const { outcome, runId, baselineTask, hasDirector } = args;
  const at = ports.now();

  if (outcome.kind === "measured") {
    const o = outcome;
    const baseline: BaselineResultRecord = {
      runId,
      candidateId: o.candidateId,
      snapshotDigest: o.snapshotDigest,
      evaluator: o.evaluator,
      evaluation: o.measurement,
      evidenceRefs: o.evidenceRefs,
      measuredAt: at,
    };
    record = {
      ...record,
      baselineRunId: runId,
      baseline,
      stateVersion: (record.stateVersion ?? 0) + 1,
    };
    if (o.measurement.ok) {
      record = withEvent(record, { type: "BASELINE_COMPLETED", at: ports.now(), detail: { runId, score: o.measurement.score } });
    }
  }

  if (outcome.kind === "run-failed" && hasDirector) {
    const configuration = configurationLabel(baselineTask.constraints);
    const entry: ExperimentTrailEntry = {
      runId, attempt: 1, action: "baseline", ok: false,
      taskId: baselineTask.taskId, taskObjective: baselineTask.objective, evidenceRefs: [],
      ...(configuration !== undefined ? { configuration } : {}),
      error: outcome.error, at: ports.now(),
    };
    record = { ...record, experiments: [...(record.experiments ?? []), entry], stateVersion: (record.stateVersion ?? 0) + 1 };
  }

  record = await ports.refreshResearchMemory(record);

  // ── T4 path: one baseline, then a truthful terminal status ──────────────
  if (!hasDirector) {
    if (outcome.kind === "run-failed") {
      // A baseline dispatch failure is terminal (RUN_FAILED is already recorded
      // in the run ledger by the dispatcher).
      record = { ...record, status: "run-failed", stopReason: `baseline Run failed before measurement: ${outcome.error}` };
      return { kind: "failed-without-director", record, error: outcome.error };
    }
    if (!record.stopReason) {
      const ok = outcome.measurement.ok;
      record = { ...record, status: ok ? "baseline-complete" : "evaluator-rule-failure", stopReason: ok ? "baseline-complete" : "evaluator-rule-failure" };
    }
    return { kind: "measured-without-director", record };
  }

  return { kind: "continue", record };
}

/**
 * Adopt one Experiment attempt: a trail entry carries whether the direction was
 * really refuted or merely failed to run, and the state version advances so a
 * stale proposal can never dispatch against the old evidence.
 */
export async function finalizeExperimentRun(
  record: MissionRecord,
  args: {
    readonly outcome: AttemptOutcome;
    readonly action: DirectorAction;
    readonly task: MissionTaskRecord;
    readonly runId: string;
    readonly attempt: number;
  },
  ports: FinalizationPorts,
): Promise<MissionRecord> {
  const { outcome, action, task, runId, attempt } = args;
  const at = ports.now();
  const configuration = configurationLabel(task.constraints);
  const entry: ExperimentTrailEntry = outcome.kind === "measured"
    ? {
        runId, attempt, action, ok: outcome.measurement.ok,
        taskId: task.taskId,
        // Only a real measured refutation is Negative Evidence; an invalid
        // measurement or a failed dispatch is an operational outcome.
        ...(classifyRunOutcome(outcome.measurement).scientificNegativeEvidence ? { negativeEvidence: true } : {}),
        taskObjective: task.objective,
        ...(configuration !== undefined ? { configuration } : {}),
        candidateId: outcome.candidateId, snapshotDigest: outcome.snapshotDigest,
        evaluator: outcome.evaluator, evaluation: outcome.measurement,
        evidenceRefs: outcome.evidenceRefs,
        ...(outcome.measurement.ruleViolations?.length ? { ruleViolations: [...outcome.measurement.ruleViolations] } : {}),
        at,
      }
    : {
        runId, attempt, action, ok: false,
        taskId: task.taskId,
        taskObjective: task.objective, evidenceRefs: [],
        ...(configuration !== undefined ? { configuration } : {}),
        error: outcome.error, at,
      };
  // New observation => authoritative state advances; the next decision must
  // echo this new stateVersion (stale proposals are rejected).
  record = { ...record, experiments: [...(record.experiments ?? []), entry], stateVersion: (record.stateVersion ?? 0) + 1 };
  record = withConcentrationReview(record, ports.now());
  return ports.refreshResearchMemory(record);
}

/** The caller-facing outcome of one controller run, built from the record. */
export function missionOutcomeOf(
  record: MissionRecord,
  last: {
    readonly runId: string;
    readonly result?: AgentRuntimeResult;
    readonly measurement?: BaselineMeasurement;
  },
): StartMissionOutcome {
  return {
    runId: last.runId,
    status: record.status,
    stopReason: record.stopReason ?? record.status,
    model: last.result?.model ?? record.runs[record.baselineRunId!]?.model ?? { provider: "unknown", model: "unknown", id: "unknown" },
    usage: last.result?.usage ?? ZERO_USAGE,
    budget: record.budget,
    evaluation: last.measurement ?? record.baseline?.evaluation ?? { ok: false },
    record,
    experiments: record.experiments ?? [],
  };
}

/**
 * M1-T6: records ONE durable, advisory direction-concentration review when
 * Memory has repeatedly funnelled this Mission into the same direction without
 * new discriminating Evidence. It only writes an event: it cannot force an
 * action, impose an exploration quota, alter Search math, or reserve/freeze any
 * budget or execution authority.
 */
function withConcentrationReview(record: MissionRecord, at: string): MissionRecord {
  const recorded = (record.history ?? [])
    .filter((event) => event.type === "DIRECTION_CONCENTRATION_REVIEW")
    .map((event) => ({
      objective: event.detail?.objective,
      decisionGroupIds: (event.detail?.decisionGroupIds as string[] | undefined) ?? [],
    }));
  // One review per concentration episode: an already-reviewed window that only
  // grows (same objective, no new discriminating Evidence) re-states the same
  // recommendation, so it must not emit a second event.
  const due = projectDecisionAccountability(record).concentration.find((review) =>
    !recorded.some((event) => event.objective === review.objective
      && event.decisionGroupIds.length > 0
      && event.decisionGroupIds.every((decisionGroupId) => review.decisionGroupIds.includes(decisionGroupId))));
  if (due === undefined) return record;
  return withEvent(record, {
    type: "DIRECTION_CONCENTRATION_REVIEW",
    at,
    detail: {
      kind: due.kind,
      objective: due.objective,
      decisionGroupIds: [...due.decisionGroupIds],
      memoryChangedDecisions: due.memoryChangedDecisions,
      advisory: due.advisory,
      recommendation: due.recommendation,
    },
  });
}
