/**
 * ET-M1-BUD / #144 — Budget Gate reserve → settle skeleton.
 *
 * Seams: BudgetLedger.reserve / settle / authorize,
 * evaluateBudgetAuthorization.
 * Over-budget or unreserved refuses continue / writeback.
 * Budget pass is not Admission pass.
 */
import { describe, expect, test } from "bun:test";
import { evaluateExperimentValidity } from "./experiment-validity";
import {
  MethodWritebackSession,
  evaluateMethodAdmission,
} from "./method-admission";
import {
  BudgetLedger,
  evaluateBudgetAuthorization,
} from "./budget-gate";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search-selection-port";

function caps(total = 1, methodImprovement?: number) {
  return {
    total,
    units: "model-USD",
    ...(methodImprovement === undefined ? {} : { methodImprovement }),
  };
}

function validityPass() {
  return evaluateExperimentValidity({
    slices: [
      { kind: "official_samples", present: true, outcome: "pass" },
      { kind: "adversarial_labeled", present: true, outcome: "pass" },
      { kind: "protected_holdout", present: true, outcome: "pass" },
    ],
  });
}

function admissionPass() {
  return evaluateMethodAdmission({
    validity: validityPass(),
    slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
  });
}

describe("Budget Gate — reserve then settle", () => {
  test("settle without reserve fails", () => {
    const ledger = new BudgetLedger(caps(1));
    const settled = ledger.settle("never-reserved", 0.1);
    expect(settled.ok).toBe(false);
    expect(settled.outcome).toBe("refuse");
    expect(settled.reason).toBe("unreserved");
    expect(settled.objections.join(" ")).toMatch(/unreserved|no reserve/i);
    expect(ledger.snapshot().consumed).toBe(0);
  });

  test("reserve then settle within cap consumes the actual amount", () => {
    const ledger = new BudgetLedger(caps(1));
    const reserved = ledger.reserve({
      reservationId: "exp-1",
      amount: 0.4,
      kind: "research",
      action: "continue",
    });
    expect(reserved.ok).toBe(true);
    expect(reserved.outcome).toBe("pass");
    expect(reserved.reservation?.status).toBe("open");
    expect(ledger.snapshot().reserved).toBe(0.4);
    expect(ledger.snapshot().remaining).toBe(0.6);

    const settled = ledger.settle("exp-1", 0.25);
    expect(settled.ok).toBe(true);
    expect(settled.outcome).toBe("pass");
    expect(settled.reservation?.status).toBe("settled");
    expect(ledger.snapshot().consumed).toBe(0.25);
    expect(ledger.snapshot().reserved).toBe(0);
    expect(ledger.snapshot().remaining).toBe(0.75);
  });
});

