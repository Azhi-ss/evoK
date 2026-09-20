/**
 * ET-SUBMIT-AUTO / #179 — contest-arm auto-submit after all gates green.
 *
 * Thin orchestrator: reuse existing gate APIs, fail closed on any
 * red / yellow / missing color, write an attempt ledger every time,
 * and only then call the existing submit seam. The hang gate requires a
 * ledger-bound KillTestPlan (no plan cannot claim pass). Real network
 * submit stays behind `{ live: true }` plus an injected destination.
 *
 * Does not loosen Admission / Budget / hang / T48 predicates.
 * Hang green additionally requires a ledger KillTestPlan (harden).
 * Does not change SubmissionBroker's compatibility `autoSubmit` flag
 * (that flag still cannot bypass Human Acceptance).
 * Does not weld `#40` / Progressive as the product default.
 */
import { deepFreeze } from "../security-boundary";
import {
  budgetDecisionIsPass,
  evaluateBudgetGate,
  type BudgetAuthorizationInput,
} from "./budget-gate";
import { killTestHangHasLedgerPlan, runKillTestHang, type KillTestHangInput } from "./kill-test-hang";
import { evaluateMethodAdmission, type MethodAdmissionInput } from "./method-admission";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import {
  SubmissionBroker,
  submissionChampionIsEligible,
  type SubmissionChampion,
  type SubmissionRequestInput,
  type SubmissionResult,
} from "./submission-broker";

export type ContestAutoSubmitGateId =
  | "promotion"
  | "hang"
  | "t48"
  | "admission"
  | "budget";

export type ContestAutoSubmitGateColor = "green" | "yellow" | "red" | "missing";

export type ContestAutoSubmitReason = "gates-green" | "gates-not-green" | "submit-unavailable";

export type ContestAutoSubmitOutcome = "submitted" | "refused";

export type ContestAutoSubmitEventType =
  | "CONTEST_AUTO_SUBMIT_ATTEMPTED"
  | "CONTEST_AUTO_SUBMIT_REFUSED"
  | "CONTEST_AUTO_SUBMIT_SUBMITTED";

export interface ContestAutoSubmitGateStatus {
  readonly id: ContestAutoSubmitGateId;
  readonly color: ContestAutoSubmitGateColor;
  readonly objections: readonly string[];
}

export type ContestPromotionChampion = Pick<
  SubmissionChampion,
  | "evaluatorSucceeded"
  | "evaluatorPassed"
  | "successAuditorPassed"
  | "successAudited"
  | "verification"
  | "promotionApproved"
  | "promoted"
  | "status"
>;

export interface ContestT48Input {
  readonly evidence?: MethodologyEvidence;
  readonly contracts?: MethodologyContracts;
}

export interface ContestAutoSubmitDecision {
  readonly ok: boolean;
  readonly submitted: boolean;
  readonly outcome: ContestAutoSubmitOutcome;
  readonly reason: ContestAutoSubmitReason;
  readonly gates: readonly ContestAutoSubmitGateStatus[];
  readonly refusedGates: readonly ContestAutoSubmitGateStatus[];
}

export interface ContestSubmitSeamInput {
  readonly live: boolean;
  readonly decision: ContestAutoSubmitDecision;
}

export interface ContestSubmitSeamResult {
  readonly status: "DRY_RUN" | "SUCCEEDED" | "FAILED";
  readonly submissionId?: string;
  readonly response?: Readonly<Record<string, unknown>>;
}

export type ContestSubmitSeam = (
  input: ContestSubmitSeamInput,
) => ContestSubmitSeamResult | Promise<ContestSubmitSeamResult>;

