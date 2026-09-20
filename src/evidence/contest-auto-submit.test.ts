/**
 * ET-SUBMIT-AUTO / #179 — contest-arm auto-submit after all gates green.
 *
 * Seams: attemptContestAutoSubmit / evaluateContestAutoSubmitGates /
 * createBrokerContestSubmitSeam / evaluateMethodAdmission /
 * evaluateBudgetGate / runKillTestHang / auditMethodology / oofEnsembleGate.
 *
 * Fail-closed: any red / yellow / missing gate must not call submit.
 * Every attempt writes the auto-submit ledger. Admission / Budget / hang /
 * T48 predicates are reused, not loosened. `#40` stays opt-in / default
 * fixed_uct. Elite ≠ 晋级.
 */
import { describe, expect, test } from "bun:test";
import { EvidenceMemory } from "../research-loop";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search-selection-port";
import { BudgetLedger } from "./budget-gate";
import {
  InMemoryContestAutoSubmitLedger,
  attemptContestAutoSubmit,
  createBrokerContestSubmitSeam,
  evaluateContestAutoSubmitGates,
  type ContestAutoSubmitInput,
  type ContestSubmitSeam,
} from "./contest-auto-submit";
import { evaluateExperimentValidity } from "./experiment-validity";
import { HypothesisLedger, T48MappedCatalog, type KillTestOutcome } from "./hypothesis-ledger";
import { type KillTestHangInput } from "./kill-test-hang";
import { type MethodAdmissionInput } from "./method-admission";
import {
  InMemorySubmissionLedger,
  SubmissionBroker,
  type SubmissionChampion,
  type SubmissionCredential,
  type SubmissionDestination,
} from "./submission-broker";

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
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

function admissionPass(): MethodAdmissionInput {
  return {
    validity: validityPass(),
    slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
  };
}

function budgetPassInput() {
  const ledger = new BudgetLedger({ total: 1, units: "model-USD" });
  ledger.reserve({
    reservationId: "contest-auto-submit",
    amount: 0.2,
    kind: "research",
    action: "continue",
  });
  return { action: "continue" as const, snapshot: ledger.snapshot() };
}

function championPass(): SubmissionChampion {
  return {
    missionId: "contest-auto-submit",
    competition: "score-file",
    branchId: "candidate",
    championDigest: "sha256:champion-green",
    artifactDigest: "sha256:champion-green",
    evaluatorSucceeded: true,
    successAuditorPassed: true,
    promotionApproved: true,
  };
}

function ledgerBoundHang(overrides: Partial<KillTestHangInput> & { outcome?: KillTestOutcome } = {}): KillTestHangInput {
  const catalog = overrides.catalog ?? catalogWithMappedIds();
  const ledger = overrides.ledger instanceof HypothesisLedger
    ? overrides.ledger
    : new HypothesisLedger({ catalog });
  const planId = overrides.planId ?? "kt-contest";
  if (ledger.state().hypotheses["h-contest"] === undefined) {
    ledger.createHypothesis({
      hypothesisId: "h-contest",
      statement: "contest-arm champion survives the predeclared kill-test",
      evidenceRefs: ["ev-holdout"],
    });
  }
  if (ledger.state().plans[planId] === undefined) {
    ledger.planKillTest({
      planId,
      hypothesisId: "h-contest",
      predicate: "protected hold-out must not move after removing the shared step",
      evidenceRefs: ["ev-holdout"],
    });
  }
  return {
    outcome: "pass",
    evidenceRefs: ["ev-kill"],
    ...overrides,
    catalog,
    ledger,
    planId,
  };
}

function greenInput(overrides: Partial<ContestAutoSubmitInput> = {}): ContestAutoSubmitInput {
  return {
    champion: championPass(),
    hang: ledgerBoundHang(),
    admission: admissionPass(),
    budget: budgetPassInput(),
    ...overrides,
  };
}

function recordingSubmit(calls: unknown[]): ContestSubmitSeam {
  return (input) => {
    calls.push(input);
    return { status: input.live === true ? "SUCCEEDED" : "DRY_RUN", submissionId: "auto-1" };
  };
}