describe("Budget Gate — over-cap or unreserved refuses continue / writeback", () => {
  test("over-cap reserve refuses and does not hold units", () => {
    const ledger = new BudgetLedger(caps(0.2));
    const reserved = ledger.reserve({
      reservationId: "too-big",
      amount: 0.5,
      kind: "research",
      action: "continue",
    });
    expect(reserved.ok).toBe(false);
    expect(reserved.outcome).toBe("refuse");
    expect(reserved.reason).toBe("over_budget");
    expect(reserved.objections.join(" ")).toMatch(/over.?budget|exceed/i);
    expect(ledger.snapshot().reserved).toBe(0);
    expect(evaluateBudgetAuthorization({ action: "continue", snapshot: ledger.snapshot() }).reason).toBe("unreserved");
  });

  test("settle above the reservation refuses and does not consume", () => {
    const ledger = new BudgetLedger(caps(1));
    ledger.reserve({
      reservationId: "exp-1",
      amount: 0.2,
      kind: "research",
      action: "continue",
    });
    const settled = ledger.settle("exp-1", 0.9);
    expect(settled.ok).toBe(false);
    expect(settled.reason).toBe("over_budget");
    expect(ledger.snapshot().consumed).toBe(0);
    expect(ledger.snapshot().reserved).toBe(0.2);
  });

  test("continue without a reserve is refused", () => {
    const ledger = new BudgetLedger(caps(1));
    const decision = ledger.authorize("continue");
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("refuse");
    expect(decision.reason).toBe("unreserved");
    expect(decision.action).toBe("continue");
    expect(decision.objections.join(" ")).toMatch(/unreserved|no reserve/i);
    expect(decision.objections.join(" ")).toMatch(/continue/i);
  });

  test("writeback without a reserve is refused", () => {
    const ledger = new BudgetLedger(caps(1));
    const decision = evaluateBudgetAuthorization({
      action: "writeback",
      snapshot: ledger.snapshot(),
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("unreserved");
    expect(decision.action).toBe("writeback");
    expect(decision.objections.join(" ")).toMatch(/writeback/i);
  });

  test("an open reserve authorizes that action only", () => {
    const ledger = new BudgetLedger(caps(1));
    ledger.reserve({
      reservationId: "cont-1",
      amount: 0.1,
      kind: "research",
      action: "continue",
    });
    const cont = ledger.authorize("continue");
    expect(cont.ok).toBe(true);
    expect(cont.outcome).toBe("pass");
    expect(cont.action).toBe("continue");
    expect(ledger.authorize("writeback").ok).toBe(false);
    expect(ledger.authorize("writeback").reason).toBe("unreserved");
  });

  test("Elite or score cannot substitute for a reserve", () => {
    const decision = evaluateBudgetAuthorization({
      action: "continue",
      snapshot: new BudgetLedger(caps(10)).snapshot(),
      elite: true,
      score: 99,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("unreserved");
    expect(decision.objections.join(" ")).not.toMatch(/elite|score/i);
  });
});

describe("Budget Gate — thin Method Improvement sub-cap", () => {
  test("Method Improvement spend can be capped separately from the Mission total", () => {
    const ledger = new BudgetLedger(caps(5, 0.3));
    const overSub = ledger.reserve({
      reservationId: "mi-over",
      amount: 0.8,
      kind: "method_improvement",
      action: "writeback",
    });
    expect(overSub.ok).toBe(false);
    expect(overSub.reason).toBe("over_method_improvement_cap");
    expect(overSub.objections.join(" ")).toMatch(/method improvement/i);
    expect(ledger.snapshot().reserved).toBe(0);

    const research = ledger.reserve({
      reservationId: "research-ok",
      amount: 0.8,
      kind: "research",
      action: "continue",
    });
    expect(research.ok).toBe(true);

    const mi = ledger.reserve({
      reservationId: "mi-ok",
      amount: 0.2,
      kind: "method_improvement",
      action: "writeback",
    });
    expect(mi.ok).toBe(true);
    expect(ledger.snapshot().methodImprovementReserved).toBe(0.2);
    expect(ledger.authorize("writeback").ok).toBe(true);
  });

  test("without a Method Improvement sub-cap, that kind still counts against the total only", () => {
    const ledger = new BudgetLedger(caps(1));
    const reserved = ledger.reserve({
      reservationId: "mi-total",
      amount: 0.4,
      kind: "method_improvement",
      action: "writeback",
    });
    expect(reserved.ok).toBe(true);
    expect(ledger.snapshot().methodImprovementRemaining).toBeUndefined();
  });
});

describe("Budget Gate is orthogonal to Admission", () => {
  test("budget pass is not Admission pass", () => {
    const ledger = new BudgetLedger(caps(1));
    ledger.reserve({
      reservationId: "wb-1",
      amount: 0.1,
      kind: "method_improvement",
      action: "writeback",
    });
    const budget = ledger.authorize("writeback");
    expect(budget.ok).toBe(true);

    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [
          { kind: "official_samples", present: true, outcome: "pass" },
          { kind: "adversarial_labeled", present: true, outcome: "pass" },
        ],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
    });
    expect(admission.admitted).toBe(false);
    expect(admission.objections.join(" ")).toMatch(/protected holdout/i);

    const session = new MethodWritebackSession();
    session.propose({ sliceId: "skill:try", kind: "skill", targetName: "try" });
    session.regress("pass");
    const refused = session.admit(admission, budget);
    expect(refused.admitted).toBe(false);
    expect(refused.phase).toBe("rolled_back");
    expect(refused.objections.join(" ")).toMatch(/protected holdout/i);
  });

  test("Admission pass still refuses writeback when budget is unreserved or over cap", () => {
    const admission = admissionPass();
    expect(admission.admitted).toBe(true);

    const unreserved = evaluateBudgetAuthorization({
      action: "writeback",
      snapshot: new BudgetLedger(caps(1)).snapshot(),
    });
    const session = new MethodWritebackSession();
    session.propose({ sliceId: "skill:keep", kind: "skill", targetName: "keep" });
    session.regress("pass");
    const refused = session.admit(admission, unreserved);
    expect(refused.admitted).toBe(false);
    expect(refused.phase).toBe("rolled_back");
    expect(refused.objections.join(" ")).toMatch(/unreserved|no reserve/i);

    const over = new BudgetLedger(caps(0.1));
    const overReserve = over.reserve({
      reservationId: "wb-over",
      amount: 5,
      kind: "method_improvement",
      action: "writeback",
    });
    expect(overReserve.ok).toBe(false);
    const again = new MethodWritebackSession();
    again.propose({ sliceId: "skill:keep", kind: "skill", targetName: "keep" });
    again.regress("pass");
    const overRefused = again.admit(admission, overReserve);
    expect(overRefused.admitted).toBe(false);
    expect(overRefused.phase).toBe("rolled_back");
    expect(overRefused.objections.join(" ")).toMatch(/over.?budget|exceed/i);
  });
});

describe("BUD gate does not thaw frozen pins", () => {
  test("default search stays fixed_uct and #40 stays off", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });
});
