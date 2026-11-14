/**
 * ContextBroker / ResearchRunAssembler. Physical home: `src/execution/`.
 *
 * One place assembles the injectable context for ONE Run, from that Run's own
 * Mission/Task/Run/target-agent identity and ITS competition's contract +
 * RuleVisibilityPolicy. It never broadcasts: two competitions, or two roles
 * under one competition, get different, independently content-addressed
 * contexts.
 *
 * Output is either
 *   - `RoleTaskContext` for a short-lived Researcher/Critic/Reviewer (rule
 *     fields only from that role's policy allowlist, plus an optional
 *     MemorySlice bound to the same Run), or
 *   - `ExecutionContext` for a TRUSTED Executor/Evaluator (contract, evaluation
 *     entry + data-access policy, inventory + lease, isolated workspace).
 *
 * Every brokered context records its contract digest, policy digest, context
 * digest, and — when present — inventory, lease, and memory digests. The
 * wrapper is itself content-addressed, so a tampered or cross-wired context
 * fails `validateBrokeredContext` before it reaches a model.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import {
  validateCompetitionContract,
  type CompetitionContract,
} from "../competition/competition-contract";
import {
  RULE_AUDIENCE_ROLES,
  validateRuleVisibilityPolicy,
  type RuleAudienceRole,
  type RuleVisibilityPolicy,
} from "../competition/rule-visibility";
import { validateExecutionContext, createExecutionContext, type EvaluationDataAccess, type ExecutionContext } from "./execution-context";
import { validateMemorySlice, type MemorySlice } from "../memory";
import { assembleRoleContext, validateRoleContext, type RoleTaskContext } from "./role-context";
import {
  grantResourceLease,
  validateResourceLease,
  type ResourceLease,
  type ResourceRequest,
} from "./resource-lease";
import type { HostInventory } from "./host-inventory";

export const BROKERED_CONTEXT_SCHEMA = "evok.brokered-context/v1" as const;

/** Trusted audiences: they get an ExecutionContext, never a role summary. */
export const TRUSTED_CONTEXT_ROLES = ["executor", "evaluator"] as const;
export type TrustedContextRole = (typeof TRUSTED_CONTEXT_ROLES)[number];

export type ContextRole = RuleAudienceRole | TrustedContextRole;

export const CONTEXT_ROLES: readonly ContextRole[] = [...RULE_AUDIENCE_ROLES, ...TRUSTED_CONTEXT_ROLES];

export class ContextBrokerError extends Error {
  readonly kind = "context-broker" as const;
  constructor(message: string) {
    super(message);
    this.name = "ContextBrokerError";
  }
}

/** What the broker asks a memory provider for; the answer is bound to this Run. */
export interface MemoryProviderRequest {
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly role: RuleAudienceRole;
  readonly evidenceRefs: readonly string[];
}

/**
 * Optional durable-memory seam. The provider returns the slice for exactly
 * this Run (or undefined); the broker validates the Run binding, so a provider
 * cannot hand one agent another Run's memory.
 */
export type MemoryProvider = (
  request: MemoryProviderRequest,
) => MemorySlice | undefined | Promise<MemorySlice | undefined>;

export interface ContextBrokerOptions {
  /** The competition this broker serves; rules are never shared across competitions. */
  readonly contract: CompetitionContract;
  readonly policy: RuleVisibilityPolicy;
  /** Host snapshot used to grant a lease when a resource request is supplied. */
  readonly inventory?: HostInventory;
  readonly memory?: MemoryProvider;
  /** Injection source recorded for audit (default "context-broker"). */
  readonly source?: string;
}

export interface AssembleRunContextInput {
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  /** The one agent instance this context is for. */
  readonly targetAgentId: string;
  readonly role: ContextRole;
  readonly objective: string;
  readonly hypothesis?: string;
  readonly evidenceRefs?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly tools?: readonly string[];
  /** Lease input: grant from the caller's inventory, or pass a granted lease. */
  readonly resourceRequest?: ResourceRequest;
  readonly lease?: ResourceLease;
  /** Trusted audiences only: the approved isolated workspace. */
  readonly workspace?: { readonly root: string; readonly isolated?: boolean; readonly readRoots?: readonly string[] };
  /** Trusted audiences only: evaluation entry point + data-access policy. */
  readonly evaluation?: { readonly entry: string; readonly dataAccess?: EvaluationDataAccess };
  readonly network?: "none" | "restricted" | "open";
  readonly timeLimitMs?: number;
  readonly source?: string;
}

export type BrokeredContextBody =
  | { readonly kind: "role"; readonly roleContext: RoleTaskContext }
  | { readonly kind: "execution"; readonly executionContext: ExecutionContext };

