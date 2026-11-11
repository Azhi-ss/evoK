/** Host-side transport for pi-subagents' foreground delegation protocol.
 * This is the one native transport behind `createPiSubagentsAdapter`: it takes
 * the guarded `SubagentDelegation` (child slice already derived) and the
 * transport-only options, and never re-decides authority. The installed
 * protocol is probed before anything is registered or started, so a skewed or
 * absent install fails closed instead of surfacing later as a registration or
 * identity failure. The host registers the unique evok-meter-* provider
 * against its exclusive loopback relay before calling this function, and owns
 * that relay's lifetime. A child gets only the scoped tools its Task Contract
 * grants (default none) and only in tool turns it may still spend; the grant and
 * the installer entry are written into the child's own workspace. That workspace
 * is fresh, or a copy of a parent snapshot — never shared. No credentials or
 * child-authored filenames are passed to tools here. One deadline covers
 * registration, launch and execution: a
 * cancel or timeout resolves only on a terminal native state for this request
 * id, on confirmation that the child never started, or as an explicit
 * `termination_unconfirmed` carrying the request id — and the registration is
 * never disposed while the child may still be running.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { RuleAudienceRole } from "../competition/rule-visibility";
import { validateMemorySlice, type MemorySlice } from "./memory-slice";
import { redactedRecord } from "./pi-child-records";
import {
  CHILD_STATE_DIR,
  childToolGrants,
  profileForRole,
  writeChildToolPackage,
  type ChildEvidence,
} from "./pi-child-tools";
import { probePiSubagentsProtocol, type PiSubagentsVersionProbe } from "./pi-subagents-protocol";
import { validateRoleContext } from "./role-context";
import { digestValue } from "./security-boundary";
import {
  cancellationOutcome,
  type ExecutionOutcome,
  type ExecutionReceipt,
  type ExecutionRequest,
} from "./execution-protocol";
import { closeHarnessExecution, createEnvironmentSnapshot, environmentRefsOf } from "../harness";
import type { SubagentDelegation, SubagentDelegationResult } from "./subagents-adapter";

interface Host {
  events: {
    emit(channel: string, payload: unknown): void;
    on(channel: string, handler: (payload: unknown) => void): () => void;
  };
}

/** Fresh, or artifacts copied from a parent snapshot. A shared workspace is refused (ADR-0001). */
export type PiChildWorkspace =
  | { readonly mode: "fresh" }
  | { readonly mode: "fork"; readonly from: string };

/** Everything the transport decides itself; the delegation supplies the rest. */
export interface PiChildTransportOptions {
  /** The child's own workspace; the transport never chooses or shares it. */
  cwd: string;
  /** Fully qualified metered child model, e.g. `evok-meter-child/<model id>`. */
  model: string;
  signal?: AbortSignal;
  /** Single deadline covering registration, launch and execution; `0` means it is already spent. */
  timeoutMs?: number;
  /**
   * Non-control tool turns the Task Contract still allows this child. Default 8,
   * the same total the receipt store reconciles against; `0` spends none.
   */
  remainingToolTurns?: number;
  /** How the child's workspace is prepared. Default: a fresh empty directory. */
  workspace?: PiChildWorkspace;
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
  /** The one execution protocol's receipt for this child execution (B4, #255). */
  readonly receipt: ExecutionReceipt;
}

/** What the native child was doing when it failed; already redacted (C8). */
export interface PiChildDiagnostics {
  readonly requestId: string;
  readonly status: string;
  readonly error?: string;
  readonly runId?: string;
  readonly exitCode?: number;
  readonly lastTool?: string;
  readonly outputTail?: readonly string[];
  readonly nativeErrors?: { readonly count: number; readonly lastMessage?: string };
}

/** A native failure carrying the bounded redacted record behind its message (C8). */
export class PiChildFailureError extends Error {
  readonly diagnostics: PiChildDiagnostics;
  readonly receipt: ExecutionReceipt;
  constructor(role: RuleAudienceRole, diagnostics: PiChildDiagnostics, receipt: ExecutionReceipt) {
    super("EvoK " + role + " delegation " + describeFailure(diagnostics));
    this.name = "PiChildFailureError";
    this.diagnostics = diagnostics;
    this.receipt = receipt;
  }
}

/** A cancellation the transport or the plugin confirmed: terminal, never success. */
export class PiChildCancelledError extends Error {
  readonly receipt: ExecutionReceipt;
  constructor(message: string, receipt: ExecutionReceipt) {
    super(message);
    this.name = "PiChildCancelledError";
    this.receipt = receipt;
  }
}

