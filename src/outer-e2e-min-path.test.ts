import { describe, expect, test } from "bun:test";
import {
  asKillTestPass,
  killTestOutcomeIsPass,
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
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import {
  OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
  OUTER_MIN_KILL_EVIDENCE_ID,
  runOuterMinPathSetup,
} from "./outer-min-path";
import {
  assembleOuterE2eMinPath,
} from "./outer-e2e-min-path";
import { buildOuterSearchSpaceFixtures } from "./outer-search-space-fixtures";
import { MissionDirector, type ResearchTask } from "./research-loop";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "./search-space-profile";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type ToyAgentRuntime,
} from "./toy-harness";
import { verificationRoleContract } from "./verification-gates";

const TASKS: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
];

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for E2");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for E2");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for E2");
    },
  };
}

function runtimeFromFiles(files: Record<string, string>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { ...files } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

async function runWiredHarness(
  path: ReturnType<typeof assembleOuterE2eMinPath>,
  missionId: string,
  files: Record<string, string> = { score: "3" },
) {
  const harness = new ToyCompetitionHarness({
    missionId,
    taskContract: { objective: "outer-e2e min path before-promotion AC" },
    branchIds: ["candidate"],
    runtime: runtimeFromFiles(files),
    adapter: new ScoreFileToyCompetitionAdapter(),
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    verification: {
      killTestHang: path.killTestHang,
    },
  });
  const state = await harness.run();
  return { harness, state };
}

describe("E2 before-promotion outer AC", () => {
  test("E1 setup returns hypothesisId, planId, and E3 T48-mapped evidence_refs", () => {
    const path = assembleOuterE2eMinPath();
    const e3 = buildOuterSearchSpaceFixtures();

    expect(runOuterMinPathSetup).toBeDefined();
    expect(path.setup.hypothesisId).toBe("h-outer-min");
    expect(path.setup.planId).toBe("kt-outer-min");
    expect(path.setup.hypothesis.hypothesisId).toBe(path.setup.hypothesisId);
    expect(path.setup.plan.planId).toBe(path.setup.planId);
    expect(OUTER_MIN_HOLD_OUT_EVIDENCE_ID).toBe("ev-holdout");
    expect(path.setup.evidenceRefs).toEqual([
      { kind: "evidence", id: OUTER_MIN_HOLD_OUT_EVIDENCE_ID },
      path.searchSpace.mappedNearDup,
      path.searchSpace.mappedDiversity,
    ]);
    expect(path.searchSpace.mappedNearDup).toEqual(e3.mappedNearDup);
    expect(path.searchSpace.mappedDiversity).toEqual(e3.mappedDiversity);
    expect(path.searchSpace.mappedRefs).toEqual([
      path.searchSpace.mappedNearDup,
      path.searchSpace.mappedDiversity,
    ]);
    expect(path.setup.ledger.state().hypotheses[path.setup.hypothesisId]?.evidenceRefs).toEqual(
      path.setup.evidenceRefs,
    );
    expect(path.setup.ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
    ]);
  });

  test("T48 sleeps without a contract, then Kill-test runs before PROMOTED_LOCAL / acceptChampion", async () => {
    const path = assembleOuterE2eMinPath({ outcome: "pass" });
    expect(path.setup.fixture.contracts).toEqual({});
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);

    const slept = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: path.setup.fixture.catalog,
    });
    expect(slept.ok).toBe(true);
    expect(slept.blocksPromotion).toBe(false);

    const { harness, state } = await runWiredHarness(path, "e2-t48-sleep");
    const types = harness.events().map((event) => event.type);
    const killAt = types.indexOf("KILL_TESTER_COMPLETED");
    const promotedAt = types.indexOf("PROMOTED_LOCAL");
    expect(killAt).toBeGreaterThan(-1);
    expect(promotedAt).toBeGreaterThan(killAt);
    expect(path.setup.ledger.resultFor(path.setup.planId)?.outcome).toBe("pass");
    expect(state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(harness.acceptChampion({
      acceptedBy: "operator",
      championDigest: state.champion!.snapshot.digest,
    }).acceptedBy).toBe("operator");
    expect(harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");
  });

  test("pass may PROMOTED_LOCAL; fail and inconclusive block Broker analog / acceptChampion", async () => {
    async function runWith(outcome: KillTestOutcome) {
      const path = assembleOuterE2eMinPath({
        outcome,
        resultId: `ktr-e2-${outcome}`,
      });
      const wired = await runWiredHarness(path, `e2-${outcome}`);
      return { ...wired, path };
    }

    const passed = await runWith("pass");
    const recorded = passed.path.setup.ledger.resultFor(passed.path.setup.planId);
    expect(recorded?.outcome).toBe("pass");
    expect(killTestOutcomeIsPass(recorded!.outcome)).toBe(true);
    expect(killTestOutcomeBlocksBroker(recorded!.outcome)).toBe(false);
    expect(passed.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(passed.harness.acceptChampion({
      acceptedBy: "operator",
      championDigest: passed.state.champion!.snapshot.digest,
    }).acceptedBy).toBe("operator");
    expect(passed.harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");

    for (const outcome of ["fail", "inconclusive"] as const) {
      const blocked = await runWith(outcome);
      const result = blocked.path.setup.ledger.resultFor(blocked.path.setup.planId);
      expect(result?.outcome).toBe(outcome);
      expect(killTestOutcomeIsPass(result!.outcome)).toBe(false);
      expect(killTestOutcomeBlocksBroker(result!.outcome)).toBe(true);
      if (outcome === "inconclusive") {
        expect(() => asKillTestPass(result!.outcome)).toThrow(/inconclusive|not pass/i);
      }
      expect(blocked.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
      expect(blocked.harness.events().some((event) => event.type === "HUMAN_ACCEPTED")).toBe(false);
      expect(blocked.state.champion).toBeUndefined();
      expect(blocked.state.branches.candidate.status).toBe("REJECTED");
      expect(blocked.state.humanAcceptance).toBeUndefined();
      expect(() => blocked.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    }
  });

  test("unmapped Artifact or scalar-only diagnosis hard-rejects; no silent pass", async () => {
    const unmapped = assembleOuterE2eMinPath({
      outcome: "pass",
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    const unmappedRun = await runWiredHarness(unmapped, "e2-unmapped");
    expect(unmappedRun.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(unmappedRun.state.branches.candidate.status).toBe("REJECTED");
    expect(unmappedRun.state.champion).toBeUndefined();
    expect(() => unmappedRun.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    expect(unmapped.setup.ledger.resultFor(unmapped.setup.planId)).toBeUndefined();

    const scalar = assembleOuterE2eMinPath({
      outcome: "pass",
      killEvidenceRefs: [{ mmd: 0.12 }],
    });
    const scalarRun = await runWiredHarness(scalar, "e2-scalar");
    expect(scalarRun.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scalarRun.state.branches.candidate.status).toBe("REJECTED");
    expect(scalar.setup.ledger.resultFor(scalar.setup.planId)).toBeUndefined();

    expect(() => assembleOuterE2eMinPath({
      evidenceRefs: [{ near_dup: 0.01 }],
    })).toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
  });

  test("does not wrap or relax auditMethodology / oofEnsembleGate / Broker semantics", async () => {
    const path = assembleOuterE2eMinPath();
    expect(path.killTestHang).toBeDefined();
    expect(createKillTestHangHook).toBeDefined();
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");

    const contracts: MethodologyContracts = {
      splitContract: { splitRef: { digest: "sha256:toy-split-ref-v1" } },
      oofEnsemble: { required: true },
    };
    const agree: MethodologyEvidence = {
      splitRefDigest: "sha256:toy-split-ref-v1",
      splitDigestAgreement: "agree",
      oofPresent: true,
    };
    const disagree: MethodologyEvidence = {
      splitRefDigest: "sha256:other",
      splitDigestAgreement: "disagree",
      oofPresent: false,
    };
    const missing: MethodologyEvidence = {
      splitDigestAgreement: "unknown",
      oofPresent: false,
    };

    expect(auditMethodology(agree, contracts).ok).toBe(true);
    expect(auditMethodology(disagree, contracts).ok).toBe(false);
    expect(auditMethodology(missing, contracts).ok).toBe(false);
    expect(auditMethodology(agree).ok).toBe(true);
    expect(auditMethodology(agree, path.setup.fixture.contracts).ok).toBe(true);
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);
    expect(oofEnsembleGate(missing, path.setup.fixture.contracts).ok).toBe(true);

    const t48Blocked = assembleOuterE2eMinPath({
      outcome: "pass",
      contracts,
      methodologyEvidence: disagree,
    });
    const blocked = await runWiredHarness(t48Blocked, "e2-t48-block");
    const killEvent = blocked.harness.events().find((event) => event.type === "KILL_TESTER_COMPLETED");
    expect(killEvent?.payload.ok).toBe(false);
    expect((killEvent?.payload.objections as string[]).join(" ")).toMatch(/split|OOF|leak/i);
    expect(blocked.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(blocked.state.champion).toBeUndefined();
    expect(blocked.state.branches.candidate.status).toBe("REJECTED");
    expect(() => blocked.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    expect(t48Blocked.setup.ledger.resultFor(t48Blocked.setup.planId)).toBeUndefined();
  });

  test("does not call UCT / SelectionPolicy; #40 remains off; default A unchanged", () => {
    const ports = smuggledSearchPorts();
    const before = new MissionDirector({
      missionId: "e2-before",
      objective: "improve the competition result",
      budget: 10,
      tasks: TASKS,
    });
    const path = assembleOuterE2eMinPath();
    path.setup.requestExpand();
    projectHypothesisSearchSpaceRefs({
      catalog: path.setup.fixture.catalog,
      hypothesis: path.setup.hypothesis,
      sources: [path.setup.fixture.nearDup, path.setup.fixture.diversity],
      select_node: ports.select_node,
      uct: ports.uct,
      selectionPolicy: { select: ports.select_node },
    } as Parameters<typeof projectHypothesisSearchSpaceRefs>[0] & {
      readonly select_node: () => never;
      readonly uct: () => never;
      readonly selectionPolicy: { readonly select: () => never };
    });
    const after = new MissionDirector({
      missionId: "e2-after",
      objective: "improve the competition result",
      budget: 10,
      tasks: TASKS,
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(before.selectNextTask()?.taskId).toBe("baseline");
    expect(after.selectNextTask()?.taskId).toBe("baseline");
    expect(before.readyTasks().map((task) => task.taskId)).toEqual(
      after.readyTasks().map((task) => task.taskId),
    );
    expect(path.setup.ledger.searchNodes()).toEqual([]);
    expect(path.setup.ledger.events().at(-1)?.type).toBe("hypothesis.expand_requested");
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
  });
});
