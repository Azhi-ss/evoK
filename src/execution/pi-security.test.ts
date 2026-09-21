import { describe, expect, test } from "bun:test";
import { PiAgentRuntime, type AgentRuntimeSession, type PiAgentRuntimeRequest } from "./pi-agent-runtime";

function approved(path = "/tmp/evok-pi-security") {
  return { path, isolated: true as const, approved: true as const };
}

function request(overrides: Partial<PiAgentRuntimeRequest> = {}): PiAgentRuntimeRequest {
  return {
    task: { objective: "use super-secret in a safe way", constraints: { token: "super-secret" } },
    role: { name: "explorer" },
    workspace: approved(),
    ...overrides,
  };
}

function session(events: readonly Record<string, unknown>[], onPrompt?: (text: string) => void): AgentRuntimeSession {
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  return {
    sessionId: `security-${Math.random()}`,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt(text) { onPrompt?.(text); for (const event of events) listener?.(event); },
    async abort() {},
    dispose() {},
    getSessionStats() { return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }; },
  };
}

describe("PiAgentRuntime T06 boundary", () => {
  test("cannot let session options override the enforced workspace or tool allowlist", async () => {
    let created: { cwd?: string; tools?: string[] } = {};
    const runtime = new PiAgentRuntime({
      workspaceRoot: "/tmp",
      sessionOptions: { cwd: "/tmp/attacker", tools: ["bash"] } as never,
      sessionFactory: async (options) => {
        created = { cwd: options.cwd, tools: options.tools };
        return session([{ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] }]);
      },
    });

    await runtime.execute(request());

    expect(created.cwd).toContain("/tmp/evok-pi-security/run-");
    expect(created.cwd).not.toBe("/tmp/attacker");
    expect(created.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  test("redacts secrets from prompts, tool output, and completion text", async () => {
    let prompt = "";
    const runtime = new PiAgentRuntime({
      secrets: ["super-secret"],
      sessionFactory: async () => session([
        { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "safe.txt" } },
        { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { text: "super-secret" }, isError: false },
        { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "super-secret" }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] },
      ], (text) => { prompt = text; }),
    });

    const result = await runtime.execute(request());

    expect(prompt).not.toContain("super-secret");
    expect(JSON.stringify(result.events)).not.toContain("super-secret");
    expect(result.text).not.toContain("super-secret");
  });

  test("verification roles cannot request coding tools", async () => {
    let created = false;
    const runtime = new PiAgentRuntime({ sessionFactory: async () => { created = true; return session([]); } });

    await expect(runtime.execute(request({ role: { name: "critic", verificationRole: "Critic", tools: ["write"] } }))).rejects.toThrow();
    expect(created).toBe(false);
  });

  test("a workspace request cannot enable bash when the runtime policy denies it", async () => {
    let created = false;
    const runtime = new PiAgentRuntime({ sessionFactory: async () => { created = true; return session([]); } });
    await expect(runtime.execute(request({
      workspace: { ...approved("/tmp/evok-pi-policy"), sandbox: { allowBash: true } },
      role: { name: "worker", tools: ["bash"], allowCodingTools: true },
    }))).rejects.toThrow();
    expect(created).toBe(false);
  });

  test("powershell stays fail-closed unless bash is explicitly granted; user_bash is not a model tool", async () => {
    let created = false;
    const runtime = new PiAgentRuntime({ sessionFactory: async () => { created = true; return session([]); } });
    await expect(runtime.execute(request({
      role: { name: "worker", tools: ["powershell"], allowCodingTools: true },
    }))).rejects.toThrow();
    await expect(runtime.execute(request({
      role: { name: "worker", tools: ["user_bash"], allowCodingTools: true },
    }))).rejects.toThrow("unknown tool");
    expect(created).toBe(false);
  });
});
