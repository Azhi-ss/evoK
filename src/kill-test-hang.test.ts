import { describe, expect, test } from "bun:test";
import {
  asKillTestPass,
  HypothesisLedger,
  killTestOutcomeIsPass,
  T48MappedCatalog,
  type KillTestOutcome,
} from "./hypothesis-ledger";
import {
  createKillTestHangHook,
  killTestOutcomeBlocksBroker,
  runKillTestHang,
} from "./kill-test-hang";
import {
  auditMethodology,
  oofEnsembleGate,
  readMethodologyManifest,
  resolveMethodologyContracts,
} from "./methodology";
import {
  MethodologyToyCompetitionAdapter,
  fakeInnerCandidate,
} from "./methodology-acceptance";
import { EvidenceMemory } from "./research-loop";
import { ToyCompetitionHarness, type ToyAgentRuntime } from "./toy-harness";
import { verificationRoleContract } from "./verification-gates";
import { RESEARCH_PREDICTION as prediction } from "./fixtures/research";
import contractFixture from "./fixtures/methodology/plugin-task.contract.json";

const contracts = resolveMethodologyContracts(contractFixture)!;

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function passingMethodology() {
  const inner = fakeInnerCandidate({ contracts, variant: "oof", score: "3" });
  return {
    inner,
    evidence: readMethodologyManifest(inner.manifest, contracts),
  };
}

function runtimeFromFiles(files: Record<string, string>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { ...files } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

describe("kill-test hang T48-then-outcome", () => {
  test("runs T48 methodology and OOF first; those gates sleep when no contract is injected", () => {
    const catalog = catalogWithMappedIds();
    const { evidence } = passingMethodology();
    expect(auditMethodology(evidence, contracts).ok).toBe(true);
    expect(oofEnsembleGate(evidence, contracts).ok).toBe(true);

    const accepted = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      contracts,
      methodologyEvidence: evidence,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.blocksPromotion).toBe(false);
    expect(accepted.blocksBroker).toBe(false);

    const slept = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
    });
    expect(slept.ok).toBe(true);

    const t48Blocked = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      contracts,
      methodologyEvidence: { splitDigestAgreement: "disagree", oofPresent: false },
    });
    expect(t48Blocked.ok).toBe(false);
    expect(t48Blocked.blocksPromotion).toBe(true);
    expect(t48Blocked.objections.join(" ")).toMatch(/split|OOF|leak/i);
  });

  test("hard-rejects artifacts without T48 mapping", () => {
    const catalog = catalogWithMappedIds();
    const rejected = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.blocksPromotion).toBe(true);
    expect(rejected.objections.join(" ")).toMatch(/T48|artifact/i);

    const mapped = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      artifacts: [{ artifactId: "art-score" }],
    });
    expect(mapped.ok).toBe(true);
  });

  test("rejects side-slot, MMD, near-dup, or diversity scalars as the sole verdict", () => {
    const catalog = catalogWithMappedIds();
    const scalars: unknown[] = [
      0.91,
      "0.91",
      { mmd: 0.12 },
      { sideSlot: 0.8 },
      { side_slot: 0.4 },
      { nearDup: 0.2 },
      { diversity: 0.3 },
    ];
    for (const key of scalars) {
      const result = runKillTestHang({
        outcome: "pass",
        evidenceRefs: [key],
        catalog,
      });
      expect(result.ok).toBe(false);
      expect(result.objections.join(" ")).toMatch(/side-slot|MMD|near-dup|diversity|scalar/i);
    }

    const mixed = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill", { mmd: 0.12 }],
      catalog,
    });
    expect(mixed.ok).toBe(true);
  });
});

describe("kill-test hang tri-state vs broker analog", () => {
  test("records pass, fail, and inconclusive, and treats inconclusive as not pass", () => {
    const catalog = catalogWithMappedIds();
    const pass = runKillTestHang({ outcome: "pass", evidenceRefs: ["ev-kill"], catalog });
    const fail = runKillTestHang({ outcome: "fail", evidenceRefs: ["ev-kill"], catalog });
    const inconclusive = runKillTestHang({ outcome: "inconclusive", evidenceRefs: ["ev-kill"], catalog });

    expect(pass.outcome).toBe("pass");
    expect(fail.outcome).toBe("fail");
    expect(inconclusive.outcome).toBe("inconclusive");
    expect(killTestOutcomeIsPass(inconclusive.outcome)).toBe(false);
    expect(killTestOutcomeBlocksBroker("fail")).toBe(true);
    expect(killTestOutcomeBlocksBroker("inconclusive")).toBe(true);
    expect(killTestOutcomeBlocksBroker("pass")).toBe(false);
    expect(() => asKillTestPass("inconclusive")).toThrow(/inconclusive|not pass/i);

    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(inconclusive.ok).toBe(false);
    expect(fail.blocksPromotion).toBe(true);
    expect(fail.blocksBroker).toBe(true);
    expect(inconclusive.blocksPromotion).toBe(true);
    expect(inconclusive.blocksBroker).toBe(true);
    expect(inconclusive.objections.join(" ")).toMatch(/inconclusive|not pass/i);
  });
});

