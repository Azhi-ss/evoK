/**
 * ME-1 propose → methodologyEvidence auto-seam named AC.
 *
 * Convention keys on proposal `files` are parsed through existing
 * `readMethodologyEvidence` / `readMethodologyManifest`. Hang / audit /
 * OOF source semantics stay unchanged. Default mock stays zero-network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import oofManifest from "../fixtures/methodology/manifest-oof.json";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_LIVE_ENV,
  type FetchLike,
} from "../newapi-client";
import {
  MOCK_LLM_CANDIDATE_FILES,
  MOCK_LLM_METHODOLOGY_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
} from "../llm-competition-runtime";
import {
  assembleLlmCompArmSetup,
  readProposalMethodologyEvidence,
} from "../llm-propose-outer-min";
import {
  auditMethodology,
  oofEnsembleGate,
  readMethodologyEvidence,
  readMethodologyManifest,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import { runKillTestHang } from "./kill-test-hang";
import { OUTER_MIN_KILL_EVIDENCE_ID } from "../outer-min-path";
import type { ToyAgentRuntime } from "../toy-harness";
import { verificationRoleContract } from "./verification-gates";
import { runGoldenPath } from "../v1-golden-path";

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const LIVE_STUB_KEY = "sk-me1-stub-must-not-appear";
const AWAKE: MethodologyContracts = {
  splitContract: { splitRef: { digest: "sha256:toy-split-ref-v1" } },
  oofEnsemble: { required: true },
};
const DISAGREE: MethodologyEvidence = {
  splitRefDigest: "sha256:other",
  splitDigestAgreement: "disagree",
  oofPresent: false,
};

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
});

function stubProposalFetch(content: string): FetchLike {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
  }), { status: 200 });
}

function runtimeReturning(files: Record<string, string>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true, objections: [] }),
    propose: () => ({ files: { ...files } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

function hangContext(missionId: string) {
  return {
    role: "KillTester" as const,
    contract: verificationRoleContract("KillTester"),
    missionId,
    branchId: "candidate",
    taskContract: { objective: "ME-1 methodology auto-seam" },
  };
}

describe("ME-1 proposal methodology file convention", () => {
  test("readMethodologyEvidence is the existing manifest reader", () => {
    expect(readMethodologyEvidence).toBe(readMethodologyManifest);
    const evidence = readMethodologyEvidence(oofManifest, AWAKE);
    expect(evidence.splitDigestAgreement).toBe("agree");
    expect(evidence.oofPresent).toBe(true);
    expect(auditMethodology(evidence, AWAKE).ok).toBe(true);
    expect(oofEnsembleGate(evidence, AWAKE).ok).toBe(true);
  });

  test("reads methodology.json and synonyms through readMethodologyEvidence", () => {
    const raw = JSON.stringify(oofManifest);
    const fromCanonical = readProposalMethodologyEvidence({
      score: "1",
      "methodology.json": raw,
    }, AWAKE);
    const fromManifest = readProposalMethodologyEvidence({
      score: "1",
      "manifest.json": raw,
    }, AWAKE);
    const fromBare = readProposalMethodologyEvidence({
      score: "1",
      methodology: raw,
    }, AWAKE);
    expect(fromCanonical).toEqual(readMethodologyEvidence(oofManifest, AWAKE));
    expect(fromManifest).toEqual(fromCanonical);
    expect(fromBare).toEqual(fromCanonical);
    expect(readProposalMethodologyEvidence({ score: "1" }, AWAKE)).toBeUndefined();
  });

  test("malformed or non-object convention values fail closed", () => {
    expect(() => readProposalMethodologyEvidence({
      "methodology.json": "{",
    })).toThrow(/methodology\.json|valid JSON|plain object/i);
    expect(() => readProposalMethodologyEvidence({
      "methodology.json": "[]",
    })).toThrow(/methodology\.json|plain object/i);
    expect(() => readProposalMethodologyEvidence({
      "manifest.json": "null",
    })).toThrow(/manifest\.json|plain object/i);
    expect(() => readProposalMethodologyEvidence({
      methodology: "\"just a string\"",
    })).toThrow(/methodology|plain object/i);
  });
});

describe("ME-1 assemble / golden-path auto-seam", () => {
  test("no explicit evidence + valid methodology.json + awake contracts → hang pass", async () => {
    const runtime = runtimeReturning({
      ...MOCK_LLM_CANDIDATE_FILES,
      "methodology.json": JSON.stringify(oofManifest),
    });
    const arm = await assembleLlmCompArmSetup({ runtime, contracts: AWAKE });
    const hooked = await arm.killTestHang(hangContext("me1-assemble-pass"));
    expect(arm.methodologyEvidence?.splitDigestAgreement).toBe("agree");
    expect(arm.methodologyEvidence?.oofPresent).toBe(true);
    expect(hooked.ok).toBe(true);

    const path = await runGoldenPath({
      statement: "auto-seam awake pass",
      runtime,
      contracts: AWAKE,
    });
    expect(path.hang?.ok).toBe(true);
    expect(path.summary.passed).toBe(true);
    expect(path.summary.blocked).toBe(false);
    expect(path.arm.setup.ledger.resultFor(path.planId)?.outcome).toBe("pass");
  });

  test("mock emitMethodologyManifest covers auto-seam zero-net without manual inject", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("ME-1 mock auto-seam must not use the network");
    }) as typeof fetch;

    try {
      const runtime = new MockLlmCompetitionRuntime({ emitMethodologyManifest: true });
      expect(runtime.propose({
        missionId: "me1",
        branchId: "candidate",
        taskContract: { objective: "emit" },
        workspace: {},
      }).files).toEqual({ ...MOCK_LLM_METHODOLOGY_FILES });
      expect(createLlmCompetitionRuntime({ emitMethodologyManifest: true }))
        .toBeInstanceOf(MockLlmCompetitionRuntime);

      const arm = await assembleLlmCompArmSetup({
        runtime,
        contracts: AWAKE,
      });
      const hooked = await arm.killTestHang(hangContext("me1-mock-zero-net"));
      expect(arm.proposal.files["methodology.json"]).toBe(MOCK_LLM_METHODOLOGY_FILES["methodology.json"]);
      expect(hooked.ok).toBe(true);
      expect(fetches).toBe(0);

      const path = await runGoldenPath({
        statement: "mock emit auto-seam",
        emitMethodologyManifest: true,
        contracts: AWAKE,
      });
      expect(path.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      expect(path.hang?.ok).toBe(true);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("default mock stays score-only; awake + missing evidence still blocks", async () => {
    const defaultMock = new MockLlmCompetitionRuntime();
    expect(defaultMock.propose({
      missionId: "me1-default",
      branchId: "candidate",
      taskContract: { objective: "default" },
      workspace: {},
    }).files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
    expect(defaultMock.propose({
      missionId: "me1-default",
      branchId: "candidate",
      taskContract: { objective: "default" },
      workspace: {},
    }).files["methodology.json"]).toBeUndefined();

    const arm = await assembleLlmCompArmSetup({ contracts: AWAKE });
    const hooked = await arm.killTestHang(hangContext("me1-awake-missing"));
    expect(arm.methodologyEvidence).toBeUndefined();
    expect(hooked.ok).toBe(false);
    expect(hooked.objections.join(" ")).toMatch(/split|OOF|leak|missing/i);

    const path = await runGoldenPath({
      statement: "awake missing evidence",
      contracts: AWAKE,
    });
    expect(path.hang?.ok).toBe(false);
    expect(path.summary.blocked).toBe(true);
    expect(path.arm.setup.ledger.resultFor(path.planId)).toBeUndefined();
  });

  test("empty contracts sleep whether or not the methodology key is present", async () => {
    const withKey = await assembleLlmCompArmSetup({
      runtime: new MockLlmCompetitionRuntime({ emitMethodologyManifest: true }),
    });
    const withoutKey = await assembleLlmCompArmSetup();
    expect(withKey.setup.fixture.contracts).toEqual({});
    expect(withoutKey.setup.fixture.contracts).toEqual({});
    expect((await withKey.killTestHang(hangContext("me1-sleep-key"))).ok).toBe(true);
    expect((await withoutKey.killTestHang(hangContext("me1-sleep-none"))).ok).toBe(true);

    const sleptWithKey = await runGoldenPath({
      statement: "empty contracts with key",
      emitMethodologyManifest: true,
    });
    const sleptWithout = await runGoldenPath({ statement: "empty contracts no key" });
    expect(sleptWithKey.hang?.ok).toBe(true);
    expect(sleptWithout.hang?.ok).toBe(true);

    const emptyObject = await runGoldenPath({
      statement: "empty object contracts",
      contracts: {},
      emitMethodologyManifest: true,
    });
    expect(emptyObject.hang?.ok).toBe(true);
  });

  test("explicit methodologyEvidence overrides the auto-seam", async () => {
    const runtime = new MockLlmCompetitionRuntime({ emitMethodologyManifest: true });
    const arm = await assembleLlmCompArmSetup({
      runtime,
      contracts: AWAKE,
      methodologyEvidence: DISAGREE,
    });
    const hooked = await arm.killTestHang(hangContext("me1-override"));
    expect(arm.methodologyEvidence).toEqual(DISAGREE);
    expect(hooked.ok).toBe(false);
    expect(hooked.objections.join(" ")).toMatch(/split|OOF|leak/i);

    const path = await runGoldenPath({
      statement: "explicit disagree wins",
      runtime,
      contracts: AWAKE,
      methodologyEvidence: DISAGREE,
    });
    expect(path.hang?.ok).toBe(false);
    expect(path.summary.blocked).toBe(true);
    expect(path.arm.setup.ledger.resultFor(path.planId)).toBeUndefined();

    const malformedButOverridden = await assembleLlmCompArmSetup({
      runtime: runtimeReturning({
        score: "1",
        "methodology.json": "{",
      }),
      contracts: AWAKE,
      methodologyEvidence: {
        splitRefDigest: "sha256:toy-split-ref-v1",
        splitDigestAgreement: "agree",
        oofPresent: true,
      },
    });
    expect((await malformedButOverridden.killTestHang(hangContext("me1-override-malformed"))).ok).toBe(true);
  });

  test("malformed convention key fails closed and does not silently drop", async () => {
    await expect(assembleLlmCompArmSetup({
      runtime: runtimeReturning({ score: "1", "methodology.json": "{" }),
      contracts: AWAKE,
    })).rejects.toThrow(/methodology\.json|valid JSON|plain object/i);

    await expect(runGoldenPath({
      statement: "malformed convention",
      runtime: runtimeReturning({ score: "1", "manifest.json": "[]" }),
    })).rejects.toThrow(/manifest\.json|plain object/i);
  });

  test("live prompt allows methodology.json; unstructured / missing files still fail-closed", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    await expect(assembleLlmCompArmSetup({ live: true })).rejects.toBeInstanceOf(LiveLlmKeyMissingError);
    await expect(runGoldenPath({ live: true, statement: "live key missing" })).rejects.toBeInstanceOf(
      LiveLlmKeyMissingError,
    );

    process.env[NEWAPI_API_KEY_ENV] = LIVE_STUB_KEY;
    let body = "";
    const liveFiles = {
      score: "7",
      "methodology.json": JSON.stringify(oofManifest),
    };
    const arm = await assembleLlmCompArmSetup({
      live: true,
      contracts: AWAKE,
      fetch: async (_input, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: JSON.stringify({ files: liveFiles }) },
          }],
        }), { status: 200 });
      },
    });
    expect(body).toMatch(/methodology\.json/i);
    expect(arm.proposal.files["methodology.json"]).toBe(liveFiles["methodology.json"]);
    expect((await arm.killTestHang(hangContext("me1-live-auto"))).ok).toBe(true);
    expect(JSON.stringify(arm)).not.toContain(LIVE_STUB_KEY);

    for (const content of ["just prose", "{", "{}", "{\"files\":{}}"]) {
      await expect(assembleLlmCompArmSetup({
        live: true,
        fetch: stubProposalFetch(content),
      })).rejects.toThrow(/candidate files/i);
      await expect(runGoldenPath({
        live: true,
        statement: "live fail-closed",
        fetch: stubProposalFetch(content),
      })).rejects.toThrow(/candidate files/i);
    }
  });

  test("does not change hang / audit / OOF source semantics or invent evidence", async () => {
    const arm = await assembleLlmCompArmSetup();
    expect(arm.methodologyEvidence).toBeUndefined();
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }, AWAKE).ok).toBe(false);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }, AWAKE).ok).toBe(false);
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);

    const slept = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: arm.setup.fixture.catalog,
    });
    expect(slept.ok).toBe(true);

    const blocked = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [OUTER_MIN_KILL_EVIDENCE_ID],
      catalog: arm.setup.fixture.catalog,
      contracts: AWAKE,
    });
    expect(blocked.ok).toBe(false);
  });
});
