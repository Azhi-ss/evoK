import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TaskContract, ToyAgentRuntime } from "./toy-harness";
import {
  deepFreeze,
  digestValue,
  restrictSandboxPolicy,
  SandboxBoundary,
  SandboxViolation,
  SecretRedactor,
  type SandboxPolicy,
} from "./security-boundary";
import { verificationRoleContract, type VerificationRole } from "./verification-gates";
import type { BranchRunIdentity } from "./branch-recovery";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MissingAuthenticationError, type SessionModelResolver } from "./evok-model";
import type { EvokResources } from "./evok-resources";
export { MissingAuthenticationError } from "./evok-model";

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
  /** Team verification roles are constrained to their declared capabilities. */
  readonly verificationRole?: VerificationRole;
  readonly allowTestExecution?: boolean;
  /** Coding tools require both this explicit grant and an approved isolated workspace. */
  readonly allowCodingTools?: boolean;
}

export interface ApprovedWorkspace {
  readonly path: string;
  readonly isolated: boolean;
  readonly approved: boolean;
  readonly sandbox?: SandboxPolicy;
  /**
   * Additional trusted absolute directories the Run may read but never write
   * (e.g. the research project opened by the foreground CLI). Merged into the
   * sandbox policy; runs cannot widen them (#109).
   */
  readonly readRoots?: readonly string[];
}

export interface PiAgentRuntimeRequest {
  readonly task: TaskPlan;
  readonly role: RolePlan;
  readonly workspace?: ApprovedWorkspace;
  readonly secrets?: readonly string[];
  readonly tier?: string;
  readonly intentId?: string;
  readonly identity?: BranchRunIdentity;
  readonly repair?: boolean;
}

export type IntentStatus =
  | "DECLARED"
  | "DISPATCHED"
  | "COMPLETED"
  | "FAILED"
  | "PAUSED"
  | "QUARANTINED";

export interface DurableToolIntent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly status: "DISPATCHED" | "COMPLETED" | "FAILED";
  readonly args?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export interface IntentReconcileRecord {
  readonly action: "repair" | "adopt_result" | "quarantine";
  readonly reconciledAt: number;
  readonly note?: string;
  readonly adoptedResult?: AgentRuntimeResult;
}

export interface IntentReconcileDecision {
  readonly action: "repair" | "adopt_result" | "quarantine";
  readonly note?: string;
  readonly reason?: string;
  readonly result?: AgentRuntimeResult;
}

export interface DurableIntentRecord {
  readonly intentId: string;
  readonly role: string;
  readonly tier: string;
  readonly inputDigest: string;
  readonly status: IntentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly identity?: BranchRunIdentity;
  readonly repair?: boolean;
  readonly toolIntents?: readonly DurableToolIntent[];
  readonly result?: AgentRuntimeResult;
  readonly error?: string;
  readonly uncertainReason?: string;
  readonly reconcile?: IntentReconcileRecord;
}

export interface DurableIntentStore {
  recordIntent(record: Omit<DurableIntentRecord, "createdAt" | "updatedAt">): Promise<DurableIntentRecord>;
  updateIntent(intentId: string, patch: Partial<DurableIntentRecord>): Promise<DurableIntentRecord>;
  getIntent(intentId: string): Promise<DurableIntentRecord | undefined>;
  findIntent(criteria: { role?: string; tier?: string; inputDigest?: string; runId?: string; intentId?: string }): Promise<DurableIntentRecord | undefined>;
  listIntents(): Promise<readonly DurableIntentRecord[]>;
  auditPendingIntents?(): Promise<readonly DurableIntentRecord[]>;
}

export class InMemoryDurableIntentStore implements DurableIntentStore {
  private readonly records = new Map<string, DurableIntentRecord>();

  setDirect(record: DurableIntentRecord): void {
    this.records.set(record.intentId, deepFreeze(JSON.parse(JSON.stringify(record))) as DurableIntentRecord);
  }

