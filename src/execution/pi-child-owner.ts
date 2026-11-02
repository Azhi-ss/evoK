/** A private Pi session owns native notifications. Its own model can only emit a local acknowledgement. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerBinding } from "./pi-child-tools";
type Host = Pick<ExtensionAPI, "events">;
interface RpcResult {
  details?: { asyncId?: string; asyncDir?: string; runId?: string };
}
function rpc(pi: Host, method: string, params: object): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      off();
      reject(Error("pi-subagents RPC timed out: " + method));
    }, 30000);
    const off = pi.events.on("subagents:rpc:v1:reply:" + requestId, (v: any) => {
      clearTimeout(timer);
      off();
      if (v.success) resolve(v.data);
      else reject(Error(v.error?.message ?? "pi-subagents RPC failed"));
    });
    pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
  });
}
export default function workerControlOwner(pi: ExtensionAPI) {
  const stateDir = process.env.EVOK_WORKER_STATE!;
  const binding: WorkerBinding = JSON.parse(readFileSync(join(stateDir, "active.json"), "utf8"));
  const round = binding.roleRunId;
  function report(kind: string, value: unknown) {
    const file = join(stateDir, round + "." + kind + ".json"),
      tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  }
  const spec = JSON.parse(readFileSync(join(stateDir, round + ".launch.json"), "utf8"));
  const config = binding.provider.config;
  const alias = binding.provider.alias;
  pi.registerProvider(alias, config);
  pi.registerProvider("evok-internal", {
    baseUrl: "http://127.0.0.1",
    api: "openai-completions",
    apiKey: "local-only",
    models: [
      {
        id: "owner",
        name: "Local control receipt",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 20,
      },
    ],
    streamSimple: (model) => {
      const s = createAssistantMessageEventStream();
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const result = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Recorded." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      s.push({ type: "done", reason: "stop", message: result });
      s.end(result);
      return s;
    },
  });
  let nativeRunId: string | undefined;
  pi.registerCommand("evok-start", {
    description: "Execute a single bound native launch",
    handler: async () => {
      try {
        // Keep the same parent session identity when the control process restarts for a later round.
        pi.appendEntry("evok-owner", { nodeId: binding.nodeId });
        pi.events.emit("pi-subagents:runtime-agent-register:v1", spec.registration);
        if (!spec.registration.result?.ok) throw Error("worker registration unavailable");
        const launched = await rpc(pi, spec.method, spec.params);
        nativeRunId = launched.details?.asyncId ?? launched.details?.runId;
        if (!nativeRunId || !launched.details?.asyncDir) throw Error("missing native launch receipt");
        report("started", { nativeRunId, asyncDir: launched.details.asyncDir });
      } catch (e) {
        report("error", { error: String(e) });
      }
    },
  });
  pi.registerCommand("evok-cancel", {
    description: "Stop the owned run",
    handler: async () => {
      if (nativeRunId) await rpc(pi, "stop", { id: nativeRunId });
    },
  });
}
