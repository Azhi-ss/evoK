/**
 * Synthesis Proposals: a structured, reference-first interpretation an
 * authorized Agent or Director may submit for storage (M1-T3 / #212).
 *
 * Proposal integrity (`accepted_for_storage` / `rejected`) is NOT scientific
 * status. An accepted Proposal is stored unverified: citing refs can never
 * create a Verified Claim, and the controller — not the model — assigns that
 * status. Validation is pure and deterministic, so no background or autonomous
 * LLM synthesis, and no next-validation suggestion can dispatch itself.
 *
 * Rejections are auditable by reason code only; the rejected payload (which may
 * contain restricted content) is never part of the record.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import { ResearchMemoryError, assertMemorySafeText } from "../memory";

export const SYNTHESIS_PROPOSAL_SCHEMA = "evok.synthesis-proposal/v1" as const;

export type SynthesisProposalKind = "hypothesis" | "finding" | "pitfall";
export type SynthesisRefKind = "run" | "evidence" | "negative-evidence" | "claim";

/** A typed pointer to an authoritative Mission object; never its payload. */
export interface SynthesisRef {
  readonly kind: SynthesisRefKind;
  readonly ref: string;
}

/** Claim-specific applicability dimension (`dimension:value`). */
export const SYNTHESIS_APPLICABILITY_DIMENSIONS = [
  "task", "objective", "evaluation", "dataset", "method", "runtime", "contract",
] as const;

/** Always advisory: a suggestion can never dispatch a Task or Run itself. */
export interface SynthesisNextValidation {
  readonly objective: string;
  readonly advisory: true;
}

/** The proposal itself carries identity, refs, unknowns, and applicability. */
export interface SynthesisProposal {
  readonly schema: typeof SYNTHESIS_PROPOSAL_SCHEMA;
  readonly proposalId: string;
  readonly operationId: string;
  readonly missionId: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly kind: SynthesisProposalKind;
  readonly statement: string;
  readonly rationale: string;
  readonly supportingRefs: readonly SynthesisRef[];
  readonly contradictingRefs: readonly SynthesisRef[];
  readonly competingRefs: readonly SynthesisRef[];
  readonly unknowns: readonly string[];
  readonly applicability: readonly string[];
  /** v1 can only be Mission-visible; a proposal never widens source visibility. */
  readonly visibility: "mission";
  readonly limitations: readonly string[];
  readonly conditions: readonly string[];
  readonly nextValidation?: SynthesisNextValidation;
  readonly digest: string;
}

/** Trusted Mission facts the controller checks a submission against. */
export interface SynthesisProposalContext {
  readonly missionId: string;
  readonly taskIds: readonly string[];
  readonly runIds: readonly string[];
  readonly negativeEvidenceRunIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly accepted: readonly SynthesisProposal[];
}

export type SynthesisRejectionReason =
  | "schema"
  | "identity"
  | "sensitive-content"
  | "refs"
  | "visibility"
  | "applicability"
  | "idempotency";

export type SynthesisProposalValidation =
  | {
    readonly outcome: "accepted_for_storage";
    /** Controller-assigned: storing a Proposal never verifies it. */
    readonly epistemicStatus: "unverified";
    readonly proposal: SynthesisProposal;
  }
  | { readonly outcome: "rejected"; readonly reason: SynthesisRejectionReason };

const TOP_KEYS = new Set([
  "schema", "proposalId", "operationId", "missionId", "agentId", "taskId", "runId", "kind",
  "statement", "rationale", "supportingRefs", "contradictingRefs", "competingRefs", "unknowns",
  "applicability", "visibility", "limitations", "conditions", "nextValidation",
]);
const REF_KEYS = new Set(["kind", "ref"]);
const NEXT_VALIDATION_KEYS = new Set(["objective", "advisory"]);
const KINDS: readonly SynthesisProposalKind[] = ["hypothesis", "finding", "pitfall"];
const REF_KINDS: readonly SynthesisRefKind[] = ["run", "evidence", "negative-evidence", "claim"];
const MAX_TEXT_LENGTH = 2000;

class Rejection extends Error {
  readonly reason: SynthesisRejectionReason;
  constructor(reason: SynthesisRejectionReason) {
    super(reason);
    this.reason = reason;
  }
}

