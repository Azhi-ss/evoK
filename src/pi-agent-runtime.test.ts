import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  PiAgentRuntime,
  SessionPolicyViolation,
  defaultSessionFactory,
  type AgentRuntimeResult,
  type AgentRuntimeSession,
  type PiAgentRuntimeRequest,
} from "./pi-agent-runtime";
import { ScoreFileToyCompetitionAdapter, ToyCompetitionHarness } from "./toy-harness";

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

const workspace = (path = "/tmp/evok-approved") => ({ path, isolated: true as const, approved: true as const });
const request = (overrides: Partial<PiAgentRuntimeRequest> = {}): PiAgentRuntimeRequest => ({
  task: { objective: "inspect the repository" },
  role: { name: "researcher", instructions: "report observations" },
  workspace: workspace(),
  ...overrides,
});

function assertExternalCompletion(result: AgentRuntimeResult, approvedRoot: string) {
  expect(result.workspace).toContain(`${approvedRoot}/run-`);
  expect(result.stopReason).toBe("stop");
  expect(result.usage.tokens.total).toBeGreaterThan(0);
  expect(Number.isFinite(result.usage.cost.total)).toBe(true);
  expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
    "session_start", "agent_start", "tool_execution_start", "tool_execution_end", "agent_end", "session_end",
  ]));
}

const POLICY_LIFECYCLE_TYPES = [
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
] as const;

const completeEnd = {
  type: "agent_end",
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" }],
};

function fakeSession(events: readonly Record<string, unknown>[], stats = {
  tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
  cost: 0.01,
}) {
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let aborted = false;
  const session: AgentRuntimeSession = {
    sessionId: "fake-session",
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() { for (const event of events) listener?.(event); },
    async abort() { aborted = true; },
    dispose() { listener = undefined; },
    getSessionStats() { return stats; },
  };
  return { session, wasAborted: () => aborted };
}