  async recordIntent(record: Omit<DurableIntentRecord, "createdAt" | "updatedAt">): Promise<DurableIntentRecord> {
    const existing = this.records.get(record.intentId);
    if (existing && !record.repair && existing.status === "COMPLETED") {
      return existing;
    }
    const now = Date.now();
    const created: DurableIntentRecord = {
      ...record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(record.intentId, deepFreeze(JSON.parse(JSON.stringify(created))) as DurableIntentRecord);
    return this.records.get(record.intentId)!;
  }

  async updateIntent(intentId: string, patch: Partial<DurableIntentRecord>): Promise<DurableIntentRecord> {
    const existing = this.records.get(intentId);
    if (!existing) throw new Error(`intent not found: ${intentId}`);
    const updated: DurableIntentRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.records.set(intentId, deepFreeze(JSON.parse(JSON.stringify(updated))) as DurableIntentRecord);
    return this.records.get(intentId)!;
  }

  async getIntent(intentId: string): Promise<DurableIntentRecord | undefined> {
    return this.records.get(intentId);
  }

  async findIntent(criteria: { role?: string; tier?: string; inputDigest?: string; runId?: string; intentId?: string }): Promise<DurableIntentRecord | undefined> {
    for (const record of this.records.values()) {
      if (criteria.intentId && record.intentId !== criteria.intentId) continue;
      if (criteria.runId && record.identity?.runId !== criteria.runId) continue;
      if (criteria.role && record.role !== criteria.role) continue;
      if (criteria.tier && record.tier !== criteria.tier) continue;
      if (criteria.inputDigest && record.inputDigest !== criteria.inputDigest) continue;
      return record;
    }
    return undefined;
  }

  async listIntents(): Promise<readonly DurableIntentRecord[]> {
    return Array.from(this.records.values());
  }

  async auditPendingIntents(): Promise<readonly DurableIntentRecord[]> {
    const paused: DurableIntentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === "DISPATCHED") {
        const updated: DurableIntentRecord = {
          ...record,
          status: "PAUSED",
          uncertainReason: "crash occurred after intent was sent but before result was confirmed",
          updatedAt: Date.now(),
        };
        this.records.set(record.intentId, deepFreeze(JSON.parse(JSON.stringify(updated))) as DurableIntentRecord);
        paused.push(this.records.get(record.intentId)!);
      }
    }
    return paused;
  }
}

export class FileDurableIntentStore implements DurableIntentStore {
  private readonly filePath: string;
  private readonly inMemory = new InMemoryDurableIntentStore();
  private loadPromise?: Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<void> {
    this.loadPromise ??= (async () => {
      try {
        const data = await readFile(this.filePath, "utf8");
        const records = JSON.parse(data);
        if (Array.isArray(records)) {
          for (const record of records) {
            this.inMemory.setDirect(record);
          }
        }
      } catch {
        // file does not exist yet
      }
    })();
    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    const list = await this.inMemory.listIntents();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(list, null, 2), "utf8");
  }

  async recordIntent(record: Omit<DurableIntentRecord, "createdAt" | "updatedAt">): Promise<DurableIntentRecord> {
    await this.load();
    const result = await this.inMemory.recordIntent(record);
    await this.persist();
    return result;
  }

  async updateIntent(intentId: string, patch: Partial<DurableIntentRecord>): Promise<DurableIntentRecord> {
    await this.load();
    const result = await this.inMemory.updateIntent(intentId, patch);
    await this.persist();
    return result;
  }

  async getIntent(intentId: string): Promise<DurableIntentRecord | undefined> {
    await this.load();
    return this.inMemory.getIntent(intentId);
  }

  async findIntent(criteria: { role?: string; tier?: string; inputDigest?: string; runId?: string; intentId?: string }): Promise<DurableIntentRecord | undefined> {
    await this.load();
    return this.inMemory.findIntent(criteria);
  }

  async listIntents(): Promise<readonly DurableIntentRecord[]> {
    await this.load();
    return this.inMemory.listIntents();
  }

  async auditPendingIntents(): Promise<readonly DurableIntentRecord[]> {
    await this.load();
    const result = await this.inMemory.auditPendingIntents();
    if (result.length > 0) await this.persist();
    return result;
  }
}

export function computeInputDigest(input: PiAgentRuntimeRequest): string {
  return digestValue({
    task: {
      objective: input.task.objective,
      constraints: input.task.constraints,
      expectedOutputs: input.task.expectedOutputs,
    },
    role: {
      name: input.role.name,
      instructions: input.role.instructions,
      tools: input.role.tools,
      verificationRole: input.role.verificationRole,
      allowTestExecution: input.role.allowTestExecution,
      allowCodingTools: input.role.allowCodingTools,
    },
    tier: input.tier ?? "default",
  });
}

export class UncertainExecutionError extends Error {
  readonly kind = "uncertain-execution" as const;
  readonly intent: DurableIntentRecord;
  constructor(intent: DurableIntentRecord, message?: string) {
    super(message ?? `intent "${intent.intentId}" is in an auditable uncertain state (${intent.status}): ${intent.uncertainReason ?? "requires human or controlled reconcile"}`);
    this.name = "UncertainExecutionError";
    this.intent = intent;
  }
}

export class RuntimeCrashError extends Error {
  readonly kind = "runtime-crash" as const;
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCrashError";
  }
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
    | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "error"
    | "compaction_start" | "compaction_end"
    | "auto_retry_start" | "auto_retry_end"
    | "summarization_retry_scheduled" | "summarization_retry_attempt_start" | "summarization_retry_finished";
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
  /** Actual model that executed the Run (canonical provider/model identity). */
  readonly model?: ModelConfigView;
}

/** Minimal model identity view (structurally compatible with evok-model ModelConfig). */
export interface ModelConfigView {
  readonly provider: string;
  readonly model: string;
  readonly id: string;
}

export type { SessionModelResolver };

export interface AgentRuntimeSession {
  readonly sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getSessionStats?(): unknown;
}

