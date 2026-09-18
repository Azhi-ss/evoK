/**
 * V1-G self-serve golden-path glue named AC (control-plane).
 *
 * Packages existing assemble / hang. Does not change gate semantics,
 * weld #40, or open live from `EVOK_NEWAPI_LIVE` alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  asKillTestPass,
  killTestOutcomeIsPass,
  type KillTestOutcome,
} from "../hypothesis-ledger";
import {
  createKillTestHangHook,
  killTestOutcomeBlocksBroker,
  runKillTestHang,
} from "../kill-test-hang";
import {
  LiveLlmCompetitionRuntime,
  MOCK_LLM_CANDIDATE_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
} from "../llm-competition-runtime";
import {
  assembleLlmCompArmSetup,
  mapLlmProposalArtifact,
} from "./llm-propose-outer-min";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "../methodology";
import {
  DEFAULT_NEWAPI_MODEL,
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
  resolveDefaultNewapiModel,
  type FetchLike,
} from "../newapi-client";
import { assembleOuterMinPath } from "./outer-min-path";
import { MissionDirector } from "./research-loop";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
} from "../search-selection-port";
import {
  SEARCH_SPACE_BINDING,
  projectHypothesisSearchSpaceRefs,
} from "../search-space-profile";
import type { ToyAgentRuntime } from "../toy-harness";
import { verificationRoleContract } from "../verification-gates";
import {
  V1_GOLDEN_HYPOTHESIS_ID,
  V1_GOLDEN_PLAN_ID,
  assembleV1GoldenPath,
  attachGoldenPathHang,
  projectGoldenPathReview,
  runGoldenPath,
} from "./v1-golden-path";

import { RESEARCH_TASKS as TASKS } from "../fixtures/research";

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];
const LIVE_STUB_FILES = { score: "7", source: "live-fixture" } as const;
const LIVE_STUB_KEY = "sk-v1g-stub-must-not-appear";
const CLAIM = "one claim: mapped proposal must survive hold-out";

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

function runtimeReturning(proposal: unknown): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true, objections: [] }),
    propose: () => proposal as { files: Record<string, string> },
    falsify: () => ({ ok: true, objections: [] }),
  };
}

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for V1-G");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for V1-G");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for V1-G");
    },
  };
}

describe("V1-G self-serve golden-path glue", () => {
  test("mock one-shot returns hypothesisId, planId, mapped refs, and can attach hang", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];

    const oneShot = await runGoldenPath({ statement: CLAIM });
    const setup = await assembleV1GoldenPath({ statement: CLAIM });
    const attached = attachGoldenPathHang(setup);
    const hookSetup = await assembleV1GoldenPath({ statement: CLAIM });

    expect(assembleOuterMinPath).toBeDefined();
    expect(assembleLlmCompArmSetup).toBeDefined();
    expect(oneShot.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(oneShot.hypothesisId).toBe(V1_GOLDEN_HYPOTHESIS_ID);
    expect(oneShot.planId).toBe(V1_GOLDEN_PLAN_ID);
    expect(oneShot.hypothesisId).toBe("h-v1-golden");
    expect(oneShot.planId).toBe("kt-v1-golden");
    expect(oneShot.arm.setup.hypothesis.statement).toBe(CLAIM);
    expect(oneShot.evidenceRefs[0]).toEqual(oneShot.arm.proposalRef);
    expect(oneShot.evidenceRefs).toEqual(oneShot.arm.evidenceRefs);
    expect(oneShot.arm.setup.ledger.state().hypotheses[oneShot.hypothesisId]?.evidenceRefs).toEqual(
      oneShot.evidenceRefs,
    );
    expect(setup.killTestHang).toBeDefined();
    expect(createKillTestHangHook).toBeDefined();
    expect(setup.hang).toBeUndefined();
    expect(setup.summary.hangRun).toBe(false);
    const hooked = await hookSetup.killTestHang({
      role: "KillTester",
      contract: verificationRoleContract("KillTester"),
      missionId: "v1g-attach-hook",
      branchId: "candidate",
      taskContract: { objective: CLAIM },
    });
    expect(hooked.ok).toBe(true);
    const afterHook = projectGoldenPathReview(hookSetup);
    expect(afterHook.timeline.map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
    ]);
    expect(afterHook.summary.hangRun).toBe(true);
    expect(afterHook.summary.passed).toBe(true);
    expect(attached.hang?.ok).toBe(true);
    expect(attached.summary.hangRun).toBe(true);
    expect(oneShot.hang?.ok).toBe(true);
    expect("harness" in oneShot).toBe(false);
  });

  test("events and projection are reviewable: created + kill planned/finished", async () => {
    const setup = await assembleV1GoldenPath({ statement: CLAIM });
    const review = projectGoldenPathReview(setup);
    expect(review.hypothesisId).toBe("h-v1-golden");
    expect(review.planId).toBe("kt-v1-golden");
    expect(review.evidenceRefs).toEqual(setup.evidenceRefs);
    expect(setup.timeline.map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
    ]);
    expect(review.timeline.map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
    ]);
    expect(review.summary.authoritative).toBe(false);

    const hung = await runGoldenPath({ statement: CLAIM, outcome: "pass" });
    expect(hung.timeline.map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
    ]);
    expect(hung.summary.passed).toBe(true);
    expect(hung.summary.blocked).toBe(false);
    expect(hung.summary.status).toBe("open");
    expect(hung.arm.setup.ledger.resultFor(hung.planId)?.outcome).toBe("pass");

    const failed = await runGoldenPath({ statement: CLAIM, outcome: "fail", resultId: "ktr-v1g-fail" });
    expect(failed.timeline.map((event) => event.type)).toContain("kill_test.finished");
    expect(failed.timeline.map((event) => event.type)).toContain("hypothesis.status_changed");
    expect(failed.summary.passed).toBe(false);
    expect(failed.summary.blocked).toBe(true);
    expect(failed.summary.status).toBe("killed");
    expect(failed.summary.authoritative).toBe(false);
    expect(failed.arm.setup.ledger.state().hypotheses[failed.hypothesisId]?.status).toBe("killed");
  });

  test("default mock is zero-net; EVOK_NEWAPI_LIVE alone does not go live", async () => {
    delete process.env[NEWAPI_API_KEY_ENV];
    process.env[NEWAPI_LIVE_ENV] = "1";
    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("V1-G product path must not call live newapi from EVOK_NEWAPI_LIVE alone");
    }) as typeof fetch;

    try {
      const path = await runGoldenPath({
        statement: CLAIM,
        fetch: async () => {
          fetches += 1;
          throw new Error("product golden path must not go live from EVOK_NEWAPI_LIVE alone");
        },
      });
      expect(path.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(path.arm.runtime).not.toBeInstanceOf(LiveLlmCompetitionRuntime);
      expect(path.arm.proposal.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
      expect(fetches).toBe(0);
      expect(JSON.stringify(path)).not.toContain(LIVE_STUB_KEY);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("explicit live: true matches LP1 contracts (key fail-closed, stub files one-shot)", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    await expect(runGoldenPath({ live: true, statement: CLAIM })).rejects.toBeInstanceOf(
      LiveLlmKeyMissingError,
    );

    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    let body = "";
    const path = await runGoldenPath({
      live: true,
      statement: CLAIM,
      model: resolveDefaultNewapiModel(),
      fetch: async (_input, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: JSON.stringify({ files: LIVE_STUB_FILES }) },
          }],
        }), { status: 200 });
      },
    });

    expect(path.arm.runtime).toBeInstanceOf(LiveLlmCompetitionRuntime);
    expect(path.arm.runtime).not.toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(path.arm.proposal.files).toEqual({ ...LIVE_STUB_FILES });
    expect(path.hypothesisId).toBe("h-v1-golden");
    expect(path.planId).toBe("kt-v1-golden");
    expect(path.evidenceRefs[0]).toEqual(path.arm.proposalRef);
    expect(path.timeline.map((event) => event.type)).toContain("kill_test.finished");
    expect(body).toContain(DEFAULT_NEWAPI_MODEL);
    expect(body).not.toContain(LIVE_STUB_KEY);
    expect(JSON.stringify(path)).not.toContain(LIVE_STUB_KEY);
  });

  test("unmapped, scalars, GPT*, and malformed live files fail closed", async () => {
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
      "unmapped-proposal",
    ];
    for (const key of illegal) {
      await expect(runGoldenPath({
        statement: CLAIM,
        evidenceRefs: [key],
      })).rejects.toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    }
    await expect(runGoldenPath({
      statement: CLAIM,
      runtime: runtimeReturning({ mmd: 0.12 }),
    })).rejects.toThrow(/unknown|unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);

    const scalarHang = await runGoldenPath({
      statement: CLAIM,
      outcome: "pass",
      killEvidenceRefs: [{ mmd: 0.12 }],
    });
    expect(scalarHang.summary.blocked).toBe(true);
    expect(scalarHang.hang?.ok).toBe(false);
    expect(scalarHang.arm.setup.ledger.resultFor(scalarHang.planId)).toBeUndefined();

    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    delete process.env[NEWAPI_LIVE_ENV];
    for (const content of ["just prose", "{", "{}", "{\"files\":{}}"]) {
      await expect(runGoldenPath({
        live: true,
        statement: CLAIM,
        fetch: stubProposalFetch(content),
      })).rejects.toThrow(/candidate files/i);
    }
    await expect(runGoldenPath({ live: true, statement: CLAIM, model: "gpt-4" })).rejects.toThrow(
      /allowlist|not allowlisted/i,
    );
    await expect(runGoldenPath({ live: true, statement: CLAIM, model: "GPT-4o" })).rejects.toThrow(
      /allowlist|not allowlisted/i,
    );

    const fixtures = (await assembleV1GoldenPath({ statement: CLAIM })).arm.searchSpace;
    expect(() => fixtures.catalog.map({ score: "99" })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(() => mapLlmProposalArtifact({
      catalog: fixtures.catalog,
      proposal: { files: { score: "99" } },
    })).not.toThrow();
  });

  test("does not change auditMethodology / hang / Broker / SelectionPolicy / #40 / default A", async () => {
    const path = await runGoldenPath({ statement: CLAIM, outcome: "pass" });
    expect(path.arm.setup.fixture.contracts).toEqual({});
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(createDefaultSearchSelectionPort().describe().selectionPolicy40).toBe("off");

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
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);

    const slept = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog: path.arm.setup.fixture.catalog,
    });
    expect(slept.ok).toBe(true);

    const t48Blocked = await runGoldenPath({
      statement: CLAIM,
      outcome: "pass",
      contracts,
      methodologyEvidence: disagree,
    });
    expect(t48Blocked.hang?.ok).toBe(false);
    expect(t48Blocked.summary.blocked).toBe(true);
    expect((t48Blocked.hang?.objections ?? []).join(" ")).toMatch(/split|OOF|leak/i);
    expect(t48Blocked.arm.setup.ledger.resultFor(t48Blocked.planId)).toBeUndefined();

    for (const outcome of ["fail", "inconclusive"] as const) {
      const blocked = await runGoldenPath({
        statement: CLAIM,
        outcome,
        resultId: `ktr-v1g-${outcome}`,
      });
      const recorded = blocked.arm.setup.ledger.resultFor(blocked.planId);
      expect(recorded?.outcome).toBe(outcome);
      expect(killTestOutcomeIsPass(recorded!.outcome)).toBe(false);
      expect(killTestOutcomeBlocksBroker(recorded!.outcome)).toBe(true);
      expect(blocked.summary.blocked).toBe(true);
      if (outcome === "inconclusive") {
        expect(() => asKillTestPass(recorded!.outcome)).toThrow(/inconclusive|not pass/i);
      }
    }
  });

  test("Elite / MMD / near-dup / side-slot never become promotion keys; no submit / auto-schedule", async () => {
    const ports = smuggledSearchPorts();
    const before = new MissionDirector({
      missionId: "v1g-before",
      objective: "improve the competition result",
      budget: 10,
      tasks: TASKS,
    });
    const path = await runGoldenPath({ statement: CLAIM, outcome: "pass" });
    path.arm.setup.requestExpand();
    projectHypothesisSearchSpaceRefs({
      catalog: path.arm.setup.fixture.catalog,
      hypothesis: path.arm.setup.hypothesis,
      sources: [path.arm.setup.fixture.nearDup, path.arm.setup.fixture.diversity],
      select_node: ports.select_node,
      uct: ports.uct,
      selectionPolicy: { select: ports.select_node },
    } as Parameters<typeof projectHypothesisSearchSpaceRefs>[0] & {
      readonly select_node: () => never;
      readonly uct: () => never;
      readonly selectionPolicy: { readonly select: () => never };
    });
    const after = new MissionDirector({
      missionId: "v1g-after",
      objective: "improve the competition result",
      budget: 10,
      tasks: TASKS,
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(before.selectNextTask()?.taskId).toBe("baseline");
    expect(after.selectNextTask()?.taskId).toBe("baseline");
    expect(path.arm.setup.ledger.searchNodes()).toEqual([]);
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
    expect(createLlmCompetitionRuntime()).toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(() => createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(/allowlist|not allowlisted/i);

    const review = projectGoldenPathReview(path);
    const serialized = JSON.stringify({
      hypothesisId: path.hypothesisId,
      planId: path.planId,
      evidenceRefs: path.evidenceRefs,
      timeline: path.timeline,
      summary: path.summary,
    });
    expect(serialized).not.toMatch(/gpt-/i);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toMatch(/"mmd"|"sideSlot"|"nearDup"|"elite"/i);
    expect(review.evidenceRefs.every((ref) => ref.kind === "evidence" || ref.kind === "artifact")).toBe(true);
    expect(() => path.arm.setup.fixture.catalog.map({ mmd: 0.12 })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(() => path.arm.setup.fixture.catalog.map({ sideSlot: 0.8 })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(() => path.arm.setup.fixture.catalog.map({ nearDup: 0.01 })).toThrow(
      /T48|promotion key|side-slot|MMD|near-dup|diversity/i,
    );
    expect(path.summary.authoritative).toBe(false);
    expect("harness" in path).toBe(false);
    expect("submission" in path).toBe(false);
  });
});
