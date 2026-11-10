/** Host-side transport for pi-subagents' foreground delegation protocol.
 * This is the one native transport behind `createPiSubagentsAdapter`: it takes
 * the guarded `SubagentDelegation` (child slice already derived) and the
 * transport-only options, and never re-decides authority. The installed
 * protocol is probed before anything is registered or started, so a skewed or
 * absent install fails closed instead of surfacing later as a registration or
 * identity failure. The host registers the unique evok-meter-* provider
 * against its exclusive loopback relay before calling this function, and owns
 * that relay's lifetime. No credentials or child-authored filenames are passed
 * to tools here. One deadline covers registration, launch and execution: a
 * cancel or timeout resolves only on a terminal native state for this request
 * id, on confirmation that the child never started, or as an explicit
 * `termination_unconfirmed` carrying the request id — and the registration is
 * never disposed while the child may still be running.
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
  /** Single deadline covering registration, launch and execution; `0` means it is already spent. */
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

/** The plugin never proved the cancelled child is terminal: reconcile by request id. */
export class PiChildTerminationUnconfirmedError extends Error {
  readonly code = "termination_unconfirmed" as const;
  readonly requestId: string;
  constructor(requestId: string, reason: string) {
    super(reason + "; child termination is unconfirmed");
    this.name = "PiChildTerminationUnconfirmedError";
    this.requestId = requestId;
  }
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
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_478_647)
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
  // The single deadline only asks the plugin to cancel; it never settles as a
  // success, and a cancel before the launch request is confirmed by the child
  // never having started.
  const cancelConfirmMs = Math.min(timeoutMs, 5000);
  const unlisten: (() => void)[] = [];
  let cancelReason: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let confirmDeadline: ReturnType<typeof setTimeout> | undefined;
  let settleCancel: ((reason: string) => void) | undefined;
  let handle: { dispose(): void } | undefined;
  let started = false;
  let settled = false;
  const finish = (outcome: () => void, keepRegistration = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(confirmDeadline);
    options.signal?.removeEventListener("abort", abort);
    for (const off of unlisten) off();
    if (!keepRegistration) handle?.dispose();
    outcome();
  };
  const abort = () => cancel("EvoK child cancelled");
  function cancel(reason: string) {
    if (settled || cancelReason !== undefined) return;
    cancelReason = reason;
    clearTimeout(deadline);
    settleCancel?.(reason);
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadlineAt = Date.now() + timeoutMs;
  deadline = setTimeout(() => cancel("EvoK child timed out"), timeoutMs);
  try {
    const cwd = await realpath(options.cwd);
    if (!isAbsolute(options.cwd) || (await readdir(cwd)).length !== 0)
      throw Error("child needs its own empty workspace");
    // A budget already spent while preparing never registers or launches a child.
    if (Date.now() >= deadlineAt) cancel("EvoK child timed out");
    if (cancelReason !== undefined) throw Error(cancelReason + "; child never started");
    pi.events.emit(REGISTER, registration);
    if (!registration.result?.ok)
      throw Error(
        "pi-subagents runtime registration unavailable" +
          (registration.result ? ": " + registration.result.error.message : ""),
      );
    handle = registration.result.registration;
    // A cancel during registration never launched anything: dispose is safe.
    if (cancelReason !== undefined) throw Error(cancelReason + "; child never started");
    return await new Promise<PiChildDelegationResult>((resolve, reject) => {
      settleCancel = (reason) => {
        if (!started) return finish(() => reject(Error(reason + "; child never started")));
        pi.events.emit(CHANNEL + "cancel", identity);
        // Bounded wait for the terminal native state. The outcome never becomes a
        // success and the child may still run, so the registration stays put.
        if (!settled)
          confirmDeadline = setTimeout(
            () => finish(() => reject(new PiChildTerminationUnconfirmedError(requestId, reason)), true),
            cancelConfirmMs,
          );
      };
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
            return finish(() => reject(Error("EvoK " + role + " delegation invalid_request")));
          }
          if (!isOurs(raw)) return;
          const e = raw as Partial<PiChildResult> & {
            agent?: string;
            model?: string;
            thinking?: string;
            status?: string;
            result?: { kind?: string; text?: string };
          };
          // The plugin emits this only once its own run for this request id is
          // terminal, which is the terminal native state this transport can see.
          const cancelled = cancelReason;
          if (cancelled !== undefined) return finish(() => reject(Error(cancelled)));
          if (e.status !== "completed")
            return finish(() => reject(Error("EvoK " + role + " delegation " + (e.status ?? "failed"))));
          // A bare model here would be a violation of the negotiated protocol.
          if (e.agent !== name || e.model !== protocol.modelIdentity(options.model, THINKING) || e.thinking !== THINKING) {
            return finish(() => reject(Error("unexpected child agent, model or thinking level")));
          }
          if (e.result?.kind !== "text" || !e.result.text?.trim())
            return finish(() => reject(Error("child returned no text result")));
          const text = e.result.text;
          finish(() => resolve({ agent: delegation.agent, value: { text, runId: e.runId, usage: e.usage } }));
        }),
      );
      started = true;
      try {
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
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : Error(String(error))));
      }
    });
  } catch (error) {
    finish(() => {});
    throw error;
  }
}