describe("before-promotion KillTester stacks after SuccessAuditor", () => {
  test("KillTester stays on the SuccessAuditor family and does not replace it", () => {
    expect(verificationRoleContract("KillTester")).toMatchObject({
      trigger: "before-promotion",
      input: "success-claim",
      authoritative: false,
    });
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(verificationRoleContract("KillTester").purpose).not.toBe(verificationRoleContract("SuccessAuditor").purpose);
  });

  test("runs after T48 acceptance and SuccessAuditor, and fail or inconclusive block local promote and HumanAcceptance", async () => {
    const { inner, evidence } = passingMethodology();
    expect(auditMethodology(evidence, contracts).ok).toBe(true);
    expect(oofEnsembleGate(evidence, contracts).ok).toBe(true);
    const catalog = catalogWithMappedIds();
    const policy = { maxBranches: 1, maxParallelBranches: 1, quorum: 1 };

    async function runWith(outcome: KillTestOutcome) {
      const order: string[] = [];
      const harness = new ToyCompetitionHarness({
        missionId: `k1-${outcome}`,
        prediction,
        taskContract: { objective: "maximize the score under methodology contracts" },
        branchIds: ["candidate"],
        runtime: runtimeFromFiles(inner.files as Record<string, string>),
        adapter: new MethodologyToyCompetitionAdapter(contracts),
        policy,
        verification: {
          successAuditor: () => {
            order.push("SuccessAuditor");
            return { ok: true, objections: [] };
          },
          killTestHang: createKillTestHangHook({
            outcome,
            evidenceRefs: ["ev-kill"],
            catalog,
            contracts,
            methodologyEvidence: evidence,
          }),
        },
      });
      const state = await harness.run();
      return { harness, state, order };
    }

    const passed = await runWith("pass");
    expect(passed.order).toEqual(["SuccessAuditor"]);
    const passedTypes = passed.harness.events().map((event) => event.type);
    const successAt = passedTypes.indexOf("SUCCESS_AUDITOR_COMPLETED");
    const killAt = passedTypes.indexOf("KILL_TESTER_COMPLETED");
    const promotedAt = passedTypes.indexOf("PROMOTED_LOCAL");
    expect(successAt).toBeGreaterThan(-1);
    expect(killAt).toBeGreaterThan(successAt);
    expect(promotedAt).toBeGreaterThan(killAt);
    expect(passed.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    const accepted = passed.harness.acceptChampion({
      acceptedBy: "operator",
      championDigest: passed.state.champion!.snapshot.digest,
    });
    expect(accepted.acceptedBy).toBe("operator");
    expect(passed.harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");

    for (const outcome of ["fail", "inconclusive"] as const) {
      const blocked = await runWith(outcome);
      expect(blocked.order).toEqual(["SuccessAuditor"]);
      expect(blocked.harness.events().map((event) => event.type)).toEqual(expect.arrayContaining([
        "SUCCESS_AUDITOR_COMPLETED",
        "KILL_TESTER_COMPLETED",
      ]));
      expect(blocked.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
      expect(blocked.state.champion).toBeUndefined();
      expect(blocked.state.branches.candidate.status).toBe("REJECTED");
      expect(blocked.state.humanAcceptance).toBeUndefined();
      expect(() => blocked.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    }
  });
});

function ledgerWithOpenPlan(catalog = catalogWithMappedIds()) {
  const ledger = new HypothesisLedger({ catalog });
  ledger.createHypothesis({
    hypothesisId: "h-k2",
    statement: "shared preprocessing leaks the hold-out",
    evidenceRefs: ["ev-holdout"],
  });
  const plan = ledger.planKillTest({
    planId: "kt-k2",
    hypothesisId: "h-k2",
    predicate: "retrain without the shared step; hold-out must not move",
    evidenceRefs: ["ev-holdout"],
  });
  return { catalog, ledger, plan };
}

describe("K2 kill-test hang reads and writes the H2 ledger", () => {
  test("reads KillTestPlan and writes KillTestResult through HypothesisLedger with H1/H2 field names", () => {
    const { catalog, ledger, plan } = ledgerWithOpenPlan();
    expect(ledger.state().plans[plan.planId]?.planId).toBe("kt-k2");
    expect(ledger.state().plans[plan.planId]?.hypothesisId).toBe("h-k2");
    expect(ledger.state().plans[plan.planId]?.predicate).toBe("retrain without the shared step; hold-out must not move");
    expect(ledger.state().plans[plan.planId]?.evidenceRefs).toEqual([{ kind: "evidence", id: "ev-holdout" }]);
    expect(ledger.resultFor("kt-k2")).toBeUndefined();

    const hang = runKillTestHang({
      outcome: "fail",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: plan.planId,
      resultId: "ktr-k2",
    });

    expect(hang.ok).toBe(false);
    expect(hang.blocksBroker).toBe(true);
    expect(hang.plan).toEqual({
      planId: "kt-k2",
      hypothesisId: "h-k2",
      predicate: "retrain without the shared step; hold-out must not move",
      evidenceRefs: [{ kind: "evidence", id: "ev-holdout" }],
    });
    const result = ledger.resultFor("kt-k2");
    expect(result).toEqual({
      resultId: "ktr-k2",
      planId: "kt-k2",
      hypothesisId: "h-k2",
      outcome: "fail",
      evidenceRefs: [{ kind: "evidence", id: "ev-kill" }],
    });
    expect(Object.keys(result ?? {})).toEqual(["resultId", "planId", "hypothesisId", "outcome", "evidenceRefs"]);
    expect(ledger.state().results["ktr-k2"]).toEqual(result);
    expect(ledger.state().hypotheses["h-k2"]?.killTestPlanIds).toEqual(["kt-k2"]);
    expect(ledger.state().hypotheses["h-k2"]?.status).toBe("killed");
    expect(ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
      "hypothesis.status_changed",
    ]);
  });

  test("fail and inconclusive write through the ledger and cannot reach the Broker analog; pass may promote", async () => {
    const { inner, evidence } = passingMethodology();
    expect(auditMethodology(evidence, contracts).ok).toBe(true);
    expect(oofEnsembleGate(evidence, contracts).ok).toBe(true);
    const policy = { maxBranches: 1, maxParallelBranches: 1, quorum: 1 };

    async function runWith(outcome: KillTestOutcome) {
      const { catalog, ledger, plan } = ledgerWithOpenPlan();
      const harness = new ToyCompetitionHarness({
        missionId: `k2-${outcome}`,
        prediction,
        taskContract: { objective: "maximize the score under methodology contracts" },
        branchIds: ["candidate"],
        runtime: runtimeFromFiles(inner.files as Record<string, string>),
        adapter: new MethodologyToyCompetitionAdapter(contracts),
        policy,
        verification: {
          successAuditor: () => ({ ok: true, objections: [] }),
          killTestHang: createKillTestHangHook({
            outcome,
            evidenceRefs: ["ev-kill"],
            catalog,
            ledger,
            planId: plan.planId,
            resultId: `ktr-${outcome}`,
            contracts,
            methodologyEvidence: evidence,
          }),
        },
      });
      const state = await harness.run();
      return { harness, state, ledger, plan };
    }

    const passed = await runWith("pass");
    expect(passed.ledger.resultFor(passed.plan.planId)).toEqual({
      resultId: "ktr-pass",
      planId: "kt-k2",
      hypothesisId: "h-k2",
      outcome: "pass",
      evidenceRefs: [{ kind: "evidence", id: "ev-kill" }],
    });
    expect(passed.ledger.state().hypotheses["h-k2"]?.status).toBe("open");
    expect(passed.ledger.state().hypotheses["h-k2"]?.status).not.toBe("killed");
    expect(killTestOutcomeIsPass(passed.ledger.resultFor(passed.plan.planId)!.outcome)).toBe(true);
    const passedTypes = passed.harness.events().map((event) => event.type);
    expect(passedTypes.indexOf("KILL_TESTER_COMPLETED")).toBeGreaterThan(passedTypes.indexOf("SUCCESS_AUDITOR_COMPLETED"));
    expect(passedTypes.indexOf("PROMOTED_LOCAL")).toBeGreaterThan(passedTypes.indexOf("KILL_TESTER_COMPLETED"));
    expect(passed.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(passed.harness.acceptChampion({
      acceptedBy: "operator",
      championDigest: passed.state.champion!.snapshot.digest,
    }).acceptedBy).toBe("operator");
    expect(passed.harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");

    for (const outcome of ["fail", "inconclusive"] as const) {
      const blocked = await runWith(outcome);
      const recorded = blocked.ledger.resultFor(blocked.plan.planId);
      expect(recorded?.outcome).toBe(outcome);
      expect(recorded?.planId).toBe("kt-k2");
      expect(recorded?.hypothesisId).toBe("h-k2");
      expect(recorded?.evidenceRefs).toEqual([{ kind: "evidence", id: "ev-kill" }]);
      expect(killTestOutcomeIsPass(recorded!.outcome)).toBe(false);
      expect(killTestOutcomeBlocksBroker(recorded!.outcome)).toBe(true);
      if (outcome === "fail") {
        expect(blocked.ledger.state().hypotheses["h-k2"]?.status).toBe("killed");
      } else {
        expect(blocked.ledger.state().hypotheses["h-k2"]?.status).toBe("open");
        expect(blocked.ledger.state().hypotheses["h-k2"]?.status).not.toBe("killed");
        expect(() => asKillTestPass(recorded!.outcome)).toThrow(/inconclusive|not pass/i);
      }
      expect(blocked.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
      expect(blocked.harness.events().some((event) => event.type === "HUMAN_ACCEPTED")).toBe(false);
      expect(blocked.state.champion).toBeUndefined();
      expect(blocked.state.branches.candidate.status).toBe("REJECTED");
      expect(blocked.state.humanAcceptance).toBeUndefined();
      expect(() => blocked.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    }
  });

  test("keeps unmapped-artifact and sole side-slot/MMD filters and does not write a ledger result", () => {
    const { catalog, ledger, plan } = ledgerWithOpenPlan();
    const unmapped = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: plan.planId,
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    expect(unmapped.ok).toBe(false);
    expect(unmapped.blocksBroker).toBe(true);
    expect(unmapped.objections.join(" ")).toMatch(/T48|artifact/i);
    expect(ledger.resultFor(plan.planId)).toBeUndefined();
    expect(ledger.state().results).toEqual({});

    const scalars: unknown[] = [0.91, { mmd: 0.12 }, { sideSlot: 0.8 }, { side_slot: 0.4 }];
    for (const key of scalars) {
      const { catalog: nextCatalog, ledger: nextLedger, plan: nextPlan } = ledgerWithOpenPlan();
      const rejected = runKillTestHang({
        outcome: "pass",
        evidenceRefs: [key],
        catalog: nextCatalog,
        ledger: nextLedger,
        planId: nextPlan.planId,
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.objections.join(" ")).toMatch(/side-slot|MMD|near-dup|diversity|scalar/i);
      expect(nextLedger.resultFor(nextPlan.planId)).toBeUndefined();
    }

    const mixed = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill", { mmd: 0.12 }],
      catalog,
      ledger,
      planId: plan.planId,
      resultId: "ktr-mixed",
    });
    expect(mixed.ok).toBe(true);
    expect(ledger.resultFor(plan.planId)?.evidenceRefs).toEqual([{ kind: "evidence", id: "ev-kill" }]);
    expect(ledger.resultFor(plan.planId)?.evidenceRefs.some((ref) => "mmd" in ref)).toBe(false);
  });

  test("fails closed on a missing plan and does not silently skip the hang", () => {
    const { catalog, ledger } = ledgerWithOpenPlan();
    const missingPlan = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: "kt-missing",
    });
    expect(missingPlan.ok).toBe(false);
    expect(missingPlan.blocksPromotion).toBe(true);
    expect(missingPlan.blocksBroker).toBe(true);
    expect(missingPlan.objections.join(" ")).toMatch(/unknown kill-test plan/i);
    expect(ledger.resultFor("kt-missing")).toBeUndefined();
    expect(Object.keys(ledger.state().results)).toEqual([]);

    const ledgerWithoutPlan = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
    });
    expect(ledgerWithoutPlan.ok).toBe(false);
    expect(ledgerWithoutPlan.objections.join(" ")).toMatch(/ledger KillTestPlan/i);

    const t48Blocked = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: "kt-k2",
      contracts,
      methodologyEvidence: { splitDigestAgreement: "disagree", oofPresent: false },
    });
    expect(t48Blocked.ok).toBe(false);
    expect(t48Blocked.objections.join(" ")).toMatch(/split|OOF|leak/i);
    expect(ledger.resultFor("kt-k2")).toBeUndefined();

    const first = runKillTestHang({
      outcome: "fail",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: "kt-k2",
      resultId: "ktr-first",
    });
    expect(first.plan?.planId).toBe("kt-k2");
    expect(ledger.resultFor("kt-k2")?.resultId).toBe("ktr-first");
    const replay = runKillTestHang({
      outcome: "fail",
      evidenceRefs: ["ev-kill"],
      catalog,
      ledger,
      planId: "kt-k2",
      resultId: "ktr-replay",
    });
    expect(replay.ok).toBe(false);
    expect(replay.objections.join(" ")).toMatch(/already has a result/i);
    expect(ledger.resultFor("kt-k2")?.resultId).toBe("ktr-first");
    expect(Object.keys(ledger.state().results)).toEqual(["ktr-first"]);
  });
});
