/**
 * MemorySlice: the bounded, reference-first memory one short-lived agent may
 * receive. Physical home: `src/execution/`.
 *
 * A slice is assembled by the ContextBroker (`context-broker.ts`) from durable
 * mission/task/run evidence, bound to exactly one Run, and content-addressed.
 * It carries references, structured facts and short findings — never raw
 * transcripts, credentials, hidden/holdout data, global budgets, or full rule
 * bodies. `readPolicy` is fixed: references and summaries are readable, bodies
 * and sensitive content are not, so a slice can be handed to an agent (or a
 * delegated subagent) without becoming a second transcript store.
 *
 * `MemoryWriteProposal` is how an agent asks to add memory: it is a proposal
 * only, validated against the same sensitivity rule and never applied here.
 * `AgentResult` is the structured return a short-lived agent produces; the
 * coordinator (not the agent) decides what becomes the next slice.
 */
import { deepFreeze, digestValue } from "./security-boundary";

export const MEMORY_SLICE_SCHEMA = "evok.memory-slice/v1" as const;
export const MEMORY_WRITE_PROPOSAL_SCHEMA = "evok.memory-write-proposal/v1" as const;
export const AGENT_RESULT_SCHEMA = "evok.agent-result/v1" as const;

/**
 * Content that a memory slice, fact, or write proposal must never carry.
 * Keys are matched exactly (case-sensitively) against every object level the
 * slice assembler accepts, so a builder that passes a credential store or a
 * transcript fails closed instead of leaking it into an agent prompt.
 */
export const MEMORY_SENSITIVE_FIELDS = [
  "credentials", "credential", "secrets", "secret", "apiKeys", "apiKey", "token", "password",
  "hiddenData", "holdout", "privateLeaderboard", "transcript", "transcripts",
  "history", "agentHistory", "globalBudget", "missionBudget",
  "rules", "competitionRules",
] as const;

/**
 * The only read policy a slice may declare: references and summaries are
 * readable; bodies and sensitive content are never part of a slice.
 */
export interface MemoryReadPolicy {
  readonly references: true;
  readonly summaries: true;
  readonly bodies: false;
  readonly sensitive: false;
}

export const DEFAULT_MEMORY_READ_POLICY: MemoryReadPolicy = deepFreeze({
  references: true,
  summaries: true,
  bodies: false,
  sensitive: false,
});

export interface MemoryFact {
  readonly name: string;
  readonly value: string | number | boolean;
  readonly source?: string;
}

export interface MemoryFinding {
  readonly findingId: string;
  readonly summary: string;
  readonly ok?: boolean;
  readonly sourceRefs?: readonly string[];
}

export interface MemorySliceInput {
  readonly sliceId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly sourceRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly facts?: readonly MemoryFact[];
  readonly findings?: readonly MemoryFinding[];
  readonly readPolicy?: MemoryReadPolicy;
  readonly issuedAt?: string;
}

/** A frozen, digest-addressed memory slice bound to one Mission Task Run. */
export interface MemorySlice {
  readonly schema: typeof MEMORY_SLICE_SCHEMA;
  readonly sliceId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly sourceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly facts: readonly MemoryFact[];
  readonly findings: readonly MemoryFinding[];
  readonly readPolicy: MemoryReadPolicy;
  readonly issuedAt?: string;
  readonly digest: string;
}

export interface MemoryWriteProposalInput {
  readonly proposalId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly rationale: string;
  readonly sourceRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly facts?: readonly MemoryFact[];
  readonly findings?: readonly MemoryFinding[];
  readonly createdAt?: string;
}

/**
 * What an agent asks to remember. It is never applied by the agent: the
 * coordinator validates it and decides whether it becomes a new slice.
 */
export interface MemoryWriteProposal {
  readonly schema: typeof MEMORY_WRITE_PROPOSAL_SCHEMA;
  readonly proposalId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly rationale: string;
  readonly sourceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly facts: readonly MemoryFact[];
  readonly findings: readonly MemoryFinding[];
  readonly createdAt?: string;
  readonly digest: string;
}

/** The structured return of one short-lived agent; never a result authority. */
export interface AgentResult {
  readonly schema: typeof AGENT_RESULT_SCHEMA;
  readonly agentId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly memoryWrite?: MemoryWriteProposal;
}

export class MemorySliceError extends Error {
  readonly kind = "memory-slice" as const;
  constructor(message: string) {
    super(message);
    this.name = "MemorySliceError";
  }
}

const SENSITIVE = new Set<string>(MEMORY_SENSITIVE_FIELDS);
const FACT_KEYS = new Set(["name", "value", "source"]);
const FINDING_KEYS = new Set(["findingId", "summary", "ok", "sourceRefs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new MemorySliceError(`${label} is required`);
  return value;
}

function assertNoSensitiveKeys(label: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (SENSITIVE.has(key)) {
      throw new MemorySliceError(`${label} "${key}" is sensitive and can never be part of agent memory`);
    }
  }
}

