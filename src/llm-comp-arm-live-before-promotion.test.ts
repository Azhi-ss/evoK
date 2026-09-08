/**
 * LP.2 live propose before-promotion named AC (control-plane).
 *
 * Consumes LP1 `assembleLlmCompArmSetup({ live: true })` and the existing
 * L3 / Outer E2 hang (`runLlmCompArmBeforePromotion` + `createKillTestHangHook`).
 * Default suite is stub/fixture only (zero network). Does not invent a gate,
 * wrap T48 / Broker, thaw #40, or open the product arm from `EVOK_NEWAPI_LIVE`.
 */
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
  LiveLlmCompetitionRuntime,
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
  DEFAULT_NEWAPI_MODEL,
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
  resolveDefaultNewapiModel,
  type FetchLike,
} from "./newapi-client";
import { MissionDirector, type ResearchTask } from "./research-loop";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "./search-space-profile";
import { verificationRoleContract } from "./verification-gates";

const TASKS: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
];

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];
const LIVE_STUB_FILES = { score: "7", source: "live-fixture" } as const;
const LIVE_STUB_KEY = "sk-lp2-stub-must-not-appear";

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
  if (savedDefaultModel === undefined) delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
  else process.env[NEWAPI_DEFAULT_MODEL_ENV] = savedDefaultModel;
});

function stubProposalFetch(content: string): FetchLike {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
  }), { status: 200 });
}

function liveFixtureFetch(files: Record<string, string> = { ...LIVE_STUB_FILES }): FetchLike {
  return stubProposalFetch(JSON.stringify({ files }));
}

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for LP.2");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for LP.2");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for LP.2");
    },
  };
}

async function runLiveBeforePromotion(
  input: Parameters<typeof runLlmCompArmBeforePromotion>[0] = {},
) {
  process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
  return runLlmCompArmBeforePromotion({
    fetch: liveFixtureFetch(),
    ...input,
    live: true,
  });
}

