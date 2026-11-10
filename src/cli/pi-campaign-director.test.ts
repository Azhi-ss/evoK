import { expect, test } from "bun:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCampaignDirector, type CampaignDispatch } from "./pi-campaign-director";

/** The controller's current model: metering forwards here with its real key. */
const model = {
  id: "kimi-k3-1-pro-261024",
  name: "Kimi",
  api: "openai-completions",
  provider: "ai-modeling",
  baseUrl: "https://api.example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1.83, output: 9.58, cacheRead: 0.18, cacheWrite: 1.83 },
  contextWindow: 1048576,
  maxTokens: 32768,
};

function harness() {
  const tools = new Map<string, any>(), events = new Map<string, (...args: any[]) => any>();
  const notices: any[] = [];
  const order: string[] = [], registered = new Map<string, ProviderConfig>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(event: string, hook: any) {
      events.set(event, hook);
    },
    sendMessage(message: any, options: any) {
      notices.push({ message, options });
    },
    registerProvider(name: string, config: ProviderConfig) {
      order.push("registerProvider");
      registered.set(name, config);
    },
    unregisterProvider(name: string) {
      order.push("unregisterProvider");
      registered.delete(name);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => "main-A" },
    model,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "host-secret" }) },
  };
  const call = (name: string, args: object) =>
    tools.get(name).execute("call", args, undefined, undefined, ctx);
  return { tools, events, notices, order, registered, pi, ctx, call };
}

test("the main Pi session stays available while its named child runs and can read persisted status", async () => {
  const w = harness();
  const seen: CampaignDispatch[] = [];
  type Receipt = { job: { state: string } };
  let finish!: (result: Receipt) => void;
  const done = new Promise<Receipt>((resolve) => {
    finish = resolve;
  });
  registerCampaignDirector(w.pi, {
    async status() {
      return { pending: { id: "exp-03", state: "pending" } };
    },
    async dispatch(input) {
      seen.push(input);
      return input.role === "reviewer" ? { job: { state: "completed" } } : done;
    },
    async retry() {
      throw Error("unexpected retry");
    },
    async stop() {
      throw Error("unexpected stop");
    },
  });
  const experiment = {
    role: "researcher",
    jobId: "exp-03",
    objective: "Test early delivery",
    sourcePaths: ["runtime/agent.py"],
    reviewRequested: true,
    collaborators: [
      {
        role_name: "timer",
        capability_profile: "diagnostic",
        task_goal: "Locate the deadline failure",
        evidence_refs: ["screening"],
        deliverable_spec: "An observation",
      },
    ],
  };
  const receipt = await w.call("evok_dispatch", experiment);
  expect(receipt.details).toMatchObject({ jobId: "exp-03", state: "starting" });
  expect((await w.call("evok_status", {})).details.pending.id).toBe("exp-03");
  await expect(w.call("evok_dispatch", experiment)).rejects.toThrow(/active/);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ ...experiment, sessionId: "main-A" });
  finish({ job: { state: "review-pending" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.map((x) => x.role)).toEqual(["researcher", "reviewer"]);
  expect(seen[1]!.sourcePaths).toBeUndefined();
  expect(seen[1]!.collaborators).toBeUndefined();
  expect(seen[1]!.sessionId).toBe("main-A");
  expect(w.notices.at(-1).message.content).toContain("completed");
  expect(w.notices[0].options).toEqual({ triggerTurn: false });
  await w.events.get("session_shutdown")!({}, w.ctx);
});

test("one controller-owned metering registration precedes dispatch and outlives each child call", async () => {
  const w = harness();
  const seen: CampaignDispatch[] = [];
  registerCampaignDirector(w.pi, {
    async status() {
      return {};
    },
    async dispatch(input) {
      w.order.push("dispatch:" + input.role);
      seen.push(input);
      return { job: { state: input.role === "researcher" ? "review-pending" : "completed" } };
    },
    async retry() {
      throw Error("unexpected retry");
    },
    async stop() {
      throw Error("unexpected stop");
    },
  });
  await w.call("evok_dispatch", {
    role: "researcher",
    jobId: "exp-03",
    objective: "Test metering ownership",
    sourcePaths: ["runtime/agent.py"],
    reviewRequested: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Registered before the first child, and never torn down between children.
  expect(w.order).toEqual(["registerProvider", "dispatch:researcher", "dispatch:reviewer"]);
  expect(seen).toHaveLength(2);
  const meter = seen[0]!.metering;
  expect(seen[1]!.metering).toEqual(meter);
  expect(meter.model).toBe(meter.alias + "/" + model.id);
  expect(meter.provider.baseUrl).toStartWith("http://127.0.0.1:");
  expect(meter.provider.apiKey).not.toBe("host-secret");
  expect(w.registered.get(meter.alias)).toEqual(meter.provider);

  await w.events.get("session_shutdown")!({}, w.ctx);
  expect(w.order.at(-1)).toBe("unregisterProvider");
  expect(w.registered.size).toBe(0);
});

test("a dispatch without a resolvable controller model fails closed before any child starts", async () => {
  const w = harness();
  const ctx = { ...w.ctx, model: undefined };
  registerCampaignDirector(w.pi, {
    async status() {
      return {};
    },
    async dispatch() {
      w.order.push("dispatch");
      return { job: { state: "completed" } };
    },
    async retry() {
      throw Error("unexpected retry");
    },
    async stop() {
      throw Error("unexpected stop");
    },
  });
  const call = (name: string, args: object) =>
    w.tools.get(name).execute("call", args, undefined, undefined, ctx);
  await expect(
    call("evok_dispatch", { role: "researcher", jobId: "exp-03", objective: "Test", sourcePaths: ["runtime/a.py"] }),
  ).rejects.toThrow(/current model/);
  expect(w.order).toEqual([]);
  expect(w.registered.size).toBe(0);
});

test("concurrent dispatches cannot both claim the controller while metering opens", async () => {
  const w = harness();
  const seen: CampaignDispatch[] = [];
  registerCampaignDirector(w.pi, {
    async status() {
      return {};
    },
    async dispatch(input) {
      w.order.push("dispatch:" + input.role);
      seen.push(input);
      return { job: { state: "completed" } };
    },
    async retry() {
      throw Error("unexpected retry");
    },
    async stop() {
      throw Error("unexpected stop");
    },
  });
  const job = (jobId: string, sourcePath: string) => ({
    role: "researcher",
    jobId,
    objective: "Test " + jobId,
    sourcePaths: [sourcePath],
  });
  const first = w.call("evok_dispatch", job("exp-01", "runtime/a.py"));
  // Attach the rejection handler in the same tick: the claim is claimed synchronously.
  const second = w.call("evok_dispatch", job("exp-02", "runtime/b.py")).then(
    () => "started",
    (error: Error) => error.message,
  );
  await expect(first).resolves.toBeDefined();
  expect(await second).toMatch(/already has an active/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen).toHaveLength(1);
  expect(w.order).toEqual(["registerProvider", "dispatch:researcher"]);
  await w.events.get("session_shutdown")!({}, w.ctx);
});
