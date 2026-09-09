import { afterEach, describe, expect, test } from "bun:test";
import {
  asKillTestPass,
  killTestOutcomeIsPass,
  type KillTestOutcome,
} from "./hypothesis-ledger";
import {
  createKillTestHangHook,
  killTestOutcomeBlocksBroker,
} from "./kill-test-hang";
import { runLlmCompArmBeforePromotion } from "./llm-comp-arm-before-promotion";
import {
  MOCK_LLM_CANDIDATE_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
} from "./llm-competition-runtime";
import {
  assembleLlmCompArmSetup,
  mapLlmProposalArtifact,
} from "./llm-propose-outer-min";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import {
  NEWAPI_API_KEY_ENV,
  NEWAPI_LIVE_ENV,
} from "./newapi-client";
import { assembleOuterE2eMinPath } from "./outer-e2e-min-path";
import { MissionDirector } from "./research-loop";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "./search-space-profile";
import type { ToyAgentRuntime } from "./toy-harness";
import { verificationRoleContract } from "./verification-gates";

import { RESEARCH_TASKS as TASKS } from "./fixtures/research";

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
});

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for LLM.3");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for LLM.3");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for LLM.3");
    },
  };
}

function runtimeReturning(proposal: unknown): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true, objections: [] }),
    propose: () => proposal as { files: Record<string, string> },
    falsify: () => ({ ok: true, objections: [] }),
  };
}