/** A context plus the digests it is bound to; the wrapper is content-addressed. */
export interface BrokeredContext {
  readonly schema: typeof BROKERED_CONTEXT_SCHEMA;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly role: ContextRole;
  readonly competition: {
    readonly competitionId: string;
    readonly version: string;
    readonly contractDigest: string;
    readonly policyDigest: string;
  };
  readonly context: BrokeredContextBody;
  readonly memorySlice?: MemorySlice;
  readonly digests: {
    readonly contract: string;
    readonly policy: string;
    readonly context: string;
    readonly memory?: string;
    readonly inventory?: string;
    readonly lease?: string;
  };
  readonly source: string;
  readonly digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ContextBrokerError(`${label} is required`);
  return value;
}

function stringList(label: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ContextBrokerError(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

const NETWORK_RANK: Record<"none" | "restricted" | "open", number> = { none: 0, restricted: 1, open: 2 };

function boundedNetwork(contractNetwork: "none" | "restricted" | "open", requested?: "none" | "restricted" | "open"):
  "none" | "restricted" | "open" {
  const network = requested ?? contractNetwork;
  if (NETWORK_RANK[network] > NETWORK_RANK[contractNetwork]) {
    throw new ContextBrokerError(`requested network policy "${network}" exceeds the competition contract limit "${contractNetwork}"`);
  }
  return network;
}

export function isTrustedContextRole(role: string): role is TrustedContextRole {
  return (TRUSTED_CONTEXT_ROLES as readonly string[]).includes(role);
}

/**
 * Per-competition broker. Construction validates the contract, the policy, and
 * the binding between them, so a policy can never be used with another
 * competition's contract.
 */
export class ContextBroker {
  readonly contract: CompetitionContract;
  readonly policy: RuleVisibilityPolicy;
  readonly source: string;
  private readonly inventory?: HostInventory;
  private readonly memory?: MemoryProvider;

  constructor(options: ContextBrokerOptions) {
    try {
      this.contract = validateCompetitionContract(options.contract);
      this.policy = validateRuleVisibilityPolicy(options.policy);
    } catch (error) {
      throw new ContextBrokerError(error instanceof Error ? error.message : "invalid competition contract or policy");
    }
    if (this.policy.competitionId !== this.contract.competitionId) {
      throw new ContextBrokerError("rule visibility policy competitionId does not match the broker's contract");
    }
    if (this.policy.contractDigest !== this.contract.digest) {
      throw new ContextBrokerError("rule visibility policy contractDigest does not match the broker's contract");
    }
    this.inventory = options.inventory;
    this.memory = options.memory;
    this.source = options.source ?? "context-broker";
  }

  /**
   * Assembles the context for one Run. Rules, memory, and the lease are bound
   * to the exact role/Run; a mismatch fails closed before anything is injected.
   */
  async assemble(input: AssembleRunContextInput): Promise<BrokeredContext> {
    const missionId = requireNonEmpty("brokered context missionId", input.missionId);
    const taskId = requireNonEmpty("brokered context taskId", input.taskId);
    const runId = requireNonEmpty("brokered context runId", input.runId);
    const targetAgentId = requireNonEmpty("brokered context targetAgentId", input.targetAgentId);
    const objective = requireNonEmpty("brokered context objective", input.objective);
    if (!CONTEXT_ROLES.includes(input.role)) {
      throw new ContextBrokerError(`brokered context role must be one of ${CONTEXT_ROLES.join(", ")}`);
    }
    const trusted = isTrustedContextRole(input.role);
    const source = input.source ?? this.source;

    const lease = this.leaseFor(input, taskId);
    const memorySlice = trusted ? undefined : await this.memoryFor(input, { missionId, taskId, runId, targetAgentId });

    const context: BrokeredContextBody = trusted
      ? {
          kind: "execution",
          executionContext: this.executionContextFor(input, {
            role: input.role as TrustedContextRole,
            lease,
            source,
          }),
        }
      : {
          kind: "role",
          roleContext: assembleRoleContext({
            role: input.role as RuleAudienceRole,
            contract: this.contract,
            policy: this.policy,
            source,
            objective,
            ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
            evidenceRefs: stringList("brokered context evidenceRefs", input.evidenceRefs),
            allowedPaths: stringList("brokered context allowedPaths", input.allowedPaths),
            tools: stringList("brokered context tools", input.tools),
            ...(lease !== undefined ? { lease } : {}),
            targetAgentId,
            runId,
            missionId,
            taskId,
            ...(memorySlice !== undefined ? { memoryDigest: memorySlice.digest } : {}),
          }),
        };

    const digests = {
      contract: this.contract.digest,
      policy: this.policy.digest,
      context: context.kind === "role" ? context.roleContext.digest : context.executionContext.digest,
      ...(memorySlice !== undefined ? { memory: memorySlice.digest } : {}),
      ...(lease !== undefined ? { inventory: lease.inventoryDigest, lease: lease.digest } : {}),
    };
    const body = {
      schema: BROKERED_CONTEXT_SCHEMA,
      missionId,
      taskId,
      runId,
      targetAgentId,
      role: input.role,
      competition: {
        competitionId: this.contract.competitionId,
        version: this.contract.version,
        contractDigest: this.contract.digest,
        policyDigest: this.policy.digest,
      },
      context,
      ...(memorySlice !== undefined ? { memorySlice } : {}),
      digests,
      source,
    };
    return deepFreeze({ ...body, digest: digestValue(body) });
  }

  private leaseFor(input: AssembleRunContextInput, taskId: string): ResourceLease | undefined {
    if (input.lease !== undefined) {
      const lease = validateResourceLease(input.lease);
      if (lease.taskId !== taskId) throw new ContextBrokerError(`resource lease taskId "${lease.taskId}" does not match this Task "${taskId}"`);
      return lease;
    }
    if (input.resourceRequest === undefined) return undefined;
    if (this.contract.limits.timeLimitMs !== undefined
      && input.resourceRequest.timeLimitMs !== undefined
      && input.resourceRequest.timeLimitMs > this.contract.limits.timeLimitMs) {
      throw new ContextBrokerError("resource request timeLimitMs exceeds the competition contract limit");
    }
    if (this.inventory === undefined) {
      throw new ContextBrokerError("a resource request needs a HostInventory to grant a lease against");
    }
    return grantResourceLease({ inventory: this.inventory, taskId, request: input.resourceRequest });
  }

  private async memoryFor(
    input: AssembleRunContextInput,
    binding: { missionId: string; taskId: string; runId: string; targetAgentId: string },
  ): Promise<MemorySlice | undefined> {
    if (!this.memory) return undefined;
    const provided = await this.memory({
      ...binding,
      role: input.role as RuleAudienceRole,
      evidenceRefs: stringList("brokered context evidenceRefs", input.evidenceRefs),
    });
    if (provided === undefined) return undefined;
    const slice = validateMemorySlice(provided);
    if (slice.missionId !== binding.missionId) {
      throw new ContextBrokerError(`memory slice missionId "${slice.missionId}" does not match this Run's Mission "${binding.missionId}"`);
    }
    if (slice.taskId !== binding.taskId) {
      throw new ContextBrokerError(`memory slice taskId "${slice.taskId}" does not match this Run's Task "${binding.taskId}"`);
    }
    if (slice.runId !== binding.runId) {
      throw new ContextBrokerError(`memory slice runId "${slice.runId}" does not match this Run "${binding.runId}"`);
    }
    if (slice.targetAgentId !== binding.targetAgentId) {
      throw new ContextBrokerError(`memory slice targetAgentId "${slice.targetAgentId}" does not match this agent "${binding.targetAgentId}"`);
    }
    return slice;
  }

  private executionContextFor(
    input: AssembleRunContextInput,
    args: { role: TrustedContextRole; lease?: ResourceLease; source: string },
  ): ExecutionContext {
    if (!input.evaluation || typeof input.evaluation.entry !== "string" || input.evaluation.entry.trim() === "") {
      throw new ContextBrokerError("a trusted execution context requires an evaluation entry point");
    }
    if (!args.lease) {
      throw new ContextBrokerError("a trusted execution context requires a resource lease (grant one or pass a granted lease)");
    }
    if (!input.workspace || typeof input.workspace.root !== "string" || input.workspace.root.trim() === "") {
      throw new ContextBrokerError("a trusted execution context requires an approved workspace root");
    }
    if (input.timeLimitMs !== undefined && this.contract.limits.timeLimitMs !== undefined
      && input.timeLimitMs > this.contract.limits.timeLimitMs) {
      throw new ContextBrokerError("execution context timeLimitMs exceeds the competition contract limit");
    }
    const requestedTimeLimit = input.timeLimitMs ?? input.resourceRequest?.timeLimitMs;
    const timeLimitMs = requestedTimeLimit ?? this.contract.limits.timeLimitMs;
    return createExecutionContext({
      audience: args.role,
      contract: this.contract,
      evaluation: { entry: input.evaluation.entry, dataAccess: input.evaluation.dataAccess ?? "none" },
      lease: args.lease,
      workspace: {
        root: input.workspace.root,
        isolated: input.workspace.isolated ?? true,
        readRoots: input.workspace.readRoots ?? [],
      },
      network: boundedNetwork(this.contract.limits.network, input.network),
      ...(timeLimitMs !== undefined ? { timeLimitMs } : {}),
      source: args.source,
    });
  }
}

/**
 * Validates a persisted/loaded brokered context: inner context and memory
 * digests, contract/policy binding, Run/agent binding, and the wrapper digest.
 */
export function validateBrokeredContext(raw: unknown): BrokeredContext {
  if (!isRecord(raw)) throw new ContextBrokerError("brokered context must be an object");
  if (raw.schema !== BROKERED_CONTEXT_SCHEMA) {
    throw new ContextBrokerError(`brokered context schema must be ${BROKERED_CONTEXT_SCHEMA}`);
  }
  const missionId = requireNonEmpty("brokered context missionId", raw.missionId);
  const taskId = requireNonEmpty("brokered context taskId", raw.taskId);
  const runId = requireNonEmpty("brokered context runId", raw.runId);
  const targetAgentId = requireNonEmpty("brokered context targetAgentId", raw.targetAgentId);
  if (!CONTEXT_ROLES.includes(raw.role as ContextRole)) {
    throw new ContextBrokerError(`brokered context role must be one of ${CONTEXT_ROLES.join(", ")}`);
  }
  const role = raw.role as ContextRole;
  requireNonEmpty("brokered context source", raw.source);
  requireNonEmpty("brokered context digest", raw.digest);
  if (!isRecord(raw.competition) || !isRecord(raw.digests) || !isRecord(raw.context)) {
    throw new ContextBrokerError("brokered context competition, digests, and context are required");
  }
  const competition = raw.competition;
  const digests = raw.digests;
  requireNonEmpty("brokered context competition.competitionId", competition.competitionId);
  requireNonEmpty("brokered context competition.version", competition.version);
  requireNonEmpty("brokered context competition.contractDigest", competition.contractDigest);
  requireNonEmpty("brokered context competition.policyDigest", competition.policyDigest);
  for (const key of ["contract", "policy", "context"] as const) {
    requireNonEmpty(`brokered context digests.${key}`, digests[key]);
  }
  if (competition.contractDigest !== digests.contract || competition.policyDigest !== digests.policy) {
    throw new ContextBrokerError("brokered context competition and digest block disagree");
  }

  const trusted = isTrustedContextRole(role);
  if ((raw.context.kind === "role") === trusted) {
    throw new ContextBrokerError(`brokered context for role "${role}" has the wrong context kind`);
  }

  let memorySlice: MemorySlice | undefined;
  if (raw.memorySlice !== undefined) {
    if (trusted) throw new ContextBrokerError("a trusted execution context is never injected with agent memory");
    memorySlice = validateMemorySlice(raw.memorySlice);
    if (memorySlice.missionId !== missionId || memorySlice.taskId !== taskId || memorySlice.runId !== runId) {
      throw new ContextBrokerError("brokered context memory slice is bound to another Mission/Task/Run");
    }
    if (memorySlice.targetAgentId !== targetAgentId) {
      throw new ContextBrokerError("brokered context memory slice is bound to another target agent");
    }
    if (digests.memory !== memorySlice.digest) throw new ContextBrokerError("brokered context memory digest does not match the slice");
  } else if (digests.memory !== undefined) {
    throw new ContextBrokerError("brokered context declares a memory digest without a memory slice");
  }

  if (raw.context.kind === "role") {
    const roleContext = validateRoleContext(raw.context.roleContext);
    if (roleContext.role !== role) throw new ContextBrokerError("brokered context role does not match its role context");
    const audit = roleContext.audit;
    if (audit.targetAgentId !== targetAgentId) throw new ContextBrokerError("brokered context targetAgentId does not match the role context audit");
    if (audit.runId !== runId) throw new ContextBrokerError("brokered context runId does not match the role context audit");
    if (audit.missionId !== missionId || audit.taskId !== taskId) {
      throw new ContextBrokerError("brokered context Mission/Task does not match the role context audit");
    }
    if (audit.contractDigest !== digests.contract || audit.policyDigest !== digests.policy) {
      throw new ContextBrokerError("brokered context digest block does not match the role context audit");
    }
    if (digests.context !== roleContext.digest) throw new ContextBrokerError("brokered context digest does not match its role context");
    if (audit.memoryDigest !== digests.memory) throw new ContextBrokerError("brokered context memory digest does not match the role context audit");
  } else {
    const executionContext = validateExecutionContext(raw.context.executionContext);
    if (executionContext.audience !== role) {
      throw new ContextBrokerError("brokered execution context audience does not match the wrapper role");
    }
    if (executionContext.contract.digest !== digests.contract) {
      throw new ContextBrokerError("brokered context contract digest does not match its execution context");
    }
    if (digests.context !== executionContext.digest) throw new ContextBrokerError("brokered context digest does not match its execution context");
    if (digests.inventory !== executionContext.inventoryDigest) {
      throw new ContextBrokerError("brokered context inventory digest does not match its execution context");
    }
    if (digests.lease !== executionContext.lease.digest) {
      throw new ContextBrokerError("brokered context lease digest does not match its execution context");
    }
  }

  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new ContextBrokerError("brokered context digest mismatch");
  return deepFreeze(raw as unknown as BrokeredContext);
}