export interface ContestAutoSubmitEvent {
  readonly sequence: number;
  readonly type: ContestAutoSubmitEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ContestAutoSubmitLedger {
  append(event: { readonly type: ContestAutoSubmitEventType; readonly payload: Record<string, unknown> }): unknown;
  events(): readonly ContestAutoSubmitEvent[];
}

export interface ContestAutoSubmitInput {
  readonly champion?: ContestPromotionChampion;
  readonly hang?: KillTestHangInput;
  readonly t48?: ContestT48Input;
  readonly admission?: MethodAdmissionInput;
  readonly budget?: BudgetAuthorizationInput;
  readonly live?: boolean;
  readonly submit?: ContestSubmitSeam;
  readonly ledger?: ContestAutoSubmitLedger;
}

export interface ContestAutoSubmitAttempt extends ContestAutoSubmitDecision {
  readonly live: boolean;
  readonly submission?: ContestSubmitSeamResult;
}

const EVENT_TYPES = new Set<ContestAutoSubmitEventType>([
  "CONTEST_AUTO_SUBMIT_ATTEMPTED",
  "CONTEST_AUTO_SUBMIT_REFUSED",
  "CONTEST_AUTO_SUBMIT_SUBMITTED",
]);

function freezeGate(
  id: ContestAutoSubmitGateId,
  color: ContestAutoSubmitGateColor,
  objections: readonly string[] = [],
): ContestAutoSubmitGateStatus {
  return deepFreeze({
    id,
    color,
    objections: Object.freeze([...objections]),
  }) as ContestAutoSubmitGateStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evaluatePromotion(champion: ContestPromotionChampion | undefined): ContestAutoSubmitGateStatus {
  if (champion === undefined) {
    return freezeGate("promotion", "missing", ["promotion champion is missing"]);
  }
  if (submissionChampionIsEligible(champion as SubmissionChampion)) return freezeGate("promotion", "green");
  return freezeGate("promotion", "red", [
    "champion has not passed evaluator, Success Auditor, and promotion policy",
  ]);
}

function evaluateHang(input: KillTestHangInput | undefined): ContestAutoSubmitGateStatus {
  if (input === undefined) {
    return freezeGate("hang", "missing", ["kill-test hang input is missing"]);
  }
  if (!killTestHangHasLedgerPlan(input)) {
    return freezeGate("hang", "missing", ["kill-test hang requires a ledger KillTestPlan"]);
  }
  try {
    const hang = runKillTestHang(input);
    if (hang.ok) return freezeGate("hang", "green");
    if (hang.outcome === "inconclusive") {
      return freezeGate("hang", "yellow", hang.objections);
    }
    return freezeGate("hang", "red", hang.objections);
  } catch (error) {
    return freezeGate("hang", "red", [
      error instanceof Error ? error.message : "kill-test hang rejected the candidate",
    ]);
  }
}

function evaluateT48(input: ContestAutoSubmitInput): ContestAutoSubmitGateStatus {
  const evidence = input.t48?.evidence
    ?? input.hang?.methodologyEvidence
    ?? { splitDigestAgreement: "unknown" as const, oofPresent: false };
  const contracts = input.t48?.contracts ?? input.hang?.contracts;
  const audit = auditMethodology(evidence, contracts);
  const oof = oofEnsembleGate(evidence, contracts);
  if (audit.ok && oof.ok) return freezeGate("t48", "green");
  return freezeGate("t48", "red", [...audit.objections, ...oof.objections]);
}

function evaluateAdmission(input: MethodAdmissionInput | undefined): ContestAutoSubmitGateStatus {
  if (input === undefined) {
    return freezeGate("admission", "missing", ["Admission input is missing"]);
  }
  const admission = evaluateMethodAdmission(input);
  if (admission.admitted) return freezeGate("admission", "green");
  if (admission.hang || admission.outcome === "inconclusive") {
    return freezeGate("admission", "yellow", admission.objections);
  }
  return freezeGate("admission", "red", admission.objections);
}

function evaluateBudget(input: BudgetAuthorizationInput | undefined): ContestAutoSubmitGateStatus {
  if (input === undefined) {
    return freezeGate("budget", "missing", ["Budget Gate input is missing"]);
  }
  const decision = evaluateBudgetGate(input);
  if (budgetDecisionIsPass(decision, input.action)) return freezeGate("budget", "green");
  return freezeGate("budget", "red", decision.objections);
}

function decisionOf(input: {
  readonly gates: readonly ContestAutoSubmitGateStatus[];
  readonly reason: ContestAutoSubmitReason;
  readonly submitted: boolean;
  readonly ok: boolean;
}): ContestAutoSubmitDecision {
  const refusedGates = Object.freeze(input.gates.filter((gate) => gate.color !== "green"));
  return deepFreeze({
    ok: input.ok,
    submitted: input.submitted,
    outcome: input.submitted ? "submitted" : "refused",
    reason: input.reason,
    gates: Object.freeze([...input.gates]),
    refusedGates,
  }) as ContestAutoSubmitDecision;
}

export function evaluateContestAutoSubmitGates(input: ContestAutoSubmitInput): ContestAutoSubmitDecision {
  const gates = Object.freeze([
    evaluatePromotion(input.champion),
    evaluateHang(input.hang),
    evaluateT48(input),
    evaluateAdmission(input.admission),
    evaluateBudget(input.budget),
  ]);
  const refused = gates.filter((gate) => gate.color !== "green");
  const gatesGreen = refused.length === 0;
  return decisionOf({
    gates,
    reason: gatesGreen ? "gates-green" : "gates-not-green",
    submitted: false,
    ok: gatesGreen,
  });
}

export class InMemoryContestAutoSubmitLedger implements ContestAutoSubmitLedger {
  private readonly entries: ContestAutoSubmitEvent[] = [];

  append(event: { readonly type: ContestAutoSubmitEventType; readonly payload: Record<string, unknown> }): ContestAutoSubmitEvent {
    if (!event || !EVENT_TYPES.has(event.type) || !isRecord(event.payload)) {
      throw new TypeError("invalid contest auto-submit ledger event");
    }
    const entry = deepFreeze({
      sequence: this.entries.length + 1,
      type: event.type,
      payload: { ...event.payload },
    }) as ContestAutoSubmitEvent;
    this.entries.push(entry);
    return entry;
  }

  events(): readonly ContestAutoSubmitEvent[] {
    return Object.freeze([...this.entries]);
  }
}

function append(
  ledger: ContestAutoSubmitLedger,
  type: ContestAutoSubmitEventType,
  payload: Record<string, unknown>,
): void {
  ledger.append({ type, payload: { ...payload } });
}

function publicGates(gates: readonly ContestAutoSubmitGateStatus[]): readonly Record<string, unknown>[] {
  return gates.map((gate) => ({
    id: gate.id,
    color: gate.color,
    objections: [...gate.objections],
  }));
}

export function createBrokerContestSubmitSeam(
  broker: SubmissionBroker,
  request: SubmissionRequestInput,
): ContestSubmitSeam {
  return async ({ live, decision }) => {
    if (decision.reason === "gates-not-green" || decision.refusedGates.length > 0) {
      throw new Error("contest auto-submit seam refused: gates are not green");
    }
    if (live === true) {
      const created = broker.createRequest({ ...request, dryRun: false });
      broker.approve(created, {
        acceptedBy: "contest-auto-submit",
        reason: "all promotion/evidence gates green",
      });
      return copyBrokerResult(await broker.submit(created));
    }
    const created = broker.createDryRun(request);
    return copyBrokerResult(await broker.submit(created));
  };
}

function copyBrokerResult(result: SubmissionResult): ContestSubmitSeamResult {
  return deepFreeze({
    status: result.status,
    ...(result.submissionId === undefined ? {} : { submissionId: result.submissionId }),
    ...(result.response === undefined ? {} : { response: result.response }),
  }) as ContestSubmitSeamResult;
}

export async function attemptContestAutoSubmit(
  input: ContestAutoSubmitInput,
): Promise<ContestAutoSubmitAttempt> {
  const live = input.live === true;
  const ledger = input.ledger ?? new InMemoryContestAutoSubmitLedger();
  const evaluated = evaluateContestAutoSubmitGates(input);
  append(ledger, "CONTEST_AUTO_SUBMIT_ATTEMPTED", {
    live,
    reason: evaluated.reason,
    gates: publicGates(evaluated.gates),
    refusedGates: publicGates(evaluated.refusedGates),
  });

  if (evaluated.reason === "gates-not-green") {
    const refused = decisionOf({
      gates: evaluated.gates,
      reason: "gates-not-green",
      submitted: false,
      ok: false,
    });
    append(ledger, "CONTEST_AUTO_SUBMIT_REFUSED", {
      outcome: "refused",
      reason: "gates-not-green",
      refusedGates: publicGates(refused.refusedGates),
    });
    return deepFreeze({ ...refused, live }) as ContestAutoSubmitAttempt;
  }

  if (input.submit === undefined) {
    const refused = decisionOf({
      gates: evaluated.gates,
      reason: "submit-unavailable",
      submitted: false,
      ok: false,
    });
    append(ledger, "CONTEST_AUTO_SUBMIT_REFUSED", {
      outcome: "refused",
      reason: "submit-unavailable",
      refusedGates: publicGates(refused.refusedGates),
    });
    return deepFreeze({ ...refused, live }) as ContestAutoSubmitAttempt;
  }

  const submission = await input.submit({ live, decision: evaluated });
  const ok = submission.status === "DRY_RUN" || submission.status === "SUCCEEDED";
  const accepted = decisionOf({
    gates: evaluated.gates,
    reason: "gates-green",
    submitted: true,
    ok,
  });
  append(ledger, "CONTEST_AUTO_SUBMIT_SUBMITTED", {
    outcome: "submitted",
    status: submission.status,
    ...(submission.submissionId === undefined ? {} : { submissionId: submission.submissionId }),
  });
  return deepFreeze({
    ...accepted,
    live,
    submission,
  }) as ContestAutoSubmitAttempt;
}