export type AgentSessionFactory = (options: Pick<CreateAgentSessionOptions, "cwd" | "tools"> & Partial<Omit<CreateAgentSessionOptions, "cwd" | "tools">> & {
  readonly sandbox?: SandboxPolicy;
  readonly redactor?: SecretRedactor;
  /** Trusted-side evoK resource selection (#110); undefined => no prompts/skills. */
  readonly evokResources?: EvokSessionResources;
}) => Promise<AgentRuntimeSession>;

/** The subset of EvokResources the session factory needs to build its loader. */
export interface EvokSessionResources {
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
  /** Ordered, already-enumerated approved SKILL.md files (project-first). */
  readonly skillFiles: readonly string[];
  /** evoK user resource root (normally ~/.evok); used as SDK agentDir. */
  readonly userRoot?: string;
}

export interface RuntimeFaultInjection {
  readonly crashBeforeDispatch?: boolean;
  readonly crashAfterDispatch?: boolean;
  readonly crashDuringTool?: { readonly toolName?: string; readonly afterExecution?: boolean };
  readonly crashBeforeResultConfirmation?: boolean;
}

export interface PiAgentRuntimeOptions {
  readonly workspaceRoot?: string;
  readonly sessionFactory?: AgentSessionFactory;
  readonly sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "tools" | "sessionManager">;
  readonly sandbox?: SandboxPolicy;
  readonly secrets?: readonly string[];
  readonly redactor?: SecretRedactor;
  readonly onDispose?: () => void;
  readonly intentStore?: DurableIntentStore;
  readonly faultInjection?: RuntimeFaultInjection;
  /**
   * Resolves the actual SDK model for a request tier and verifies
   * credentials before dispatch. When supplied, the resolved model and its
   * ModelRuntime are handed to the session factory, so the reported tier is
   * the model that really executes (#109).
   */
  readonly modelResolver?: SessionModelResolver;
  /**
   * Approved evoK research resources for this Run's sessions (#110): explicit
   * SYSTEM/APPEND prompts and enumerated skills parsed by the SDK. Discovery
   * happens against the research project, never the Run workspace; the loader
   * adds no other Pi/global/package/extension sources. Undefined keeps the
   * locked-down #109 loader (no skills/context).
   */
  readonly resources?: EvokResources;
  /** Trusted non-filesystem tools this runtime may register (#111). */
  readonly configuredTools?: readonly ToolDefinition[];
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
  "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);

/**
 * Lifecycle events that must never fire under the runtime policy
 * (compaction and retry are runtime-disabled). Receiving one means SDK
 * policy drift or a config bypass: the Run must fail closed.
 */
const POLICY_VIOLATION_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
  "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);

const RUNTIME_SESSION_POLICY = { compaction: { enabled: false }, retry: { enabled: false } } as const;

export class SessionPolicyViolation extends Error {
  readonly kind = "session-policy-violation" as const;
  readonly eventType: string;
  readonly raw: unknown;
  /** Redacted run event ledger at detection time (kept live as later events are redacted). */
  readonly events: readonly RuntimeEvent[];
  constructor(eventType: string, raw: unknown, events: readonly RuntimeEvent[] = []) {
    super(`pi session policy violation: received ${eventType} lifecycle event while compaction/retry are runtime-disabled`);
    this.name = "SessionPolicyViolation";
    this.eventType = eventType;
    this.raw = raw;
    this.events = events;
  }
}

function toolsFor(
  role: RolePlan,
  workspace: ApprovedWorkspace,
  sandboxPolicy: SandboxPolicy,
  configuredTools: readonly ToolDefinition[] = [],
): string[] {
  if (role.tools !== undefined && !Array.isArray(role.tools)) throw new TypeError("role tools must be an array");
  const requested = role.tools ? [...role.tools] : [...READ_ONLY_TOOLS];
  if (requested.some((tool) => typeof tool !== "string" || tool.trim() === "")) throw new TypeError("role tools must contain non-empty strings");
  if (new Set(requested).size !== requested.length) throw new TypeError("role tools must be unique");
  const configuredNames = new Set(configuredTools.map((tool) => tool.name));
  if (requested.some((tool) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool)
    && !(CODING_TOOLS as readonly string[]).includes(tool)
    && !configuredNames.has(tool))) {
    throw new Error("role requests an unknown tool");
  }
  if (sandboxPolicy.allowedTools && requested.some((tool) => !sandboxPolicy.allowedTools!.includes(tool))) {
    throw new Error("role requests a tool outside the sandbox allowlist");
  }
  if (requested.includes("bash") && sandboxPolicy.allowBash !== true) {
    throw new Error("bash requires an explicitly enabled sandbox policy");
  }
  if (role.allowCodingTools !== undefined && typeof role.allowCodingTools !== "boolean") {
    throw new TypeError("allowCodingTools must be a boolean");
  }
  if (role.allowTestExecution !== undefined && typeof role.allowTestExecution !== "boolean") {
    throw new TypeError("allowTestExecution must be a boolean");
  }
  if (role.verificationRole !== undefined) {
    const contract = verificationRoleContract(role.verificationRole);
    const coding = requested.some((tool) => (CODING_TOOLS as readonly string[]).includes(tool));
    if (coding && role.verificationRole !== "Falsifier" && role.verificationRole !== "Critic" && role.verificationRole !== "Challenger") {
      throw new Error(`${contract.role} is read-only`);
    }
    if (coding && requested.some((tool) => tool === "edit" || tool === "write")) {
      throw new Error(`${contract.role} cannot modify a candidate workspace`);
    }
    if (requested.includes("bash") && (role.allowTestExecution !== true || sandboxPolicy.allowBash !== true)) {
      throw new Error(`${contract.role} may run tests only through an explicitly sandboxed command policy`);
    }
  }
  const coding = requested.some((tool) => (CODING_TOOLS as readonly string[]).includes(tool));
  if (coding && (role.allowCodingTools !== true || workspace.approved !== true || workspace.isolated !== true)) {
    throw new Error("coding tools require an approved isolated workspace and explicit role grant");
  }
  return requested;
}

