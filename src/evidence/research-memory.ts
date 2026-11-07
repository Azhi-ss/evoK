/**
 * Mission Research Memory: the bounded, deterministic projection of the
 * authoritative Mission history into agent-readable reading cards (M1-T1 / #210).
 *
 * Derived, never authoritative: the Mission record stays the only write log,
 * and a snapshot can be rebuilt from it at any time. Cards carry identities,
 * bounded summaries, applicability labels and typed source refs — never
 * transcripts, artifact bodies, credentials, holdouts, or restricted content.
 *
 * Two reads are deliberately different (#214): a Decision Packet is bounded
 * research CONTEXT and keeps competing/contradicting history even when it is
 * not directly applicable, while `retrieveResearchMemory` answers "which card
 * may be REUSED as a direct prior under these conditions". Neither read grants
 * authority, and neither can widen visibility.
 */
import { deepFreeze, digestValue } from "../security-boundary";
import {
  RUN_FAILURE_KINDS,
  RUN_OUTCOME_STATES,
  classifyRunOutcome,
  type RunFailureKind,
  type RunOutcomeState,
} from "./run-outcome";
import type { SynthesisProposal } from "./synthesis-proposal";

export const RESEARCH_MEMORY_SNAPSHOT_SCHEMA = "evok.research-memory-snapshot/v1" as const;
export const RESEARCH_MEMORY_FINDING_CARD_SCHEMA = "evok.research-memory-finding-card/v1" as const;
/** M1-T3: reading cards projected from accepted (unverified) Synthesis Proposals. */
export const SYNTHESIS_HYPOTHESIS_CARD_SCHEMA = "evok.research-memory-hypothesis-card/v1" as const;
export const SYNTHESIS_FINDING_CARD_SCHEMA = "evok.research-memory-synthesis-finding-card/v1" as const;
export const SYNTHESIS_PITFALL_CARD_SCHEMA = "evok.research-memory-pitfall-card/v1" as const;
/** M1-T4: an operational failure projected from its Run, never a scientific claim. */
export const OPERATIONAL_PITFALL_CARD_SCHEMA = "evok.research-memory-operational-pitfall-card/v1" as const;
/**
 * M1-T9: the Schema-only Sham slot. It occupies the same structural position as
 * one real card (kind, bounded presentation) while carrying no research fact, no
 * refs, no applicability and no directional advice, and is explicitly marked as
 * a control input.
 */
export const RESEARCH_CONTROL_CARD_SCHEMA = "evok.research-memory-control-card/v1" as const;
// Still /v1: the applicability, lineage and condition fields are additive and a
// snapshot published before them keeps loading and revalidating unchanged.
export const RESEARCH_MEMORY_REVISION = "research-memory/v1" as const;
export const RESEARCH_DECISION_PACKET_SCHEMA = "evok.research-decision-packet/v1" as const;
export const RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION = "research-memory-retrieval/v1" as const;
/** Hard retrieval bound; trusted policy may lower it, never trust an absent value. */
export const RESEARCH_MEMORY_DEFAULT_MAX_CARDS = 8;

/** The three trusted evaluation arms of Research Memory (M1-T9). */
export const RESEARCH_MEMORY_EVALUATION_MODES = ["off", "sham", "real"] as const;
export type ResearchMemoryEvaluationMode = (typeof RESEARCH_MEMORY_EVALUATION_MODES)[number];

/**
 * Normalizes the TRUSTED configuration value into one evaluation arm. `true`
 * (or absent) keeps the product default, Real Memory; `false` stays the legacy
 * off switch; an explicit arm name selects a comparison arm. An unknown value
 * fails closed rather than silently choosing an arm.
 */
export function researchMemoryModeOf(value: unknown): ResearchMemoryEvaluationMode {
  if (value === undefined || value === true) return "real";
  if (value === false) return "off";
  if (typeof value === "string" && RESEARCH_MEMORY_EVALUATION_MODES.includes(value as ResearchMemoryEvaluationMode)) {
    return value as ResearchMemoryEvaluationMode;
  }
  throw new ResearchMemoryError(
    `Research Memory evaluation mode must be one of ${RESEARCH_MEMORY_EVALUATION_MODES.join("/")}, not ${JSON.stringify(value)}`,
  );
}
const MAX_CARDS_CEILING = 64;
const MAX_SUMMARY_LENGTH = 240;

export class ResearchMemoryError extends Error {
  readonly kind = "research-memory" as const;
  constructor(message: string) {
    super(message);
    this.name = "ResearchMemoryError";
  }
}

export type ResearchCardLifecycle = "active" | "provisional" | "contested" | "stale" | "superseded" | "withdrawn";

/**
 * Claim-specific applicability dimensions. A card declares only the
 * dimensions it actually knows: a GPU Pitfall needs runtime/configuration
 * without an Objective, a generalization Finding needs dataset/evaluation/
 * method without hardware. A dimension nobody declared stays unknown.
 */
export const RESEARCH_APPLICABILITY_DIMENSIONS = [
  "mission", "task", "objective", "evaluation", "dataset", "method", "runtime", "contract",
] as const;
export type ResearchApplicabilityDimension = (typeof RESEARCH_APPLICABILITY_DIMENSIONS)[number];

/** Scope dimensions answer "is this about my Task at all", not a scientific conflict. */
const SCOPE_DIMENSIONS: ReadonlySet<ResearchApplicabilityDimension> = new Set(["mission", "task"]);

/** A changed value here invalidates an earlier conclusion: stale, revalidation required. */
export const RESEARCH_REVALIDATION_DIMENSIONS: readonly ResearchApplicabilityDimension[] = [
  "objective", "evaluation", "dataset", "method", "runtime", "contract",
];

/** A lifecycle only ever moves forward within one projection: retirement always wins. */
const LIFECYCLE_RANK: Readonly<Record<ResearchCardLifecycle, number>> = {
  active: 0, provisional: 1, contested: 2, stale: 3, superseded: 4, withdrawn: 5,
};

/** A per-card lifecycle draft; only the final card is frozen and published. */
interface CardOverlay {
  lifecycle: ResearchCardLifecycle;
  lineage?: ResearchCardLineage;
  revalidationRequired?: true;
}

/** Card-level lineage: an explicit revision chain, never an overwrite. */
export interface ResearchCardLineage {
  readonly revision?: number;
  readonly derivesFrom?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly supersededBy?: string;
}

/** An authoritative retirement of one card; historical Evidence stays untouched. */
export interface ResearchCardWithdrawal {
  readonly cardId: string;
  readonly reason?: string;
}

/** One measured (or failed) Mission Run as the projection sees it. */
export interface ResearchRunFinding {
  readonly runId: string;
  readonly taskId?: string;
  /** The Experiment objective, the stable identity a repeat is matched on. */
  readonly taskObjective?: string;
  readonly ok: boolean;
  readonly score?: number;
  readonly ruleViolations?: readonly string[];
  readonly error?: string;
  readonly evidenceRefs: readonly string[];
  readonly snapshotDigest?: string;
  /** The declared Task configuration that reproduced an operational failure. */
  readonly configuration?: string;
}

/** The trusted Mission projection a snapshot is derived from. */
export interface ResearchMemorySource {
  readonly missionId: string;
  readonly ledgerRevision: number;
  readonly runs: readonly ResearchRunFinding[];
  /** Already validated, `accepted_for_storage` proposals from Mission history. */
  readonly proposals?: readonly SynthesisProposal[];
  /**
   * Current Mission conditions as `dimension:value` (trusted, from the Mission
   * record). A card that declared an older value of a critical dimension is
   * projected stale instead of being reused under changed conditions.
   */
  readonly conditions?: readonly string[];
  /**
   * Withdrawal records replayed from authoritative Mission history, keyed by
   * card id. They only retire future reads: the stored Evidence and every
   * already published snapshot keep their exact bytes, and no projection
   * writes history back. The withdrawal write path is a separate slice, so no
   * producer exists yet; until then this projection seam stays inert.
   */
  readonly withdrawals?: readonly ResearchCardWithdrawal[];
  readonly maxCards?: number;
}

