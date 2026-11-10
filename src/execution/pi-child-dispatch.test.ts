import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompetitionContract } from "../competition/competition-contract";
import { createRuleVisibilityPolicy } from "../competition/rule-visibility";
import { assembleRoleContext } from "./role-context";
import { createMemorySlice } from "./memory-slice";
import { dispatchPiChild } from "./pi-child-dispatch";
import { PiSubagentsProtocolError } from "./pi-subagents-protocol";

const contract = createCompetitionContract({
  version: "1",
  competitionId: "local",
  objective: "Improve.",
  scoring: { metric: "reward", direction: "maximize" },
  dataSplit: { kind: "group", holdout: "protected" },
  submission: { format: "json" },
  limits: { network: "restricted" },
});
const policy = createRuleVisibilityPolicy({
  competitionId: "local",
  contractDigest: contract.digest,
  allow: { researcher: ["scoring.metric"] },
});
const identity = { missionId: "mission", taskId: "task", runId: "run123", targetAgentId: "researcher@run123" };
const memorySlice = createMemorySlice({
  ...identity,
  sliceId: "slice123",
  findings: [{ findingId: "one", summary: "Only this observation." }],
});
const roleContext = assembleRoleContext({
  ...identity,
  role: "researcher",
  objective: "Improve.",
  contract,
  policy,
  source: "test",
  tools: [],
  memoryDigest: memorySlice.digest,
});
const input = {
  role: "researcher" as const,
  task: "Return one patch",
  model: "evok-meter-test/kimi-k3-1-pro-261024",
  roleContext,
  memorySlice,
  protocolProbe: () => "0.84.0",
};
type Handler = (data: unknown) => void;
function bus() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(channel: string, handler: Handler) {
      const items = handlers.get(channel) ?? new Set();
      items.add(handler);
      handlers.set(channel, items);
      return () => {
        items.delete(handler);
      };
    },
    emit(channel: string, data: unknown) {
      for (const h of [...(handlers.get(channel) ?? [])]) h(data);
    },
  };
}
const register = "pi-subagents:runtime-agent-register:v1",
  request = "prompt-template:subagent:request",
  response = "prompt-template:subagent:response";

test("only the bound memory reaches the isolated, tool-free child; unrelated terminal events cannot complete it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-child-test-"));
  const events = bus();
  let disposed = false;
  events.on(register, (v: any) => {
    expect(v.definition).toMatchObject({
      tools: [],
      model: input.model,
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      allowNestedSubagents: false,
    });
    v.result = {
      ok: true,
      registration: {
        dispose: () => {
          disposed = true;
        },
      },
    };
  });
  events.on(request, (v: any) => {
    expect(v).toMatchObject({
      context: "fresh",
      skill: false,
      artifacts: false,
      intercomBridge: { mode: "off" },
      model: input.model,
      thinking: "max",
    });
    const task = JSON.parse(v.task);
    expect(task.memorySlice.digest).toBe(memorySlice.digest);
    const terminal = {
      requestId: v.requestId,
      ownerRunId: v.ownerRunId,
      nodeId: v.nodeId,
      agent: v.agent,
      status: "completed",
      model: v.model + ":max",
      thinking: "max",
      result: { kind: "text", text: "actual" },
    };
    events.emit(response, { ...terminal, nodeId: "other", result: { kind: "text", text: "foreign" } });
    events.emit(response, terminal);
  });
  try {
    const output = await dispatchPiChild({ events }, { ...input, cwd });
    expect(output.text).toBe("actual");
    expect(disposed).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mismatched bound context, direct provider and absent real listener all fail before any child is launched", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-child-test-"));
  const events = bus();
  let launches = 0;
  events.on(request, () => {
    launches++;
  });
  try {
    const wrong = createMemorySlice({ ...identity, sliceId: "other" });
    await expect(dispatchPiChild({ events }, { ...input, cwd, memorySlice: wrong })).rejects.toThrow(
      /bound|binding/i,
    );
    await expect(
      dispatchPiChild({ events }, { ...input, cwd, model: "ai-modeling/kimi-k3-1-pro-261024" }),
    ).rejects.toThrow(/meter/i);
    await expect(dispatchPiChild({ events }, { ...input, cwd })).rejects.toThrow(/pi-subagents/i);
    expect(launches).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an absent or pre-0.84 protocol fails closed before any registration or child start", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-child-test-"));
  const events = bus();
  const seen: string[] = [];
  events.on(register, () => seen.push("register"));
  events.on(request, () => seen.push("request"));
  try {
    const absent = dispatchPiChild({ events }, { ...input, cwd, protocolProbe: () => undefined });
    await expect(absent).rejects.toBeInstanceOf(PiSubagentsProtocolError);
    await expect(absent).rejects.toThrow(/detected none[\s\S]*required >= 0\.84/);
    const skew = dispatchPiChild({ events }, { ...input, cwd, protocolProbe: () => "0.79.1" });
    await expect(skew).rejects.toBeInstanceOf(PiSubagentsProtocolError);
    await expect(skew).rejects.toThrow(/detected 0\.79\.1[\s\S]*required >= 0\.84/);
    expect(seen).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the negotiated protocol, not a hard-coded suffix, decides the expected child identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-child-identity-"));
  const events = bus();
  events.on(register, (registration: any) => {
    registration.result = { ok: true, registration: { dispose() {} } };
  });
  events.on(request, (v: any) =>
    events.emit(response, {
      requestId: v.requestId,
      ownerRunId: v.ownerRunId,
      nodeId: v.nodeId,
      agent: v.agent,
      status: "completed",
      model: v.model,
      thinking: "max",
      result: { kind: "text", text: "actual" },
    }),
  );
  try {
    await expect(dispatchPiChild({ events }, { ...input, cwd })).rejects.toThrow(
      /unexpected child agent, model or thinking level/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("aborting waits for the plugin to acknowledge cancellation before disposing the child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-cancel-"));
  const events = bus();
  const controller = new AbortController();
  const order: string[] = [];
  events.on(register, (registration: any) => {
    registration.result = { ok: true, registration: { dispose: () => order.push("disposed") } };
  });
  events.on(request, () => controller.abort());
  events.on("prompt-template:subagent:cancel", (identity: any) => {
    order.push("cancel");
    queueMicrotask(() => {
      order.push("acknowledged");
      events.emit(response, { ...identity, status: "cancelled" });
    });
  });
  try {
    await expect(dispatchPiChild({ events }, { ...input, cwd, signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(order).toEqual(["cancel", "acknowledged", "disposed"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plugin validation errors that only echo requestId reject the dispatch immediately", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "evok-invalid-"));
  const events = bus();
  events.on(register, (registration: any) => {
    registration.result = { ok: true, registration: { dispose() {} } };
  });
  events.on(request, (message: any) =>
    events.emit(response, { requestId: message.requestId, status: "invalid_request" }),
  );
  try {
    await expect(dispatchPiChild({ events }, { ...input, cwd, timeoutMs: 30 })).rejects.toThrow(/invalid_request/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 8000);