function promptFor(input: PiAgentRuntimeRequest, redactor: SecretRedactor): string {
  const constraints = input.task.constraints ? `\nConstraints: ${JSON.stringify(redactor.redact(input.task.constraints))}` : "";
  const outputs = input.task.expectedOutputs?.length ? `\nExpected outputs: ${input.task.expectedOutputs.map((output) => redactor.redactText(output)).join(", ")}` : "";
  return redactor.redactText(`Task objective: ${input.task.objective}\nRole: ${input.role.name}${input.role.instructions ? `\nRole instructions: ${input.role.instructions}` : ""}${constraints}${outputs}`);
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
  if (!parsed || typeof parsed.ok !== "boolean"
    || parsed.objections !== undefined && (!Array.isArray(parsed.objections) || parsed.objections.some((value) => typeof value !== "string"))) {
    return { ok: false, objections: [`${stage} output must be a JSON object with boolean ok and string objections`] };
  }
  const objections = (parsed.objections as string[] | undefined) ?? [];
  return { ok: parsed.ok, objections: parsed.ok || objections.length > 0 ? objections : [`${stage} rejected the candidate`] };
}

export const defaultSessionFactory: AgentSessionFactory = async (options) => {
  const { sandbox, redactor, evokResources, ...sdkOptions } = options;
  const cwd = sdkOptions.cwd!;
  // The user namespace root (normally ~/.evok); the locked tmp fallback keeps
  // #109 behavior when no resources were discovered.
  const evokUserRoot = evokResources?.userRoot;
  const agentDir = sdkOptions.agentDir ?? (evokUserRoot ?? join(tmpdir(), "evok-pi-agent"));
  const boundary = new SandboxBoundary({
    ...(sandbox ?? {}),
    root: cwd,
    allowedTools: sdkOptions.tools,
    allowBash: sandbox?.allowBash === true,
  });
  const securityExtension: InlineExtension = {
    name: "evok-sandbox-boundary",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", (event) => {
        try {
          boundary.assertToolCall(event.toolName, event.input);
          return { block: false };
        } catch (error) {
          return { block: true, reason: redactor?.error(error).message ?? "sandbox policy denied the tool call" };
        }
      });
    },
  };
  // #110: explicit evoK resource sources. noSkills stays true UNCONDITIONALLY:
  // flipping it false when resources are absent would re-enable the SDK default
  // project .pi and global ~/.agents skill discovery on non-CLI runtime paths,
  // reopening the namespace isolation #110 closes (#108 decision 9). Approved,
  // pre-enumerated SKILL.md files still load via additionalSkillPaths because
  // those are merged independently of noSkills (SDK resource-loader). The SDK
  // (not evoK) parses frontmatter and builds the metadata index. SYSTEM/APPEND
  // are selected one-each project-before-user by discovery. The security
  // extension is always wired, even with a custom set.
  const resourceLoader = sdkOptions.resourceLoader ?? new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    ...(evokResources
      ? {
          additionalSkillPaths: [...evokResources.skillFiles],
          ...(evokResources.systemPrompt !== undefined ? { systemPrompt: evokResources.systemPrompt } : {}),
          ...(evokResources.appendSystemPrompt !== undefined ? { appendSystemPrompt: [evokResources.appendSystemPrompt] } : {}),
        }
      : {}),
    extensionFactories: [securityExtension],
  });
  if (!sdkOptions.resourceLoader) await resourceLoader.reload();
  const result = await createAgentSession({
    ...sdkOptions,
    agentDir,
    resourceLoader,
    // Trusted, runtime-registered configured tools (#111); callers cannot
    // inject tools because PiAgentRuntime builds this list itself.
    customTools: sdkOptions.customTools ?? [],
    settingsManager: SettingsManager.inMemory(RUNTIME_SESSION_POLICY),
    sessionManager: SessionManager.inMemory(cwd),
  });
  return result.session;
};