describe("LLM.3 before-promotion AC", () => {
  test("uses L2 assembly + MockLlmCompetitionRuntime and the Outer E2 hang", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("LLM.3 must not call live newapi");
    }) as typeof fetch;

    try {
      const run = await runLlmCompArmBeforePromotion({
        missionId: "llm3-l2-mock",
        outcome: "pass",
      });

      expect(run.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(createLlmCompetitionRuntime()).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(run.arm.proposal.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
      expect(run.arm.killTestHang).toBeDefined();
      expect(createKillTestHangHook).toBeDefined();
      expect(assembleOuterE2eMinPath).toBeDefined();
      expect(assembleLlmCompArmSetup).toBeDefined();
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("T48 sleeps without a contract, then Kill-test runs before PROMOTED_LOCAL / acceptChampion", async () => {
    const run = await runLlmCompArmBeforePromotion({
      missionId: "llm3-t48-sleep",
      outcome: "pass",
    });
    expect(run.arm.setup.fixture.contracts).toEqual({});
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);

    const types = run.harness.events().map((event) => event.type);
    const killAt = types.indexOf("KILL_TESTER_COMPLETED");
    const promotedAt = types.indexOf("PROMOTED_LOCAL");
    expect(killAt).toBeGreaterThan(-1);
    expect(promotedAt).toBeGreaterThan(killAt);
    expect(run.arm.setup.ledger.resultFor(run.arm.planId)?.outcome).toBe("pass");
    expect(run.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(run.harness.acceptChampion({
      acceptedBy: "operator",
      championDigest: run.state.champion!.snapshot.digest,
    }).acceptedBy).toBe("operator");
    expect(run.harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");
  });

  test("mock pass may PROMOTED_LOCAL; fail and inconclusive block Broker analog / acceptChampion", async () => {
    async function runWith(outcome: KillTestOutcome) {
      return runLlmCompArmBeforePromotion({
        missionId: `llm3-${outcome}`,
        outcome,
        resultId: `ktr-llm3-${outcome}`,
      });
    }

    const passed = await runWith("pass");
    const recorded = passed.arm.setup.ledger.resultFor(passed.arm.planId);
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
      const result = blocked.arm.setup.ledger.resultFor(blocked.arm.planId);
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

  test("unmapped proposal or scalar-only diagnosis hard-rejects; LLM scores do not bypass Kill-test", async () => {
    expect(MOCK_LLM_CANDIDATE_FILES.score).toBe("1");

    const scoreBypass = await runLlmCompArmBeforePromotion({
      missionId: "llm3-score-fail",
      outcome: "fail",
      resultId: "ktr-llm3-score-fail",
    });
    expect(scoreBypass.arm.proposal.files.score).toBe("1");
    expect(scoreBypass.state.branches.candidate.score).toBe(1);
    expect(scoreBypass.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scoreBypass.state.branches.candidate.status).toBe("REJECTED");
    expect(() => scoreBypass.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);

    const scoreAsKill = await runLlmCompArmBeforePromotion({
      missionId: "llm3-score-as-kill",
      outcome: "pass",
      killEvidenceRefs: [{ score: MOCK_LLM_CANDIDATE_FILES.score }],
    });
    expect(scoreAsKill.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scoreAsKill.state.branches.candidate.status).toBe("REJECTED");
    expect(scoreAsKill.arm.setup.ledger.resultFor(scoreAsKill.arm.planId)).toBeUndefined();

    const unmapped = await runLlmCompArmBeforePromotion({
      missionId: "llm3-unmapped",
      outcome: "pass",
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    expect(unmapped.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(unmapped.state.branches.candidate.status).toBe("REJECTED");
    expect(unmapped.state.champion).toBeUndefined();
    expect(() => unmapped.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    expect(unmapped.arm.setup.ledger.resultFor(unmapped.arm.planId)).toBeUndefined();

    const scalar = await runLlmCompArmBeforePromotion({
      missionId: "llm3-scalar",
      outcome: "pass",
      killEvidenceRefs: [{ mmd: 0.12 }],
    });
    expect(scalar.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scalar.state.branches.candidate.status).toBe("REJECTED");
    expect(scalar.arm.setup.ledger.resultFor(scalar.arm.planId)).toBeUndefined();

    await expect(assembleLlmCompArmSetup({
      evidenceRefs: ["unmapped-proposal"],
    })).rejects.toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);

    await expect(assembleLlmCompArmSetup({
      runtime: runtimeReturning({ score: MOCK_LLM_CANDIDATE_FILES.score }),
    })).rejects.toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);

    const fixtures = (await assembleLlmCompArmSetup()).searchSpace;
    expect(() => mapLlmProposalArtifact({
      catalog: fixtures.catalog,
      proposal: { files: { score: "99" } },
    })).not.toThrow();
    expect(() => fixtures.catalog.map({ score: "99" })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
  });

  test("does not wrap or relax auditMethodology / oofEnsembleGate / Broker semantics", async () => {
    const run = await runLlmCompArmBeforePromotion({ missionId: "llm3-gates" });
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
    expect(auditMethodology(agree, run.arm.setup.fixture.contracts).ok).toBe(true);
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);
    expect(oofEnsembleGate(missing, run.arm.setup.fixture.contracts).ok).toBe(true);

    const t48Blocked = await runLlmCompArmBeforePromotion({
      missionId: "llm3-t48-block",
      outcome: "pass",
      contracts,
      methodologyEvidence: disagree,
    });
    const killEvent = t48Blocked.harness.events().find((event) => event.type === "KILL_TESTER_COMPLETED");
    expect(killEvent?.payload.ok).toBe(false);
    expect((killEvent?.payload.objections as string[]).join(" ")).toMatch(/split|OOF|leak/i);
    expect(t48Blocked.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(t48Blocked.state.champion).toBeUndefined();
    expect(t48Blocked.state.branches.candidate.status).toBe("REJECTED");
    expect(() => t48Blocked.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    expect(t48Blocked.arm.setup.ledger.resultFor(t48Blocked.arm.planId)).toBeUndefined();
  });

  test("live stays off; no GPT*; #40 stays off; default parent-selection A is unchanged; no secrets", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    const secret = "sk-llm3-must-never-appear";
    process.env[NEWAPI_API_KEY_ENV] = secret;
    process.env[NEWAPI_LIVE_ENV] = "1";

    const ports = smuggledSearchPorts();
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("LLM.3 must not call live newapi");
    }) as typeof fetch;

    try {
      const before = new MissionDirector({
        missionId: "llm3-before",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });
      const run = await runLlmCompArmBeforePromotion({
        missionId: "llm3-isolation",
        outcome: "pass",
      });
      run.arm.setup.requestExpand();
      projectHypothesisSearchSpaceRefs({
        catalog: run.arm.setup.fixture.catalog,
        hypothesis: run.arm.setup.hypothesis,
        sources: [run.arm.setup.fixture.nearDup, run.arm.setup.fixture.diversity],
        select_node: ports.select_node,
        uct: ports.uct,
        selectionPolicy: { select: ports.select_node },
      } as Parameters<typeof projectHypothesisSearchSpaceRefs>[0] & {
        readonly select_node: () => never;
        readonly uct: () => never;
        readonly selectionPolicy: { readonly select: () => never };
      });
      const after = new MissionDirector({
        missionId: "llm3-after",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });

      expect(run.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(() => createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(/allowlist|not allowlisted/i);
      expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
      expect(before.selectNextTask()?.taskId).toBe("baseline");
      expect(after.selectNextTask()?.taskId).toBe("baseline");
      expect(before.readyTasks().map((task) => task.taskId)).toEqual(
        after.readyTasks().map((task) => task.taskId),
      );
      expect(run.arm.setup.ledger.searchNodes()).toEqual([]);
      expect(run.arm.setup.ledger.events().some((event) => event.type === "hypothesis.expand_requested")).toBe(true);
      expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
      expect(fetches).toBe(0);

      const serialized = JSON.stringify({
        arm: run.arm,
        events: run.harness.events(),
        state: run.state,
        ledger: run.arm.setup.ledger.events(),
      });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("sk-");
      expect(serialized).not.toMatch(/gpt-/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
