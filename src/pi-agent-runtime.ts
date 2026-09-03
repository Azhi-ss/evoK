import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TaskContract, ToyAgentRuntime } from "./toy-harness";
import {
  createAgentSession,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const CODING_TOOLS = ["bash", "edit", "write"] as const;

export interface TaskPlan {
  readonly objective: string;
  readonly constraints?: Record<string, unknown>;
  readonly expectedOutputs?: readonly string[];
}

export interface RolePlan {
  readonly name: string;
  readonly instructions?: string;
  readonly tools?: readonly string[];
  /** Coding tools require both this explicit grant and an approved isolated workspace. */
  readonly allowCodingTools?: boolean;
}

export interface ApprovedWorkspace {
  readonly path: string;
  readonly isolated: boolean;
  readonly approved: boolean;
}

export interface PiAgentRuntimeRequest {
  readonly task: TaskPlan;
  readonly role: RolePlan;
  readonly workspace?: ApprovedWorkspace;
}

export interface RuntimeUsage {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export type RuntimeEvent = {
  readonly type:
    | "session_start" | "session_end" | "agent_start" | "agent_end"
    | "turn_start" | "turn_end" | "agent_settled"
    | "message_start" | "message_update" | "message_end"
    | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "error";
  readonly sessionId: string;
  readonly raw?: unknown;
  readonly reason?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
};

export interface AgentRuntimeResult {
  readonly sessionId: string;
  readonly workspace: string;
  readonly events: readonly RuntimeEvent[];
  readonly ledger: readonly RuntimeEvent[];
  readonly usage: RuntimeUsage;
  readonly stopReason: string;
  readonly text?: string;
}

export interface AgentRuntimeSession {
  readonly sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getSessionStats?(): unknown;
}

export type AgentSessionFactory = (options: Pick<CreateAgentSessionOptions, "cwd" | "tools"> & Partial<CreateAgentSessionOptions>) => Promise<AgentRuntimeSession>;

export interface PiAgentRuntimeOptions {
  readonly workspaceRoot?: string;
  readonly sessionFactory?: AgentSessionFactory;
  readonly sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "tools" | "sessionManager">;
  readonly onDispose?: () => void;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function within(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function abortError(): Error {
  const error = new Error("agent run aborted");
  error.name = "AbortError";
  return error;
}

function usageFrom(value: unknown): RuntimeUsage | undefined {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.cost)) return undefined;
  const tokenKeys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  if (!tokenKeys.every((key) => finite(value.tokens[key])) || !costKeys.every((key) => finite(value.cost[key]))) return undefined;
  return {
    tokens: Object.fromEntries(tokenKeys.map((key) => [key, value.tokens[key]])) as RuntimeUsage["tokens"],
    cost: Object.fromEntries(costKeys.map((key) => [key, value.cost[key]])) as RuntimeUsage["cost"],
  };
}

function usageFromSdk(value: unknown): RuntimeUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const u = value.usage;
  if (!isRecord(u.cost)) return undefined;
  return usageFrom({
    tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens },
    cost: u.cost,
  });
}