export class PiAgentRuntime {
  readonly intentStore: DurableIntentStore;
  private readonly faultInjection?: RuntimeFaultInjection;
  private readonly root: string;
  private readonly factory: AgentSessionFactory;
  private readonly sessionOptions: PiAgentRuntimeOptions["sessionOptions"];
  private readonly usedWorkspaces = new Set<string>();
  private readonly usedSessions = new Set<string>();
  private readonly sandboxPolicy: SandboxPolicy;
  private readonly redactor: SecretRedactor;
  private readonly secrets: readonly string[];
  private readonly onDispose?: () => void;
  private readonly modelResolver?: SessionModelResolver;
  private readonly resources?: EvokResources;
  private readonly configuredTools: readonly ToolDefinition[];
  private harnessRun = 0;
  private auditPromise?: Promise<readonly DurableIntentRecord[]>;

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.root = resolve(options.workspaceRoot ?? tmpdir());
    this.intentStore = options.intentStore ?? new InMemoryDurableIntentStore();
    this.faultInjection = options.faultInjection;
    this.factory = options.sessionFactory ?? defaultSessionFactory;
    this.sessionOptions = options.sessionOptions;
    this.sandboxPolicy = restrictSandboxPolicy(options.sandbox ?? {});
    this.secrets = Object.freeze([...(options.secrets ?? [])]);
    this.redactor = options.redactor ?? new SecretRedactor(this.secrets);
    this.onDispose = options.onDispose;
    this.modelResolver = options.modelResolver;
    this.resources = options.resources;
    // ponytail: one shared list; role-level gating is the SDK allowlist. A
    // multi-tenant runtime would carry per-role capability registries.
    this.configuredTools = Object.freeze([...(options.configuredTools ?? [])]);
  }

  private async ensureAudited(): Promise<void> {
    this.auditPromise ??= this.intentStore.auditPendingIntents?.() ?? Promise.resolve([]);
    await this.auditPromise;
  }

  async auditPendingIntents(): Promise<readonly DurableIntentRecord[]> {
    await this.ensureAudited();
    return this.intentStore.auditPendingIntents?.() ?? [];
  }

  private shouldInjectToolCrash(toolName: string, after: boolean): boolean {
    if (!this.faultInjection?.crashDuringTool) return false;
    const { toolName: target, afterExecution } = this.faultInjection.crashDuringTool;
    if (target !== undefined && target !== toolName) return false;
    return Boolean(afterExecution) === after;
  }

  async reconcileIntent(intentId: string, decision: IntentReconcileDecision): Promise<DurableIntentRecord> {
    const intent = await this.intentStore.getIntent(intentId);
    if (!intent) throw new Error(`intent not found: ${intentId}`);
    const now = Date.now();
    switch (decision.action) {
      case "repair":
        return await this.intentStore.updateIntent(intentId, {
          status: "PAUSED",
          uncertainReason: undefined,
          reconcile: { action: "repair", reconciledAt: now, note: decision.note },
        });
      case "adopt_result":
        if (!decision.result) throw new TypeError("adopt_result requires an adopted result");
        return await this.intentStore.updateIntent(intentId, {
          status: "COMPLETED",
          result: decision.result,
          uncertainReason: undefined,
          reconcile: { action: "adopt_result", reconciledAt: now, note: decision.note, adoptedResult: decision.result },
        });
      case "quarantine":
        return await this.intentStore.updateIntent(intentId, {
          status: "QUARANTINED",
          uncertainReason: decision.reason ?? intent.uncertainReason ?? "quarantined by controlled reconcile",
          reconcile: { action: "quarantine", reconciledAt: now, note: decision.note },
        });
    }
  }

  private redactorFor(input: PiAgentRuntimeRequest): SecretRedactor {
    return input.secrets?.length ? new SecretRedactor([...this.secrets, ...input.secrets]) : this.redactor;
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

    const redactor = this.redactorFor(input);
    const requestedPolicy: SandboxPolicy = restrictSandboxPolicy(this.sandboxPolicy, input.workspace.sandbox ?? {});
    const requestedRoot = resolve(input.workspace.path);
    if (!isAbsolute(input.workspace.path) || !within(this.root, requestedRoot)) throw new SandboxViolation("path-traversal", "workspace path escapes the approved workspace root");
    if (this.usedWorkspaces.has(requestedRoot)) throw new Error("workspace/session reuse is not allowed");
    const rootBoundary = new SandboxBoundary({ ...requestedPolicy, root: this.root });
    await rootBoundary.assertPathAsync(input.workspace.path, "write");
    const tools = toolsFor(input.role, input.workspace, requestedPolicy, this.configuredTools);
    await mkdir(requestedRoot, { recursive: true });
    const approvedRoot = await realpath(requestedRoot);
    const approvedWorkspaceRoot = await realpath(this.root);
    if (!within(approvedWorkspaceRoot, approvedRoot)) throw new SandboxViolation("symlink", "workspace path escapes the approved workspace root");
    if (this.usedWorkspaces.has(approvedRoot)) throw new Error("workspace/session reuse is not allowed");

    await this.ensureAudited();
    const tier = input.tier ?? "default";

    // Resolve the actual SDK model and verify credentials BEFORE any intent is
    // declared/dispatched: missing model/auth configuration must fail clearly
    // rather than silently falling back to another provider (#109).
    let resolvedModel: Awaited<ReturnType<SessionModelResolver["resolve"]>> | undefined;
    if (this.modelResolver) {
      resolvedModel = await this.modelResolver.resolve(tier);
      const preflight = await this.modelResolver.preflight(resolvedModel.model);
      if (!preflight.ok) throw new MissingAuthenticationError(preflight.error);
    }
    const inputDigest = computeInputDigest(input);
    const baseIntentId = input.intentId ?? (input.identity ? `${input.identity.runId}:${input.identity.attempt}:intent` : `intent-${inputDigest}`);

    let existing = input.intentId
      ? await this.intentStore.getIntent(input.intentId)
      : await this.intentStore.findIntent({ role: input.role.name, tier, inputDigest, runId: input.identity?.runId });

    if (existing) {
      if (existing.status === "DISPATCHED") {
        existing = await this.intentStore.updateIntent(existing.intentId, {
          status: "PAUSED",
          uncertainReason: "crash occurred after intent was sent but before result was confirmed",
        });
      }
      if (existing.status === "PAUSED") {
        if (!input.repair || existing.reconcile?.action !== "repair") {
          throw new UncertainExecutionError(
            existing,
            `intent "${existing.intentId}" is in an auditable uncertain state (PAUSED): ${existing.uncertainReason ?? "requires human or controlled reconcile before repair"}`
          );
        }
      } else if (existing.status === "QUARANTINED") {
        throw new Error(`intent "${existing.intentId}" is quarantined and cannot be retried`);
      } else if (existing.status === "COMPLETED" && existing.result) {
        if (!input.repair) {
          // Idempotency / crash-recovery guard of #23: already confirmed result does not re-execute session
          return existing.result;
        }
      }
    }

    this.usedWorkspaces.add(approvedRoot);
    const intentId = input.repair && existing ? `${baseIntentId}:repair:${Date.now()}` : baseIntentId;

    await this.intentStore.recordIntent({
      intentId,
      role: input.role.name,
      tier,
      inputDigest,
      status: "DECLARED",
      identity: input.identity,
      repair: input.repair === true,
    });

    if (this.faultInjection?.crashBeforeDispatch) {
      throw new RuntimeCrashError("fault injection: crash before intent dispatch");
    }

    let dispatched = false;
    await this.intentStore.updateIntent(intentId, { status: "DISPATCHED" });
    dispatched = true;

    if (this.faultInjection?.crashAfterDispatch) {
      throw new RuntimeCrashError("fault injection: crash after intent sent before result confirmed");
    }

    let session: AgentRuntimeSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    const recordedToolIntents: DurableToolIntent[] = [];

    try {
      const workspace = await realpath(await mkdtemp(join(approvedRoot, "run-")));
      // Trusted read-only project roots: validated as absolute real paths that
      // cannot be widened by the run. Writes remain rooted at `workspace`.
      const readRoots: string[] = [];
      for (const readRoot of input.workspace.readRoots ?? []) {
        if (typeof readRoot !== "string" || !isAbsolute(readRoot)) {
          throw new SandboxViolation("path-traversal", "workspace readRoots must be absolute paths");
        }
        const realReadRoot = await realpath(readRoot);
        if (within(workspace, realReadRoot)) continue; // already covered by the run workspace
        readRoots.push(realReadRoot);
      }
      const boundary = new SandboxBoundary({
        ...requestedPolicy,
        root: workspace,
        ...(readRoots.length > 0 ? { readRoots } : {}),
        allowedTools: tools,
        allowBash: requestedPolicy.allowBash === true,
      });
      const events: RuntimeEvent[] = [];
      const seen = new Set<string>();
      const { customTools: _callerCustomTools, ...sessionOptions } = this.sessionOptions ?? {};
      session = await this.factory({
        ...sessionOptions,
        ...(resolvedModel ? { model: resolvedModel.modelId, modelRuntime: resolvedModel.modelRuntime } : {}),
        // Trusted configured tools only; caller session options cannot inject
        // tools (#111). The per-Run `tools` allowlist still hides any
        // unselected capability from the model.
        customTools: [...this.configuredTools],
        settingsManager: SettingsManager.inMemory(RUNTIME_SESSION_POLICY),
        cwd: workspace,
        tools,
        sandbox: boundary.policy,
        redactor,
        ...(this.resources
          ? {
              evokResources: {
                skillFiles: this.resources.skills.map((entry) => entry.skill.filePath),
                ...(this.resources.systemPrompt !== undefined ? { systemPrompt: this.resources.systemPrompt } : {}),
                ...(this.resources.appendSystemPrompt !== undefined ? { appendSystemPrompt: this.resources.appendSystemPrompt } : {}),
                userRoot: this.resources.userRoot,
              },
            }
          : {}),
      });
      const sessionId = session.sessionId;
      if (typeof sessionId !== "string" || sessionId.trim() === "" || this.usedSessions.has(sessionId)) {
        throw new Error("workspace/session reuse is not allowed");
      }
      this.usedSessions.add(sessionId);
      const add = (event: RuntimeEvent, key?: string) => {
        const safeEvent = redactor.redact(event) as RuntimeEvent;
        const eventKey = key ?? JSON.stringify([safeEvent.type, safeEvent.toolCallId, safeEvent.toolName, safeEvent.reason, safeEvent.isError, safeEvent.raw]);
        if (seen.has(eventKey)) return;
        seen.add(eventKey);
        events.push(safeEvent);
      };
      add({ type: "session_start", sessionId });
      let completionUsage: RuntimeUsage | undefined;
      const accountedMessages = new Set<string>();
      let stopReason: string | undefined;
      let completionText: string | undefined;
      let eventError: Error | undefined;
      const setEventError = (error: Error) => {
        if (eventError instanceof SessionPolicyViolation) return;
        eventError ??= error;
      };
      unsubscribe = session.subscribe((raw) => {
        if (!isRecord(raw) || typeof raw.type !== "string") return;
        const type = raw.type;
        if (type === "tool_execution_start") {
          const toolName = String(raw.toolName ?? "");
          const toolCallId = String(raw.toolCallId ?? `tool-${Date.now()}`);
          const toolDigest = digestValue(raw.args ?? {});
          recordedToolIntents.push({
            toolCallId,
            toolName,
            inputDigest: toolDigest,
            status: "DISPATCHED",
            args: redactor.redact(raw.args),
          });

          if (this.shouldInjectToolCrash(toolName, false)) {
            setEventError(new RuntimeCrashError(`fault injection: crash during tool execution of ${toolName}`));
            abortPromise ??= session?.abort();
            return;
          }
          try {
            boundary.assertToolCall(toolName, isRecord(raw.args) ? raw.args : {});
          } catch (error) {
            setEventError(error instanceof SandboxViolation ? error : redactor.error(error));
            abortPromise ??= session?.abort();
          }
        }
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
            completionText = redactor.redactText(textFromMessage(assistant)) || completionText;
            if (typeof assistant.stopReason === "string") stopReason = redactor.redactText(assistant.stopReason);
            if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
              setEventError(redactor.error(String(assistant.errorMessage ?? `agent ${assistant.stopReason}`)));
            }
          }
        }
        if (type === "tool_execution_end") {
          const toolName = String(raw.toolName ?? "");
          const toolCallId = String(raw.toolCallId ?? "");
          const index = recordedToolIntents.findLastIndex((ti) => ti.toolCallId === toolCallId || (ti.toolName === toolName && ti.status === "DISPATCHED"));
          if (index >= 0) {
            recordedToolIntents[index] = {
              ...recordedToolIntents[index],
              status: raw.isError ? "FAILED" : "COMPLETED",
              result: redactor.redact(raw.result),
              isError: Boolean(raw.isError),
            };
          }
          if (this.shouldInjectToolCrash(toolName, true)) {
            setEventError(new RuntimeCrashError(`fault injection: crash after tool execution of ${toolName}`));
            abortPromise ??= session?.abort();
            return;
          }
          if (raw.isError === true) setEventError(redactor.error(`tool execution failed: ${String(raw.toolName ?? "unknown tool")}`));
        }
        if (type === "error" || type === "session_error") setEventError(redactor.error(String(raw.message ?? raw.errorMessage ?? "agent session failed")));
        const normalizedType = type === "session_error" ? "error" : type;
        if (!NORMALIZED_EVENT_TYPES.has(normalizedType as RuntimeEvent["type"])) return;
        if (POLICY_VIOLATION_EVENT_TYPES.has(normalizedType as RuntimeEvent["type"])) {
          // Fail closed: the redacted event is recorded below; keep the first violation
          // and its live event ledger so later evidence is never silently dropped.
          eventError = eventError instanceof SessionPolicyViolation
            ? eventError
            : new SessionPolicyViolation(normalizedType, redactor.redact(raw), events);
          abortPromise ??= session?.abort();
        }
        add({
          type: normalizedType as RuntimeEvent["type"], sessionId, raw: redactor.redact(raw),
          toolCallId: typeof raw.toolCallId === "string" ? redactor.redactText(raw.toolCallId) : undefined,
          toolName: typeof raw.toolName === "string" ? redactor.redactText(raw.toolName) : undefined,
          isError: typeof raw.isError === "boolean" ? raw.isError : undefined,
          reason: typeof raw.reason === "string" ? redactor.redactText(raw.reason) : undefined,
        });
      });
      onAbort = () => { abortPromise ??= session?.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        await abortPromise;
        throw abortError();
      }
      try {
        await session.prompt(promptFor(input, redactor));
      } catch (error) {
        if (eventError) throw eventError;
        throw error;
      }
      if (eventError) throw eventError;
      if (abortPromise || signal?.aborted) throw abortError();
      const stats = session.getSessionStats?.();
      completionUsage = usageFromStats(stats) ?? completionUsage;
      if (!completionUsage) throw new Error("agent completion is missing usage/cost data");
      if (!stopReason) throw new Error("agent completion is missing stop reason");
      if (this.faultInjection?.crashBeforeResultConfirmation) {
        throw new RuntimeCrashError("fault injection: crash before result confirmation");
      }
      add({ type: "session_end", sessionId, reason: stopReason });
      const result: AgentRuntimeResult = { sessionId, workspace, events, ledger: events, usage: completionUsage, stopReason, text: completionText, model: resolvedModel?.model };
      await this.intentStore.updateIntent(intentId, {
        status: "COMPLETED",
        result,
        toolIntents: recordedToolIntents.length > 0 ? recordedToolIntents : undefined,
      });
      if (input.repair && existing) {
        await this.intentStore.updateIntent(existing.intentId, {
          reconcile: existing.reconcile ? { ...existing.reconcile, note: `repaired by ${intentId}` } : undefined,
        }).catch(() => {});
      }
      return result;
    } catch (error) {
      if (error instanceof RuntimeCrashError) {
        // Crash with work in flight: side effects are uncertain. Persist the
        // in-flight tool intents but leave the intent DISPATCHED so the startup
        // audit / restart detects the uncertain state — never silent success.
        await this.intentStore.updateIntent(intentId, {
          toolIntents: recordedToolIntents.length > 0 ? recordedToolIntents : undefined,
        }).catch(() => {});
      } else if (!(error instanceof UncertainExecutionError)) {
        await this.intentStore.updateIntent(intentId, {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
          toolIntents: recordedToolIntents.length > 0 ? recordedToolIntents : undefined,
        }).catch(() => {});
      }
      if (abortPromise) await abortPromise.catch(() => undefined);
      if (signal?.aborted) throw abortError();
      if (error instanceof RuntimeCrashError || error instanceof UncertainExecutionError) throw error;
      if (error instanceof SandboxViolation) throw new SandboxViolation(error.kind, redactor.redactText(error.message));
      if (error instanceof SessionPolicyViolation) throw error; // evidence already redacted
      throw redactor.error(error);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      if (session) {
        try { session.dispose(); } finally { this.onDispose?.(); }
      }
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
    tier?: string;
  }): Promise<AgentRuntimeResult> {
    const attempt = this.harnessRun++;
    const workspace = join(this.root, ".evok-harness", encodeURIComponent(input.missionId), encodeURIComponent(input.branchId), `${attempt}-${input.stage}`);
    const runId = `${input.missionId}:${input.branchId}:${input.stage}:${attempt}`;
    return this.execute({
      task: { objective: input.taskContract.objective, constraints: input.taskContract.constraints, expectedOutputs: input.expectedOutputs },
      role: {
        name: input.stage,
        instructions: input.instructions,
        tools: [...READ_ONLY_TOOLS],
        ...(input.stage === "self-verify" ? { verificationRole: "SelfVerifier" as const }
          : input.stage === "falsify" ? { verificationRole: "Falsifier" as const } : {}),
      },
      workspace: { path: workspace, isolated: true, approved: true },
      tier: input.tier ?? "default",
      intentId: `${input.missionId}:${input.branchId}:${input.stage}:${attempt}`,
      identity: {
        branchId: input.branchId,
        runId,
        attempt,
        workspaceId: workspace,
        fencingToken: 1,
      },
    });
  }

  async selfVerify(input: Parameters<ToyAgentRuntime["selfVerify"]>[0]): Promise<{ ok: boolean; objections?: string[] }> {
    const tier = input.tier;
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.taskContract, stage: "self-verify",
      instructions: "Check the approved Task and Role plan. Return JSON {\"ok\":true,\"objections\":[]} unless the plan is incomplete.",
      expectedOutputs: ["JSON self-verification result"],
      tier,
    });
    return verificationFromText(result.text, "self-verification");
  }

  async propose(input: Parameters<ToyAgentRuntime["propose"]>[0]): Promise<{ files: Record<string, string> }> {
    const tier = input.tier;
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.taskContract, stage: "propose",
      instructions: "Produce the candidate. Return JSON {\"files\":{\"score\":\"number\"}} with the candidate files and no prose.",
      expectedOutputs: ["JSON candidate files"],
      tier,
    });
    const parsed = objectFromText(result.text);
    const files = parsed?.files;
    if (isRecord(files)) return { files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, String(value)])) };
    return { files: { output: result.text ?? "" } };
  }

  async falsify(input: Parameters<ToyAgentRuntime["falsify"]>[0]): Promise<{ ok: boolean; objections: string[] }> {
    const tier = input.tier;
    const result = await this.executeHarnessPlan({
      missionId: input.missionId, branchId: input.branchId, taskContract: input.snapshot.contract, stage: "falsify",
      instructions: `Actively find a counterexample in this candidate snapshot: ${JSON.stringify(input.snapshot)}. Return JSON {\"ok\":true,\"objections\":[]}.`,
      expectedOutputs: ["JSON falsification result"],
      tier,
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
