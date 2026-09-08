import { afterEach, describe, expect, test } from "bun:test";
import {
  NEWAPI_API_KEY_ENV,
  NEWAPI_LIVE_ENV,
} from "./newapi-client";
import {
  MOCK_LLM_CANDIDATE_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
} from "./llm-competition-runtime";
import {
  assembleLlmCompArmSetup,
  mapLlmProposalArtifact,
  runLlmProposeOuterMin,
} from "./llm-propose-outer-min";
import {
  HypothesisLedger,
  T48MappedCatalog,
} from "./hypothesis-ledger";
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
import { assembleOuterE2eMinPath } from "./outer-e2e-min-path";
import { buildOuterSearchSpaceFixtures } from "./outer-search-space-fixtures";
import { runKillTestHang } from "./kill-test-hang";
import { MissionDirector, type ResearchTask } from "./research-loop";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "./search-space-profile";
import type { ToyAgentRuntime } from "./toy-harness";
import { verificationRoleContract } from "./verification-gates";

const TASKS: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
];

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
});

function runtimeReturning(proposal: unknown): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true, objections: [] }),
    propose: () => proposal as { files: Record<string, string> },
    falsify: () => ({ ok: true, objections: [] }),
  };
}

describe("LLM.2 propose → Outer E2E assembly", () => {
  test("one-call with the L1 mock yields hypothesisId, planId, and mapped evidence_refs", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];

    const arm = await runLlmProposeOuterMin();
    const e3 = buildOuterSearchSpaceFixtures();

    expect(assembleLlmCompArmSetup).toBe(runLlmProposeOuterMin);
    expect(arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(arm.proposal.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
    expect(arm.hypothesisId).toBe("h-llm-comp");
    expect(arm.planId).toBe("kt-llm-comp");
    expect(arm.setup.hypothesisId).toBe(arm.hypothesisId);
    expect(arm.setup.planId).toBe(arm.planId);
    expect(arm.proposalRef).toEqual({ kind: "artifact", id: arm.proposalArtifact.artifactId });
    expect(arm.proposalRef.kind).toBe("artifact");
    expect(arm.evidenceRefs[0]).toEqual(arm.proposalRef);
    expect(arm.evidenceRefs).toEqual([
      arm.proposalRef,
      { kind: "evidence", id: OUTER_MIN_HOLD_OUT_EVIDENCE_ID },
      arm.searchSpace.mappedNearDup,
      arm.searchSpace.mappedDiversity,
    ]);
    expect(arm.searchSpace.mappedNearDup).toEqual(e3.mappedNearDup);
    expect(arm.searchSpace.mappedDiversity).toEqual(e3.mappedDiversity);
    expect(arm.setup.ledger.state().hypotheses[arm.hypothesisId]?.evidenceRefs).toEqual(arm.evidenceRefs);
    expect(arm.setup.ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
    ]);
    expect(arm.killTestHang).toBeDefined();
    expect(runOuterMinPathSetup).toBeDefined();
    expect(assembleOuterE2eMinPath).toBeDefined();
  });

  test("proposal files become a T48-mapped Artifact; raw score files are not promotion keys", () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const mapped = mapLlmProposalArtifact({
      catalog: fixtures.catalog,
      proposal: { files: { ...MOCK_LLM_CANDIDATE_FILES } },
    });

    expect(mapped.mapped).toEqual({ kind: "artifact", id: mapped.artifact.artifactId });
    expect(mapped.artifact.kind).toBe("llm_proposal");
    expect(mapped.artifact.artifactId.startsWith("llm-proposal:")).toBe(true);
    expect(mapped.catalog.map(mapped.artifact.artifactId)).toEqual(mapped.mapped);
    expect(() => fixtures.catalog.map(MOCK_LLM_CANDIDATE_FILES)).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(() => fixtures.catalog.map({ score: "1" })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
  });

  test("unmapped or scalar proposals hard-reject and never write promotion keys", async () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const ledger = new HypothesisLedger({ catalog: fixtures.catalog });
    const illegal: unknown[] = [
      0.91,
      "0.12",
      { mmd: 0.12 },
      { mmdScore: 0.12 },
      { near_dup: 0.01 },
      { nearDup: 0.01 },
      { sideSlot: 0.8 },
      { diversity: 1 },
      { score: "1" },
      MOCK_LLM_CANDIDATE_FILES,
      "unmapped-proposal",
      { artifactId: "unmapped-art" },
    ];

    for (const proposal of illegal) {
      expect(() => mapLlmProposalArtifact({
        catalog: fixtures.catalog,
        proposal,
      })).toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    }

    for (const key of illegal) {
      expect(() => ledger.createHypothesis({
        statement: "must not persist an unmapped proposal",
        evidenceRefs: [key],
      })).toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    }
    expect(ledger.events()).toEqual([]);

    for (const key of illegal) {
      let thrown: unknown;
      try {
        await assembleLlmCompArmSetup({ evidenceRefs: [key] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(thrown instanceof Error ? thrown.message : "").toMatch(
        /unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i,
      );
    }

    let badRuntime: unknown;
    try {
      await assembleLlmCompArmSetup({ runtime: runtimeReturning({ mmd: 0.12 }) });
    } catch (error) {
      badRuntime = error;
    }
    expect(badRuntime).toBeDefined();
    expect(badRuntime instanceof Error ? (badRuntime as Error).message : "").toMatch(
      /unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
  });

  test("SearchSpace diagnosis stays diagnostic_only and is not the sole promotion key", async () => {
    const arm = await assembleLlmCompArmSetup();
    const projected = projectHypothesisSearchSpaceRefs({
      catalog: arm.setup.fixture.catalog,
      hypothesis: arm.setup.hypothesis,
      sources: [arm.setup.fixture.nearDup, arm.setup.fixture.diversity],
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(arm.evidenceRefs).toContainEqual(arm.proposalRef);
    expect(arm.evidenceRefs).toContainEqual(arm.searchSpace.mappedNearDup);
    expect(arm.evidenceRefs).toContainEqual(arm.searchSpace.mappedDiversity);
    expect(arm.evidenceRefs.filter((ref) => ref.id === arm.proposalRef.id)).toHaveLength(1);
    expect(arm.evidenceRefs.every((ref) => ref.id === arm.searchSpace.mappedNearDup.id
      || ref.id === arm.searchSpace.mappedDiversity.id)).toBe(false);
    expect(projected.evidenceRefs).toEqual(arm.evidenceRefs);
    expect(arm.setup.projected.evidenceRefs).toEqual(arm.evidenceRefs);
  });

  test("does not change auditMethodology / Kill-test hang / Broker / before-promotion semantics", async () => {
    const arm = await assembleLlmCompArmSetup();
    expect(arm.setup.fixture.contracts).toEqual({});
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");

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
    expect(auditMethodology(agree, arm.setup.fixture.contracts).ok).toBe(true);
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);
    expect(oofEnsembleGate(missing, arm.setup.fixture.contracts).ok).toBe(true);

    const slept = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: arm.setup.fixture.catalog,
    });
    expect(slept.ok).toBe(true);
    expect(slept.blocksPromotion).toBe(false);
    expect(slept.blocksBroker).toBe(false);

    const scalarHang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [{ mmd: 0.12 }],
      catalog: arm.setup.fixture.catalog,
    });
    expect(scalarHang.ok).toBe(false);
    expect(scalarHang.blocksPromotion).toBe(true);
    expect(scalarHang.blocksBroker).toBe(true);
  });

  test("live stays off; #40 stays off; default parent-selection A is unchanged", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("LLM.2 must not call live newapi");
    }) as typeof fetch;

    try {
      const before = new MissionDirector({
        missionId: "llm2-before",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });
      const runtime = createLlmCompetitionRuntime();
      const arm = await assembleLlmCompArmSetup({ runtime });
      arm.setup.requestExpand();
      const after = new MissionDirector({
        missionId: "llm2-after",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });

      process.env[NEWAPI_LIVE_ENV] = "1";
      process.env[NEWAPI_API_KEY_ENV] = "sk-must-not-enable-live-from-env";
      const envArmed = await assembleLlmCompArmSetup();
      expect(envArmed.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(JSON.stringify(envArmed)).not.toContain("sk-must-not-enable-live-from-env");
      expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
      expect(before.selectNextTask()?.taskId).toBe("baseline");
      expect(after.selectNextTask()?.taskId).toBe("baseline");
      expect(before.readyTasks().map((task) => task.taskId)).toEqual(
        after.readyTasks().map((task) => task.taskId),
      );
      expect(arm.setup.ledger.searchNodes()).toEqual([]);
      expect(fetches).toBe(0);
      expect(JSON.stringify(arm)).not.toContain("sk-");
      expect(JSON.stringify(arm)).not.toMatch(/gpt-/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