function usageFromStats(value: unknown): RuntimeUsage | undefined {
  if (!isRecord(value) || !isRecord(value.tokens)) return undefined;
  const tokens = value.tokens;
  if (!(["input", "output", "cacheRead", "cacheWrite", "total"] as const).every((key) => finite(tokens[key]))) return undefined;
  const cost = value.cost;
  if (finite(cost)) return { tokens: tokens as RuntimeUsage["tokens"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
  return usageFrom({ tokens, cost });
}

function addUsage(left: RuntimeUsage | undefined, right: RuntimeUsage): RuntimeUsage {
  if (!left) return right;
  return {
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      total: left.tokens.total + right.tokens.total,
    },
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function textFromMessage(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

const NORMALIZED_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
  "session_start", "session_end", "agent_start", "agent_end", "turn_start", "turn_end", "agent_settled",
  "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "error",
]);

function toolsFor(role: RolePlan, workspace: ApprovedWorkspace): string[] {
  const requested = role.tools ? [...role.tools] : [...READ_ONLY_TOOLS];
  if (requested.some((tool) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool) && !(CODING_TOOLS as readonly string[]).includes(tool))) {
    throw new Error("role requests an unknown tool");
  }
  if (role.allowCodingTools !== undefined && typeof role.allowCodingTools !== "boolean") {
    throw new TypeError("allowCodingTools must be a boolean");
  }
  const coding = requested.some((tool) => (CODING_TOOLS as readonly string[]).includes(tool));
  if (coding && (role.allowCodingTools !== true || workspace.approved !== true || workspace.isolated !== true)) {
    throw new Error("coding tools require an approved isolated workspace and explicit role grant");
  }
  return requested;
}

function promptFor(input: PiAgentRuntimeRequest): string {
  const constraints = input.task.constraints ? `\nConstraints: ${JSON.stringify(input.task.constraints)}` : "";
  const outputs = input.task.expectedOutputs?.length ? `\nExpected outputs: ${input.task.expectedOutputs.join(", ")}` : "";
  return `Task objective: ${input.task.objective}\nRole: ${input.role.name}${input.role.instructions ? `\nRole instructions: ${input.role.instructions}` : ""}${constraints}${outputs}`;
}

function objectFromText(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"));
  if (!candidate) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate.trim());
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function verificationFromText(text: string | undefined, stage: string): { ok: boolean; objections: string[] } {
  const parsed = objectFromText(text);
  if (!parsed || typeof parsed.ok !== "boolean") {
    return { ok: false, objections: [`${stage} output must be a JSON object with boolean ok`] };
  }
  return {
    ok: parsed.ok,
    objections: Array.isArray(parsed.objections)
      ? parsed.objections.filter((value): value is string => typeof value === "string")
      : [],
  };
}

const defaultFactory: AgentSessionFactory = async (options) => {
  const result = await createAgentSession({
    ...options,
    agentDir: options.agentDir ?? join(tmpdir(), "evok-pi-agent"),
    sessionManager: SessionManager.inMemory(options.cwd),
  });
  return result.session;
};

export class PiAgentRuntime {
  private readonly root: string;
  private readonly factory: AgentSessionFactory;
  private readonly sessionOptions: PiAgentRuntimeOptions["sessionOptions"];
  private readonly usedWorkspaces = new Set<string>();
  private readonly usedSessions = new Set<string>();
  private readonly onDispose?: () => void;
  private harnessRun = 0;

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.root = resolve(options.workspaceRoot ?? tmpdir());
    this.factory = options.sessionFactory ?? defaultFactory;
    this.sessionOptions = options.sessionOptions;
    this.onDispose = options.onDispose;
  }

  async execute(input: PiAgentRuntimeRequest, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    if (!isRecord(input.task) || typeof input.task.objective !== "string" || input.task.objective.trim() === "") throw new TypeError("task objective is required");
    if (!isRecord(input.role) || typeof input.role.name !== "string" || input.role.name.trim() === "") throw new TypeError("role plan is required");
    if (!input.workspace || typeof input.workspace.path !== "string"
      || typeof input.workspace.approved !== "boolean" || typeof input.workspace.isolated !== "boolean"
      || input.workspace.approved !== true || input.workspace.isolated !== true) {
      throw new TypeError("an approved isolated workspace is required");
    }
    if (signal?.aborted) throw abortError();

    const requestedRoot = resolve(input.workspace.path);
    if (!isAbsolute(input.workspace.path) || !within(this.root, requestedRoot)) throw new Error("workspace path escapes the approved workspace root");
    if (this.usedWorkspaces.has(requestedRoot)) throw new Error("workspace/session reuse is not allowed");
    const tools = toolsFor(input.role, input.workspace);
    await mkdir(requestedRoot, { recursive: true });
    const approvedRoot = await realpath(requestedRoot);
    const approvedWorkspaceRoot = await realpath(this.root);
    if (!within(approvedWorkspaceRoot, approvedRoot)) throw new Error("workspace path escapes the approved workspace root");
    if (this.usedWorkspaces.has(approvedRoot)) throw new Error("workspace/session reuse is not allowed");
    this.usedWorkspaces.add(approvedRoot);
    const workspace = await realpath(await mkdtemp(join(approvedRoot, "run-")));
    const events: RuntimeEvent[] = [];
    const seen = new Set<string>();
    const session = await this.factory({ cwd: workspace, tools, ...this.sessionOptions });
    const sessionId = session.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim() === "" || this.usedSessions.has(sessionId)) {
      try { session.dispose(); } finally { this.onDispose?.(); }
      throw new Error("workspace/session reuse is not allowed");
    }
    this.usedSessions.add(sessionId);
    const add = (event: RuntimeEvent, key = JSON.stringify([event.type, event.toolCallId, event.toolName, event.reason, event.isError, event.raw])) => {
      if (seen.has(key)) return;
      seen.add(key);
      events.push(event);
    };
    add({ type: "session_start", sessionId });
    let completionUsage: RuntimeUsage | undefined;
    const accountedMessages = new Set<string>();
    let stopReason: string | undefined;
    let completionText: string | undefined;
    let eventError: Error | undefined;
    let abortPromise: Promise<void> | undefined;
    const unsubscribe = session.subscribe((raw) => {
      if (!isRecord(raw) || typeof raw.type !== "string") return;
      const type = raw.type;
      if (type === "agent_end") {
        const messages = Array.isArray(raw.messages) ? raw.messages : [];
        for (const message of messages) {
          if (!isRecord(message) || message.role !== "assistant") continue;
          const key = JSON.stringify(message);
          const usage = usageFromSdk(message);
          if (usage && !accountedMessages.has(key)) {
            accountedMessages.add(key);
            completionUsage = addUsage(completionUsage, usage);
          }
        }
        const assistant = messages.findLast((message) => isRecord(message) && message.role === "assistant");
        if (isRecord(assistant)) {
          completionText = textFromMessage(assistant) || completionText;
          if (typeof assistant.stopReason === "string") stopReason = assistant.stopReason;
          if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
            eventError = new Error(String(assistant.errorMessage ?? `agent ${assistant.stopReason}`));
          }
        }
      }
      if (type === "tool_execution_end" && raw.isError === true) eventError = new Error(`tool execution failed: ${String(raw.toolName ?? "unknown tool")}`);
      if (type === "error" || type === "session_error") eventError = new Error(String(raw.message ?? raw.errorMessage ?? "agent session failed"));
      const normalizedType = type === "session_error" ? "error" : type;
      if (!NORMALIZED_EVENT_TYPES.has(normalizedType as RuntimeEvent["type"])) return;
      add({
        type: normalizedType as RuntimeEvent["type"], sessionId, raw,
        toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
        toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
        isError: typeof raw.isError === "boolean" ? raw.isError : undefined,
        reason: typeof raw.reason === "string" ? raw.reason : undefined,
      });
    });
    const onAbort = () => { abortPromise ??= session.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) {
        onAbort();
        await abortPromise;
        throw abortError();
      }
      await session.prompt(promptFor(input));
      if (abortPromise || signal?.aborted) throw abortError();
      if (eventError) throw eventError;
      const stats = session.getSessionStats?.();
      completionUsage = usageFromStats(stats) ?? completionUsage;
      if (!completionUsage) throw new Error("agent completion is missing usage/cost data");
      if (!stopReason) throw new Error("agent completion is missing stop reason");
      add({ type: "session_end", sessionId, reason: stopReason });
      return { sessionId, workspace, events, ledger: events, usage: completionUsage, stopReason, text: completionText };
    } catch (error) {
      if (abortPromise) await abortPromise;
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      try { session.dispose(); } finally { this.onDispose?.(); }
    }
  }

  run(input: PiAgentRuntimeRequest, signal?: AbortSignal): Promise<AgentRuntimeResult> {
    return this.execute(input, signal);
  }

  private async executeHarnessPlan(input: {
    missionId: string;
    branchId: string;
    taskContract: TaskContract;
    stage: string;
    instructions: string;
    expectedOutputs?: readonly string[];
  }): Promise<AgentRuntimeResult> {
    const workspace = join(this.root, ".evok-harness", encodeURIComponent(input.missionId), encodeURIComponent(input.branchId), `${this.harnessRun++}-${input.stage}`);
    return this.execute({
      task: { objective: input.taskContract.objective, constraints: input.taskContract.constraints, expectedOutputs: input.expectedOutputs },
      role: { name: input.stage, instructions: input.instructions, tools: [...READ_ONLY_TOOLS] },
      workspace: { path: workspace, isolated: true, approved: true },
    });
  }

  async selfVerify(input: Parameters<ToyAgentRuntime["selfVerify"]>[0]): Promise<{ ok: boolean; objections?: string[] }> {
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.taskContract, stage: "self-verify",
      instructions: "Check the approved Task and Role plan. Return JSON {\"ok\":true,\"objections\":[]} unless the plan is incomplete.",
      expectedOutputs: ["JSON self-verification result"],
    });
    return verificationFromText(result.text, "self-verification");
  }

  async propose(input: Parameters<ToyAgentRuntime["propose"]>[0]): Promise<{ files: Record<string, string> }> {
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.taskContract, stage: "propose",
      instructions: "Produce the candidate. Return JSON {\"files\":{\"score\":\"number\"}} with the candidate files and no prose.",
      expectedOutputs: ["JSON candidate files"],
    });
    const parsed = objectFromText(result.text);
    const files = parsed?.files;
    if (isRecord(files)) return { files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, String(value)])) };
    return { files: { output: result.text ?? "" } };
  }

  async falsify(input: Parameters<ToyAgentRuntime["falsify"]>[0]): Promise<{ ok: boolean; objections: string[] }> {
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.snapshot.contract, stage: "falsify",
      instructions: `Actively find a counterexample in this candidate snapshot: ${JSON.stringify(input.snapshot)}. Return JSON {\"ok\":true,\"objections\":[]}.`,
      expectedOutputs: ["JSON falsification result"],
    });
    return verificationFromText(result.text, "falsification");
  }
}

export type Task = TaskPlan;
export type Role = RolePlan;
export interface AgentRuntime extends Pick<PiAgentRuntime, "execute" | "run" | "selfVerify" | "propose" | "falsify"> {}

export async function createPiAgentRuntime(options: PiAgentRuntimeOptions = {}): Promise<PiAgentRuntime> {
  return new PiAgentRuntime(options);
}