/** The plugin never proved the cancelled child is terminal: reconcile by request id. */
export class PiChildTerminationUnconfirmedError extends Error {
  readonly code = "termination_unconfirmed" as const;
  readonly requestId: string;
  readonly diagnostics: PiChildDiagnostics;
  readonly receipt: ExecutionReceipt;
  constructor(requestId: string, reason: string, diagnostics: PiChildDiagnostics, receipt: ExecutionReceipt) {
    super(reason + "; child termination is unconfirmed" + describeTrace(diagnostics));
    this.name = "PiChildTerminationUnconfirmedError";
    this.requestId = requestId;
    this.diagnostics = diagnostics;
    this.receipt = receipt;
  }
}

const CHANNEL = "prompt-template:subagent:";
/** The retained tail is bounded: enough to explain a failure, never the transcript. */
const TAIL_LINES = 6;
const TAIL_LINE_CHARS = 240;

/** Bounded view of the child's progress stream; never persisted, only reported. */
interface ProgressTrace {
  runId?: string;
  lastTool?: string;
  output: string[];
  nativeErrors?: { count: number; lastMessage?: string };
}

/** Retain what the child streamed instead of draining and discarding it (C8).
 * The plugin reports a rolling window, so a later snapshot replaces the tail
 * rather than appending to it (appending would duplicate lines and evict evidence).
 */
function retainProgress(trace: ProgressTrace, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const update = raw as Record<string, unknown>;
  if (typeof update.runId === "string") trace.runId = update.runId;
  if (typeof update.currentTool === "string") trace.lastTool = update.currentTool;
  const keep = (line: unknown): string[] =>
    typeof line === "string" && line.trim() !== "" ? [line.slice(0, TAIL_LINE_CHARS)] : [];
  if (Array.isArray(update.recentOutputLines)) {
    const window = update.recentOutputLines.flatMap(keep);
    if (window.length) trace.output = window.slice(-TAIL_LINES);
  } else if (typeof update.recentOutput === "string") {
    const [line] = keep(update.recentOutput);
    if (line !== undefined && trace.output.at(-1) !== line) {
      trace.output = [...trace.output, line].slice(-TAIL_LINES);
    }
  }
  const diagnostics = update.providerDiagnostics as
    | { errorCount?: unknown; lastError?: { message?: unknown } }
    | undefined;
  if (!diagnostics || typeof diagnostics !== "object") return;
  const lastMessage = diagnostics.lastError?.message;
  trace.nativeErrors = {
    count: typeof diagnostics.errorCount === "number" ? diagnostics.errorCount : 0,
    ...(typeof lastMessage === "string" ? { lastMessage } : {}),
  };
}

