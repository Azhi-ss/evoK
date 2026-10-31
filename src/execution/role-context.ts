/**
 * Role-scoped injectable Task Contract context for short-lived
 * Researcher/Critic/Reviewer agents. Physical home: `src/execution/`.
 *
 * Composition of two existing boundaries: `buildResearcherContext` (whitelist
 * minimal context — never full rules, credentials, hidden data, global
 * budget, or long-term history) plus `summarizeRulesForRole` (the
 * competition-defined safe rule fields for exactly this role). The result
 * records the context digest, contract digest, policy digest, audience role,
 * and injection source for audit. Rules are injected per role and never
 * broadcast: a role the policy does not name gets an empty rule summary.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import type { CompetitionContract } from "../competition/competition-contract";
import type { RuleAudienceRole, RuleVisibilityPolicy } from "../competition/rule-visibility";
import { RULE_AUDIENCE_ROLES, summarizeRulesForRole } from "../competition/rule-visibility";
import type { ResourceLease } from "./resource-lease";
import {
  buildResearcherContext,
  type ResearcherCompetitionSummary,
  type ResearcherContext,
  type ResearcherResourceSummary,
} from "./researcher-context";

export const ROLE_CONTEXT_SCHEMA = "evok.role-context/v1" as const;

export interface RoleContextAudit {
  readonly role: RuleAudienceRole;
  readonly contractDigest: string;
  readonly policyDigest: string;
  /** Where this context was assembled, e.g. "mission-controller" or "team-coordinator". */
  readonly source: string;
  /**
   * Bound agent instance and Run this context belongs to. The ContextBroker
   * always sets both; a low-level `assembleRoleContext` call may omit them
   * (legacy contexts stay valid, but `PiAgentRuntime` then accepts only
   * requests that declare no target binding either).
   */
  readonly targetAgentId?: string;
  readonly runId?: string;
  readonly missionId?: string;
  readonly taskId?: string;
  /** Digest of the MemorySlice injected together with this context. */
  readonly memoryDigest?: string;
}

export interface RoleTaskContext {
  readonly schema: typeof ROLE_CONTEXT_SCHEMA;
  readonly role: RuleAudienceRole;
  readonly objective: string;
  readonly hypothesis?: string;
  readonly evidenceRefs: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly tools: readonly string[];
  readonly competition?: ResearcherCompetitionSummary;
  readonly resources: ResearcherResourceSummary;
  /** Only the rule fields the competition policy allows for this role. */
  readonly rules: Readonly<Record<string, unknown>>;
  readonly audit: RoleContextAudit;
  readonly digest: string;
}

export class RoleContextError extends Error {
  readonly kind = "role-context" as const;
  constructor(message: string) {
    super(message);
    this.name = "RoleContextError";
  }
}

export interface AssembleRoleContextInput {
  readonly role: RuleAudienceRole;
  readonly contract: CompetitionContract;
  readonly policy: RuleVisibilityPolicy;
  /** Injection source recorded for audit. */
  readonly source: string;
  readonly objective: string;
  readonly hypothesis?: string;
  readonly evidenceRefs?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly tools?: readonly string[];
  readonly lease?: ResourceLease;
  /** Bind the context to the agent instance and Run it is dispatched for. */
  readonly targetAgentId?: string;
  readonly runId?: string;
  readonly missionId?: string;
  readonly taskId?: string;
  readonly memoryDigest?: string;
}

/**
 * Assembles the injectable context for one named role. The competition
 * summary passed to the base assembler carries identity + scoring only;
 * rule detail comes solely from the policy's per-role allowlist.
 */
export function assembleRoleContext(input: AssembleRoleContextInput): RoleTaskContext {
  if (!(RULE_AUDIENCE_ROLES as readonly string[]).includes(input.role)) {
    throw new RoleContextError(`role context role must be one of ${RULE_AUDIENCE_ROLES.join(", ")}`);
  }
  if (typeof input.source !== "string" || input.source.trim() === "") {
    throw new RoleContextError("role context source is required");
  }
  let rules: Readonly<Record<string, unknown>>;
  try {
    rules = summarizeRulesForRole(input.contract, input.policy, input.role);
  } catch (error) {
    throw new RoleContextError(error instanceof Error ? error.message : "rule summary failed");
  }
  const base: ResearcherContext = buildResearcherContext({
    objective: input.objective,
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
    evidenceRefs: input.evidenceRefs,
    allowedPaths: input.allowedPaths,
    tools: input.tools,
    competition: {
      competitionId: input.contract.competitionId,
      version: input.contract.version,
      metric: input.contract.scoring.metric,
      direction: input.contract.scoring.direction,
    },
    ...(input.lease !== undefined ? { lease: input.lease } : {}),
  });
  const body = {
    schema: ROLE_CONTEXT_SCHEMA,
    role: input.role,
    objective: base.objective,
    ...(base.hypothesis !== undefined ? { hypothesis: base.hypothesis } : {}),
    evidenceRefs: base.evidenceRefs,
    allowedPaths: base.allowedPaths,
    tools: base.tools,
    ...(base.competition !== undefined ? { competition: base.competition } : {}),
    resources: base.resources,
    rules,
    audit: {
      role: input.role,
      contractDigest: input.contract.digest,
      policyDigest: input.policy.digest,
      source: input.source,
      ...auditBinding(input),
    },
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/** Copies the optional identity bindings exactly as supplied (no coercion). */
function auditBinding(input: AssembleRoleContextInput): Record<string, string> {
  const binding: Record<string, string> = {};
  for (const key of ["targetAgentId", "runId", "missionId", "taskId", "memoryDigest"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") throw new RoleContextError(`role context audit.${key} must be a non-empty string`);
    binding[key] = value;
  }
  return binding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validates a persisted role context: shape, audit block, and content digest. */
export function validateRoleContext(raw: unknown): RoleTaskContext {
  if (!isRecord(raw)) throw new RoleContextError("role context must be an object");
  if (raw.schema !== ROLE_CONTEXT_SCHEMA) throw new RoleContextError(`role context schema must be ${ROLE_CONTEXT_SCHEMA}`);
  if (typeof raw.digest !== "string" || raw.digest === "") throw new RoleContextError("role context digest is required");
  if (!(RULE_AUDIENCE_ROLES as readonly string[]).includes(raw.role as string)) {
    throw new RoleContextError(`role context role must be one of ${RULE_AUDIENCE_ROLES.join(", ")}`);
  }
  if (typeof raw.objective !== "string" || raw.objective.trim() === "") throw new RoleContextError("role context objective is required");
  if (!isRecord(raw.resources)) throw new RoleContextError("role context resources are required");
  if (!isRecord(raw.rules)) throw new RoleContextError("role context rules must be an object");
  const audit = raw.audit;
  if (!isRecord(audit)) throw new RoleContextError("role context audit is required");
  if (audit.role !== raw.role) throw new RoleContextError("role context audit.role must match the audience role");
  for (const key of ["contractDigest", "policyDigest", "source"] as const) {
    if (typeof audit[key] !== "string" || (audit[key] as string) === "") {
      throw new RoleContextError(`role context audit.${key} is required`);
    }
  }
  for (const key of ["targetAgentId", "runId", "missionId", "taskId", "memoryDigest"] as const) {
    if (audit[key] !== undefined && (typeof audit[key] !== "string" || (audit[key] as string) === "")) {
      throw new RoleContextError(`role context audit.${key} must be a non-empty string when present`);
    }
  }
  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new RoleContextError("role context digest mismatch");
  return deepFreeze(raw as unknown as RoleTaskContext);
}
