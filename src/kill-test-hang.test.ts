import { describe, expect, test } from "bun:test";
import {
  asKillTestPass,
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