/** One diagnostic write, through the one record guard: redact, then refuse. */
function diagnosticsRecord(
  requestId: string,
  status: string,
  trace: ProgressTrace,
  detail: { error?: string; exitCode?: number } = {},
): PiChildDiagnostics {
  return redactedRecord(
    {
      requestId,
      status,
      ...(detail.error ? { error: detail.error } : {}),
      ...(trace.runId !== undefined ? { runId: trace.runId } : {}),
      ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      ...(trace.lastTool !== undefined ? { lastTool: trace.lastTool } : {}),
      ...(trace.output.length ? { outputTail: trace.output } : {}),
      ...(trace.nativeErrors ? { nativeErrors: trace.nativeErrors } : {}),
    },
    "pi-child diagnostics",
  );
}
function describeFailure(diagnostics: PiChildDiagnostics): string {
  let text = diagnostics.status;
  if (diagnostics.error) text += ": " + diagnostics.error;
  if (diagnostics.nativeErrors !== undefined) {
    text += "; native errors " + diagnostics.nativeErrors.count;
    if (diagnostics.nativeErrors.lastMessage) text += ": " + diagnostics.nativeErrors.lastMessage;
  }
  if (diagnostics.exitCode !== undefined) text += "; exit " + diagnostics.exitCode;
  return text + describeTrace(diagnostics);
}
function describeTrace(diagnostics: PiChildDiagnostics): string {
  let text = "";
  if (diagnostics.runId !== undefined) text += "; native run " + diagnostics.runId;
  if (diagnostics.lastTool !== undefined) text += "; last tool " + diagnostics.lastTool;
  if (diagnostics.outputTail?.length)
    text += "; output: " + diagnostics.outputTail.map((line) => JSON.stringify(line)).join(" | ");
  return text;
}
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
  // C10: the Task Contract decides the child's tools, and the default is none.
  const tools = childToolGrants(role, context.tools);
  const remainingToolTurns = options.remainingToolTurns ?? 8;
  if (!Number.isSafeInteger(remainingToolTurns) || remainingToolTurns < 0 || remainingToolTurns > 8)
    throw Error("invalid remaining tool turns");
  const workspace = options.workspace ?? { mode: "fresh" };
  options.signal?.throwIfAborted();
  // Fail closed before the native registration and before any child exists.
  const protocol = probePiSubagentsProtocol(options.protocolProbe);

  const requestId = randomUUID();
  const trace: ProgressTrace = { output: [] };
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
      tools,
      skills: [],
      extensions: [],
      subagentOnlyExtensions: [] as string[],
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
    const cwd = await prepareWorkspace(options.cwd, workspace);
    // B1: the child's execution environment is frozen before the execution is
    // declared; the Mission's authorization conditions are never part of it.
    const environment = createEnvironmentSnapshot({
      backend: "pi-child-dispatch",
      workspace: cwd,
      tools,
      runtime: "pi-subagents",
      model: options.model,
    });
    // B4: the same protocol the main Run path uses. The child declares what it is
    // before it launches, and every terminal answer below closes the same identity.
    const execution = Object.freeze<ExecutionRequest>({
      executionId: requestId,
      ...(delegation.parentBinding?.runId === undefined
        ? {}
        : { parentExecutionId: delegation.parentBinding.runId }),
      inputs: {
        inputDigest: digestValue({
          task: delegation.task,
          roleContext: context.digest,
          memorySlice: memory.digest,
        }),
      },
      environment: environmentRefsOf(environment),
      capabilities: { tools: [...tools] },
      limits: { timeoutMs, toolTurns: remainingToolTurns },
    });
    // A native failure and its receipt close together, so `diagnostics.status`
    // means the same thing on both paths.
    const failureOf = (diagnostics: PiChildDiagnostics): PiChildFailureError =>
      new PiChildFailureError(
        role,
        diagnostics,
        close("failed", {
          diagnostics: {
            status: diagnostics.status,
            ...(diagnostics.error === undefined ? {} : { error: diagnostics.error }),
          },
        }),
      );
    // Only what this backend alone knows: the turns the child's own installer
    // spent, what the plugin reported, and how it failed. Measurement and
    // assembly are the harness's.
    const close = (
      outcome: ExecutionOutcome,
      detail: { usage?: PiChildResult["usage"]; diagnostics?: { status: string; error?: string } } = {},
    ): ExecutionReceipt =>
      closeHarnessExecution(execution, environment, {
        outcome,
        // The installer already spent these turns by the one rule; the receipt
        // reports that number instead of counting a second way (C7, B4).
        toolTurns: { spent: spentToolTurns(cwd, memory.runId), limit: remainingToolTurns },
        // `own`: the child is metered by its own relay, so the parent session's
        // reported usage never contains it and this number must be added once (B3).
        ...(detail.usage === undefined ? {} : { usage: detail.usage, usageAttribution: "own" }),
        ...(detail.diagnostics === undefined ? {} : { diagnostics: detail.diagnostics }),
      });
    // A granted tool only exists if the child is pointed at the installer entry,
    // which carries the grant list and the turn budget it must enforce.
    if (tools.length)
      registration.definition.subagentOnlyExtensions = [
        await writeChildToolPackage(join(cwd, CHILD_STATE_DIR), {
          roleRunId: memory.runId,
          profile: profileForRole(role),
          tools,
          remainingToolTurns,
          evidence: evidenceOf(memory),
        }),
      ];
    // A budget already spent while preparing never registers or launches a child.
    if (Date.now() >= deadlineAt) cancel("EvoK child timed out");
    if (cancelReason !== undefined)
      throw new PiChildCancelledError(
        cancelReason + "; child never started",
        close(cancellationOutcome(true)),
      );
    pi.events.emit(REGISTER, registration);
    if (!registration.result?.ok)
      throw failureOf(
        diagnosticsRecord(requestId, "registration_failed", trace, {
          error: registration.result
            ? registration.result.error.message
            : "pi-subagents runtime registration unavailable",
        }),
      );
    handle = registration.result.registration;
    // A cancel during registration never launched anything: dispose is safe.
    if (cancelReason !== undefined)
      throw new PiChildCancelledError(
        cancelReason + "; child never started",
        close(cancellationOutcome(true)),
      );
    return await new Promise<PiChildDelegationResult>((resolve, reject) => {
      settleCancel = (reason) => {
        if (!started)
          return finish(() =>
            reject(new PiChildCancelledError(reason + "; child never started", close(cancellationOutcome(true)))),
          );
        pi.events.emit(CHANNEL + "cancel", identity);
        // Bounded wait for the terminal native state. The outcome never becomes a
        // success and the child may still run, so the registration stays put.
        if (!settled)
          confirmDeadline = setTimeout(
            () =>
              finish(
                () =>
                  reject(
                    new PiChildTerminationUnconfirmedError(
                      requestId,
                      reason,
                      diagnosticsRecord(requestId, "termination_unconfirmed", trace, { error: reason }),
                      // The plugin never proved the child terminal: unknown, never success.
                      close(cancellationOutcome(false), {
                        diagnostics: { status: "termination_unconfirmed", error: reason },
                      }),
                    ),
                  ),
                true,
              ),
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
          if (!isOurs(e)) return;
          retainProgress(trace, e);
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
            const reason = (raw as { error?: unknown }).error;
            return finish(() =>
              reject(
                failureOf(
                  diagnosticsRecord(requestId, "invalid_request", trace, {
                    ...(typeof reason === "string" ? { error: reason } : {}),
                  }),
                ),
              ),
            );
          }
          if (!isOurs(raw)) return;
          const e = raw as Partial<PiChildResult> & {
            agent?: string;
            model?: string;
            thinking?: string;
            status?: string;
            error?: string;
            exitCode?: number;
            result?: { kind?: string; text?: string };
          };
          // The plugin emits this only once its own run for this request id is
          // terminal, which is the terminal native state this transport can see.
          const cancelled = cancelReason;
          if (cancelled !== undefined)
            return finish(() =>
              reject(new PiChildCancelledError(cancelled, close(cancellationOutcome(true)))),
            );
          // Native status, error text, exit code and the retained stream tail: a
          // crash reports what happened instead of a bare "failed" (C8).
          if (e.status !== "completed")
            return finish(() => {
              // The terminal response can carry the only provider diagnostics there were.
              retainProgress(trace, e);
              reject(
                failureOf(
                  diagnosticsRecord(requestId, e.status ?? "failed", trace, {
                    ...(typeof e.error === "string" ? { error: e.error } : {}),
                    ...(typeof e.exitCode === "number" ? { exitCode: e.exitCode } : {}),
                  }),
                ),
              );
            });
          // A bare model here would be a violation of the negotiated protocol.
          // It is a failed execution, so it closes with a receipt like any other.
          if (e.agent !== name || e.model !== protocol.modelIdentity(options.model, THINKING) || e.thinking !== THINKING) {
            const reason = "unexpected child agent, model or thinking level";
            return finish(() =>
              reject(failureOf(diagnosticsRecord(requestId, "identity_mismatch", trace, { error: reason }))),
            );
          }
          if (e.result?.kind !== "text" || !e.result.text?.trim()) {
            const reason = "child returned no text result";
            return finish(() =>
              reject(failureOf(diagnosticsRecord(requestId, "no_result", trace, { error: reason }))),
            );
          }
          const text = e.result.text;
          finish(() =>
            resolve({
              agent: delegation.agent,
              value: { text, runId: e.runId, usage: e.usage },
              receipt: close("succeeded", {
                ...(e.usage === undefined ? {} : { usage: e.usage }),
              }),
            }),
          );
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
          // No `toolBudget`: it counts calls, while the child's grant is spent in
          // tool turns, which the installer enforces as the one rule (C7).
          result: { kind: "text" },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        finish(() =>
          reject(failureOf(diagnosticsRecord(requestId, "launch_failed", trace, { error: reason }))),
        );
      }
    });
  } catch (error) {
    finish(() => {});
    throw error;
  }
}