describe("contest-arm auto-submit — all-green path", () => {
  test("all promotion/evidence gates green calls the submit seam (contest arm)", async () => {
    const calls: unknown[] = [];
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await attemptContestAutoSubmit({
      ...greenInput(),
      live: false,
      submit: recordingSubmit(calls),
      ledger,
    });

    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    expect(result.outcome).toBe("submitted");
    expect(result.reason).toBe("gates-green");
    expect(result.gates.every((gate) => gate.color === "green")).toBe(true);
    expect(result.refusedGates).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ live: false });
    expect(result.gates.find((gate) => gate.id === "hang")?.color).toBe("green");
  });

  test("all-green hang writes KillTestResult through the HypothesisLedger", async () => {
    const hang = ledgerBoundHang({ resultId: "ktr-contest-green" });
    const result = await attemptContestAutoSubmit({
      ...greenInput({ hang }),
      submit: recordingSubmit([]),
    });
    expect(result.submitted).toBe(true);
    expect(hang.ledger?.resultFor("kt-contest")).toEqual({
      resultId: "ktr-contest-green",
      planId: "kt-contest",
      hypothesisId: "h-contest",
      outcome: "pass",
      evidenceRefs: [{ kind: "evidence", id: "ev-kill" }],
    });
    expect(hang.ledger?.state().hypotheses["h-contest"]?.status).toBe("open");
  });

  test("live all-green path uses the existing broker destination (mockable; still ledgers)", async () => {
    const destinationCalls: unknown[] = [];
    const destination: SubmissionDestination = {
      submit(input) {
        destinationCalls.push(input);
        return { submissionId: "external-auto-1", accepted: true };
      },
    };
    const credential: SubmissionCredential = {
      id: "credential-1",
      scopes: ["submit:score-file"],
      expiresAt: 100,
    };
    const champion = championPass();
    const brokerLedger = new InMemorySubmissionLedger();
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination,
      clock: () => 1,
      ledger: brokerLedger,
      champion,
    });
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await attemptContestAutoSubmit({
      ...greenInput({ champion }),
      live: true,
      submit: createBrokerContestSubmitSeam(broker, {
        missionId: champion.missionId,
        competition: "score-file",
        target: "fake://score-file",
        champion,
        artifactDigest: champion.artifactDigest,
        credential,
        requestId: "contest-auto-live",
      }),
      ledger,
    });

    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    expect(destinationCalls).toHaveLength(1);
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_SUBMITTED",
    ]);
    expect(broker.events().some((event) => event.type === "SUBMISSION_RESULT")).toBe(true);
  });
});

