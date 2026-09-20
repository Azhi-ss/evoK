/**
 * ET-PROMO-HARD / #180 — named ACs for landable before-promotion /
 * kill-hang / ledger Specs (#50–52, #68–70, and the #185 contest seam).
 *
 * Seams: assembleOuterE2eMinPath (E1+E3+E2) → runKillTestHang /
 * createKillTestHangHook → attemptContestAutoSubmit.
 * Tighten-only: Broker / before-promotion consumers require a ledger
 * KillTestPlan. Isolated hang predicates stay available for T48 / scalar
 * filter checks. Admission / Budget / hang / T48 predicates are not loosened.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search-selection-port";
import {
  OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
  OUTER_MIN_KILL_EVIDENCE_ID,
} from "../mission/outer-min-path";
import { assembleOuterE2eMinPath } from "../mission/outer-e2e-min-path";
import { BudgetLedger } from "./budget-gate";
import {
  InMemoryContestAutoSubmitLedger,
  attemptContestAutoSubmit,
  evaluateContestAutoSubmitGates,
  type ContestSubmitSeam,
} from "./contest-auto-submit";
import { evaluateExperimentValidity } from "./experiment-validity";
import {
  asKillTestPass,
  killTestOutcomeIsPass,
  type KillTestOutcome,
} from "./hypothesis-ledger";
import {
  killTestHangHasLedgerPlan,
  killTestOutcomeBlocksBroker,
  runKillTestHang,
  type KillTestHangInput,
} from "./kill-test-hang";
import { auditMethodology, oofEnsembleGate } from "./methodology";
import { verificationRoleContract } from "./verification-gates";

function admissionPass() {
  return {
    validity: evaluateExperimentValidity({
      slices: [
        { kind: "official_samples" as const, present: true, outcome: "pass" as const },
        { kind: "adversarial_labeled" as const, present: true, outcome: "pass" as const },
        { kind: "protected_holdout" as const, present: true, outcome: "pass" as const },
      ],
    }),
    slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
  };
}

function budgetPassInput() {
  const ledger = new BudgetLedger({ total: 1, units: "model-USD" });
  ledger.reserve({
    reservationId: "et-promo-hard",
    amount: 0.2,
    kind: "research",
    action: "continue",
  });
  return { action: "continue" as const, snapshot: ledger.snapshot() };
}

function championPass() {
  return {
    missionId: "et-promo-hard",
    competition: "score-file",
    branchId: "candidate",
    championDigest: "sha256:promo-hard",
    artifactDigest: "sha256:promo-hard",
    evaluatorSucceeded: true,
    successAuditorPassed: true,
    promotionApproved: true,
  };
}

function hangFromOuter(outcome: KillTestOutcome = "pass", extra: Partial<KillTestHangInput> = {}): KillTestHangInput {
  const path = assembleOuterE2eMinPath({
    outcome,
    ...(extra.artifacts === undefined ? {} : { artifacts: extra.artifacts }),
    ...(extra.evidenceRefs === undefined ? {} : { killEvidenceRefs: extra.evidenceRefs }),
  });
  return {
    outcome,
    evidenceRefs: extra.evidenceRefs ?? [OUTER_MIN_KILL_EVIDENCE_ID],
    catalog: path.setup.fixture.catalog,
    ledger: path.setup.ledger,
    planId: path.setup.planId,
    ...(extra.resultId === undefined ? {} : { resultId: extra.resultId }),
    ...(extra.artifacts === undefined ? {} : { artifacts: extra.artifacts }),
    ...(extra.contracts === undefined ? {} : { contracts: extra.contracts }),
    ...(extra.methodologyEvidence === undefined ? {} : { methodologyEvidence: extra.methodologyEvidence }),
  };
}

function recordingSubmit(calls: unknown[]): ContestSubmitSeam {
  return (input) => {
    calls.push(input);
    return { status: "DRY_RUN", submissionId: "promo-hard-1" };
  };
}

describe("ET-PROMO-HARD — landed Spec stack", () => {
  test("#50/#52 field names stay H1/H2 camelCase and expand_requested writes no search nodes", () => {
    const path = assembleOuterE2eMinPath();
    const decided = runKillTestHang({
      outcome: "fail",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: path.setup.fixture.catalog,
      ledger: path.setup.ledger,
      planId: path.setup.planId,
      resultId: "ktr-field",
    });
    expect(decided.ok).toBe(false);
    expect(decided.plan?.planId).toBe(path.setup.planId);
    expect(decided.plan?.hypothesisId).toBe("h-outer-min");
    expect(decided.plan?.predicate).toMatch(/hold-out|kill/i);
    expect(Object.keys(decided.plan ?? {})).toEqual(["planId", "hypothesisId", "predicate", "evidenceRefs"]);
    const recorded = path.setup.ledger.resultFor(path.setup.planId);
    expect(recorded).toEqual({
      resultId: "ktr-field",
      planId: path.setup.planId,
      hypothesisId: "h-outer-min",
      outcome: "fail",
      evidenceRefs: [{ kind: "evidence", id: OUTER_MIN_KILL_EVIDENCE_ID }],
    });
    expect(Object.keys(recorded ?? {})).toEqual(["resultId", "planId", "hypothesisId", "outcome", "evidenceRefs"]);
    expect(path.setup.ledger.state().hypotheses["h-outer-min"]?.status).toBe("killed");
    expect(path.setup.ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
      "hypothesis.status_changed",
    ]);
    const expandable = assembleOuterE2eMinPath();
    expandable.setup.requestExpand();
    expect(expandable.setup.ledger.events().at(-1)?.type).toBe("hypothesis.expand_requested");
    expect(expandable.setup.ledger.searchNodes()).toEqual([]);
  });

  test("#52/#70 hang stays before-promotion after T48 and before Broker; inconclusive ≠ pass", () => {
    expect(verificationRoleContract("KillTester")).toMatchObject({
      trigger: "before-promotion",
      input: "success-claim",
      authoritative: false,
    });
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);

    const pass = runKillTestHang(hangFromOuter("pass"));
    const fail = runKillTestHang(hangFromOuter("fail"));
    const inconclusive = runKillTestHang(hangFromOuter("inconclusive"));
    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(inconclusive.ok).toBe(false);
    expect(killTestOutcomeIsPass(inconclusive.outcome)).toBe(false);
    expect(killTestOutcomeBlocksBroker("inconclusive")).toBe(true);
    expect(() => asKillTestPass("inconclusive")).toThrow(/inconclusive|not pass/i);
  });

  test("#68/#69/#70 E1+E3 mapped refs feed a ledger-bound hang into contest-auto-submit", async () => {
    const path = assembleOuterE2eMinPath({ outcome: "pass", resultId: "ktr-e2-broker" });
    expect(path.setup.hypothesisId).toBe("h-outer-min");
    expect(path.setup.planId).toBe("kt-outer-min");
    expect(path.setup.evidenceRefs).toEqual(expect.arrayContaining([
      { kind: "evidence", id: OUTER_MIN_HOLD_OUT_EVIDENCE_ID },
      path.searchSpace.mappedNearDup,
      path.searchSpace.mappedDiversity,
    ]));
    expect(killTestHangHasLedgerPlan({ ledger: path.setup.ledger, planId: path.setup.planId })).toBe(true);

    const calls: unknown[] = [];
    const ledger = new InMemoryContestAutoSubmitLedger();
    const hang: KillTestHangInput = {
      outcome: "pass",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: path.setup.fixture.catalog,
      ledger: path.setup.ledger,
      planId: path.setup.planId,
      resultId: "ktr-e2-broker",
    };
    const result = await attemptContestAutoSubmit({
      champion: championPass(),
      hang,
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
      ledger,
    });

    expect(result.submitted).toBe(true);
    expect(result.gates.every((gate) => gate.color === "green")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(path.setup.ledger.resultFor(path.setup.planId)?.outcome).toBe("pass");
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_SUBMITTED",
    ]);
  });

  test("fail / inconclusive / plan-less / unmapped / scalar hang cannot reach the Broker seam", async () => {
    const calls: unknown[] = [];
    const fail = await attemptContestAutoSubmit({
      champion: championPass(),
      hang: hangFromOuter("fail"),
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
    });
    expect(fail.submitted).toBe(false);
    expect(fail.gates.find((gate) => gate.id === "hang")?.color).toBe("red");

    const inconclusive = await attemptContestAutoSubmit({
      champion: championPass(),
      hang: hangFromOuter("inconclusive"),
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
    });
    expect(inconclusive.submitted).toBe(false);
    expect(inconclusive.gates.find((gate) => gate.id === "hang")?.color).toBe("yellow");

    const planless = assembleOuterE2eMinPath();
    const missingPlan = await attemptContestAutoSubmit({
      champion: championPass(),
      hang: {
        outcome: "pass",
        evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
        catalog: planless.setup.fixture.catalog,
      },
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
    });
    expect(missingPlan.submitted).toBe(false);
    expect(missingPlan.gates.find((gate) => gate.id === "hang")?.color).toBe("missing");

    const unmapped = await attemptContestAutoSubmit({
      champion: championPass(),
      hang: hangFromOuter("pass", { artifacts: [{ artifactId: "unmapped-art" }] }),
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
    });
    expect(unmapped.submitted).toBe(false);
    expect(unmapped.gates.find((gate) => gate.id === "hang")?.objections.join(" ")).toMatch(/T48|artifact/i);

    const scalar = await attemptContestAutoSubmit({
      champion: championPass(),
      hang: hangFromOuter("pass", { evidenceRefs: [{ mmd: 0.12 }] }),
      admission: admissionPass(),
      budget: budgetPassInput(),
      submit: recordingSubmit(calls),
    });
    expect(scalar.submitted).toBe(false);
    expect(scalar.gates.find((gate) => gate.id === "hang")?.objections.join(" ")).toMatch(/side-slot|MMD|near-dup|diversity|scalar/i);
    expect(calls).toHaveLength(0);
  });

  test("does not loosen Admission / Budget / T48 / #40; Elite is not a promotion key", () => {
    const path = assembleOuterE2eMinPath();
    const decision = evaluateContestAutoSubmitGates({
      champion: championPass(),
      hang: {
        outcome: "pass",
        evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
        catalog: path.setup.fixture.catalog,
        ledger: path.setup.ledger,
        planId: path.setup.planId,
      },
      admission: {
        validity: evaluateExperimentValidity({
          claimed: "effective",
          slices: [
            { kind: "official_samples", present: true, outcome: "pass" },
            { kind: "adversarial_labeled", present: true, outcome: "pass" },
          ],
        }),
        slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
        elite: true,
        score: 0.99,
      },
      budget: { action: "continue", snapshot: new BudgetLedger({ total: 1, units: "model-USD" }).snapshot(), elite: true },
      t48: {
        evidence: { splitDigestAgreement: "disagree", oofPresent: false },
        contracts: {
          splitContract: { splitRef: { digest: "sha256:expected-split" } },
          oofEnsemble: { required: true },
        },
      },
    });
    expect(decision.ok).toBe(false);
    expect(decision.submitted).toBe(false);
    expect(decision.gates.find((gate) => gate.id === "admission")?.color).toBe("red");
    expect(decision.gates.find((gate) => gate.id === "budget")?.color).toBe("red");
    expect(decision.gates.find((gate) => gate.id === "t48")?.color).toBe("red");
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });
});
