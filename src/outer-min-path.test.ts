import { describe, expect, test } from "bun:test";
import {
  assembleOuterMinPath,
  createOuterMinFixture,
  runOuterMinPathSetup,
} from "./outer-min-path";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import { MissionDirector, type ResearchTask } from "./research-loop";
import { runKillTestHang } from "./kill-test-hang";
import { verificationRoleContract } from "./verification-gates";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "./search-space-profile";

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
      throw new Error("select_node / default inner A must not run for E2E.1");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for E2E.1");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for E2E.1");
    },
  };
}

describe("E2E.1 outer-min fixture + runner (control-plane steps 0–5)", () => {
  test("a single runner call returns hypothesisId, planId, and mapped evidence_refs", () => {
    const setup = runOuterMinPathSetup();

    expect(setup.hypothesisId).toBe("h-outer-min");
    expect(setup.planId).toBe("kt-outer-min");
    expect(setup.hypothesis.hypothesisId).toBe("h-outer-min");
    expect(setup.plan.planId).toBe("kt-outer-min");
    expect(setup.plan.hypothesisId).toBe("h-outer-min");
    expect(setup.evidenceRefs).toEqual([
      { kind: "evidence", id: "ev-holdout" },
      { kind: "artifact", id: setup.fixture.nearDup.artifact.artifactId },
      { kind: "artifact", id: setup.fixture.diversity.artifact.artifactId },
    ]);
    expect(setup.ledger.state().hypotheses["h-outer-min"]?.evidenceRefs).toEqual(setup.evidenceRefs);
    expect(setup.ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
    ]);
    expect(assembleOuterMinPath).toBe(runOuterMinPathSetup);
  });

  test("projection shows mapped refs and illegal refs are rejected", () => {
    const setup = runOuterMinPathSetup();
    const projected = projectHypothesisSearchSpaceRefs({
      catalog: setup.fixture.catalog,
      hypothesis: setup.hypothesis,
      sources: [setup.fixture.nearDup, setup.fixture.diversity],
    });

    expect(projected.hypothesisId).toBe("h-outer-min");
    expect(projected.status).toBe("open");
    expect(projected.evidenceRefs).toEqual(setup.evidenceRefs);
    expect(setup.ledger.state().hypotheses["h-outer-min"]?.evidenceRefs).toEqual([
      { kind: "evidence", id: "ev-holdout" },
      { kind: "artifact", id: setup.fixture.nearDup.artifact.artifactId },
      { kind: "artifact", id: setup.fixture.diversity.artifact.artifactId },
    ]);

    const fixture = createOuterMinFixture();
    const illegal: unknown[] = [
      0.91,
      "0.12",
      { mmd: 0.12 },
      { mmdScore: 0.12 },
      { near_dup: 0.01 },
      { nearDup: 0.01 },
      { sideSlot: 0.8 },
      { diversity: 1 },
      "near-dup:not-in-catalog",
    ];
    for (const key of illegal) {
      expect(() => runOuterMinPathSetup({
        fixture,
        evidenceRefs: [key],
      })).toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    }
  });

  test("requestExpand does not drive UCT and leaves searchNodes empty", () => {
    const ports = smuggledSearchPorts();
    const setup = runOuterMinPathSetup();
    const eventCount = setup.ledger.events().length;
    const expanded = setup.requestExpand({
      enqueue: {
        campaignId: "campaign-outer-min",
        task: { taskId: "outer-min-expand", objective: "enqueue without UCT", estimatedCost: 1 },
      },
    });

    expect(expanded.hypothesisId).toBe("h-outer-min");
    expect(setup.ledger.events()).toHaveLength(eventCount + 1);
    expect(setup.ledger.events().at(-1)?.type).toBe("hypothesis.expand_requested");
    expect(setup.ledger.searchNodes()).toEqual([]);
    expect(setup.ledger.state().searchNodes).toEqual([]);
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
  });

  test("does not change auditMethodology / oofEnsembleGate / Broker / before-promotion semantics", () => {
    const setup = runOuterMinPathSetup();
    expect(setup.fixture.contracts).toEqual({});

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
    expect(auditMethodology(agree, setup.fixture.contracts).ok).toBe(true);
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);
    expect(oofEnsembleGate(missing, setup.fixture.contracts).ok).toBe(true);
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");

    const hang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog: setup.fixture.catalog,
      contracts,
      methodologyEvidence: agree,
    });
    expect(hang.ok).toBe(true);
    expect(hang.blocksPromotion).toBe(false);
    expect(hang.blocksBroker).toBe(false);

    const scalarHang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [{ mmd: 0.12 }],
      catalog: setup.fixture.catalog,
    });
    expect(scalarHang.ok).toBe(false);
    expect(scalarHang.blocksPromotion).toBe(true);
    expect(scalarHang.blocksBroker).toBe(true);
  });

  test("does not change default parent selection A and leaves #40 SelectionPolicy off", () => {
    const ports = smuggledSearchPorts();
    const before = new MissionDirector({
      missionId: "e2e1-before",
      objective: "improve the competition result",
      budget: 10,
      tasks: TASKS,
    });
    const setup = runOuterMinPathSetup();
    setup.requestExpand();
    const after = new MissionDirector({
      missionId: "e2e1-after",
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
    expect(setup.ledger.searchNodes()).toEqual([]);
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
  });
});