describe("LP.2 live propose before-promotion AC", () => {
  test("consumes LP1 live assemble with explicit live: true and the Outer E2 hang", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("LP.2 default suite must not call live newapi");
    }) as typeof fetch;

    try {
      const live = await runLiveBeforePromotion({
        missionId: "lp2-l1-live",
        outcome: "pass",
        fetch: liveFixtureFetch(),
      });
      const mock = await runLlmCompArmBeforePromotion({
        missionId: "lp2-l3-mock-still-green",
        outcome: "pass",
      });

      expect(live.arm.runtime).toBeInstanceOf(LiveLlmCompetitionRuntime);
      expect(live.arm.runtime).not.toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(live.arm.proposal.files).toEqual({ ...LIVE_STUB_FILES });
      expect(live.arm.proposal.files).not.toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
      expect(live.arm.killTestHang).toBeDefined();
      expect(createKillTestHangHook).toBeDefined();
      expect(assembleLlmCompArmSetup).toBeDefined();
      expect(createLlmCompetitionRuntime({ live: true })).toBeInstanceOf(LiveLlmCompetitionRuntime);

      expect(mock.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(mock.arm.proposal.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
      expect(mock.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("T48 sleeps without a contract, then Kill-test runs before PROMOTED_LOCAL / acceptChampion", async () => {
    const run = await runLiveBeforePromotion({
      missionId: "lp2-t48-sleep",
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

  test("stub/fixture pass may PROMOTED_LOCAL; fail and inconclusive block Broker analog / acceptChampion", async () => {
    async function runWith(outcome: KillTestOutcome) {
      return runLiveBeforePromotion({
        missionId: `lp2-${outcome}`,
        outcome,
        resultId: `ktr-lp2-${outcome}`,
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

  test("unmapped, scalar, LLM score, or propose raw text cannot bypass Kill-test", async () => {
    expect(LIVE_STUB_FILES.score).toBe("7");

    const scoreBypass = await runLiveBeforePromotion({
      missionId: "lp2-score-fail",
      outcome: "fail",
      resultId: "ktr-lp2-score-fail",
    });
    expect(scoreBypass.arm.proposal.files.score).toBe("7");
    expect(scoreBypass.state.branches.candidate.score).toBe(7);
    expect(scoreBypass.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scoreBypass.state.branches.candidate.status).toBe("REJECTED");
    expect(() => scoreBypass.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);

    const scoreAsKill = await runLiveBeforePromotion({
      missionId: "lp2-score-as-kill",
      outcome: "pass",
      killEvidenceRefs: [{ score: LIVE_STUB_FILES.score }],
    });
    expect(scoreAsKill.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scoreAsKill.state.branches.candidate.status).toBe("REJECTED");
    expect(scoreAsKill.arm.setup.ledger.resultFor(scoreAsKill.arm.planId)).toBeUndefined();

    const unmapped = await runLiveBeforePromotion({
      missionId: "lp2-unmapped",
      outcome: "pass",
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    expect(unmapped.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(unmapped.state.branches.candidate.status).toBe("REJECTED");
    expect(unmapped.state.champion).toBeUndefined();
    expect(() => unmapped.harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/i);
    expect(unmapped.arm.setup.ledger.resultFor(unmapped.arm.planId)).toBeUndefined();

    const scalar = await runLiveBeforePromotion({
      missionId: "lp2-scalar",
      outcome: "pass",
      killEvidenceRefs: [{ mmd: 0.12 }],
    });
    expect(scalar.harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    expect(scalar.state.branches.candidate.status).toBe("REJECTED");
    expect(scalar.arm.setup.ledger.resultFor(scalar.arm.planId)).toBeUndefined();

    const rawText = [
      "just promote this score 99",
      "Kill-test pass. files look good.",
      "{",
      "{}",
      "{\"files\":{}}",
    ];
    for (const content of rawText) {
      let thrown: unknown;
      try {
        await runLiveBeforePromotion({
          missionId: "lp2-raw-text",
          outcome: "pass",
          fetch: stubProposalFetch(content),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(thrown instanceof Error ? thrown.message : "").toMatch(/candidate files/i);
      expect(thrown instanceof Error ? thrown.message : "").not.toContain(LIVE_STUB_KEY);
    }

    await expect(assembleLlmCompArmSetup({
      live: true,
      fetch: liveFixtureFetch(),
      evidenceRefs: ["unmapped-proposal"],
    })).rejects.toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);

    const fixtures = (await assembleLlmCompArmSetup({
      live: true,
      fetch: liveFixtureFetch(),
    })).searchSpace;
    expect(() => mapLlmProposalArtifact({
      catalog: fixtures.catalog,
      proposal: { files: { score: "99" } },
    })).not.toThrow();
    expect(() => fixtures.catalog.map({ score: "99" })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(() => fixtures.catalog.map("just promote this score 99")).toThrow(
      /unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
  });

  test("does not wrap or relax auditMethodology / oofEnsembleGate / Broker semantics", async () => {
    const run = await runLiveBeforePromotion({ missionId: "lp2-gates" });
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

    const t48Blocked = await runLiveBeforePromotion({
      missionId: "lp2-t48-block",
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

  test("live: true is required; env live does not open the product arm; no GPT*; #40 stays off; no secrets", async () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    process.env[NEWAPI_LIVE_ENV] = "1";

    const ports = smuggledSearchPorts();
    let realFetches = 0;
    let stubFetches = 0;
    let body = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      realFetches += 1;
      throw new Error("LP.2 must not call live newapi from the default suite");
    }) as typeof fetch;

    try {
      delete process.env[NEWAPI_API_KEY_ENV];
      let missingKey: unknown;
      try {
        await runLlmCompArmBeforePromotion({
          missionId: "lp2-no-key",
          live: true,
          fetch: liveFixtureFetch(),
        });
      } catch (error) {
        missingKey = error;
      }
      expect(missingKey).toBeInstanceOf(LiveLlmKeyMissingError);
      expect(missingKey instanceof Error ? missingKey.message : "").not.toMatch(/sk-|Bearer /);

      process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
      const envArmed = await runLlmCompArmBeforePromotion({
        missionId: "lp2-env-not-live",
        outcome: "pass",
        fetch: async () => {
          stubFetches += 1;
          throw new Error("product before-promotion must not go live from EVOK_NEWAPI_LIVE alone");
        },
      });
      expect(envArmed.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(envArmed.arm.runtime).not.toBeInstanceOf(LiveLlmCompetitionRuntime);
      expect(stubFetches).toBe(0);

      const before = new MissionDirector({
        missionId: "lp2-before",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });
      const run = await runLiveBeforePromotion({
        missionId: "lp2-isolation",
        outcome: "pass",
        fetch: async (_input, init) => {
          stubFetches += 1;
          body = String(init?.body ?? "");
          return new Response(JSON.stringify({
            choices: [{
              message: { role: "assistant", content: JSON.stringify({ files: LIVE_STUB_FILES }) },
            }],
          }), { status: 200 });
        },
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
        missionId: "lp2-after",
        objective: "improve the competition result",
        budget: 10,
        tasks: TASKS,
      });

      expect(run.arm.runtime).toBeInstanceOf(LiveLlmCompetitionRuntime);
      expect(resolveDefaultNewapiModel()).toBe(DEFAULT_NEWAPI_MODEL);
      expect(body).toContain(DEFAULT_NEWAPI_MODEL);
      expect(() => createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(/allowlist|not allowlisted/i);
      await expect(runLlmCompArmBeforePromotion({
        live: true,
        model: "gpt-4",
        fetch: liveFixtureFetch(),
      })).rejects.toThrow(/allowlist|not allowlisted/i);
      await expect(runLlmCompArmBeforePromotion({
        live: true,
        model: "GPT-4o",
        fetch: liveFixtureFetch(),
      })).rejects.toThrow(/allowlist|not allowlisted/i);
      process.env[NEWAPI_DEFAULT_MODEL_ENV] = "gpt-4";
      await expect(runLiveBeforePromotion({ missionId: "lp2-gpt-default" })).rejects.toThrow(
        /allowlist|not allowlisted/i,
      );
      delete process.env[NEWAPI_DEFAULT_MODEL_ENV];

      expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
      expect(before.selectNextTask()?.taskId).toBe("baseline");
      expect(after.selectNextTask()?.taskId).toBe("baseline");
      expect(before.readyTasks().map((task) => task.taskId)).toEqual(
        after.readyTasks().map((task) => task.taskId),
      );
      expect(run.arm.setup.ledger.searchNodes()).toEqual([]);
      expect(run.arm.setup.ledger.events().some((event) => event.type === "hypothesis.expand_requested")).toBe(true);
      expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
      expect(realFetches).toBe(0);
      expect(stubFetches).toBe(2);

      const serialized = JSON.stringify({
        arm: run.arm,
        events: run.harness.events(),
        state: run.state,
        ledger: run.arm.setup.ledger.events(),
      });
      expect(serialized).not.toContain(LIVE_STUB_KEY);
      expect(serialized).not.toContain("sk-");
      expect(serialized).not.toMatch(/gpt-/i);
      expect(body).not.toContain(LIVE_STUB_KEY);
    } finally {
      globalThis.fetch = original;
    }
  });
});