function stringList(label: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new MemorySliceError(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function factsOf(value: unknown): MemoryFact[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MemorySliceError("memory facts must be an array");
  return value.map((raw) => {
    if (!isRecord(raw)) throw new MemorySliceError("memory facts must be objects");
    assertNoSensitiveKeys("memory fact field", Object.keys(raw));
    for (const key of Object.keys(raw)) {
      if (!FACT_KEYS.has(key)) throw new MemorySliceError(`unsupported memory fact field "${key}"`);
    }
    const name = requireNonEmpty("memory fact name", raw.name);
    if (SENSITIVE.has(name)) {
      throw new MemorySliceError(`memory fact "${name}" names sensitive content and can never be part of agent memory`);
    }
    if (typeof raw.value !== "string" && typeof raw.value !== "number" && typeof raw.value !== "boolean") {
      throw new MemorySliceError(`memory fact "${name}" value must be a string, number, or boolean`);
    }
    if (typeof raw.value === "number" && !Number.isFinite(raw.value)) {
      throw new MemorySliceError(`memory fact "${name}" value must be finite`);
    }
    return {
      name,
      value: raw.value,
      ...(raw.source !== undefined ? { source: requireNonEmpty(`memory fact "${name}" source`, raw.source) } : {}),
    };
  });
}

function findingsOf(value: unknown): MemoryFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MemorySliceError("memory findings must be an array");
  return value.map((raw) => {
    if (!isRecord(raw)) throw new MemorySliceError("memory findings must be objects");
    assertNoSensitiveKeys("memory finding field", Object.keys(raw));
    for (const key of Object.keys(raw)) {
      if (!FINDING_KEYS.has(key)) throw new MemorySliceError(`unsupported memory finding field "${key}"`);
    }
    const findingId = requireNonEmpty("memory finding findingId", raw.findingId);
    if (SENSITIVE.has(findingId)) {
      throw new MemorySliceError(`memory finding "${findingId}" names sensitive content and can never be part of agent memory`);
    }
    if (raw.ok !== undefined && typeof raw.ok !== "boolean") {
      throw new MemorySliceError(`memory finding "${findingId}" ok must be a boolean`);
    }
    const sourceRefs = stringList(`memory finding "${findingId}" sourceRefs`, raw.sourceRefs);
    return {
      findingId,
      summary: requireNonEmpty(`memory finding "${findingId}" summary`, raw.summary),
      ...(raw.ok !== undefined ? { ok: raw.ok } : {}),
      ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    };
  });
}

function readPolicyOf(value: unknown): MemoryReadPolicy {
  if (value === undefined) return DEFAULT_MEMORY_READ_POLICY;
  if (!isRecord(value)) throw new MemorySliceError("memory readPolicy must be an object");
  assertNoSensitiveKeys("memory readPolicy field", Object.keys(value));
  if (value.references !== true || value.summaries !== true) {
    throw new MemorySliceError("memory readPolicy must allow references and summaries");
  }
  if (value.bodies !== false || value.sensitive !== false) {
    throw new MemorySliceError("memory readPolicy must deny bodies and sensitive content");
  }
  return DEFAULT_MEMORY_READ_POLICY;
}

function assertSafeInput(label: string, raw: unknown): asserts raw is Record<string, unknown> {
  if (!isRecord(raw)) throw new MemorySliceError(`${label} must be an object`);
  assertNoSensitiveKeys(`${label} field`, Object.keys(raw));
}

/** Creates a frozen, content-addressed memory slice bound to one Run. */
export function createMemorySlice(input: MemorySliceInput): MemorySlice {
  assertSafeInput("memory slice", input);
  const body = {
    sliceId: requireNonEmpty("memory slice sliceId", input.sliceId),
    missionId: requireNonEmpty("memory slice missionId", input.missionId),
    taskId: requireNonEmpty("memory slice taskId", input.taskId),
    runId: requireNonEmpty("memory slice runId", input.runId),
    sourceRefs: stringList("memory slice sourceRefs", input.sourceRefs),
    evidenceRefs: stringList("memory slice evidenceRefs", input.evidenceRefs),
    artifactRefs: stringList("memory slice artifactRefs", input.artifactRefs),
    facts: factsOf(input.facts),
    findings: findingsOf(input.findings),
    readPolicy: readPolicyOf(input.readPolicy),
    ...(input.issuedAt !== undefined ? { issuedAt: requireNonEmpty("memory slice issuedAt", input.issuedAt) } : {}),
  };
  return deepFreeze({
    schema: MEMORY_SLICE_SCHEMA,
    ...body,
    digest: digestValue({ schema: MEMORY_SLICE_SCHEMA, ...body }),
  });
}

/** Validates a persisted slice: sensitivity, shape, Run binding, and digest. */
export function validateMemorySlice(raw: unknown): MemorySlice {
  assertSafeInput("memory slice", raw);
  if (raw.schema !== MEMORY_SLICE_SCHEMA) throw new MemorySliceError(`memory slice schema must be ${MEMORY_SLICE_SCHEMA}`);
  const { schema: _schema, digest, ...body } = raw;
  const rebuilt = createMemorySlice(body as unknown as MemorySliceInput);
  if (rebuilt.digest !== digest) throw new MemorySliceError("memory slice digest mismatch");
  return rebuilt;
}

/** Creates a frozen, digest-addressed memory write proposal (never applied here). */
export function createMemoryWriteProposal(input: MemoryWriteProposalInput): MemoryWriteProposal {
  assertSafeInput("memory write proposal", input);
  const body = {
    proposalId: requireNonEmpty("memory write proposal proposalId", input.proposalId),
    missionId: requireNonEmpty("memory write proposal missionId", input.missionId),
    taskId: requireNonEmpty("memory write proposal taskId", input.taskId),
    runId: requireNonEmpty("memory write proposal runId", input.runId),
    agentId: requireNonEmpty("memory write proposal agentId", input.agentId),
    rationale: requireNonEmpty("memory write proposal rationale", input.rationale),
    sourceRefs: stringList("memory write proposal sourceRefs", input.sourceRefs),
    evidenceRefs: stringList("memory write proposal evidenceRefs", input.evidenceRefs),
    facts: factsOf(input.facts),
    findings: findingsOf(input.findings),
    ...(input.createdAt !== undefined ? { createdAt: requireNonEmpty("memory write proposal createdAt", input.createdAt) } : {}),
  };
  return deepFreeze({
    schema: MEMORY_WRITE_PROPOSAL_SCHEMA,
    ...body,
    digest: digestValue({ schema: MEMORY_WRITE_PROPOSAL_SCHEMA, ...body }),
  });
}

export function validateMemoryWriteProposal(raw: unknown): MemoryWriteProposal {
  assertSafeInput("memory write proposal", raw);
  if (raw.schema !== MEMORY_WRITE_PROPOSAL_SCHEMA) {
    throw new MemorySliceError(`memory write proposal schema must be ${MEMORY_WRITE_PROPOSAL_SCHEMA}`);
  }
  const { schema: _schema, digest, ...body } = raw;
  const rebuilt = createMemoryWriteProposal(body as unknown as MemoryWriteProposalInput);
  if (rebuilt.digest !== digest) throw new MemorySliceError("memory write proposal digest mismatch");
  return rebuilt;
}

/**
 * Validates an agent's structured return against the Run it claims to answer.
 * A result from another Mission/Task/Run/agent fails closed, so a delegated
 * agent can never answer with its parent's (or a sibling's) identity.
 */
export function validateAgentResult(
  raw: unknown,
  binding: { readonly missionId?: string; readonly taskId?: string; readonly runId?: string; readonly agentId?: string } = {},
): AgentResult {
  if (!isRecord(raw)) throw new MemorySliceError("agent result must be an object");
  if (raw.schema !== AGENT_RESULT_SCHEMA) throw new MemorySliceError(`agent result schema must be ${AGENT_RESULT_SCHEMA}`);
  assertNoSensitiveKeys("agent result field", Object.keys(raw));
  if (typeof raw.ok !== "boolean") throw new MemorySliceError("agent result ok must be a boolean");
  const result = {
    schema: AGENT_RESULT_SCHEMA,
    agentId: requireNonEmpty("agent result agentId", raw.agentId),
    missionId: requireNonEmpty("agent result missionId", raw.missionId),
    taskId: requireNonEmpty("agent result taskId", raw.taskId),
    runId: requireNonEmpty("agent result runId", raw.runId),
    ok: raw.ok,
    summary: requireNonEmpty("agent result summary", raw.summary),
    artifactRefs: stringList("agent result artifactRefs", raw.artifactRefs),
    evidenceRefs: stringList("agent result evidenceRefs", raw.evidenceRefs),
    ...(raw.memoryWrite !== undefined ? { memoryWrite: validateMemoryWriteProposal(raw.memoryWrite) } : {}),
  };
  for (const key of ["missionId", "taskId", "runId", "agentId"] as const) {
    const expected = binding[key];
    if (expected !== undefined && result[key] !== expected) {
      throw new MemorySliceError(`agent result ${key} "${result[key]}" does not match the dispatched ${key} "${expected}"`);
    }
  }
  if (result.memoryWrite && result.memoryWrite.runId !== result.runId) {
    throw new MemorySliceError("agent result memoryWrite must be bound to the same run");
  }
  return deepFreeze(result);
}