describe("contest-arm auto-submit — fail-closed when any gate is not green", () => {
  test("claiming hang pass without a ledger KillTestPlan must not submit", async () => {
    const calls: unknown[] = [];
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        hang: {
          outcome: "pass",
          evidenceRefs: ["ev-kill"],
          catalog: catalogWithMappedIds(),
        },
      }),
      submit: recordingSubmit(calls),
      ledger,
    });

    expect(result.ok).toBe(false);
    expect(result.submitted).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("gates-not-green");
    expect(result.gates.find((gate) => gate.id === "hang")?.color).toBe("missing");
    expect(result.gates.find((gate) => gate.id === "hang")?.objections.join(" ")).toMatch(/ledger KillTestPlan/i);
    expect(calls).toHaveLength(0);
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_REFUSED",
    ]);
  });

  test("inconclusive hang is yellow and must not submit", async () => {
    const calls: unknown[] = [];
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        hang: ledgerBoundHang({ outcome: "inconclusive" }),
      }),
      submit: recordingSubmit(calls),
      ledger,
    });

    expect(result.ok).toBe(false);
    expect(result.submitted).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("gates-not-green");
    expect(result.gates.find((gate) => gate.id === "hang")?.color).toBe("yellow");
    expect(calls).toHaveLength(0);
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_REFUSED",
    ]);
    expect(ledger.events().at(-1)?.payload).toMatchObject({
      outcome: "refused",
      reason: "gates-not-green",
    });
  });

  test("failed hang is red and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        hang: ledgerBoundHang({ outcome: "fail" }),
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "hang")?.color).toBe("red");
    expect(calls).toHaveLength(0);
  });

  test("missing hang is missing and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({ hang: undefined }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "hang")?.color).toBe("missing");
    expect(calls).toHaveLength(0);
  });

  test("missing protected holdout still refuses Admission and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        admission: {
          validity: evaluateExperimentValidity({
            claimed: "effective",
            slices: [
              { kind: "official_samples", present: true, outcome: "pass" },
              { kind: "adversarial_labeled", present: true, outcome: "pass" },
            ],
          }),
          slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
        },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "admission")?.color).toBe("red");
    expect(result.gates.find((gate) => gate.id === "admission")?.objections.join(" ")).toMatch(/protected holdout/i);
    expect(calls).toHaveLength(0);
  });

  test("Admission hang is yellow and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        admission: {
          validity: evaluateExperimentValidity({
            hang: true,
            slices: [
              { kind: "official_samples", present: true, outcome: "pass" },
              { kind: "adversarial_labeled", present: true, outcome: "pass" },
              { kind: "protected_holdout", present: true, outcome: "pass" },
            ],
          }),
          slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
        },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "admission")?.color).toBe("yellow");
    expect(calls).toHaveLength(0);
  });

  test("missing Admission input is missing and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({ admission: undefined }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "admission")?.color).toBe("missing");
    expect(calls).toHaveLength(0);
  });

  test("unreserved Budget still refuses and must not submit", async () => {
    const calls: unknown[] = [];
    const ledger = new BudgetLedger({ total: 1, units: "model-USD" });
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        budget: { action: "continue", snapshot: ledger.snapshot() },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "budget")?.color).toBe("red");
    expect(result.gates.find((gate) => gate.id === "budget")?.objections.join(" ")).toMatch(/unreserved/i);
    expect(calls).toHaveLength(0);
  });

  test("missing Budget input is missing and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({ budget: undefined }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "budget")?.color).toBe("missing");
    expect(calls).toHaveLength(0);
  });

  test("T48 disagree is red and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        t48: {
          evidence: { splitDigestAgreement: "disagree", oofPresent: false },
          contracts: {
            splitContract: { splitRef: { digest: "sha256:expected-split" } },
            oofEnsemble: { required: true },
          },
        },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "t48")?.color).toBe("red");
    expect(result.gates.find((gate) => gate.id === "t48")?.objections.join(" ")).toMatch(/split|OOF|leak/i);
    expect(calls).toHaveLength(0);
  });

  test("T48 missing used-split digest is red and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        t48: {
          evidence: { splitDigestAgreement: "unknown", oofPresent: true },
          contracts: {
            splitContract: { splitRef: { digest: "sha256:expected-split" } },
          },
        },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "t48")?.color).toBe("red");
    expect(result.gates.find((gate) => gate.id === "t48")?.objections.join(" ")).toMatch(/missing|used-split/i);
    expect(calls).toHaveLength(0);
  });

  test("T48 still sleeps (green) when no contract is injected — existing predicate", () => {
    const decision = evaluateContestAutoSubmitGates(greenInput());
    expect(decision.gates.find((gate) => gate.id === "t48")?.color).toBe("green");
    expect(decision.ok).toBe(true);
  });

  test("champion that is not locally promoted is red and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        champion: {
          ...championPass(),
          promotionApproved: false,
          promoted: false,
          status: "EVALUATED",
        },
      }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "promotion")?.color).toBe("red");
    expect(calls).toHaveLength(0);
  });

  test("missing champion is missing and must not submit", async () => {
    const calls: unknown[] = [];
    const result = await attemptContestAutoSubmit({
      ...greenInput({ champion: undefined }),
      submit: recordingSubmit(calls),
    });
    expect(result.submitted).toBe(false);
    expect(result.gates.find((gate) => gate.id === "promotion")?.color).toBe("missing");
    expect(calls).toHaveLength(0);
  });

  test("live broker seam is not reached when a gate is yellow", async () => {
    const destinationCalls: unknown[] = [];
    const champion = championPass();
    const broker = new SubmissionBroker({
      allowedCompetitions: ["score-file"],
      allowedTargets: ["fake://score-file"],
      allowedCredentialScopes: ["submit:score-file"],
      destination: {
        submit(input) {
          destinationCalls.push(input);
          return { submissionId: "should-not-fire" };
        },
      },
      clock: () => 1,
      champion,
    });
    const result = await attemptContestAutoSubmit({
      ...greenInput({
        champion,
        hang: ledgerBoundHang({ outcome: "inconclusive" }),
      }),
      live: true,
      submit: createBrokerContestSubmitSeam(broker, {
        missionId: champion.missionId,
        competition: "score-file",
        target: "fake://score-file",
        champion,
        artifactDigest: champion.artifactDigest,
        credential: { id: "credential-1", scopes: ["submit:score-file"], expiresAt: 100 },
      }),
    });
    expect(result.submitted).toBe(false);
    expect(destinationCalls).toHaveLength(0);
  });

  test("unmapped Artifact or scalar-only diagnosis hard-rejects hang and must not submit", async () => {
    const calls: unknown[] = [];
    const unmapped = await attemptContestAutoSubmit({
      ...greenInput({
        hang: ledgerBoundHang({ artifacts: [{ artifactId: "unmapped-art" }] }),
      }),
      submit: recordingSubmit(calls),
    });
    expect(unmapped.submitted).toBe(false);
    expect(unmapped.gates.find((gate) => gate.id === "hang")?.color).toBe("red");
    expect(unmapped.gates.find((gate) => gate.id === "hang")?.objections.join(" ")).toMatch(/T48|artifact/i);

    const scalar = await attemptContestAutoSubmit({
      ...greenInput({
        hang: ledgerBoundHang({
          catalog: catalogWithMappedIds(),
          evidenceRefs: [{ mmd: 0.12 }],
          planId: "kt-scalar",
        }),
      }),
      submit: recordingSubmit(calls),
    });
    expect(scalar.submitted).toBe(false);
    expect(scalar.gates.find((gate) => gate.id === "hang")?.color).toBe("red");
    expect(scalar.gates.find((gate) => gate.id === "hang")?.objections.join(" ")).toMatch(/side-slot|MMD|near-dup|diversity|scalar/i);
    expect(calls).toHaveLength(0);
  });
});

