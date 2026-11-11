import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createCompetitionContract } from "../competition/competition-contract";
import { createRuleVisibilityPolicy } from "../competition/rule-visibility";
import { createMemorySlice } from "./memory-slice";
import { createChildMetering } from "./pi-child-metering";
import { dispatchPiChild } from "./pi-child-dispatch";
import { assembleRoleContext } from "./role-context";
import { buildResearcherContext } from "./researcher-context";
import type { SubagentDelegation } from "./subagents-adapter";

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
  allow: { researcher: ["scoring.metric"], reviewer: ["scoring.metric"] },
});
function delegation(role: "researcher" | "reviewer"): SubagentDelegation {
  const identity = { missionId: "mission", taskId: "task", runId: "run123", targetAgentId: role + "@run123" };
  const memorySlice = createMemorySlice({
    ...identity,
    sliceId: "slice123",
    findings: [{ findingId: "one", summary: "Only this observation." }],
  });
  const roleContext = assembleRoleContext({
    ...identity,
    role,
    objective: "Improve.",
    contract,
    policy,
    source: "test",
    tools: [],
    memoryDigest: memorySlice.digest,
  });
  return {
    agent: role + "-child",
    capability: role === "reviewer" ? "review" : "research",
    task: "Return your role",
    context: buildResearcherContext({ objective: "Improve." }),
    roleContext,
    memorySlice,
    runId: identity.runId,
    targetAgentId: identity.targetAgentId,
  };
}

function childModel(baseUrl: string): Model<any> {
  return {
    id: "kimi-k3-1-pro-261024",
    name: "Kimi",
    api: "openai-completions",
    provider: "ai-modeling",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 1.83, output: 9.58, cacheRead: 0.18, cacheWrite: 1.83 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  } as Model<any>;
}

type Handler = (data: unknown) => void;
function bus() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(channel: string, handler: Handler) {
      const items = handlers.get(channel) ?? new Set<Handler>();
      items.add(handler);
      handlers.set(channel, items);
      return () => {
        items.delete(handler);
      };
    },
    emit(channel: string, data: unknown) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
  };
}

