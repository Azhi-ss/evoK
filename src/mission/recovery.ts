/**
 * The controller's RECOVER-OR-TERMINATE stage (PRD §4 Stage 4, §6 Recovery;
 * #253/#257).
 *
 * A controller that re-enters a Mission must never re-decide, re-charge or
 * re-dispatch work that is already durable, and it must never continue past a
 * bound. Both halves are decided here from the record alone:
 *
 * - **recover** — which decision stages are already frozen for this state
 *   version, which proposal was already APPLIED (so its Run identity is
 *   reused), and which attempt number is the next unused one;
 * - **terminate** — budget exhaustion, the authorized Experiment bound and user
 *   interruption, each with the event and truthful status the ledger needs.
 *
 * `unknown` never becomes success: an interrupted or unconfirmed attempt is
 * surfaced, not adopted, and nothing here invents a result. The functions are
 * pure (they derive records; the caller persists/releases/throws), so recovery
 * behaviour is testable without a controller.
 */
import { withEvent, type HistoryEvent, type MissionRecord } from "./mission-start";
import type { DirectorProposal } from "./mission-director";

/** One decision phase as it stands in the ledger for the current state version. */
export interface RecoveredStage {
  /** The already-accepted proposal, if this stage completed before the crash. */
  readonly proposal?: DirectorProposal;
  /** First unused attempt: a resumed stage never re-charges completed attempts. */
  readonly nextAttempt: number;
}

export interface RecoveredDecisionGroup {
  readonly blind: RecoveredStage;
  readonly revision: RecoveredStage;
  /**
   * The group already recorded its stop. It completed, so resuming asks again
   * instead of replaying that same stop.
   */
  readonly stopped: boolean;
}

/**
 * M1-T7: a stage already durable for THIS state version is reused, never
 * re-called or re-charged. A crash after the frozen Blind Proposal must not
 * regenerate a purportedly blind decision, and a crash after the Revised
 * Proposal must dispatch that exact validated action.
 */
export function recoveredDecisionGroup(
  record: MissionRecord,
  args: { readonly decisionGroupId: string; readonly stateVersion: number },
): RecoveredDecisionGroup {
  const { decisionGroupId, stateVersion } = args;
  const recorded = (record.decisions ?? []).filter((decision) =>
    decision.decisionGroupId === decisionGroupId && decision.stateVersion === stateVersion);
  const stopped = (record.history ?? []).some((event: HistoryEvent) =>
    event.type === "DIRECTOR_STOPPED" && event.detail?.stateVersion === stateVersion);
  const stageOf = (phase: "blind" | "revision"): RecoveredStage => {
    const stage = recorded.filter((decision) => decision.phase === phase);
    const accepted = stopped ? [] : stage.filter((decision) => decision.accepted && decision.proposal);
    return {
      proposal: accepted.at(-1)?.proposal,
      nextAttempt: stage.reduce((next, decision) => Math.max(next, decision.attempt), 0) + 1,
    };
  };
  return { blind: stageOf("blind"), revision: stageOf("revision"), stopped };
}

/** A proposal application that is already durable for this state version. */
export interface RecoveredApplication {
  readonly runId: string;
  readonly taskId?: string;
  readonly attempt?: number;
}

/**
 * M1-T7: an already-durable PROPOSAL_APPLIED for this state version keeps its
 * Run identity, so recovery never creates a second Experiment for one validated
 * action.
 */
export function recoveredApplication(record: MissionRecord, stateVersion: number): RecoveredApplication | undefined {
  const applied = (record.history ?? []).findLast((event) =>
    event.type === "PROPOSAL_APPLIED"
    && event.detail?.stateVersion === stateVersion
    && typeof event.detail.runId === "string");
  if (applied?.detail === undefined) return undefined;
  const { runId, taskId, attempt } = applied.detail;
  return {
    runId: String(runId),
    ...(typeof taskId === "string" ? { taskId } : {}),
    ...(typeof attempt === "number" ? { attempt } : {}),
  };
}

/**
 * Candidate Run attempts are numbered 1 (baseline), 2, 3, … across the WHOLE
 * Mission, so a retried/abandoned attempt id is never reused or silently
 * replayed after a resume.
 */
export function nextRunAttempt(record: MissionRecord): number {
  return Object.values(record.runs).reduce((max, run) => Math.max(max, run.attempt), 1) + 1;
}

/** What the loop must do next, decided from the durable record only. */
export type LoopStep =
  | { readonly kind: "continue" }
  /** A truthful terminal status is already set (or set here); no throw needed. */
  | { readonly kind: "terminate"; readonly record: MissionRecord }
  /** User interruption: the caller persists, releases the lock and throws. */
  | { readonly kind: "abort"; readonly record: MissionRecord };

export function loopStep(
  record: MissionRecord,
  args: {
    readonly maxExperiments: number;
    readonly experimentCount: number;
    readonly aborted: boolean;
    readonly now: () => string;
  },
): LoopStep {
  // After a candidate Run or priced decision crosses the budget the loop ends
  // with a truthful persisted terminal status.
  if (record.status === "budget-exhausted") return { kind: "terminate", record };
  if (args.experimentCount >= args.maxExperiments) {
    return {
      kind: "terminate",
      record: withEvent(record, { type: "ITERATION_LIMIT", at: args.now(), detail: { maxExperiments: args.maxExperiments } }, {
        status: "iteration-limit",
        stopReason: `reached the authorized bound of ${args.maxExperiments} Experiment(s) after the baseline; stopped explicitly rather than waiting for another prompt`,
      }),
    };
  }
  if (args.aborted) {
    return {
      kind: "abort",
      record: withEvent(record, { type: "RUN_INTERRUPTED", at: args.now() }, {
        status: "interrupted",
        stopReason: "user interruption during the Research Loop; result unconfirmed until recovery",
      }),
    };
  }
  return { kind: "continue" };
}

/**
 * The Director's own stop: durable terminal state, no further dispatch. The
 * stop reason is the model's only when it stated one.
 */
export function stopStep(record: MissionRecord, proposal: DirectorProposal, at: string): MissionRecord {
  return withEvent(record, {
    type: "DIRECTOR_STOPPED",
    at,
    detail: { stateVersion: record.stateVersion, stopReason: proposal.stopReason, rationale: proposal.rationale },
  }, {
    status: "director-stopped",
    stopReason: proposal.stopReason || `model-proposed stop: ${proposal.rationale}`,
  });
}