/** The turns the child's own installer already wrote, by the one tool-turn rule. */
function spentToolTurns(cwd: string, roleRunId: string): number {
  try {
    const turns: unknown = JSON.parse(readFileSync(join(cwd, CHILD_STATE_DIR, roleRunId + ".turns.json"), "utf8"));
    return typeof turns === "number" && Number.isInteger(turns) && turns >= 0 ? turns : 0;
  } catch {
    // No granted tool, or no tool message: nothing was spent.
    return 0;
  }
}

/** A fresh empty workspace, or the parent snapshot copied into it. Never shared. */
async function prepareWorkspace(cwd: string, workspace: PiChildWorkspace): Promise<string> {
  if (!isAbsolute(cwd)) throw Error("child needs an absolute workspace path");
  if (workspace.mode !== "fresh" && workspace.mode !== "fork")
    throw Error("a child workspace is fresh or a fork of a parent snapshot; a shared one is out of scope");
  const root = await realpath(cwd);
  if ((await readdir(root)).length !== 0) throw Error("child needs its own empty workspace");
  if (workspace.mode === "fresh") return root;
  const from = await realpath(workspace.from).catch(() => {
    throw Error("fork needs an existing parent snapshot directory: " + workspace.from);
  });
  if (from === root || from.startsWith(root + sep) || !(await stat(from)).isDirectory())
    throw Error("fork needs an existing parent snapshot directory outside the child workspace: " + workspace.from);
  // shortcut: the snapshot is copied whole, unmeasured; cap it if a parent
  // workspace ever grows large enough to make a bounded fork worth the I/O.
  await cp(from, root, { recursive: true, force: true });
  return root;
}

/** The evidence a granted child may read back: its own slice's findings, nothing wider. */
function evidenceOf(memory: MemorySlice): ChildEvidence[] {
  return memory.findings.map((finding) => ({ ref: finding.findingId, summary: finding.summary }));
}