/**
 * A repeated Experiment match: the same objective was already measured. This is
 * advisory context for replication/ablation value, never a rejection or veto.
 */
export interface ResearchReplicationContext {
  readonly objective: string;
  readonly priorRunIds: readonly string[];
  readonly priorOutcomes: readonly RunOutcomeState[];
  readonly advisory: true;
}

/** A presentation projection of one Finding; not a new authoritative entity. */
export interface ResearchFindingCard {
  readonly schema: typeof RESEARCH_MEMORY_FINDING_CARD_SCHEMA;
  readonly cardId: string;
  readonly kind: "finding";
  readonly summary: string;
  readonly ok: boolean;
  /** Scientific reading vs operational failure: never conflated. */
  readonly outcome: RunOutcomeState;
  /** Set only for an operational failure (OOM, timeout, invalid measurement). */
  readonly failure?: RunFailureKind;
  readonly applicability: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly lifecycle: ResearchCardLifecycle;
  /** Present when this Run repeated an already-measured Task. */
  readonly replication?: ResearchReplicationContext;
  /** Present only when a critical condition changed: revalidate before reuse. */
  readonly revalidationRequired?: true;
  readonly lineage?: ResearchCardLineage;
}

/** One operational failure pattern with the conditions that reproduced it. */
export interface ResearchOperationalPitfallCard {
  readonly schema: typeof OPERATIONAL_PITFALL_CARD_SCHEMA;
  readonly cardId: string;
  readonly kind: "pitfall";
  readonly summary: string;
  readonly failure: RunFailureKind;
  readonly conditions: readonly string[];
  readonly applicability: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly lifecycle: ResearchCardLifecycle;
  readonly revalidationRequired?: true;
  readonly lineage?: ResearchCardLineage;
}

/** Shared shape of a card derived from a stored Proposal; always unverified. */
interface SynthesisCardBase {
  readonly cardId: string;
  readonly summary: string;
  readonly applicability: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly lifecycle: ResearchCardLifecycle;
  readonly visibility: "mission";
  readonly epistemicStatus: "unverified";
  readonly revalidationRequired?: true;
  readonly lineage?: ResearchCardLineage;
}

/** Competing Hypotheses, contradicting refs, unknowns, next-validation suggestion. */
export interface ResearchHypothesisCard extends SynthesisCardBase {
  readonly schema: typeof SYNTHESIS_HYPOTHESIS_CARD_SCHEMA;
  readonly kind: "hypothesis";
  readonly supportingRefs: readonly string[];
  readonly contradictingRefs: readonly string[];
  readonly competingRefs: readonly string[];
  readonly unknowns: readonly string[];
  readonly nextValidation?: { readonly objective: string; readonly advisory: true };
}

/** One conditional Finding with its known limitations; refs stay authoritative. */
export interface ResearchSynthesisFindingCard extends SynthesisCardBase {
  readonly schema: typeof SYNTHESIS_FINDING_CARD_SCHEMA;
  readonly kind: "finding";
  readonly limitations: readonly string[];
}

/** Operational/protocol failure pattern with the conditions that reproduce it. */
export interface ResearchPitfallCard extends SynthesisCardBase {
  readonly schema: typeof SYNTHESIS_PITFALL_CARD_SCHEMA;
  readonly kind: "pitfall";
  readonly conditions: readonly string[];
  readonly avoidance: string;
}

/** A Schema-only Sham slot: control input, never Memory content. */
export interface ResearchControlCard {
  readonly schema: typeof RESEARCH_CONTROL_CARD_SCHEMA;
  readonly cardId: string;
  readonly kind: "finding" | "hypothesis" | "pitfall";
  /** Neutral placeholder text: it says what it is, and nothing about research. */
  readonly summary: string;
  /** Always empty: a control input declares no applicability. */
  readonly applicability: readonly string[];
  /** Always empty: a control input cites no Evidence or other refs. */
  readonly sourceRefs: readonly string[];
  readonly lifecycle: "provisional";
  readonly control: "sham";
}

export type ResearchMemoryCard =
  | ResearchFindingCard
  | ResearchOperationalPitfallCard
  | ResearchHypothesisCard
  | ResearchSynthesisFindingCard
  | ResearchPitfallCard
  | ResearchControlCard;

export interface ResearchMemorySnapshot {
  readonly schema: typeof RESEARCH_MEMORY_SNAPSHOT_SCHEMA;
  readonly missionId: string;
  readonly snapshotId: string;
  readonly ledgerRevision: number;
  readonly memoryRevision: typeof RESEARCH_MEMORY_REVISION;
  readonly retrievalPolicyRevision: typeof RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION;
  /**
   * The trusted Mission conditions this snapshot was projected under, so a
   * stale/revalidation projection stays explainable from the record itself.
   */
  readonly conditions?: readonly string[];
  readonly maxCards: number;
  readonly cards: readonly ResearchMemoryCard[];
  readonly omittedCardCount: number;
  readonly digest: string;
}

/**
 * The bounded Memory view one Memory-informed decision stage receives: cards
 * from exactly ONE pinned snapshot, plus the omission count. It is a
 * presentation projection of an already-derived snapshot, never a new store.
 */
export interface ResearchDecisionPacket {
  readonly schema: typeof RESEARCH_DECISION_PACKET_SCHEMA;
  readonly missionId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly ledgerRevision: number;
  readonly cards: readonly ResearchMemoryCard[];
  /**
   * Reserved presentation categories (#215): cards delivered in this order
   * first, so supporting material can never crowd out the contradicting
   * Evidence or the competing Hypothesis.
   */
  readonly reserved: {
    readonly contradictingEvidence: readonly string[];
    readonly competingHypotheses: readonly string[];
  };
  /** Per-category omission counts, so a cut packet is explainable. */
  readonly omissions: ResearchPacketOmissions;
  /** True whenever anything is missing: a truncated packet is not the history. */
  readonly truncated: boolean;
  readonly omittedCardCount: number;
  /** M1-T9: present only on a Schema-only Sham packet (a control input). */
  readonly control?: "sham";
  readonly digest: string;
}

/** Where a packet's omissions are, category by category. */
export interface ResearchPacketOmissions {
  readonly contradictingEvidence: number;
  readonly competingHypotheses: number;
  readonly supporting: number;
  /** Cards the snapshot had already dropped before any packet existed. */
  readonly snapshotOmitted: number;
}

/** Read-only Mission status projection: no card bodies, no restricted refs. */
export interface ResearchMemorySummary {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly ledgerRevision: number;
  readonly cards: {
    readonly finding: number;
    readonly hypothesis?: number;
    /** Pitfall Cards from stored Proposals. */
    readonly pitfall?: number;
    /** Derived Operational Pitfalls: a non-scientific reading, counted apart. */
    readonly operationalPitfall?: number;
  };
  readonly omittedCards: number;
  /** M1-T9: control (Sham) slots, counted apart from any real research card. */
  readonly controlCards?: number;
}

/**
 * The conditions a retrieval runs under. `conditions` lists only what the
 * caller knows; `critical` names the dimensions it needs declared, so an
 * undeclared dimension is unknown rather than compatible. Contract digest is
 * one dimension like any other: its equality never establishes applicability.
 */
export interface ResearchPriorQuery {
  readonly missionId?: string;
  readonly conditions?: readonly string[];
  readonly critical?: readonly ResearchApplicabilityDimension[];
}

export type ResearchPriorState =
  /** Every critical dimension is declared and matches; the card may be reused. */
  | "direct-prior"
  /** A declared dimension differs under the current conditions. */
  | "conflict"
  /** A critical dimension was never declared, on either side. */
  | "unknown"
  /** Another Task/Mission scope: not about this retrieval at all. */
  | "not-applicable";

