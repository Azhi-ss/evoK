/**
 * Researcher Task Contract assembly boundary. Physical home: `src/execution/`.
 *
 * Short-lived Researcher/Critic/Reviewer agents receive only what the current
 * Task needs: the objective, the current hypothesis, relevant evidence refs,
 * the allowed modification scope, tools, and a resource summary derived from
 * the granted lease. They never receive the full competition rules, any
 * credential, hidden data, the global budget, or another agent's long-term
 * history.
 *
 * `buildResearcherContext` is a whitelist assembler: it picks only the fields
 * it knows from an untrusted input record and drops everything else, so a
 * caller that accidentally carries secrets or rules on the input cannot leak
 * them into the agent's context. Known-sensitive fields are not just dropped
 * silently — the assembly records their names in `redacted` for audit.
 */
import { deepFreeze } from "./security-boundary";
import type { ResourceLease } from "./resource-lease";
import { validateResourceLease } from "./resource-lease";

export const RESEARCHER_CONTEXT_SCHEMA = "evok.researcher-context/v1" as const;

/** Fields that must never reach a Researcher agent's long-term context. */
export const RESEARCHER_CONTEXT_FORBIDDEN_FIELDS = [
  "credentials", "secrets", "apiKeys", "apiKey", "token", "password",
  "rules", "competitionRules", "hiddenData", "holdout", "privateLeaderboard",
  "globalBudget", "missionBudget", "agentHistory", "transcript", "history",
] as const;

/** The only scalar/list fields the assembler will pass through. */
const ALLOWED_INPUT_FIELDS = ["objective", "hypothesis", "evidenceRefs", "allowedPaths", "tools", "competition", "lease"] as const;
const CONTEXT_FIELDS = new Set(["schema", "objective", "hypothesis", "evidenceRefs", "allowedPaths", "tools", "competition", "resources", "redacted"]);

/** A sanitized view of the competition: identity + scoring only, no rules body. */
export interface ResearcherCompetitionSummary {
  readonly competitionId: string;
  readonly version: string;
  readonly metric: string;
  readonly direction: "maximize" | "minimize";
}

/** A sanitized view of the lease: capacities, never device UUIDs or host paths. */
export interface ResearcherResourceSummary {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly gpuCount: number;
  readonly gpuNames: readonly string[];
  readonly deadlineAt?: string;
}

export interface ResearcherContext {
  readonly schema: typeof RESEARCHER_CONTEXT_SCHEMA;
  readonly objective: string;
  readonly hypothesis?: string;
  readonly evidenceRefs: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly tools: readonly string[];
  readonly competition?: ResearcherCompetitionSummary;
  readonly resources: ResearcherResourceSummary;
  /** Names of input fields the assembler dropped as sensitive or unknown. */
  readonly redacted: readonly string[];
}

export class ResearcherContextError extends Error {
  readonly kind = "researcher-context" as const;
  constructor(message: string) {
    super(message);
    this.name = "ResearcherContextError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(label: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new ResearcherContextError(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

/** Derives the least-privilege resource summary from a granted lease. */
export function summarizeLeaseResources(lease: ResourceLease): ResearcherResourceSummary {
  const validated = validateResourceLease(lease);
  return deepFreeze({
    cpus: validated.cpus,
    memoryBytes: validated.memoryBytes,
    gpuCount: validated.gpus.length,
    gpuNames: validated.gpus.map((gpu) => gpu.device.name),
    ...(validated.deadlineAt !== undefined ? { deadlineAt: validated.deadlineAt } : {}),
  });
}

function summarizeCompetition(raw: unknown): ResearcherCompetitionSummary | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ResearcherContextError("researcher context competition must be an object");
  for (const key of ["competitionId", "version", "metric"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).trim() === "") {
      throw new ResearcherContextError(`researcher context competition.${key} is required`);
    }
  }
  if (raw.direction !== "maximize" && raw.direction !== "minimize") {
    throw new ResearcherContextError("researcher context competition.direction must be maximize or minimize");
  }
  return deepFreeze({
    competitionId: raw.competitionId,
    version: raw.version,
    metric: raw.metric,
    direction: raw.direction,
  } as ResearcherCompetitionSummary);
}

/**
 * Assembles the minimal Task Contract context for one Researcher/Critic/
 * Reviewer agent. Unknown input keys are dropped; keys in
 * RESEARCHER_CONTEXT_FORBIDDEN_FIELDS are dropped and named in `redacted`.
 */
