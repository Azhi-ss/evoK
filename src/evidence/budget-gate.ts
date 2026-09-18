/**
 * W1 Budget Gate skeleton (ET-M1-BUD / #144).
 *
 * Gate authority lives here, next to EXP Admission. Mission continue /
 * Skills writeback may hook a BudgetDecision; they do not own the ledger.
 *
 * Contract: reserve → settle. Over-budget or unreserved refuses continue
 * and writeback. A thin Method Improvement sub-cap is optional. Budget
 * pass is not Admission pass.
 *
 * Does not change Kill-test / T48 / Broker predicates, thaw true submit,
 * reopen EXP Admission predicates, or weld #40 / default fixed_uct.
 * Does not replace MissionRecord operational accounting.
 */
import { deepFreeze } from "../security-boundary";

export type BudgetAction = "continue" | "writeback";
export type BudgetSpendKind = "research" | "method_improvement";
export type BudgetRefuseReason = "unreserved" | "over_budget" | "over_method_improvement_cap";
export type BudgetReservationStatus = "open" | "settled" | "released";

export interface BudgetCaps {
  readonly total: number;
  readonly units: string;
  readonly methodImprovement?: number;
}

export interface BudgetReserveRequest {
  readonly reservationId: string;
  readonly amount: number;
  readonly kind: BudgetSpendKind;
  readonly action: BudgetAction;
}

export interface BudgetReservation {
  readonly reservationId: string;
  readonly amount: number;
  readonly kind: BudgetSpendKind;
  readonly action: BudgetAction;
  readonly status: BudgetReservationStatus;
}

export interface BudgetSnapshot {
  readonly caps: BudgetCaps;
  readonly reserved: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly methodImprovementReserved: number;
  readonly methodImprovementConsumed: number;
  readonly methodImprovementRemaining?: number;
  readonly openReservations: readonly BudgetReservation[];
}

export interface BudgetAuthorizationInput {
  readonly action: BudgetAction;
  readonly snapshot: BudgetSnapshot;
  /** Never a Budget Gate key. Accepted only so tests can prove they do not pass. */
  readonly elite?: boolean;
  readonly score?: number;
}

export interface BudgetDecision {
  readonly ok: boolean;
  readonly outcome: "pass" | "refuse";
  readonly action?: BudgetAction;
  readonly reason?: BudgetRefuseReason;
  readonly reservation?: BudgetReservation;
  readonly objections: readonly string[];
  readonly snapshot: BudgetSnapshot;
}

function freezeDecision(input: {
  readonly ok: boolean;
  readonly outcome: "pass" | "refuse";
  readonly action?: BudgetAction;
  readonly reason?: BudgetRefuseReason;
  readonly reservation?: BudgetReservation;
  readonly objections?: readonly string[];
  readonly snapshot: BudgetSnapshot;
}): BudgetDecision {
  return deepFreeze({
    ok: input.ok,
    outcome: input.outcome,
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
    objections: Object.freeze([...(input.objections ?? [])]),
    snapshot: input.snapshot,
  });
}

function refuse(input: {
  readonly reason: BudgetRefuseReason;
  readonly objections: readonly string[];
  readonly snapshot: BudgetSnapshot;
  readonly action?: BudgetAction;
  readonly reservation?: BudgetReservation;
}): BudgetDecision {
  return freezeDecision({
    ok: false,
    outcome: "refuse",
    reason: input.reason,
    objections: input.objections,
    snapshot: input.snapshot,
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
  });
}