describe("PiAgentRuntime", () => {
  test("executes an approved plan, normalizes lifecycle/tools/usage/stop, and disposes", async () => {
    let created!: { cwd: string; tools: string[] };
    let disposed = false;
    const fake = fakeSession([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "README.md" } },
      { type: "tool_execution_update", toolCallId: "1", toolName: "read", args: {}, partialResult: { text: "x" } },
      { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { text: "x" }, isError: false },
      { type: "agent_end", messages: [{ role: "assistant", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }, stopReason: "stop" }] },

    ]);
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async (options) => { created = { cwd: options.cwd!, tools: options.tools! }; return fake.session; },
      onDispose: () => { disposed = true; },
    });
    const result = await runtime.execute(request());
    expect(created.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(created.cwd).toContain("/tmp/evok-approved/");
    assertExternalCompletion(result, "/tmp/evok-approved");
    expect(result.usage.cost.total).toBe(0.01);
    expect(result.events.map((event) => event.type)).toEqual([
      "session_start", "agent_start", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_end", "session_end",
    ]);
    expect(disposed).toBe(true);
  });

  test("rejects malformed plans, unapproved workspaces, and coding tools outside isolation", async () => {
    const runtime = new PiAgentRuntime({ sessionFactory: async () => { throw new Error("must not create"); } });
    await expect(runtime.execute(request({ task: { objective: "" } }))).rejects.toThrow("task objective");
    await expect(runtime.execute(request({ role: { name: "" } }))).rejects.toThrow("role");
    await expect(runtime.execute(request({ workspace: undefined }))).rejects.toThrow("workspace");
    await expect(runtime.execute(request({ workspace: { path: "/tmp/shared", isolated: false, approved: true }, role: { name: "r", tools: ["write"] } }))).rejects.toThrow("isolated");
    await expect(runtime.execute(request({ role: { name: "r", tools: ["write"] }, workspace: workspace("/tmp/shared") }))).rejects.toThrow("approved isolated workspace");
  });

  test("enables coding tools only for an explicitly granted approved workspace", async () => {
    let tools: string[] = [];
    const fake = fakeSession([{ type: "agent_end", messages: [{ role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" }] }]);
    const runtime = new PiAgentRuntime({ sessionFactory: async (options) => { tools = options.tools!; return fake.session; } });
    await runtime.execute(request({ role: { name: "coder", tools: ["read", "write"], allowCodingTools: true } }));
    expect(tools).toEqual(["read", "write"]);
  });

  test("rejects truthy policy fields before enabling coding tools", async () => {
    const invalidRequests = [
      request({ workspace: { path: "/tmp/truthy-approved", approved: "false", isolated: true } as unknown as PiAgentRuntimeRequest["workspace"], role: { name: "coder", tools: ["write"], allowCodingTools: true } }),
      request({ workspace: { path: "/tmp/truthy-approved-true", approved: "true", isolated: true } as unknown as PiAgentRuntimeRequest["workspace"], role: { name: "coder", tools: ["write"], allowCodingTools: true } }),
      request({ workspace: { path: "/tmp/truthy-isolated", approved: true, isolated: "true" } as unknown as PiAgentRuntimeRequest["workspace"], role: { name: "coder", tools: ["edit"], allowCodingTools: true } }),
      request({ workspace: { path: "/tmp/numeric-approved", approved: 1, isolated: true } as unknown as PiAgentRuntimeRequest["workspace"], role: { name: "coder", tools: ["bash"], allowCodingTools: true } }),
      request({ workspace: { path: "/tmp/null-isolated", approved: true, isolated: null } as unknown as PiAgentRuntimeRequest["workspace"], role: { name: "coder", tools: ["write"], allowCodingTools: true } }),
      request({ role: { name: "coder", tools: ["bash"], allowCodingTools: "true" as unknown as boolean } }),
      request({ role: { name: "coder", tools: ["write"], allowCodingTools: "false" as unknown as boolean } }),
      request({ role: { name: "coder", tools: ["edit"], allowCodingTools: null as unknown as boolean } }),
      request({ role: { name: "coder", tools: ["bash"], allowCodingTools: 1 as unknown as boolean } }),
    ];

    for (const [index, invalid] of invalidRequests.entries()) {
      let tools: string[] = [];
      let created = false;
      const fake = fakeSession([{ type: "agent_end", messages: [{ role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" }] }]);
      const runtime = new PiAgentRuntime({
        sessionFactory: async (options) => { created = true; tools = options.tools!; return { ...fake.session, sessionId: `invalid-policy-${index}` }; },
      });
      await expect(runtime.execute(invalid)).rejects.toThrow();
      expect(created).toBe(false);
      expect(tools).not.toContain("write");
      expect(tools).not.toContain("edit");
      expect(tools).not.toContain("bash");
    }
  });

  test("propagates prompt errors and aborts during prompt without leaking listeners", async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    let abort!: () => void;
    const session: AgentRuntimeSession = {
      sessionId: "errors",
      subscribe() { subscribed++; return () => { unsubscribed++; }; },
      prompt() { return new Promise<void>((_, reject) => { abort = () => reject(new Error("prompt failed")); }); },
      abort: async () => abort?.(),
      dispose() {},
      getSessionStats() { return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }; },
    };
    const runtime = new PiAgentRuntime({ sessionFactory: async () => session });
    const controller = new AbortController();
    const run = runtime.execute(request(), controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(1);
  });

  test("runs the ToyCompetitionHarness through the Pi facade without changing evaluator/promotion", async () => {
    let sessionNumber = 0;
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async () => {
        const response = sessionNumber++ === 1
          ? '{"files":{"score":"7"}}'
          : '{"ok":true,"objections":[]}';
        return {
          ...fakeSession([{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: response }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" }] }]).session,
          sessionId: `facade-${sessionNumber}`,
        };
      },
    });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "pi-facade",
      taskContract: { objective: "produce a score" },
      branchIds: ["pi"],
      runtime,
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();
    expect(result.champion?.score).toBe(7);
    expect(harness.events().map((event) => event.type)).toEqual(expect.arrayContaining(["EVALUATOR_SUCCEEDED", "PROMOTED_LOCAL"]));
  });

  test("rejects malformed self-verification output with a retained objection", async () => {
    const malformed = [undefined, "not json", "42", "[]", "{}", '{"ok":"true"}'];
    for (const [index, text] of malformed.entries()) {
      const fake = fakeSession([{ type: "agent_end", messages: [{ role: "assistant", content: text === undefined ? [] : [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" }] }]);
      const runtime = new PiAgentRuntime({
        workspaceRoot: "/tmp",
        sessionFactory: async () => ({ ...fake.session, sessionId: `malformed-self-verify-${index}` }),
      });
      const result = await runtime.selfVerify({ missionId: "malformed-self", branchId: "branch", taskContract: { objective: "inspect" }, context: {}, workspace: {} });
      expect(result.ok).toBe(false);
      expect(result.objections?.length).toBeGreaterThan(0);
    }
  });

  test("malformed falsification output cannot promote a candidate", async () => {
    let sessionNumber = 0;
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async () => {
        const response = sessionNumber++ === 0 ? '{"ok":true,"objections":[]}' : '{"files":{"score":"7"}}';
        const fake = fakeSession([{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: response }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 0 }, stopReason: "stop" }] }]);
        return { ...fake.session, sessionId: `malformed-falsify-${sessionNumber}` };
      },
    });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "malformed-falsify",
      taskContract: { objective: "produce a score" },
      branchIds: ["candidate"],
      runtime,
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();

    expect(result.champion).toBeUndefined();
    expect(result.branches.candidate.status).toBe("REJECTED");
    const falsifierEvent = harness.events().find((event) => event.type === "FALSIFIER_COMPLETED");
    expect(falsifierEvent?.payload).toMatchObject({ ok: false });
    expect((falsifierEvent?.payload.objections as string[]).length).toBeGreaterThan(0);
  });

  test("aggregates multi-turn SDK usage and scalar session cost", async () => {
    const fake = fakeSession([
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } }, stopReason: "toolUse" }] },
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 6, output: 7, cacheRead: 8, cacheWrite: 9, totalTokens: 30, cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2 } }, stopReason: "stop" }] },
    ], { tokens: { input: 8, output: 10, cacheRead: 12, cacheWrite: 14, total: 44 }, cost: 3.5 });
    const runtime = new PiAgentRuntime({ sessionFactory: async () => fake.session });

    const result = await runtime.execute(request());
    expect(result.text).toContain("second");
    expect(result.usage.tokens).toEqual({ input: 8, output: 10, cacheRead: 12, cacheWrite: 14, total: 44 });
    expect(result.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 3.5 });
    expect(result.stopReason).toBe("stop");
  });

  test("executes successfully through the actual SDK AgentSession with a deterministic local model", async () => {
    const faux = fauxProvider({ api: "evok-local", provider: "evok-local", models: [{ id: "deterministic" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("approved plan complete"),
    ]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    let usedAgentSession = false;
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async (options) => {
        await writeFile(`${options.cwd}/fixture.txt`, "deterministic fixture");
        const { session } = await createAgentSession({ ...options, model: faux.getModel(), modelRuntime, sessionManager: SessionManager.inMemory(options.cwd) });
        usedAgentSession = true;
        return session;
      },
    });

    const approvedRoot = `/tmp/real-sdk-${Date.now()}`;
    const result = await runtime.execute(request({ workspace: workspace(approvedRoot) }));
    expect(usedAgentSession).toBe(true);
    assertExternalCompletion(result, approvedRoot);
    expect(result.text).toBe("approved plan complete");
  });

  test("compaction/retry lifecycle events fail the run with redacted policy-violation evidence, never silent success", async () => {
    for (const type of POLICY_LIFECYCLE_TYPES) {
      let disposed = false;
      const fake = fakeSession([
        { type, reason: "threshold", attempt: 1, errorMessage: "provider failed with token super-secret" },
        completeEnd,
      ]);
      const runtime = new PiAgentRuntime({
        secrets: ["super-secret"],
        workspaceRoot: "/tmp",
        sessionFactory: async () => ({ ...fake.session, sessionId: `policy-${type}` }),
        onDispose: () => { disposed = true; },
      });
      const error = await runtime.execute(request()).catch((caught) => caught);
      expect(error).toBeInstanceOf(SessionPolicyViolation);
      expect((error as SessionPolicyViolation).kind).toBe("session-policy-violation");
      expect((error as SessionPolicyViolation).eventType).toBe(type);
      expect((error as SessionPolicyViolation).message).toContain(type);
      expect(JSON.stringify((error as SessionPolicyViolation).raw)).not.toContain("super-secret");
      expect((error as SessionPolicyViolation).events.map((event) => event.type)).toContain(type);
      expect(JSON.stringify((error as SessionPolicyViolation).events)).not.toContain("super-secret");
      expect(fake.wasAborted()).toBe(true);
      expect(disposed).toBe(true);
    }
  });

  test("a policy violation is not clobbered by the aborted agent_end that follows the fail-closed abort", async () => {
    const fake = fakeSession([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "transient" },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "agent aborted", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] },
    ]);
    const runtime = new PiAgentRuntime({ sessionFactory: async () => fake.session });
    const error = await runtime.execute(request()).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionPolicyViolation);
    expect((error as SessionPolicyViolation).eventType).toBe("auto_retry_start");
  });

  test("a policy violation supersedes an earlier sandbox violation as the fail-closed evidence", async () => {
    const fake = fakeSession([
      { type: "tool_execution_start", toolCallId: "1", toolName: "write", args: { path: "out.txt" } },
      { type: "compaction_start", reason: "threshold" },
      completeEnd,
    ]);
    const runtime = new PiAgentRuntime({ sessionFactory: async () => fake.session });
    const error = await runtime.execute(request()).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionPolicyViolation);
    expect((error as SessionPolicyViolation).eventType).toBe("compaction_start");
    expect((error as SessionPolicyViolation).events.map((event) => event.type)).toContain("compaction_start");
  });

  test("sessionOptions cannot re-enable compaction or retry: runtime policy wins", async () => {
    let captured: SettingsManager | undefined;
    const fake = fakeSession([completeEnd]);
    const runtime = new PiAgentRuntime({
      sessionOptions: {
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true } }),
      },
      sessionFactory: async (options) => {
        captured = options.settingsManager;
        return fake.session;
      },
    });
    await runtime.execute(request());
    expect(captured?.getCompactionEnabled()).toBe(false);
    expect(captured?.getRetryEnabled()).toBe(false);
  });

  test("default factory injects a runtime policy that overrides caller settings on a real Pi session", async () => {
    const faux = fauxProvider({ api: "evok-policy", provider: "evok-policy", models: [{ id: "deterministic" }] });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const cwd = await mkdtemp(join(tmpdir(), "evok-default-factory-"));
    const session = await defaultSessionFactory({
      cwd,
      tools: ["read"],
      model: faux.getModel(),
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true } }),
    });
    const settings = (session as unknown as { settingsManager: SettingsManager }).settingsManager;
    expect(settings.getCompactionEnabled()).toBe(false);
    expect(settings.getRetryEnabled()).toBe(false);
  });

  test("transient provider failure is not SDK-auto-retried and a caller retry is a new run/session/workspace", async () => {
    const faux = fauxProvider({ api: "evok-transient", provider: "evok-transient", models: [{ id: "deterministic" }] });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      () => { throw new Error("transient provider failure"); },
      fauxAssistantMessage("caller retry succeeded"),
    ]);
    const sessionIds: string[] = [];
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async (options) => {
        await writeFile(`${options.cwd}/fixture.txt`, "fixture");
        const { session } = await createAgentSession({
          ...options,
          model: faux.getModel(),
          modelRuntime,
          sessionManager: SessionManager.inMemory(options.cwd),
        });
        sessionIds.push(session.sessionId);
        return session;
      },
    });
    const firstRoot = `/tmp/evok-transient-${Date.now()}`;
    await expect(runtime.execute(request({ workspace: workspace(firstRoot) }))).rejects.toThrow();
    expect(faux.state.callCount).toBe(1); // no SDK auto-retry inside one Run
    // a retry cannot continue the failed Run's workspace: the caller must create a new Run
    await expect(runtime.execute(request({ workspace: workspace(firstRoot) }))).rejects.toThrow("reuse");
    const secondRoot = `/tmp/evok-transient-2-${Date.now()}`;
    const result = await runtime.execute(request({ workspace: workspace(secondRoot) }));
    expect(result.text).toBe("caller retry succeeded");
    expect(result.workspace).toContain(`${secondRoot}/run-`);
    expect(new Set(sessionIds).size).toBe(2); // fresh session per Run
    expect(faux.state.callCount).toBe(2);
  });

  test("sandbox violations never auto-retry and session cleanup happens in finally", async () => {
    let disposed = false;
    const fake = fakeSession([
      { type: "tool_execution_start", toolCallId: "1", toolName: "write", args: { path: "out.txt" } },
      { type: "tool_execution_end", toolCallId: "1", toolName: "write", isError: true },
      completeEnd,
    ]);
    const runtime = new PiAgentRuntime({
      sessionFactory: async () => fake.session,
      onDispose: () => { disposed = true; },
    });
    await expect(runtime.execute(request())).rejects.toMatchObject({ name: "SandboxViolation" });
    expect(fake.wasAborted()).toBe(true);
    expect(disposed).toBe(true);
  });

  test("multi-turn real SDK run emits no compaction/summarization events and context overflow fails explicitly", async () => {
    const faux = fauxProvider({ api: "evok-overflow", provider: "evok-overflow", models: [{ id: "deterministic", contextWindow: 500 }] });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("provider error", { stopReason: "error", errorMessage: "context window exceeded for model deterministic" }),
    ]);
    const rawTypes: string[] = [];
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionFactory: async (options) => {
        await writeFile(`${options.cwd}/fixture.txt`, "tool result fixture");
        const { session } = await createAgentSession({
          ...options,
          model: faux.getModel(),
          modelRuntime,
          sessionManager: SessionManager.inMemory(options.cwd),
        });
        session.subscribe((event) => {
          const record = event as Record<string, unknown>;
          if (typeof record?.type === "string") rawTypes.push(record.type);
        });
        return session;
      },
    });
    const root = `/tmp/evok-overflow-${Date.now()}`;
    await expect(runtime.execute(request({ workspace: workspace(root) }))).rejects.toThrow("context window");
    expect(rawTypes).toContain("tool_execution_start");
    const forbidden = rawTypes.filter((type) => type.startsWith("compaction") || type.startsWith("auto_retry") || type.startsWith("summarization_retry"));
    expect(forbidden).toEqual([]);
    expect(faux.state.callCount).toBe(3); // two tool turns + final error turn, no hidden extra LLM calls
  });

  test("rejects workspace reuse, duplicate events, and missing completion facts", async () => {
    const fake = fakeSession([{ type: "agent_start" }, { type: "agent_start" }, { type: "agent_end", messages: [] }]);
    const runtime = new PiAgentRuntime({ sessionFactory: async () => fake.session });
    const first = runtime.execute(request());
    await expect(first).rejects.toThrow("stop reason");
    await expect(runtime.execute(request())).rejects.toThrow("workspace");
  });
});
