import type { MissionEventType } from "./toy-harness";

/**
 * The three-way ledger accounting mandated by spec #1 (Graph Engineering
 * 对照, 2026-09-04): Approval ≠ Evidence ≠ Evaluation. Every mission ledger
 * event type belongs to exactly one kind — adding an event type without
 * classifying it here is a compile error. See docs/ledger-event-types.md.
 *
 * - Approval: human acceptance, SubmissionBroker gate decisions, high-side-effect permission.
 * - Evidence: observations — artifact digests, evaluator-returned score/rule facts, run and traversal records.
 * - Evaluation: verdicts over Evidence ids — promotion / reject / quarantine / stop / fan-in decisions.
 *
 * Only Evaluation-kind verdicts can produce a champion; the projector never
 * derives one from an Approval event (T46).
 */
export type LedgerEventKind = "Approval" | "Evidence" | "Evaluation";

export const LEDGER_EVENT_KINDS: Record<MissionEventType, LedgerEventKind> = {
  MISSION_CREATED: "Evidence",
  MISSION_STARTED: "Evidence",
  BRANCH_RESERVED: "Evidence",
  TASK_SELECTED: "Evidence",
  PREFLIGHT_SELF_CHECK_PASSED: "Evidence",
  PREFLIGHT_SELF_CHECK_FAILED: "Evidence",
  AGENT_COMPLETED: "Evidence",
  CANDIDATE_GENERATED: "Evidence",
  CANDIDATE_MATERIALIZED: "Evidence",
  SNAPSHOT_COMMITTED: "Evidence",
  EVALUATION_STARTED: "Evidence",
  EVALUATION_RUN_COMPLETED: "Evidence",
  FEEDBACK_VIEW_CREATED: "Evidence",
  EVALUATOR_SUCCEEDED: "Evidence",
  EVALUATOR_FAILED: "Evidence",
  RECONCILED: "Evidence",
  FALSIFIER_COMPLETED: "Evidence",
  CRITIC_COMPLETED: "Evidence",
  CHALLENGER_COMPLETED: "Evidence",
  AUDITOR_COMPLETED: "Evidence",
  SUCCESS_AUDITOR_COMPLETED: "Evidence",
  LEAKAGE_DISCLOSURE: "Evidence",
  PUBLIC_PROBE_REFUSED: "Evidence",
  BASELINE_TRACK_STARTED: "Evidence",
  BASELINE_TRACK_PASSED: "Evidence",
  BASELINE_TRACK_FAILED: "Evidence",
  HEAVY_SEARCH_REFUSED: "Evaluation",
  GAIN_BANKED: "Evaluation",
  PROMOTED_LOCAL: "Evaluation",
  BRANCH_REJECTED: "Evaluation",
  BRANCH_QUARANTINED: "Evaluation",
  HUMAN_ACCEPTED: "Approval",
  SUBMISSION_REQUESTED: "Evidence",
  SUBMISSION_APPROVED: "Approval",
  SUBMISSION_REJECTED: "Approval",
  SUBMISSION_RESULT: "Evidence",
  RETRY_SCHEDULED: "Evidence",
  MODEL_RESOLVED: "Evidence",
  CROSS_MODEL_CHECK_COMPLETED: "Evidence",
  MISSION_COMPLETED: "Evaluation",
  MISSION_STOPPED: "Evaluation",
  LATE_EVENT_REJECTED: "Evidence",
  EDGE_TRAVERSED: "Evidence",
};

/** Classifies a ledger event type; unknown (foreign/forged) types classify as null. */
export function ledgerEventKind(type: string): LedgerEventKind | null {
  return (LEDGER_EVENT_KINDS as Record<string, LedgerEventKind>)[type] ?? null;
}