export interface ResearchPriorVerdict {
  readonly card: ResearchMemoryCard;
  readonly state: ResearchPriorState;
  readonly conflicts: readonly ResearchApplicabilityDimension[];
  readonly unknowns: readonly ResearchApplicabilityDimension[];
  /** Visibility is its own filter: an inapplicable card is still visible. */
  readonly visible: boolean;
  /** True only for an active, matching, visible card. */
  readonly directPrior: boolean;
}

/** One deterministic retrieval over ONE pinned snapshot. */
export interface ResearchRetrieval {
  readonly missionId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly ledgerRevision: number;
  readonly verdicts: readonly ResearchPriorVerdict[];
}

const SENSITIVE_KEYS = new Set(
  [
    "credentials", "credential", "secrets", "secret", "apiKeys", "apiKey", "token", "password",
    "hiddenData", "holdout", "privateLeaderboard", "transcript", "transcripts",
    "history", "agentHistory", "globalBudget", "missionBudget", "rules", "competitionRules",
  ].map(canonicalKey),
);

function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Secret-like values are rejected before storage; key-name filtering alone is not enough.
const SECRET_LIKE = /(?:api[_-]?key|token|password|secret)\s*[:=]|\b(?:sk|ghp|github_pat|xoxb|xoxp)-[A-Za-z0-9_-]{4,}|\bBearer\s+[A-Za-z0-9._~+/=-]+/i;

const SNAPSHOT_KEYS = new Set([
  "schema", "missionId", "snapshotId", "ledgerRevision", "memoryRevision",
  "retrievalPolicyRevision", "conditions", "maxCards", "cards", "omittedCardCount", "digest",
]);
const CARD_KEYS = new Set([
  "schema", "cardId", "kind", "summary", "ok", "outcome", "failure", "applicability", "sourceRefs", "lifecycle", "replication",
  "revalidationRequired", "lineage",
]);
const OPERATIONAL_PITFALL_CARD_KEYS = new Set([
  "schema", "cardId", "kind", "summary", "failure", "conditions", "applicability", "sourceRefs", "lifecycle",
  "revalidationRequired", "lineage",
]);
const LINEAGE_KEYS = new Set(["revision", "derivesFrom", "supersedes", "supersededBy"]);
const WITHDRAWAL_KEYS = new Set(["cardId", "reason"]);
const REPLICATION_KEYS = new Set(["objective", "priorRunIds", "priorOutcomes", "advisory"]);
const LIFECYCLE_FOR: Readonly<Record<RunOutcomeState, ResearchCardLifecycle>> = {
  positive: "active",
  negative: "contested",
  operational: "provisional",
};
const SYNTHESIS_CARD_BASE_KEYS = [
  "schema", "cardId", "kind", "summary", "applicability", "sourceRefs", "lifecycle", "visibility", "epistemicStatus",
  "revalidationRequired", "lineage",
];
const HYPOTHESIS_CARD_KEYS = new Set([
  ...SYNTHESIS_CARD_BASE_KEYS, "supportingRefs", "contradictingRefs", "competingRefs", "unknowns", "nextValidation",
]);
const SYNTHESIS_FINDING_CARD_KEYS = new Set([...SYNTHESIS_CARD_BASE_KEYS, "limitations"]);
const PITFALL_CARD_KEYS = new Set([...SYNTHESIS_CARD_BASE_KEYS, "conditions", "avoidance"]);
const CONTROL_CARD_KEYS = new Set(["schema", "cardId", "kind", "summary", "applicability", "sourceRefs", "lifecycle", "control"]);
const LIFECYCLES: readonly ResearchCardLifecycle[] = ["active", "provisional", "contested", "stale", "superseded", "withdrawn"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shared boundary for any evidence-layer text that can reach agent memory. */
export function assertMemorySafeText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ResearchMemoryError(`${label} is required`);
  if (SECRET_LIKE.test(value)) throw new ResearchMemoryError(`${label} contains a secret-like value and can never enter agent memory`);
  return value;
}

function textList(label: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ResearchMemoryError(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => assertMemorySafeText(label, entry));
}

function assertSafeKeys(label: string, keys: readonly string[], allowed?: ReadonlySet<string>): void {
  for (const key of keys) {
    if (SENSITIVE_KEYS.has(canonicalKey(key))) {
      throw new ResearchMemoryError(`${label} "${key}" is sensitive and can never enter agent memory`);
    }
    if (allowed && !allowed.has(key)) throw new ResearchMemoryError(`${label} has unsupported field "${key}"`);
  }
}

/** Applicability values compare normalized; the stored text is kept verbatim. */
function normalizedApplicability(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The one comparison rule for every declared-versus-current decision. */
function sameApplicabilityValue(left: string, right: string): boolean {
  return normalizedApplicability(left) === normalizedApplicability(right);
}

/** Parses `dimension:value` pairs; an unknown dimension fails closed. */
function applicabilityMap(
  label: string,
  entries: readonly string[],
): Map<ResearchApplicabilityDimension, string> {
  const declared = new Map<ResearchApplicabilityDimension, string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new ResearchMemoryError(`${label} must be "<dimension>:<value>"`);
    const dimension = entry.slice(0, separator);
    const value = entry.slice(separator + 1).trim();
    if (!RESEARCH_APPLICABILITY_DIMENSIONS.includes(dimension as ResearchApplicabilityDimension)) {
      throw new ResearchMemoryError(`${label} has unsupported dimension "${dimension}"`);
    }
    if (value === "") throw new ResearchMemoryError(`${label} ${dimension} needs a value`);
    assertMemorySafeText(label, entry);
    const key = dimension as ResearchApplicabilityDimension;
    const existing = declared.get(key);
    if (existing !== undefined && normalizedApplicability(existing) !== normalizedApplicability(value)) {
      throw new ResearchMemoryError(`${label} declares ${dimension} twice with different values`);
    }
    declared.set(key, existing ?? value);
  }
  return declared;
}

/** A stored card's applicability must be a well-formed, supported declaration. */
function assertApplicability(label: string, value: unknown): void {
  applicabilityMap(label, textList(label, value));
}

function laterLifecycle(base: ResearchCardLifecycle, next: ResearchCardLifecycle): ResearchCardLifecycle {
  return LIFECYCLE_RANK[next] > LIFECYCLE_RANK[base] ? next : base;
}

/**
 * A changed critical condition makes an earlier conclusion need revalidation.
 * Scope dimensions (Mission/Task) are not condition changes: a card measured
 * under another Task is simply not applicable, not stale.
 */
function staleDimensions(
  applicability: readonly string[],
  conditions: ReadonlyMap<ResearchApplicabilityDimension, string>,
): ResearchApplicabilityDimension[] {
  const declared = applicabilityMap("research memory card applicability", applicability);
  return RESEARCH_REVALIDATION_DIMENSIONS.filter((dimension) => {
    const declaredValue = declared.get(dimension);
    const current = conditions.get(dimension);
    return declaredValue !== undefined && current !== undefined && !sameApplicabilityValue(declaredValue, current);
  });
}

function withdrawalsOf(value: unknown): Map<string, string | undefined> {
  const withdrawals = new Map<string, string | undefined>();
  if (value === undefined) return withdrawals;
  if (!Array.isArray(value)) throw new ResearchMemoryError("research memory withdrawals must be an array");
  for (const entry of value) {
    if (!isRecord(entry)) throw new ResearchMemoryError("research memory withdrawal must be an object");
    assertSafeKeys("research memory withdrawal field", Object.keys(entry), WITHDRAWAL_KEYS);
    withdrawals.set(
      assertMemorySafeText("research memory withdrawal cardId", entry.cardId),
      entry.reason === undefined ? undefined : assertMemorySafeText("research memory withdrawal reason", entry.reason),
    );
  }
  return withdrawals;
}

/** Equivalent Hypotheses share a claim kind, normalized statement and scope. */
function equivalenceKey(proposal: SynthesisProposal): string {
  return digestValue({
    kind: proposal.kind,
    statement: normalizedApplicability(proposal.statement),
    scope: scopeKey(proposal),
  });
}

