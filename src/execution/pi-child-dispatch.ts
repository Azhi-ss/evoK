/** Host-side transport for pi-subagents' foreground delegation protocol.
 * This is the one native transport behind `createPiSubagentsAdapter`: it takes
 * the guarded `SubagentDelegation` (child slice already derived) and the
 * transport-only options, and never re-decides authority. The installed
 * protocol is probed before anything is registered or started, so a skewed or
 * absent install fails closed instead of surfacing later as a registration or
 * identity failure. The host registers the unique evok-meter-* provider
 * against its exclusive loopback relay before calling this function, and owns
 * that relay's lifetime. No credentials or child-authored filenames are passed
 * to tools here.
 */
import { randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RuleAudienceRole } from "../competition/rule-visibility";
import { validateMemorySlice } from "./memory-slice";
import { probePiSubagentsProtocol, type PiSubagentsVersionProbe } from "./pi-subagents-protocol";
import { validateRoleContext } from "./role-context";
import type { SubagentDelegation, SubagentDelegationResult } from "./subagents-adapter";

interface Host {
  events: {
    emit(channel: string, payload: unknown): void;
    on(channel: string, handler: (payload: unknown) => void): () => void;
  };
}

/** Everything the transport decides itself; the delegation supplies the rest. */
export interface PiChildTransportOptions {
  /** The child's own workspace; the transport never chooses or shares it. */
  cwd: string;
  /** Fully qualified metered child model, e.g. `evok-meter-child/<model id>`. */
  model: string;
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

export interface PiChildDelegationResult extends SubagentDelegationResult {
  readonly value: PiChildResult;
}

const CHANNEL = "prompt-template:subagent:";
const REGISTER = "pi-subagents:runtime-agent-register:v1";
const THINKING = "max";
const OBJECTIVE: Record<RuleAudienceRole, string> = {
  researcher: "Produce the requested candidate changes. Return your answer as text to your supervisor.",
  critic:
    "Challenge the candidate: name its weakest claim and the evidence that would falsify it. Return your assessment to your supervisor.",
  reviewer:
    "Review the candidate independently against the supplied evidence. Return your assessment to your supervisor.",
};

export async function dispatchPiChild(
  pi: Host,
  delegation: SubagentDelegation,
  options: PiChildTransportOptions,
): Promise<PiChildDelegationResult> {
  // The adapter guard already refused forbidden authority and memory widening;
  // the transport only re-checks the binding it puts on the wire. The guard
  // allows a delegation with no child context/slice, so the native registration
  // states its extra requirement here rather than half-registering a child.
  if (delegation.roleContext === undefined || delegation.memorySlice === undefined)
    throw Error("pi-child transport: a delegated child needs its own bound role context and memory slice");
  const context = validateRoleContext(delegation.roleContext);
  const memory = validateMemorySlice(delegation.memorySlice);
  const role = context.role;
  const audit = context.audit;
  if (
    audit.memoryDigest !== memory.digest ||
    audit.runId !== memory.runId ||
    audit.targetAgentId !== memory.targetAgentId ||
    audit.taskId !== memory.taskId ||
    audit.missionId !== memory.missionId
  ) {
    throw Error("child identity and MemorySlice must share the same broker binding");
  }
  if (!/^evok-meter-[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.model))
    throw Error("child requires a fully qualified metered model");
  const cwd = await realpath(options.cwd);
  if (!isAbsolute(options.cwd) || (await readdir(cwd)).length !== 0) throw Error("child needs its own empty workspace");
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_478_647)
    throw Error("invalid child timeout");
  options.signal?.throwIfAborted();
  // Fail closed before the native registration and before any child exists.
  const protocol = probePiSubagentsProtocol(options.protocolProbe);

  const requestId = randomUUID();
  const identity = { requestId, ownerRunId: memory.missionId, nodeId: memory.runId };
  const name = "evok-" + role + "-" + requestId;
  const registration = {
    version: 1,
    name,
    definition: {
      description: "EvoK " + role,
      systemPrompt: OBJECTIVE[role],
      systemPromptMode: "replace",
      defaultContext: "fresh",
      defaultAsync: false,
      model: options.model,
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
    return await new Promise<PiChildDelegationResult>((resolve, reject) => {
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
            options.onUpdate?.({
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
            return reject(Error("EvoK " + role + " delegation invalid_request"));
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
            return reject(Error("EvoK " + role + " delegation " + (e.status ?? "failed")));
          // A bare model here would be a violation of the negotiated protocol.
          if (e.agent !== name || e.model !== protocol.modelIdentity(options.model, THINKING) || e.thinking !== THINKING) {
            return reject(Error("unexpected child agent, model or thinking level"));
          }
          if (e.result?.kind !== "text" || !e.result.text?.trim())
            return reject(Error("child returned no text result"));
          resolve({ agent: delegation.agent, value: { text: e.result.text, runId: e.runId, usage: e.usage } });
        }),
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => cancel("EvoK child timed out"), timeoutMs);
      pi.events.emit(CHANNEL + "request", {
        ...identity,
        agent: name,
        task: JSON.stringify({ task: delegation.task, roleContext: context, memorySlice: memory }),
        cwd,
        context: "fresh",
        model: options.model,
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
    if (abort) options.signal?.removeEventListener("abort", abort);
    for (const off of unlisten) off();
    handle.dispose();
  }
}
