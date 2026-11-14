/**
 * Research Memory schemas: card, snapshot and packet shapes, the revisions and
 * bounds they are validated against, and the digest/content-address rules.
 *
 * Derived, never authoritative: Mission history stays the only write log, and
 * a snapshot can be rebuilt from it at any time. Cards carry identities,
 * bounded summaries, applicability labels and typed source refs — never
 * transcripts, artifact bodies, credentials, holdouts, or restricted content.
 *
 * Physical home: `src/memory/` (ADR-0016). This module owns no write path to
 * Mission history.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import {
  RUN_FAILURE_KINDS,
  RUN_OUTCOME_STATES,
  type RunFailureKind,
  type RunOutcomeState,
} from "../evidence/run-outcome";
import type { SynthesisProposal } from "../evidence/synthesis-proposal";

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

/** A changed value here invalidates an earlier conclusion: stale, revalidation required. */
export const RESEARCH_REVALIDATION_DIMENSIONS: readonly ResearchApplicabilityDimension[] = [
  "objective", "evaluation", "dataset", "method", "runtime", "contract",
];

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

export const WITHDRAWAL_KEYS = new Set(["cardId", "reason"]);

const REPLICATION_KEYS = new Set(["objective", "priorRunIds", "priorOutcomes", "advisory"]);

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shared boundary for any evidence-layer text that can reach agent memory. */
export function assertMemorySafeText(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ResearchMemoryError(`${label} is required`);
  if (SECRET_LIKE.test(value)) throw new ResearchMemoryError(`${label} contains a secret-like value and can never enter agent memory`);
  return value;
}

export function textList(label: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ResearchMemoryError(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => assertMemorySafeText(label, entry));
}

export function assertSafeKeys(label: string, keys: readonly string[], allowed?: ReadonlySet<string>): void {
  for (const key of keys) {
    if (SENSITIVE_KEYS.has(canonicalKey(key))) {
      throw new ResearchMemoryError(`${label} "${key}" is sensitive and can never enter agent memory`);
    }
    if (allowed && !allowed.has(key)) throw new ResearchMemoryError(`${label} has unsupported field "${key}"`);
  }
}

/** Applicability values compare normalized; the stored text is kept verbatim. */
export function normalizedApplicability(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The one comparison rule for every declared-versus-current decision. */
export function sameApplicabilityValue(left: string, right: string): boolean {
  return normalizedApplicability(left) === normalizedApplicability(right);
}

/** Parses `dimension:value` pairs; an unknown dimension fails closed. */
export function applicabilityMap(
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

export function maxCardsOf(value: unknown): number {
  const max = value === undefined ? RESEARCH_MEMORY_DEFAULT_MAX_CARDS : value;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_CARDS_CEILING) {
    throw new ResearchMemoryError(`research memory maxCards must be an integer in [1, ${MAX_CARDS_CEILING}]; missing or invalid limits fail closed`);
  }
  return max;
}

export function snapshotIdFor(digest: string): string {
  return `research-memory:${digest}`;
}

/** A measured refutation is Evidence that contradicts a supporting position. */
export function isContradictingEvidenceCard(card: ResearchMemoryCard): boolean {
  if (card.kind !== "finding" || card.schema !== RESEARCH_MEMORY_FINDING_CARD_SCHEMA) return false;
  // A card published before #213 carries no outcome; validation reads its `ok`
  // as the only outcome it ever had, so the same reading applies here.
  return (card.outcome ?? (card.ok ? "positive" : "negative")) === "negative";
}

/** A Hypothesis with a declared competitor, or one already contested by it. */
export function isCompetingHypothesisCard(card: ResearchMemoryCard): boolean {
  return card.schema === SYNTHESIS_HYPOTHESIS_CARD_SCHEMA
    && (card.competingRefs.length > 0 || card.lifecycle === "contested");
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