function pass(input: {
  readonly snapshot: BudgetSnapshot;
  readonly action?: BudgetAction;
  readonly reservation?: BudgetReservation;
}): BudgetDecision {
  return freezeDecision({
    ok: true,
    outcome: "pass",
    snapshot: input.snapshot,
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
  });
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function methodRemaining(caps: BudgetCaps, reserved: number, consumed: number): number | undefined {
  if (caps.methodImprovement === undefined) return undefined;
  return roundMoney(caps.methodImprovement - reserved - consumed);
}

function snapshotOf(input: {
  readonly caps: BudgetCaps;
  readonly reserved: number;
  readonly consumed: number;
  readonly methodImprovementReserved: number;
  readonly methodImprovementConsumed: number;
  readonly open: readonly BudgetReservation[];
}): BudgetSnapshot {
  const remaining = roundMoney(input.caps.total - input.reserved - input.consumed);
  const miRemaining = methodRemaining(
    input.caps,
    input.methodImprovementReserved,
    input.methodImprovementConsumed,
  );
  return deepFreeze({
    caps: input.caps,
    reserved: roundMoney(input.reserved),
    consumed: roundMoney(input.consumed),
    remaining,
    methodImprovementReserved: roundMoney(input.methodImprovementReserved),
    methodImprovementConsumed: roundMoney(input.methodImprovementConsumed),
    ...(miRemaining === undefined ? {} : { methodImprovementRemaining: miRemaining }),
    openReservations: Object.freeze([...input.open]),
  });
}

/**
 * Whether continue / writeback may proceed. An open reservation for that
 * action is required. Elite / score are ignored.
 */
export function evaluateBudgetAuthorization(input: BudgetAuthorizationInput): BudgetDecision {
  const { action, snapshot } = input;
  const open = snapshot.openReservations.find((entry) => entry.action === action && entry.status === "open");
  if (!open) {
    return refuse({
      reason: "unreserved",
      action,
      snapshot,
      objections: [`unreserved: no reserve for ${action}; refuse ${action}`],
    });
  }
  if (snapshot.remaining < 0 || snapshot.consumed > snapshot.caps.total) {
    return refuse({
      reason: "over_budget",
      action,
      reservation: open,
      snapshot,
      objections: [`over budget: refuse ${action}`],
    });
  }
  if (
    open.kind === "method_improvement"
    && snapshot.methodImprovementRemaining !== undefined
    && snapshot.methodImprovementRemaining < 0
  ) {
    return refuse({
      reason: "over_method_improvement_cap",
      action,
      reservation: open,
      snapshot,
      objections: [`Method Improvement sub-cap exceeded; refuse ${action}`],
    });
  }
  return pass({ action, reservation: open, snapshot });
}

/**
 * In-memory reserve → settle ledger. MissionRecord operational accounting
 * stays in mission/; this is the gate contract.
 */
export class BudgetLedger {
  private reserved = 0;
  private consumed = 0;
  private methodImprovementReserved = 0;
  private methodImprovementConsumed = 0;
  private readonly reservations = new Map<string, BudgetReservation>();

  constructor(private readonly caps: BudgetCaps) {
    if (!isPositiveFinite(caps.total)) {
      throw new Error("Budget Gate total must be a finite positive number");
    }
    if (caps.methodImprovement !== undefined && !isNonNegativeFinite(caps.methodImprovement)) {
      throw new Error("Method Improvement sub-cap must be a finite non-negative number");
    }
    if (caps.units.trim() === "") {
      throw new Error("Budget Gate units must be declared");
    }
  }

  snapshot(): BudgetSnapshot {
    return snapshotOf({
      caps: this.caps,
      reserved: this.reserved,
      consumed: this.consumed,
      methodImprovementReserved: this.methodImprovementReserved,
      methodImprovementConsumed: this.methodImprovementConsumed,
      open: [...this.reservations.values()].filter((entry) => entry.status === "open"),
    });
  }

  reserve(request: BudgetReserveRequest): BudgetDecision {
    const current = this.snapshot();
    if (typeof request.reservationId !== "string" || request.reservationId === "") {
      return refuse({
        reason: "unreserved",
        action: request.action,
        snapshot: current,
        objections: ["unreserved: reservation id is required"],
      });
    }
    if (this.reservations.has(request.reservationId)) {
      return refuse({
        reason: "unreserved",
        action: request.action,
        snapshot: current,
        objections: [`unreserved: reservation ${request.reservationId} already exists`],
      });
    }
    if (!isPositiveFinite(request.amount)) {
      return refuse({
        reason: "over_budget",
        action: request.action,
        snapshot: current,
        objections: ["over budget: reserve amount must be a finite positive number"],
      });
    }
    if (request.amount - current.remaining > 1e-12) {
      return refuse({
        reason: "over_budget",
        action: request.action,
        snapshot: current,
        objections: [
          `over budget: ${request.amount} ${this.caps.units} requested, ${current.remaining} remaining; refuse ${request.action}`,
        ],
      });
    }
    if (
      request.kind === "method_improvement"
      && current.methodImprovementRemaining !== undefined
      && request.amount - current.methodImprovementRemaining > 1e-12
    ) {
      return refuse({
        reason: "over_method_improvement_cap",
        action: request.action,
        snapshot: current,
        objections: [
          `Method Improvement sub-cap exceeded: ${request.amount} requested, ${current.methodImprovementRemaining} remaining; refuse ${request.action}`,
        ],
      });
    }

    const reservation: BudgetReservation = deepFreeze({
      reservationId: request.reservationId,
      amount: request.amount,
      kind: request.kind,
      action: request.action,
      status: "open",
    });
    this.reservations.set(request.reservationId, reservation);
    this.reserved = roundMoney(this.reserved + request.amount);
    if (request.kind === "method_improvement") {
      this.methodImprovementReserved = roundMoney(this.methodImprovementReserved + request.amount);
    }
    return pass({ action: request.action, reservation, snapshot: this.snapshot() });
  }

  settle(reservationId: string, actual: number): BudgetDecision {
    const current = this.snapshot();
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== "open") {
      return refuse({
        reason: "unreserved",
        snapshot: current,
        objections: ["unreserved: settle without reserve fails"],
      });
    }
    if (!isNonNegativeFinite(actual)) {
      return refuse({
        reason: "over_budget",
        action: reservation.action,
        reservation,
        snapshot: current,
        objections: ["over budget: settle amount must be a finite non-negative number"],
      });
    }
    if (actual - reservation.amount > 1e-12) {
      return refuse({
        reason: "over_budget",
        action: reservation.action,
        reservation,
        snapshot: current,
        objections: [
          `over budget: settle ${actual} exceeds reserve ${reservation.amount}; refuse ${reservation.action}`,
        ],
      });
    }
    const nextConsumed = roundMoney(this.consumed + actual);
    if (nextConsumed - this.caps.total > 1e-12) {
      return refuse({
        reason: "over_budget",
        action: reservation.action,
        reservation,
        snapshot: current,
        objections: [`over budget: settle ${actual} would exceed total ${this.caps.total}`],
      });
    }
    if (reservation.kind === "method_improvement" && this.caps.methodImprovement !== undefined) {
      const nextMi = roundMoney(this.methodImprovementConsumed + actual);
      if (nextMi - this.caps.methodImprovement > 1e-12) {
        return refuse({
          reason: "over_method_improvement_cap",
          action: reservation.action,
          reservation,
          snapshot: current,
          objections: ["Method Improvement sub-cap exceeded on settle"],
        });
      }
    }

    this.reserved = roundMoney(this.reserved - reservation.amount);
    this.consumed = nextConsumed;
    if (reservation.kind === "method_improvement") {
      this.methodImprovementReserved = roundMoney(this.methodImprovementReserved - reservation.amount);
      this.methodImprovementConsumed = roundMoney(this.methodImprovementConsumed + actual);
    }
    const settled: BudgetReservation = deepFreeze({ ...reservation, status: "settled" });
    this.reservations.set(reservationId, settled);
    return pass({ action: reservation.action, reservation: settled, snapshot: this.snapshot() });
  }

  authorize(action: BudgetAction): BudgetDecision {
    return evaluateBudgetAuthorization({ action, snapshot: this.snapshot() });
  }
}
