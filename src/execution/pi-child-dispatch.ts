/** Host-side transport for pi-subagents' foreground delegation protocol.
 * The installed protocol is probed before anything is registered or started,
 * so a skewed or absent install fails closed instead of surfacing later as a
 * registration or identity failure. The host registers the unique
 * evok-meter-* provider against its exclusive loopback relay before calling
 * this function, and owns that relay's lifetime. No credentials or
 * child-authored filenames are passed to tools here.
 */
import { randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateMemorySlice, type MemorySlice } from "./memory-slice";
import { probePiSubagentsProtocol, type PiSubagentsVersionProbe } from "./pi-subagents-protocol";
import { validateRoleContext, type RoleTaskContext } from "./role-context";

interface Host {
  events: {
    emit(channel: string, payload: unknown): void;
    on(channel: string, handler: (payload: unknown) => void): () => void;
  };
}

export interface PiChildRequest {
  role: "researcher" | "reviewer";
  task: string;
  cwd: string;
  model: string;
  roleContext: RoleTaskContext;
  memorySlice: MemorySlice;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUpdate?: (update: { runId?: string; tokens?: number }) => void;
  /** Host protocol probe; defaults to the installed pi-subagents package. */
  protocolProbe?: PiSubagentsVersionProbe;
}

export interface PiChildResult {
  text: string;
  runId?: string;
  usage?: { input: number; output: number; cost: number };
}

const CHANNEL = "prompt-template:subagent:";
const REGISTER = "pi-subagents:runtime-agent-register:v1";
const THINKING = "max";
const OBJECTIVE = {
  researcher: "Produce the requested candidate changes. Return your answer as text to your supervisor.",
  reviewer:
    "Review the candidate independently against the supplied evidence. Return your assessment to your supervisor.",
};

export async function dispatchPiChild(pi: Host, input: PiChildRequest): Promise<PiChildResult> {
  const context = validateRoleContext(input.roleContext);
  const memory = validateMemorySlice(input.memorySlice);
  const audit = context.audit;
  if (
    context.role !== input.role ||
    audit.memoryDigest !== memory.digest ||
    audit.runId !== memory.runId ||
    audit.targetAgentId !== memory.targetAgentId ||
    audit.taskId !== memory.taskId ||
    audit.missionId !== memory.missionId
  ) {
    throw Error("child role, identity and MemorySlice must share the same broker binding");
  }
  if (!/^evok-meter-[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.model))
    throw Error("child requires a fully qualified metered model");
  const cwd = await realpath(input.cwd);
  if (!isAbsolute(input.cwd) || (await readdir(cwd)).length !== 0) throw Error("child needs its own empty workspace");
  const timeoutMs = input.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_478_647)
    throw Error("invalid child timeout");
  input.signal?.throwIfAborted();
  // Fail closed before the native registration and before any child exists.
  const protocol = probePiSubagentsProtocol(input.protocolProbe);

  const requestId = randomUUID();
  const identity = { requestId, ownerRunId: memory.missionId, nodeId: memory.runId };
  const name = "evok-" + input.role + "-" + requestId;
  const registration = {
    version: 1,
    name,
    definition: {
      description: "EvoK " + input.role,
      systemPrompt: OBJECTIVE[input.role],
      systemPromptMode: "replace",
      defaultContext: "fresh",
      defaultAsync: false,
      model: input.model,
      thinking: THINKING,
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      tools: [],
      skills: [],
      extensions: [],
      subagentOnlyExtensions: [],
      mcpDirectTools: [],
      allowNestedSubagents: false,
      defaultReads: [],
      defaultProgress: false,
    },
    result: undefined as { ok: true; registration: { dispose(): void } } | { ok: false; error: Error } | undefined,
  };
  // Register on the *loaded* plugin's bus; a private npm copy's registry can
  // belong to a different ExtensionAPI owner. A missing listener is an error.
  pi.events.emit(REGISTER, registration);
  if (!registration.result?.ok)
    throw Error(
      "pi-subagents runtime registration unavailable" +
        (registration.result ? ": " + registration.result.error.message : ""),
    );
  const handle = registration.result.registration;
  const unlisten: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<PiChildResult>((resolve, reject) => {
      let cancelReason: string | undefined;
      function cancel(reason: string) {
        if (cancelReason) return;
        cancelReason = reason;
        clearTimeout(timer);
        timer = setTimeout(() => reject(Error(reason + "; child termination is unconfirmed")), 5000);
        pi.events.emit(CHANNEL + "cancel", identity);
      }
      abort = () => cancel("EvoK child cancelled");
      function isOurs(raw: unknown): raw is Record<string, unknown> {
        if (!raw || typeof raw !== "object") return false;
        const e = raw as Record<string, unknown>;
        return e.requestId === requestId && e.ownerRunId === identity.ownerRunId && e.nodeId === identity.nodeId;
      }
      unlisten.push(
        pi.events.on(CHANNEL + "update", (e) => {
          if (isOurs(e))
            input.onUpdate?.({
              ...(typeof e.runId === "string" ? { runId: e.runId } : {}),
              ...(typeof e.tokens === "number" ? { tokens: e.tokens } : {}),
            });
        }),
      );
      unlisten.push(
        pi.events.on(CHANNEL + "response", (raw) => {
          // Malformed requests can only echo the valid part of their identity.
          if (
            typeof raw === "object" &&
            raw !== null &&
            "requestId" in raw &&
            raw.requestId === requestId &&
            "status" in raw &&
            raw.status === "invalid_request"
          ) {
            return reject(Error("EvoK " + input.role + " delegation invalid_request"));
          }
          if (!isOurs(raw)) return;
          const e = raw as Partial<PiChildResult> & {
            agent?: string;
            model?: string;
            thinking?: string;
            status?: string;
            result?: { kind?: string; text?: string };
          };
          if (cancelReason) return reject(Error(cancelReason));
          if (e.status !== "completed")
            return reject(Error("EvoK " + input.role + " delegation " + (e.status ?? "failed")));
          // A bare model here would be a violation of the negotiated protocol.
          if (e.agent !== name || e.model !== protocol.modelIdentity(input.model, THINKING) || e.thinking !== THINKING) {
            return reject(Error("unexpected child agent, model or thinking level"));
          }
          if (e.result?.kind !== "text" || !e.result.text?.trim())
            return reject(Error("child returned no text result"));
          resolve({ text: e.result.text, runId: e.runId, usage: e.usage });
        }),
      );
      input.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => cancel("EvoK child timed out"), timeoutMs);
      pi.events.emit(CHANNEL + "request", {
        ...identity,
        agent: name,
        task: JSON.stringify({ task: input.task, roleContext: context, memorySlice: memory }),
        cwd,
        context: "fresh",
        model: input.model,
        thinking: THINKING,
        timeoutMs,
        skill: false,
        artifacts: false,
        intercomBridge: { mode: "off" },
        toolBudget: { hard: 0, block: "*" },
        result: { kind: "text" },
      });
    });
  } finally {
    clearTimeout(timer);
    if (abort) input.signal?.removeEventListener("abort", abort);
    for (const off of unlisten) off();
    handle.dispose();
  }
}