/** The conditions a claim was made under: a conflict is same-scope or nothing. */
function scopeKey(proposal: SynthesisProposal): string {
  return digestValue({
    kind: proposal.kind,
    applicability: proposal.applicability.map(normalizedApplicability).sort(),
  });
}

/** A Proposal card id always carries its proposal id; anything else is corruption. */
function proposalIdOf(cardId: string): string {
  const marker = ":synthesis:";
  const at = cardId.indexOf(marker);
  if (at < 0) throw new ResearchMemoryError(`research memory card "${cardId}" is not a Proposal card`);
  return cardId.slice(at + marker.length);
}

/** A competing ref is a stored `claim:<proposalId>`; other ref kinds are not claims. */
function competingClaimId(ref: string): string | undefined {
  return ref.startsWith("claim:") ? ref.slice("claim:".length) : undefined;
}

/** Every card carries the Mission's visibility; nothing can be wider. */
function cardVisibility(card: ResearchMemoryCard): string {
  return "visibility" in card ? card.visibility : "mission";
}

function maxCardsOf(value: unknown): number {
  const max = value === undefined ? RESEARCH_MEMORY_DEFAULT_MAX_CARDS : value;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_CARDS_CEILING) {
    throw new ResearchMemoryError(`research memory maxCards must be an integer in [1, ${MAX_CARDS_CEILING}]; missing or invalid limits fail closed`);
  }
  return max;
}

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_SUMMARY_LENGTH ? trimmed : `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

function cardFor(run: ResearchRunFinding, missionId: string, replication?: ResearchReplicationContext): ResearchFindingCard {
  const classification = classifyRunOutcome(run);
  const outcome = run.error !== undefined
    ? `dispatch failed: ${bounded(run.error)}`
    : run.ok
      ? `measured ok=true${typeof run.score === "number" ? ` score=${run.score}` : ""}`
      : `measured ok=false${typeof run.score === "number" ? ` score=${run.score}` : ""}${run.ruleViolations?.length ? ` rules=${bounded(run.ruleViolations.join("; "))}` : ""}`;
  const summary = classification.state === "operational"
    ? bounded(`run ${run.runId} operational failure ${classification.failure}; not scientific negative evidence: ${outcome}`)
    : bounded(`run ${run.runId} ${outcome}${classification.scientificNegativeEvidence ? " (negative evidence)" : ""}`);
  const applicability = run.taskId ? `task:${run.taskId}` : `mission:${missionId}`;
  const body = {
    schema: RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
    cardId: `finding:${run.runId}`,
    kind: "finding" as const,
    summary,
    ok: run.ok,
    outcome: classification.state,
    ...(classification.failure !== undefined ? { failure: classification.failure } : {}),
    applicability: [assertMemorySafeText("research memory applicability", applicability)],
    sourceRefs: [...run.evidenceRefs],
    // An operational failure is never a contested scientific claim.
    lifecycle: LIFECYCLE_FOR[classification.state],
    ...(replication !== undefined ? { replication } : {}),
  };
  // Sensitivity applies to the summary as well as to every label/ref.
  assertMemorySafeText("research memory card summary", body.summary);
  return body;
}

/** Operational failures become Pitfalls; a Run Outcome is never rewritten. */
function pitfallFor(run: ResearchRunFinding, card: ResearchFindingCard): ResearchOperationalPitfallCard | undefined {
  if (card.outcome !== "operational" || card.failure === undefined) return undefined;
  const classification = classifyRunOutcome(run);
  return {
    schema: OPERATIONAL_PITFALL_CARD_SCHEMA,
    cardId: `pitfall:run:${run.runId}`,
    kind: "pitfall" as const,
    summary: bounded(`run ${run.runId} ${card.failure} under ${classification.conditions.join("; ")}`),
    failure: card.failure,
    conditions: classification.conditions.map((condition) => assertMemorySafeText("research memory pitfall condition", condition)),
    applicability: [...card.applicability],
    sourceRefs: [...run.evidenceRefs],
    lifecycle: "provisional" as const,
    // Derived-from lineage: the Pitfall is a reading of that Run's own card.
    lineage: { derivesFrom: [card.cardId] },
  };
}

function normalizedObjective(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

/**
 * The same Experiment objective measured before is a repeat, not a duplicate: the card carries
 * replication-value context (a repeat may be seed replication or an ablation)
 * and no code path here can reject a Run or veto a proposal.
 */
function replicationFor(run: ResearchRunFinding, runs: readonly ResearchRunFinding[]): ResearchReplicationContext | undefined {
  const index = runs.indexOf(run);
  const objective = normalizedObjective(run.taskObjective);
  if (index <= 0 || objective === undefined) return undefined;
  // Mission history order is chronological; run ids sort lexicographically and
  // cannot order `:exp:10` after `:exp:2`.
  const prior = runs.slice(0, index).filter((other) => normalizedObjective(other.taskObjective) === objective);
  if (prior.length === 0) return undefined;
  return deepFreeze({
    objective,
    priorRunIds: prior.map((other) => other.runId),
    priorOutcomes: prior.map((other) => classifyRunOutcome(other).state),
    advisory: true as const,
  });
}

/**
 * Deterministically projects Mission history into a bounded snapshot. Same
 * source (per card limit) → byte-identical snapshot id and digest, regardless
 * of run ordering; a changed ledger revision or card changes the digest.
 */
export function projectResearchMemorySnapshot(source: ResearchMemorySource): ResearchMemorySnapshot {
  if (!isRecord(source)) throw new ResearchMemoryError("research memory source must be an object");
  assertSafeKeys("research memory source field", Object.keys(source),
    new Set(["missionId", "ledgerRevision", "runs", "proposals", "conditions", "withdrawals", "maxCards"]));
  const missionId = assertMemorySafeText("research memory missionId", source.missionId);
  const conditions = applicabilityMap("research memory condition", source.conditions ?? []);
  const withdrawals = withdrawalsOf(source.withdrawals);
  const ledgerRevision = source.ledgerRevision;
  if (typeof ledgerRevision !== "number" || !Number.isInteger(ledgerRevision) || ledgerRevision < 0) {
    throw new ResearchMemoryError("research memory ledgerRevision must be a non-negative integer");
  }
  const maxCards = maxCardsOf(source.maxCards);
  if (!Array.isArray(source.runs)) throw new ResearchMemoryError("research memory runs must be an array");

  const seen = new Set<string>();
  const runs: ResearchRunFinding[] = [];
  for (const run of source.runs) {
    if (!isRecord(run)) throw new ResearchMemoryError("research memory run must be an object");
    assertSafeKeys("research memory run field", Object.keys(run),
      new Set(["runId", "taskId", "taskObjective", "ok", "score", "ruleViolations", "error", "evidenceRefs", "snapshotDigest", "configuration"]));
    const runId = assertMemorySafeText("research memory runId", run.runId);
    if (seen.has(runId)) continue; // first observation per Run wins; history stays append-only
    seen.add(runId);
    if (typeof run.ok !== "boolean") throw new ResearchMemoryError(`research memory run ${runId} needs a boolean ok`);
    if (run.score !== undefined && (typeof run.score !== "number" || !Number.isFinite(run.score))) {
      throw new ResearchMemoryError(`research memory run ${runId} score must be a finite number`);
    }
    runs.push({
      runId,
      ...(run.taskId !== undefined ? { taskId: assertMemorySafeText("research memory taskId", run.taskId) } : {}),
      ...(run.taskObjective !== undefined ? { taskObjective: assertMemorySafeText("research memory taskObjective", run.taskObjective) } : {}),
      ok: run.ok,
      ...(typeof run.score === "number" ? { score: run.score } : {}),
      ...(run.ruleViolations !== undefined ? { ruleViolations: textList("research memory ruleViolations", run.ruleViolations) } : {}),
      ...(run.error !== undefined ? { error: assertMemorySafeText("research memory error", run.error) } : {}),
      evidenceRefs: textList("research memory evidenceRefs", run.evidenceRefs),
      ...(run.snapshotDigest !== undefined ? { snapshotDigest: assertMemorySafeText("research memory snapshotDigest", run.snapshotDigest) } : {}),
      ...(run.configuration !== undefined ? { configuration: assertMemorySafeText("research memory configuration", run.configuration) } : {}),
    });
  }

  // Replication context is resolved in Mission history order, BEFORE the
  // deterministic lexicographic sort below.
  const replication = new Map(runs.map((run) => [run.runId, replicationFor(run, runs)]));
  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  // One card per stored Proposal (operation idempotency), grouped by claim
  // equivalence so equivalent Hypotheses become an explicit revision chain.
  const proposalCards: ResearchMemoryCard[] = [];
  const seenProposalIdentities = new Set<string>();
  const groups = new Map<string, ResearchMemoryCard[]>();
  const scopeOf = new Map<string, string>();
  for (const proposal of source.proposals ?? []) {
    // Proposal commits and projection are idempotent by operation id: a replay
    // never mints a second card or another revision. The writer already refuses
    // a different payload under one operation, so this seam only deduplicates.
    const identities = [`proposal:${proposal.proposalId}`, `operation:${proposal.operationId}`];
    if (identities.some((identity) => seenProposalIdentities.has(identity))) continue;
    for (const identity of identities) seenProposalIdentities.add(identity);
    const card = synthesisCardFor(proposal);
    const key = equivalenceKey(proposal);
    scopeOf.set(proposal.proposalId, scopeKey(proposal));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [card]);
    else group.push(card);
    proposalCards.push(card);
  }

  const overlays = new Map<string, CardOverlay>(
    proposalCards.map((card) => [card.cardId, { lifecycle: card.lifecycle }]),
  );
  const promoteLifecycle = (card: ResearchMemoryCard, lifecycle: ResearchCardLifecycle): void => {
    const overlay = overlays.get(card.cardId)!;
    overlay.lifecycle = laterLifecycle(overlay.lifecycle, lifecycle);
  };

  // Equivalent Hypotheses are revised, never last-write-win: every earlier
  // revision stays visible as superseded with explicit lineage.
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const latest = group[group.length - 1]!;
    group.slice(0, -1).forEach((earlier, index) => {
      promoteLifecycle(earlier, "superseded");
      overlays.get(earlier.cardId)!.lineage = { revision: index + 1, supersededBy: latest.cardId };
    });
    overlays.get(latest.cardId)!.lineage = {
      revision: group.length,
      supersedes: group.slice(0, -1).map((card) => card.cardId),
    };
  }

  // A declared competing claim under the SAME conditions is a coexistence, not
  // an overwrite: both positions are contested. Different conditions stay apart.
  const proposalCardsById = new Map(proposalCards.map((card) => [proposalIdOf(card.cardId), card]));
  for (const card of proposalCards) {
    if (card.schema !== SYNTHESIS_HYPOTHESIS_CARD_SCHEMA) continue;
    for (const competing of card.competingRefs) {
      const claimId = competingClaimId(competing);
      const target = claimId === undefined ? undefined : proposalCardsById.get(claimId);
      if (target === undefined || target.cardId === card.cardId || target.kind !== "hypothesis") continue;
      if (scopeOf.get(proposalIdOf(card.cardId)) !== scopeOf.get(proposalIdOf(target.cardId))) continue;
      promoteLifecycle(card, "contested");
      promoteLifecycle(target, "contested");
    }
  }

  // Synthesised reading cards are kept ahead of run summary cards: a bounded
  // packet must not lose the competing/contradicting position to sheer Run volume.
  const runCards = runs.flatMap((run) => {
    const card = cardFor(run, missionId, replication.get(run.runId) ?? undefined);
    const pitfall = pitfallFor(run, card);
    return pitfall ? [card, pitfall] : [card];
  });

  // A changed critical condition downgrades the earlier conclusion in the NEXT
  // deterministic Snapshot; the previously published one is never rewritten.
  const considered = [...proposalCards, ...runCards];
  for (const card of considered) {
    if (!overlays.has(card.cardId)) overlays.set(card.cardId, { lifecycle: card.lifecycle });
    if (staleDimensions(card.applicability, conditions).length === 0) continue;
    const overlay = overlays.get(card.cardId)!;
    overlay.lifecycle = laterLifecycle(overlay.lifecycle, "stale");
    overlay.revalidationRequired = true;
  }

  // Withdrawal retires a card for future reads only.
  for (const [cardId] of withdrawals) {
    const overlay = overlays.get(cardId);
    if (overlay === undefined) continue; // a withdrawal can grant nothing new
    overlay.lifecycle = "withdrawn";
    delete overlay.revalidationRequired;
  }

  const finalized = new Map<string, ResearchMemoryCard>(considered.map((card) => {
    const overlay = overlays.get(card.cardId)!;
    return [card.cardId, deepFreeze({
      ...card,
      lifecycle: overlay.lifecycle,
      // The marker belongs to exactly one reading: a stale card awaiting revalidation.
      ...(overlay.revalidationRequired === true && overlay.lifecycle === "stale" ? { revalidationRequired: true as const } : {}),
      ...(overlay.lineage !== undefined ? { lineage: overlay.lineage } : {}),
    }) as ResearchMemoryCard];
  }));
  const orderedProposals = [...proposalCards]
    .map((card) => finalized.get(card.cardId)!)
    .sort((a, b) => {
      const rank = LIFECYCLE_RANK[a.lifecycle] - LIFECYCLE_RANK[b.lifecycle];
      return rank !== 0 ? rank : (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0);
    });
  const orderedRuns = runCards.map((card) => finalized.get(card.cardId)!);
  // #215: a bounded projection must not lose the contradicting Evidence or the
  // competing position to supporting volume. #212's rule still holds inside a
  // tier: stored Proposals stay ahead of run summary cards.
  const reserved = [
    ...orderedRuns.filter(isContradictingEvidenceCard),
    ...orderedProposals.filter(isCompetingHypothesisCard),
  ];
  const reservedIds = new Set(reserved.map((card) => card.cardId));
  const cards = [
    ...reserved,
    ...[...orderedProposals, ...orderedRuns].filter((card) => !reservedIds.has(card.cardId)),
  ].slice(0, maxCards);
  const body = {
    schema: RESEARCH_MEMORY_SNAPSHOT_SCHEMA,
    missionId,
    ledgerRevision,
    memoryRevision: RESEARCH_MEMORY_REVISION,
    retrievalPolicyRevision: RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION,
    // Canonical dimension order, so the explained conditions are deterministic.
    ...(conditions.size > 0
      ? { conditions: RESEARCH_APPLICABILITY_DIMENSIONS.filter((dimension) => conditions.has(dimension)).map((dimension) => `${dimension}:${conditions.get(dimension)!}`) }
      : {}),
    maxCards,
    cards,
    omittedCardCount: considered.length - cards.length,
  };
  const digest = digestValue(body);
  return deepFreeze({ ...body, snapshotId: snapshotIdFor(digest), digest });
}

function snapshotIdFor(digest: string): string {
  return `research-memory:${digest}`;
}

/** A typed ref renders as `<kind>:<ref>`: authoritative objects stay referenced. */
function refKey(ref: { readonly kind: string; readonly ref: string }): string {
  return `${ref.kind}:${ref.ref}`;
}

/**
 * Projects one accepted Proposal into a reading card. The card carries only
 * bounded text, typed refs, applicability and the unverified epistemic label;
 * the stored Proposal remains the authoritative record.
 */
function synthesisCardFor(proposal: SynthesisProposal): ResearchMemoryCard {
  const refs = [...proposal.supportingRefs, ...proposal.contradictingRefs, ...proposal.competingRefs].map(refKey);
  const base = {
    cardId: `${proposal.kind}:synthesis:${proposal.proposalId}`,
    summary: bounded(assertMemorySafeText("research memory card summary", proposal.statement)),
    applicability: [...proposal.applicability],
    sourceRefs: [...new Set(refs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    lifecycle: "provisional" as const,
    visibility: "mission" as const,
    epistemicStatus: "unverified" as const,
  };
  switch (proposal.kind) {
    case "hypothesis":
      return {
        ...base,
        schema: SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
        kind: "hypothesis" as const,
        supportingRefs: proposal.supportingRefs.map(refKey),
        contradictingRefs: proposal.contradictingRefs.map(refKey),
        competingRefs: proposal.competingRefs.map(refKey),
        unknowns: [...proposal.unknowns],
        ...(proposal.nextValidation !== undefined ? { nextValidation: { ...proposal.nextValidation } } : {}),
      };
    case "finding":
      return {
        ...base,
        schema: SYNTHESIS_FINDING_CARD_SCHEMA,
        kind: "finding" as const,
        limitations: [...proposal.limitations],
      };
    case "pitfall":
      return {
        ...base,
        schema: SYNTHESIS_PITFALL_CARD_SCHEMA,
        kind: "pitfall" as const,
        conditions: [...proposal.conditions],
        avoidance: bounded(assertMemorySafeText("research memory card avoidance", proposal.rationale)),
      };
  }
}

/**
 * Projects the decision packet from ONE verified snapshot. The packet is
 * deterministic for the same snapshot and card limit, and can only ever carry
 * cards that snapshot already published. It is bounded CONTEXT, not a
 * direct-prior gate: `retrieveResearchMemory` is the reuse read (#214).
 */
export function projectResearchDecisionPacket(
  snapshot: ResearchMemorySnapshot,
  options: { readonly maxCards?: number } = {},
): ResearchDecisionPacket {
  const verified = validateResearchMemorySnapshot(snapshot);
  const limit = options.maxCards === undefined
    ? verified.maxCards
    : Math.min(maxCardsOf(options.maxCards), verified.maxCards);
  const contradicting = verified.cards.filter(isContradictingEvidenceCard);
  const competing = verified.cards.filter(isCompetingHypothesisCard);
  const reservedIds = new Set([...contradicting, ...competing].map((card) => card.cardId));
  const supporting = verified.cards.filter((card) => !reservedIds.has(card.cardId));
  // A fresh snapshot already delivers the reserved categories first, but a
  // packet may be rebuilt from an older published snapshot (#215): re-assert the
  // reserved-first order here so the guarantee does not depend on snapshot vintage.
  const reservedFirst = [
    ...contradicting,
    ...competing,
    ...verified.cards.filter((card) => !reservedIds.has(card.cardId)),
  ];
  const cards = reservedFirst.slice(0, limit);
  const delivered = new Set(cards.map((card) => card.cardId));
  const dropped = (of: readonly ResearchMemoryCard[]) => of.filter((card) => !delivered.has(card.cardId)).length;
  const omittedCardCount = verified.omittedCardCount + (verified.cards.length - cards.length);
  const body = {
    schema: RESEARCH_DECISION_PACKET_SCHEMA,
    missionId: verified.missionId,
    snapshotId: verified.snapshotId,
    snapshotDigest: verified.digest,
    ledgerRevision: verified.ledgerRevision,
    cards,
    // Only DELIVERED reserved cards are named; the omissions explain the rest.
    reserved: {
      contradictingEvidence: contradicting.filter((card) => delivered.has(card.cardId)).map((card) => card.cardId),
      competingHypotheses: competing.filter((card) => delivered.has(card.cardId)).map((card) => card.cardId),
    },
    omissions: {
      contradictingEvidence: dropped(contradicting),
      competingHypotheses: dropped(competing),
      supporting: dropped(supporting),
      snapshotOmitted: verified.omittedCardCount,
    },
    truncated: omittedCardCount > 0,
    omittedCardCount,
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/**
 * Schema-only Sham slots (M1-T9): one control card per real card, in the same
 * order and with the same kind, so the presentation structure and bounds match
 * while no research fact, ref, applicability or directional advice survives.
 */
function controlCardsFor(cards: readonly ResearchMemoryCard[]): readonly ResearchControlCard[] {
  return cards.map((card, index) => deepFreeze({
    schema: RESEARCH_CONTROL_CARD_SCHEMA,
    cardId: `control:${index + 1}:${card.kind}`,
    kind: card.kind,
    summary: `control input: schema-only placeholder ${index + 1} of ${cards.length} (no research content)`,
    applicability: [] as string[],
    sourceRefs: [] as string[],
    lifecycle: "provisional" as const,
    control: "sham" as const,
  }));
}

/**
 * The Schema-only Sham projection of one snapshot: identical card count, order,
 * kinds, limits and omission counts; every card replaced by a control slot and
 * nothing derived from Mission history except the structural shape.
 */
export function shamResearchMemorySnapshot(snapshot: ResearchMemorySnapshot): ResearchMemorySnapshot {
  const verified = validateResearchMemorySnapshot(snapshot);
  const { digest: _digest, snapshotId: _snapshotId, ...rest } = verified;
  const body = { ...rest, cards: controlCardsFor(verified.cards) };
  const digest = digestValue(body);
  return deepFreeze({ ...body, snapshotId: snapshotIdFor(digest), digest });
}

/**
 * The Schema-only Sham variant of one pinned packet. Card count, kinds, order,
 * limits and omission counts keep the real packet's bounded presentation, but
 * the reserved categories stay empty: naming WHICH cards contradict or compete
 * would disclose directional research state, so a control input keeps only the
 * counts. The packet is marked as a control input so no reader can mistake it
 * for Research Memory.
 */
export function shamResearchDecisionPacket(packet: ResearchDecisionPacket): ResearchDecisionPacket {
  const cards = controlCardsFor(packet.cards);
  for (const id of [...packet.reserved.contradictingEvidence, ...packet.reserved.competingHypotheses]) {
    if (!packet.cards.some((card) => card.cardId === id)) {
      throw new ResearchMemoryError(`packet ref "${id}" is not one of its own cards`);
    }
  }
  const { digest: _digest, ...rest } = packet;
  const body = {
    ...rest,
    cards,
    reserved: { contradictingEvidence: [] as string[], competingHypotheses: [] as string[] },
    control: "sham" as const,
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/** A measured refutation is Evidence that contradicts a supporting position. */
function isContradictingEvidenceCard(card: ResearchMemoryCard): boolean {
  if (card.kind !== "finding" || card.schema !== RESEARCH_MEMORY_FINDING_CARD_SCHEMA) return false;
  // A card published before #213 carries no outcome; validation reads its `ok`
  // as the only outcome it ever had, so the same reading applies here.
  return (card.outcome ?? (card.ok ? "positive" : "negative")) === "negative";
}

/** A Hypothesis with a declared competitor, or one already contested by it. */
function isCompetingHypothesisCard(card: ResearchMemoryCard): boolean {
  return card.schema === SYNTHESIS_HYPOTHESIS_CARD_SCHEMA
    && (card.competingRefs.length > 0 || card.lifecycle === "contested");
}

/** Used Memory refs must belong to the delivered packet, never another one. */
export function assertPacketCardRefs(packet: ResearchDecisionPacket, usedRefs: readonly string[]): void {
  const delivered = new Set(packet.cards.map((card) => card.cardId));
  for (const ref of usedRefs) {
    if (!delivered.has(ref)) {
      throw new ResearchMemoryError(`Memory ref "${ref}" is not part of the delivered packet`);
    }
  }
}

/**
 * Classifies ONE card against the conditions a retrieval runs under. A declared
 * difference on a scientific dimension is a conflict even when the Contract
 * digest matches; an undeclared critical dimension is unknown, never compatible;
 * Task/Mission scope mismatch is simply not applicable. Visibility is reported
 * separately and is never widened by an applicability match.
 */
export function evaluateResearchApplicability(
  card: ResearchMemoryCard,
  query: ResearchPriorQuery = {},
): ResearchPriorVerdict {
  const declared = applicabilityMap("research memory card applicability", card.applicability);
  const conditions = applicabilityMap("research prior condition", query.conditions ?? []);
  // Fail closed: every supplied critical-condition dimension must be declared,
  // unless the caller explicitly names the dimensions it needs.
  const critical = query.critical ?? [...conditions.keys()].filter((dimension) => RESEARCH_REVALIDATION_DIMENSIONS.includes(dimension));
  for (const dimension of critical) {
    if (!RESEARCH_APPLICABILITY_DIMENSIONS.includes(dimension)) {
      throw new ResearchMemoryError(`research prior critical dimension "${dimension}" is unsupported`);
    }
  }
  const conflicts: ResearchApplicabilityDimension[] = [];
  const unknowns: ResearchApplicabilityDimension[] = [];
  let outOfScope = false;
  for (const [dimension, value] of declared) {
    if (dimension === "mission") {
      if (query.missionId !== undefined && !sameApplicabilityValue(value, query.missionId)) {
        outOfScope = true;
      }
      continue;
    }
    const current = conditions.get(dimension);
    if (current === undefined) {
      unknowns.push(dimension);
    } else if (!sameApplicabilityValue(current, value)) {
      if (SCOPE_DIMENSIONS.has(dimension)) outOfScope = true;
      else conflicts.push(dimension);
    }
  }
  for (const dimension of critical) if (!declared.has(dimension)) unknowns.push(dimension);
  const unique = (dimensions: readonly ResearchApplicabilityDimension[]) =>
    RESEARCH_APPLICABILITY_DIMENSIONS.filter((dimension) => dimensions.includes(dimension));
  const state: ResearchPriorState = outOfScope
    ? "not-applicable"
    : conflicts.length > 0
      ? "conflict"
      : unknowns.length > 0 || declared.size === 0
        ? "unknown"
        : "direct-prior";
  const visible = cardVisibility(card) === "mission";
  return deepFreeze({
    card,
    state,
    conflicts: unique(conflicts),
    unknowns: unique(unknowns),
    visible,
    // Only an active card is reusable: stale/superseded/withdrawn/provisional
    // and contested readings are context, never an authoritative prior.
    directPrior: state === "direct-prior" && card.lifecycle === "active" && visible,
  });
}

/**
 * One deterministic applicability read over ONE verified snapshot. The snapshot's
 * recorded conditions are the history of how it was projected; `query.conditions`
 * are the conditions the CURRENT retrieval runs under.
 */
export function retrieveResearchMemory(
  snapshot: ResearchMemorySnapshot,
  query: ResearchPriorQuery = {},
): ResearchRetrieval {
  const verified = validateResearchMemorySnapshot(snapshot);
  const missionId = verified.missionId;
  return deepFreeze({
    missionId,
    snapshotId: verified.snapshotId,
    snapshotDigest: verified.digest,
    ledgerRevision: verified.ledgerRevision,
    verdicts: verified.cards.map((card) => evaluateResearchApplicability(card, {
      ...query,
      missionId: query.missionId ?? missionId,
    })),
  });
}

/** Rebuilds a persisted/loaded snapshot and fails closed on any corruption. */
export function validateResearchMemorySnapshot(raw: unknown): ResearchMemorySnapshot {
  if (!isRecord(raw)) throw new ResearchMemoryError("research memory snapshot must be an object");
  assertSafeKeys("research memory snapshot field", Object.keys(raw), SNAPSHOT_KEYS);
  if (raw.schema !== RESEARCH_MEMORY_SNAPSHOT_SCHEMA) {
    throw new ResearchMemoryError(`research memory snapshot schema must be ${RESEARCH_MEMORY_SNAPSHOT_SCHEMA}`);
  }
  if (raw.memoryRevision !== RESEARCH_MEMORY_REVISION) {
    throw new ResearchMemoryError(`research memory revision must be ${RESEARCH_MEMORY_REVISION}`);
  }
  if (raw.retrievalPolicyRevision !== RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION) {
    throw new ResearchMemoryError(`research memory retrieval policy revision must be ${RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION}`);
  }
  const missionId = assertMemorySafeText("research memory snapshot missionId", raw.missionId);
  if (typeof raw.ledgerRevision !== "number" || !Number.isInteger(raw.ledgerRevision) || raw.ledgerRevision < 0) {
    throw new ResearchMemoryError("research memory snapshot ledgerRevision must be a non-negative integer");
  }
  if (raw.conditions !== undefined) assertApplicability("research memory snapshot conditions", raw.conditions);
  const maxCards = maxCardsOf(raw.maxCards);
  if (!Array.isArray(raw.cards)) throw new ResearchMemoryError("research memory snapshot cards must be an array");
  if (raw.cards.length > maxCards) throw new ResearchMemoryError("research memory snapshot exceeds its declared card limit");
  if (typeof raw.omittedCardCount !== "number" || !Number.isInteger(raw.omittedCardCount) || raw.omittedCardCount < 0) {
    throw new ResearchMemoryError("research memory snapshot omittedCardCount must be a non-negative integer");
  }
  for (const card of raw.cards) {
    if (!isRecord(card)) throw new ResearchMemoryError("research memory card must be an object");
    if (card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA) {
      assertSafeKeys("research memory card field", Object.keys(card), CARD_KEYS);
      if (card.kind !== "finding") throw new ResearchMemoryError("research memory card schema/kind mismatch");
      assertMemorySafeText("research memory card cardId", card.cardId);
      assertMemorySafeText("research memory card summary", card.summary);
      if (typeof card.ok !== "boolean") throw new ResearchMemoryError("research memory card ok must be a boolean");
      // A snapshot published before #213 carries no outcome; its `ok` is the
      // only reading it ever had, and it is not corruption.
      const outcome = card.outcome ?? (card.ok === true ? "positive" : "negative");
      if (!RUN_OUTCOME_STATES.includes(outcome as RunOutcomeState)) {
        throw new ResearchMemoryError(`research memory card outcome must be one of ${RUN_OUTCOME_STATES.join(", ")}`);
      }
      if (card.failure !== undefined) {
        if (outcome !== "operational" || !RUN_FAILURE_KINDS.includes(card.failure as RunFailureKind)) {
          throw new ResearchMemoryError("a research memory card failure belongs only to an operational outcome");
        }
      } else if (outcome === "operational") {
        throw new ResearchMemoryError("an operational research memory card must name its failure kind");
      }
      assertApplicability("research memory card applicability", card.applicability);
      applyCardLifecycleFields(card);
      textList("research memory card sourceRefs", card.sourceRefs);
      if (!LIFECYCLES.includes(card.lifecycle as ResearchCardLifecycle)) {
        throw new ResearchMemoryError(`research memory card lifecycle must be one of ${LIFECYCLES.join(", ")}`);
      }
      if (card.replication !== undefined) validateReplication(card.replication);
      continue;
    }
    if (card.schema === OPERATIONAL_PITFALL_CARD_SCHEMA) {
      assertSafeKeys("research memory card field", Object.keys(card), OPERATIONAL_PITFALL_CARD_KEYS);
      if (card.kind !== "pitfall") throw new ResearchMemoryError("research memory card schema/kind mismatch");
      if (!RUN_FAILURE_KINDS.includes(card.failure as RunFailureKind)) {
        throw new ResearchMemoryError(`research memory pitfall failure must be one of ${RUN_FAILURE_KINDS.join(", ")}`);
      }
      textList("research memory card conditions", card.conditions);
      assertMemorySafeText("research memory card cardId", card.cardId);
      assertMemorySafeText("research memory card summary", card.summary);
      assertApplicability("research memory card applicability", card.applicability);
      applyCardLifecycleFields(card);
      textList("research memory card sourceRefs", card.sourceRefs);
      if (!LIFECYCLES.includes(card.lifecycle as ResearchCardLifecycle)) {
        throw new ResearchMemoryError(`research memory card lifecycle must be one of ${LIFECYCLES.join(", ")}`);
      }
      continue;
    }
    if (card.schema === RESEARCH_CONTROL_CARD_SCHEMA) {
      assertSafeKeys("research memory control card field", Object.keys(card), CONTROL_CARD_KEYS);
      if (card.kind !== "finding" && card.kind !== "hypothesis" && card.kind !== "pitfall") {
        throw new ResearchMemoryError("research memory control card kind must be finding, hypothesis or pitfall");
      }
      assertMemorySafeText("research memory control card cardId", card.cardId);
      assertMemorySafeText("research memory control card summary", card.summary);
      // A control slot carries no fact, no ref and no advice: only an empty
      // declared/applicability surface is a valid Schema-only Sham input.
      if (!Array.isArray(card.applicability) || card.applicability.length !== 0) {
        throw new ResearchMemoryError("a research memory control card declares no applicability");
      }
      if (!Array.isArray(card.sourceRefs) || card.sourceRefs.length !== 0) {
        throw new ResearchMemoryError("a research memory control card carries no refs");
      }
      if (card.lifecycle !== "provisional") throw new ResearchMemoryError("a research memory control card stays provisional");
      if (card.control !== "sham") throw new ResearchMemoryError("a research memory control card must be marked as control input");
      continue;
    }
    validateSynthesisCard(card);
  }
  const { digest, snapshotId, ...body } = raw;
  const expected = digestValue(body);
  if (digest !== expected) throw new ResearchMemoryError("research memory snapshot digest mismatch");
  if (snapshotId !== snapshotIdFor(expected)) throw new ResearchMemoryError("research memory snapshot id does not match its digest");
  return deepFreeze({ ...body, missionId, maxCards, snapshotId: snapshotId as string, digest: digest as string } as ResearchMemorySnapshot);
}

export function summarizeResearchMemorySnapshot(snapshot: ResearchMemorySnapshot): ResearchMemorySummary {
  const controlCards = snapshot.cards.filter((card) => card.schema === RESEARCH_CONTROL_CARD_SCHEMA).length;
  // Control slots are presentation, not research cards; they are counted apart.
  const cards = snapshot.cards.filter((card) => card.schema !== RESEARCH_CONTROL_CARD_SCHEMA);
  const hypothesis = cards.filter((card) => card.kind === "hypothesis").length;
  const pitfall = cards.filter((card) => card.schema === SYNTHESIS_PITFALL_CARD_SCHEMA).length;
  const operationalPitfall = cards.filter((card) => card.schema === OPERATIONAL_PITFALL_CARD_SCHEMA).length;
  return deepFreeze({
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.digest,
    ledgerRevision: snapshot.ledgerRevision,
    cards: {
      finding: cards.filter((card) => card.kind === "finding").length,
      ...(hypothesis > 0 ? { hypothesis } : {}),
      ...(pitfall > 0 ? { pitfall } : {}),
      ...(operationalPitfall > 0 ? { operationalPitfall } : {}),
    },
    omittedCards: snapshot.omittedCardCount,
    ...(controlCards > 0 ? { controlCards } : {}),
  });
}

/** Replication context is advisory: it can never be a rejection or a veto. */
function validateReplication(raw: unknown): void {
  if (!isRecord(raw)) throw new ResearchMemoryError("research memory replication context must be an object");
  assertSafeKeys("research memory replication field", Object.keys(raw), REPLICATION_KEYS);
  assertMemorySafeText("research memory replication objective", raw.objective);
  const priorRunIds = textList("research memory replication priorRunIds", raw.priorRunIds);
  if (priorRunIds.length === 0) throw new ResearchMemoryError("replication context needs at least one prior Run");
  const outcomes = textList("research memory replication priorOutcomes", raw.priorOutcomes);
  if (outcomes.length !== priorRunIds.length || outcomes.some((outcome) => !RUN_OUTCOME_STATES.includes(outcome as RunOutcomeState))) {
    throw new ResearchMemoryError("replication prior outcomes must match its prior Runs");
  }
  if (raw.advisory !== true) throw new ResearchMemoryError("replication context is advisory; it can never be a rejection");
}

/** Lineage and the revalidation marker are read-only facts, never authority. */
function applyCardLifecycleFields(card: Record<string, unknown>): void {
  if (card.revalidationRequired !== undefined && card.revalidationRequired !== true) {
    throw new ResearchMemoryError("research memory revalidationRequired is a fixed marker");
  }
  if (card.lineage === undefined) return;
  if (!isRecord(card.lineage)) throw new ResearchMemoryError("research memory card lineage must be an object");
  assertSafeKeys("research memory card lineage field", Object.keys(card.lineage), LINEAGE_KEYS);
  const { revision, derivesFrom, supersedes, supersededBy } = card.lineage;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1)) {
    throw new ResearchMemoryError("research memory card lineage revision must be a positive integer");
  }
  if (derivesFrom !== undefined) textList("research memory card lineage derivesFrom", derivesFrom);
  if (supersedes !== undefined) textList("research memory card lineage supersedes", supersedes);
  if (supersededBy !== undefined) {
    assertMemorySafeText("research memory card lineage supersededBy", supersededBy);
    if (supersededBy === card.cardId) throw new ResearchMemoryError("a card can never supersede itself");
  }
}

/** Validates one card derived from a stored Proposal; it is never "verified". */
function validateSynthesisCard(card: Record<string, unknown>): void {
  let keys: ReadonlySet<string>;
  let kind: string;
  if (card.schema === SYNTHESIS_HYPOTHESIS_CARD_SCHEMA) {
    keys = HYPOTHESIS_CARD_KEYS;
    kind = "hypothesis";
  } else if (card.schema === SYNTHESIS_FINDING_CARD_SCHEMA) {
    keys = SYNTHESIS_FINDING_CARD_KEYS;
    kind = "finding";
  } else if (card.schema === SYNTHESIS_PITFALL_CARD_SCHEMA) {
    keys = PITFALL_CARD_KEYS;
    kind = "pitfall";
  } else {
    throw new ResearchMemoryError("research memory card schema/kind mismatch");
  }
  assertSafeKeys("research memory card field", Object.keys(card), keys);
  if (card.kind !== kind) throw new ResearchMemoryError("research memory card schema/kind mismatch");
  assertMemorySafeText("research memory card cardId", card.cardId);
  assertMemorySafeText("research memory card summary", card.summary);
  assertApplicability("research memory card applicability", card.applicability);
  applyCardLifecycleFields(card);
  textList("research memory card sourceRefs", card.sourceRefs);
  if (!LIFECYCLES.includes(card.lifecycle as ResearchCardLifecycle)) {
    throw new ResearchMemoryError(`research memory card lifecycle must be one of ${LIFECYCLES.join(", ")}`);
  }
  if (card.visibility !== "mission") {
    throw new ResearchMemoryError("research memory card visibility can never exceed its Mission");
  }
  if (card.epistemicStatus !== "unverified") {
    throw new ResearchMemoryError("research memory synthesis card must stay unverified; storage never verifies a Proposal");
  }
  if (kind === "hypothesis") {
    textList("research memory card supportingRefs", card.supportingRefs);
    textList("research memory card contradictingRefs", card.contradictingRefs);
    textList("research memory card competingRefs", card.competingRefs);
    textList("research memory card unknowns", card.unknowns);
    if (card.nextValidation !== undefined) {
      if (!isRecord(card.nextValidation)
        || Object.keys(card.nextValidation).sort().join(",") !== "advisory,objective"
        || card.nextValidation.advisory !== true) {
        throw new ResearchMemoryError("research memory next-validation suggestion must be advisory-only");
      }
      assertMemorySafeText("research memory card nextValidation objective", card.nextValidation.objective);
    }
    return;
  }
  if (kind === "finding") {
    textList("research memory card limitations", card.limitations);
    return;
  }
  textList("research memory card conditions", card.conditions);
  assertMemorySafeText("research memory card avoidance", card.avoidance);
}