async function upstream(
  reply: (request: { authorization?: string; path?: string; body: string }) => {
    status?: number;
    contentType: string;
    body: string;
  },
) {
  const seen: { authorization?: string; path?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = {
      authorization: request.headers.authorization,
      path: request.url,
      body: Buffer.concat(chunks).toString(),
    };
    seen.push(call);
    const result = reply(call);
    response.writeHead(result.status ?? 200, { "content-type": result.contentType });
    response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no loopback port");
  return { seen, url: "http://127.0.0.1:" + address.port + "/v1", close: () => server.close() };
}

test("the relay keeps the host credential, forwards the child request and meters real usage", async () => {
  const fake = await upstream((call) =>
    call.path === "/v1/responses"
      ? {
          contentType: "text/event-stream",
          body:
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":60}}}\n\n' +
            "data: [DONE]\n\n",
        }
      : call.path === "/v1/chat/completions" && call.body.includes("chat")
      ? {
          contentType: "text/event-stream",
          body:
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\n' +
            "data: [DONE]\n\n",
        }
      : {
          contentType: "text/event-stream",
          body:
            'event: message_start\ndata: {"message":{"usage":{"input_tokens":30}}}\n\n' +
            'event: message_delta\ndata: {"usage":{"output_tokens":25}}\n\n' +
            'event: message_delta\ndata: {"usage":{"output_tokens":60}}\n\n',
        },
  );
  const registered = new Map<string, ProviderConfig>();
  try {
    const metering = await createChildMetering(
      {
        registerProvider: (name, config) => registered.set(name, config),
        unregisterProvider: (name) => registered.delete(name),
      },
      { model: childModel(fake.url), auth: { apiKey: "host-secret" } },
    );
    const provider = registered.get(metering.alias);
    expect(provider).toBeDefined();
    expect(provider!.baseUrl).toStartWith("http://127.0.0.1:");
    expect(provider!.baseUrl).not.toContain("host-secret");
    expect(provider!.apiKey).not.toBe("host-secret");
    expect(provider!.models?.map((model) => model.id)).toEqual(["kimi-k3-1-pro-261024"]);

    const reply = async (path: string, body: string) =>
      fetch(provider!.baseUrl + path, {
        method: "POST",
        headers: { authorization: "Bearer " + provider!.apiKey, "content-type": "application/json" },
        body,
      });

    const openai = await reply("/chat/completions", '{"chat":true}');
    expect(openai.status).toBe(200);
    expect(await openai.text()).toContain("finish_reason");
    const anthropic = await reply("/messages", '{"messages":[]}');
    expect(anthropic.status).toBe(200);
    const responses = await reply("/responses", '{"responses":[]}');
    expect(responses.status).toBe(200);
    expect(fake.seen[2]).toMatchObject({ authorization: "Bearer host-secret", path: "/v1/responses" });

    expect(fake.seen[0]).toMatchObject({
      authorization: "Bearer host-secret",
      path: "/v1/chat/completions",
      body: '{"chat":true}',
    });
    expect(fake.seen[1]).toMatchObject({ authorization: "Bearer host-secret", path: "/v1/messages" });
    // Requests of 20/10, 30/60 (cumulative 25 then 60) and 50/60: per-request
    // maxima sum to 100/130, so a naive sum of every usage event cannot pass.
    expect(metering.usage()).toEqual({ input: 100, output: 130 });

    const outside = await fetch(new URL(provider!.baseUrl!).origin + "/other", {
      method: "POST",
      headers: { authorization: "Bearer " + provider!.apiKey },
      body: "{}",
    });
    expect(outside.status).toBe(404);
    const unauthorized = await fetch(provider!.baseUrl + "/chat/completions", { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(403);

    await metering.dispose();
    expect(registered.has(metering.alias)).toBe(false);
    await expect(reply("/chat/completions", "{}")).rejects.toThrow();
  } finally {
    fake.close();
  }
});

test("one controller-owned registration serves consecutive children and outlives a single child call", async () => {
  const fake = await upstream(() => ({
    contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  }));
  const order: string[] = [];
  const registered = new Map<string, ProviderConfig>();
  const events = bus();
  const register = "pi-subagents:runtime-agent-register:v1";
  const request = "prompt-template:subagent:request";
  const response = "prompt-template:subagent:response";
  events.on(register, (registration: any) => {
    order.push("register");
    registration.result = { ok: true, registration: { dispose() {} } };
  });
  events.on(request, (message: any) => {
    order.push("request");
    events.emit(response, {
      requestId: message.requestId,
      ownerRunId: message.ownerRunId,
      nodeId: message.nodeId,
      agent: message.agent,
      status: "completed",
      model: message.model + ":max",
      thinking: "max",
      result: { kind: "text", text: "actual" },
    });
  });
  const metering = await createChildMetering(
    {
      registerProvider: (name, config) => {
        order.push("registerProvider");
        registered.set(name, config);
      },
      unregisterProvider: (name) => {
        order.push("unregisterProvider");
        registered.delete(name);
      },
    },
    { model: childModel(fake.url), auth: { apiKey: "host-secret" } },
  );
  // The provider exists before anything may dispatch.
  expect(order).toEqual(["registerProvider"]);
  const workspaces: string[] = [];
  try {
    for (const role of ["researcher", "reviewer"] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "evok-metered-child-"));
      workspaces.push(cwd);
      const result = await dispatchPiChild({ events }, delegation(role), {
        model: metering.model,
        cwd,
        protocolProbe: () => "0.84.0",
      });
      expect(result.value.text).toBe("actual");
      // Still registered between children: no per-child registration or teardown.
      expect(registered.has(metering.alias)).toBe(true);
    }
    expect(order).toEqual(["registerProvider", "register", "request", "register", "request"]);
    await metering.dispose();
    expect(order.at(-1)).toBe("unregisterProvider");
    expect(registered.size).toBe(0);
  } finally {
    for (const cwd of workspaces) await rm(cwd, { recursive: true, force: true });
    fake.close();
  }
});

test("an unauthenticated or non-http upstream fails before any provider is registered", async () => {
  const host = {
    registerProvider: () => {
      throw Error("must not register");
    },
    unregisterProvider: () => {},
  };
  await expect(
    createChildMetering(host, { model: childModel("https://api.example.com/v1"), auth: {} }),
  ).rejects.toThrow(/authentication/);
  await expect(
    createChildMetering(host, {
      model: childModel("file:///etc/passwd"),
      auth: { apiKey: "host-secret" },
    }),
  ).rejects.toThrow(/http/);
  await expect(
    createChildMetering(host, {
      model: childModel("https://api.example.com/v1"),
      auth: { apiKey: "host-secret" },
      name: "Not A Slug",
    }),
  ).rejects.toThrow(/slug/);
});