describe("contest-arm auto-submit — ledger on success and refusal", () => {
  test("successful attempt writes attempted + submitted", async () => {
    const ledger = new InMemoryContestAutoSubmitLedger();
    await attemptContestAutoSubmit({
      ...greenInput(),
      submit: recordingSubmit([]),
      ledger,
    });
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_SUBMITTED",
    ]);
    expect(ledger.events()[0]?.payload).toMatchObject({ reason: "gates-green" });
    expect(ledger.events()[1]?.payload).toMatchObject({ outcome: "submitted", status: "DRY_RUN" });
  });

  test("missing submit seam on an all-green live path fails closed and still ledgers", async () => {
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await attemptContestAutoSubmit({
      ...greenInput(),
      live: true,
      ledger,
    });
    expect(result.ok).toBe(false);
    expect(result.submitted).toBe(false);
    expect(result.reason).toBe("submit-unavailable");
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_REFUSED",
    ]);
  });
});

describe("contest-arm auto-submit — predicates and #40 stay locked", () => {
  test("Elite is not an Admission or Budget key and cannot auto-submit", async () => {
    const calls: unknown[] = [];
    const budget = new BudgetLedger({ total: 1, units: "model-USD" });
    const refused = await attemptContestAutoSubmit({
      ...greenInput({
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
          teamFanOut: true,
        },
        budget: { action: "continue", snapshot: budget.snapshot(), elite: true, score: 0.99 },
      }),
      submit: recordingSubmit(calls),
    });
    expect(refused.submitted).toBe(false);
    expect(refused.gates.find((gate) => gate.id === "admission")?.color).toBe("red");
    expect(refused.gates.find((gate) => gate.id === "budget")?.color).toBe("red");
    expect(calls).toHaveLength(0);
  });

  test("product default stays fixed_uct / #40 Progressive OFF", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });
});
