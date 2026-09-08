import { afterEach, describe, expect, test } from "bun:test";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
} from "./newapi-client";
import {
  LiveLlmCompetitionRuntime,
  MOCK_LLM_CANDIDATE_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
} from "./llm-competition-runtime";
import {
  ToyCompetitionHarness,
  type ToyAgentRuntime,
} from "./toy-harness";
import { MissionDirector, type ResearchTask } from "./research-loop";
import { SEARCH_SPACE_BINDING } from "./search-space-profile";

const contract = { objective: "maximize the score" };
const proposeInput = {
  missionId: "llm-1",
  branchId: "candidate",
  taskContract: contract,
  workspace: {} as Record<string, string>,
};

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
  if (savedDefaultModel === undefined) delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
  else process.env[NEWAPI_DEFAULT_MODEL_ENV] = savedDefaultModel;
});

describe("MockLlmCompetitionRuntime", () => {
  test("propose is deterministic and makes zero network calls", async () => {
    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("mock runtime must not use the network");
    }) as typeof fetch;
    try {
      const runtime = new MockLlmCompetitionRuntime();
      const first = await runtime.propose(proposeInput);
      const second = await runtime.propose(proposeInput);
      expect(first.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
      expect(second.files).toEqual(first.files);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("is callable from the existing harness propose seam", async () => {
    const runtime: ToyAgentRuntime = new MockLlmCompetitionRuntime();
    const harness = new ToyCompetitionHarness({
      missionId: "llm-mock-harness",
      taskContract: contract,
      branchIds: ["candidate"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(result.champion?.snapshot.files).toEqual({ ...MOCK_LLM_CANDIDATE_FILES });
    expect(harness.events().some((event) => event.type === "CANDIDATE_GENERATED")).toBe(true);
  });

  test("does not write secrets into ledger events or snapshots", async () => {
    const secret = "sk-ledger-secret-must-never-appear";
    process.env[NEWAPI_API_KEY_ENV] = secret;
    const harness = new ToyCompetitionHarness({
      missionId: "llm-mock-secrets",
      taskContract: contract,
      branchIds: ["candidate"],
      runtime: new MockLlmCompetitionRuntime(),
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
      secrets: [secret],
    });

    await harness.run();

    const serialized = JSON.stringify({ events: harness.events(), state: harness.state() });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-ledger");
  });
});

describe("createLlmCompetitionRuntime", () => {
  test("defaults to the mock runtime while live is off", () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    const runtime = createLlmCompetitionRuntime();
    expect(runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(runtime).not.toBeInstanceOf(LiveLlmCompetitionRuntime);
  });

  test("rejects non-allowlisted models before propose", () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    expect(() => createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(/allowlist|not allowlisted/i);
    expect(() => createLlmCompetitionRuntime({ model: "claude-3" })).toThrow(/allowlist|not allowlisted/i);
    expect(() => createLlmCompetitionRuntime({ model: "DeepSeek-V3" })).not.toThrow();
    expect(() => createLlmCompetitionRuntime({ model: "Gemini-2.5-pro" })).not.toThrow();
  });

  test("unspecified model uses the catalog default and allowlisted NEWAPI_DEFAULT_MODEL override", async () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    process.env[NEWAPI_API_KEY_ENV] = "sk-present-but-must-not-be-logged";
    let body = "";
    const catalogRuntime = createLlmCompetitionRuntime({
      live: true,
      fetch: async (_input, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "{\"files\":{\"score\":\"1\"}}" } }],
        }), { status: 200 });
      },
    });
    await catalogRuntime.propose(proposeInput);
    expect(body).toContain("deepseek-v4-flash-ga-260731");
    expect(body).not.toContain("DeepSeek-V3");
    expect(body).not.toContain("sk-present");

    process.env[NEWAPI_DEFAULT_MODEL_ENV] = "Gemini-2.5-pro";
    const overrideRuntime = createLlmCompetitionRuntime({
      live: true,
      fetch: async (_input, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "{\"files\":{\"score\":\"1\"}}" } }],
        }), { status: 200 });
      },
    });
    await overrideRuntime.propose(proposeInput);
    expect(body).toContain("Gemini-2.5-pro");
    expect(JSON.stringify(overrideRuntime)).not.toContain("sk-present");
  });

  test("NEWAPI_DEFAULT_MODEL gpt-* fails closed before propose", () => {
    process.env[NEWAPI_DEFAULT_MODEL_ENV] = "gpt-4";
    expect(() => createLlmCompetitionRuntime()).toThrow(/allowlist|not allowlisted/i);
    expect(() => createLlmCompetitionRuntime({ live: true })).toThrow(/allowlist|not allowlisted/i);
  });

  test("enabling live without a key fails closed and does not fall back to mock", () => {
    delete process.env[NEWAPI_API_KEY_ENV];
    let created: ToyAgentRuntime | undefined;
    try {
      created = createLlmCompetitionRuntime({ live: true, model: "DeepSeek-V3" });
    } catch (error) {
      expect(error).toBeInstanceOf(LiveLlmKeyMissingError);
      expect(error instanceof Error ? error.message : "").not.toMatch(/sk-|Bearer /);
    }
    expect(created).toBeUndefined();
    expect(created instanceof MockLlmCompetitionRuntime).toBe(false);
  });

  test("live with a key returns the live runtime, not the mock", () => {
    process.env[NEWAPI_API_KEY_ENV] = "sk-present-but-must-not-be-logged";
    const runtime = createLlmCompetitionRuntime({ live: true, model: "DeepSeek-V3" });
    expect(runtime).toBeInstanceOf(LiveLlmCompetitionRuntime);
    expect(runtime).not.toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(JSON.stringify(runtime)).not.toContain("sk-present");
  });
});

describe("LLM.1 control-plane isolation", () => {
  test("does not change default parent selection A or thaw #40 SelectionPolicy", () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    const tasks: readonly ResearchTask[] = [
      { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
      { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
    ];
    const before = new MissionDirector({
      missionId: "llm1-before",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    createLlmCompetitionRuntime();
    const after = new MissionDirector({
      missionId: "llm1-after",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(before.selectNextTask()?.taskId).toBe("baseline");
    expect(after.selectNextTask()?.taskId).toBe("baseline");
  });
});