export function buildResearcherContext(input: unknown): ResearcherContext {
  if (!isRecord(input)) throw new ResearcherContextError("researcher context input must be an object");
  const forbidden = new Set<string>(RESEARCHER_CONTEXT_FORBIDDEN_FIELDS);
  const allowed = new Set<string>(ALLOWED_INPUT_FIELDS);
  const redacted = Object.keys(input).filter((key) => forbidden.has(key) || !allowed.has(key));
  if (typeof input.objective !== "string" || input.objective.trim() === "") {
    throw new ResearcherContextError("researcher context objective is required");
  }
  if (input.hypothesis !== undefined && typeof input.hypothesis !== "string") {
    throw new ResearcherContextError("researcher context hypothesis must be a string");
  }
  const resources = input.lease !== undefined
    ? summarizeLeaseResources(input.lease as ResourceLease)
    : deepFreeze({ cpus: 0, memoryBytes: 0, gpuCount: 0, gpuNames: [] } as ResearcherResourceSummary);
  return deepFreeze({
    schema: RESEARCHER_CONTEXT_SCHEMA,
    objective: input.objective,
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
    evidenceRefs: stringList("researcher context evidenceRefs", input.evidenceRefs),
    allowedPaths: stringList("researcher context allowedPaths", input.allowedPaths),
    tools: stringList("researcher context tools", input.tools),
    ...(input.competition !== undefined ? { competition: summarizeCompetition(input.competition) } : {}),
    resources,
    redacted: deepFreeze(redacted) as readonly string[],
  } as ResearcherContext);
}

/** Validates a context crossing the legacy subagent transport boundary. */
export function validateResearcherContext(raw: unknown): ResearcherContext {
  if (!isRecord(raw)) throw new ResearcherContextError("researcher context must be an object");
  if (raw.schema !== RESEARCHER_CONTEXT_SCHEMA) {
    throw new ResearcherContextError(`researcher context schema must be ${RESEARCHER_CONTEXT_SCHEMA}`);
  }
  const unknown = Object.keys(raw).filter((key) => !CONTEXT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new ResearcherContextError(`researcher context contains unsupported fields: ${unknown.join(", ")}`);
  }
  if (typeof raw.objective !== "string" || raw.objective.trim() === "") {
    throw new ResearcherContextError("researcher context objective is required");
  }
  if (raw.hypothesis !== undefined && typeof raw.hypothesis !== "string") {
    throw new ResearcherContextError("researcher context hypothesis must be a string");
  }
  const evidenceRefs = stringList("researcher context evidenceRefs", raw.evidenceRefs);
  const allowedPaths = stringList("researcher context allowedPaths", raw.allowedPaths);
  const tools = stringList("researcher context tools", raw.tools);
  const competition = raw.competition === undefined ? undefined : summarizeCompetition(raw.competition);
  if (!isRecord(raw.resources)) throw new ResearcherContextError("researcher context resources are required");
  const resources = raw.resources;
  for (const key of ["cpus", "memoryBytes", "gpuCount"] as const) {
    if (!Number.isSafeInteger(resources[key]) || (resources[key] as number) < 0) {
      throw new ResearcherContextError(`researcher context resources.${key} must be an integer >= 0`);
    }
  }
  if (!Array.isArray(resources.gpuNames) || resources.gpuNames.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new ResearcherContextError("researcher context resources.gpuNames must be an array of non-empty strings");
  }
  if (resources.deadlineAt !== undefined && (typeof resources.deadlineAt !== "string" || resources.deadlineAt.trim() === "")) {
    throw new ResearcherContextError("researcher context resources.deadlineAt must be a non-empty string");
  }
  if (!Array.isArray(raw.redacted) || raw.redacted.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new ResearcherContextError("researcher context redacted must be an array of non-empty strings");
  }
  return deepFreeze({
    schema: RESEARCHER_CONTEXT_SCHEMA,
    objective: raw.objective,
    ...(raw.hypothesis !== undefined ? { hypothesis: raw.hypothesis } : {}),
    evidenceRefs,
    allowedPaths,
    tools,
    ...(competition !== undefined ? { competition } : {}),
    resources: deepFreeze({
      cpus: resources.cpus,
      memoryBytes: resources.memoryBytes,
      gpuCount: resources.gpuCount,
      gpuNames: [...resources.gpuNames],
      ...(resources.deadlineAt !== undefined ? { deadlineAt: resources.deadlineAt } : {}),
    }) as ResearcherResourceSummary,
    redacted: [...raw.redacted],
  } as ResearcherContext);
}