function reject(reason: SynthesisRejectionReason): never {
  throw new Rejection(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") reject("schema");
  let checked: string;
  try {
    checked = assertMemorySafeText(label, value); // secret-like values reject the proposal
  } catch (error) {
    if (error instanceof ResearchMemoryError) reject("sensitive-content");
    throw error;
  }
  if (checked.length > MAX_TEXT_LENGTH) reject("schema");
  return checked;
}

function textList(label: string, value: unknown): string[] {
  if (!Array.isArray(value)) reject("schema");
  return value.map((entry) => text(label, entry));
}

function optionalText(label: string, value: unknown): string | undefined {
  return value === undefined ? undefined : text(label, value);
}

function refs(label: string, value: unknown, ctx: SynthesisProposalContext): SynthesisRef[] {
  if (!Array.isArray(value)) reject("schema");
  return value.map((entry) => {
    if (!isRecord(entry)) reject("refs");
    for (const key of Object.keys(entry)) if (!REF_KEYS.has(key)) reject("refs");
    const kind = entry.kind;
    if (typeof kind !== "string" || !REF_KINDS.includes(kind as SynthesisRefKind)) reject("refs");
    if (typeof entry.ref !== "string" || entry.ref.trim() === "") reject("refs");
    const ref = text(label, entry.ref);
    switch (kind) {
      case "run":
        if (!ctx.runIds.includes(ref)) reject("refs");
        break;
      case "negative-evidence":
        if (!ctx.negativeEvidenceRunIds.includes(ref)) reject("refs");
        break;
      case "evidence":
        if (!ctx.evidenceRefs.includes(ref)) reject("refs");
        break;
      case "claim":
        if (!ctx.accepted.some((stored) => stored.proposalId === ref)) reject("refs");
        break;
    }
    return { kind: kind as SynthesisRefKind, ref };
  });
}

function applicability(value: unknown, kind: SynthesisProposalKind): string[] {
  if (!Array.isArray(value) || value.length === 0) reject("applicability");
  return value.map((entry) => {
    if (typeof entry !== "string") reject("applicability");
    const separator = entry.indexOf(":");
    if (separator <= 0) reject("applicability");
    const dimension = entry.slice(0, separator);
    const scope = entry.slice(separator + 1);
    if (!SYNTHESIS_APPLICABILITY_DIMENSIONS.includes(dimension as (typeof SYNTHESIS_APPLICABILITY_DIMENSIONS)[number])) {
      reject("applicability");
    }
    if (scope.trim() === "") reject("applicability");
    return assertMemorySafeText("synthesis proposal applicability", entry);
  });
}

function nextValidation(value: unknown): SynthesisNextValidation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) reject("schema");
  for (const key of Object.keys(value)) if (!NEXT_VALIDATION_KEYS.has(key)) reject("schema");
  // `advisory` is a fixed literal: a suggestion can never be an executable order.
  if (value.advisory !== true) reject("schema");
  return deepFreeze({ objective: text("synthesis proposal nextValidation objective", value.objective), advisory: true });
}

/**
 * Validates one submission against the trusted Mission context and returns
 * either an unverified Proposal accepted for storage or a reason code.
 */
export function validateSynthesisProposal(raw: unknown, ctx: SynthesisProposalContext): SynthesisProposalValidation {
  try {
    return { outcome: "accepted_for_storage", epistemicStatus: "unverified", proposal: check(raw, ctx) };
  } catch (error) {
    if (error instanceof Rejection) return { outcome: "rejected", reason: error.reason };
    // A non-rejection failure is a defect, not a user-visible rejection.
    throw error;
  }
}

function check(raw: unknown, ctx: SynthesisProposalContext): SynthesisProposal {
  if (!isRecord(raw)) reject("schema");
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) reject("schema");
  if (raw.schema !== SYNTHESIS_PROPOSAL_SCHEMA) reject("schema");
  if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind as SynthesisProposalKind)) reject("schema");
  const kind = raw.kind as SynthesisProposalKind;

  // Identity: the Mission is authoritative, and a Run-bound agent must be bound
  // to the Run it claims.
  if (raw.missionId !== ctx.missionId) reject("identity");
  if (typeof raw.agentId !== "string" || raw.agentId.trim() === "") reject("identity");
  const taskId = optionalText("synthesis proposal taskId", raw.taskId);
  if (taskId !== undefined && !ctx.taskIds.includes(taskId)) reject("identity");
  const runId = optionalText("synthesis proposal runId", raw.runId);
  if (runId !== undefined) {
    if (!ctx.runIds.includes(runId)) reject("identity");
    if (!raw.agentId.endsWith(`@${runId}`)) reject("identity");
  }

  if (raw.visibility !== "mission") reject("visibility");

  const statement = text("synthesis proposal statement", raw.statement);
  const rationale = text("synthesis proposal rationale", raw.rationale);
  const unknowns = textList("synthesis proposal unknowns", raw.unknowns);
  const limitations = textList("synthesis proposal limitations", raw.limitations ?? []);
  const conditions = textList("synthesis proposal conditions", raw.conditions ?? []);

  const supportingRefs = refs("synthesis proposal supporting ref", raw.supportingRefs, ctx);
  if (supportingRefs.length === 0) reject("refs");
  const contradictingRefs = refs("synthesis proposal contradicting ref", raw.contradictingRefs, ctx);
  // Counterevidence is either cited or explicitly unknown; absence is not silence.
  if (contradictingRefs.length === 0 && unknowns.length === 0) reject("refs");
  const competingRefs = refs("synthesis proposal competing ref", raw.competingRefs ?? [], ctx);
  const scoped = applicability(raw.applicability, kind);
  if (kind === "pitfall" && conditions.length === 0) reject("applicability");

  // Idempotency: one operation stores one payload, and one proposal id is one
  // proposal. An identical replay returns the already-stored Proposal.
  const proposalId = text("synthesis proposal proposalId", raw.proposalId);
  const operationId = text("synthesis proposal operationId", raw.operationId);
  const body = {
    schema: SYNTHESIS_PROPOSAL_SCHEMA,
    proposalId,
    operationId,
    missionId: ctx.missionId,
    agentId: text("synthesis proposal agentId", raw.agentId),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    kind,
    statement,
    rationale,
    supportingRefs,
    contradictingRefs,
    competingRefs,
    unknowns,
    applicability: scoped,
    visibility: "mission" as const,
    limitations,
    conditions,
    ...(raw.nextValidation !== undefined ? { nextValidation: nextValidation(raw.nextValidation)! } : {}),
  };
  const digest = digestValue(body);
  const replayedOperation = ctx.accepted.find((stored) => stored.operationId === operationId);
  if (replayedOperation !== undefined) {
    if (replayedOperation.digest !== digest) reject("idempotency");
    return deepFreeze(replayedOperation);
  }
  if (ctx.accepted.some((stored) => stored.proposalId === proposalId)) reject("idempotency");
  return deepFreeze({ ...body, digest });
}
