/**
 * Mission Research Memory: the bounded, deterministic projection of the
 * authoritative Mission history into agent-readable reading cards (M1-T1 / #210).
 *
 * Derived, never authoritative: the Mission record stays the only write log,
 * and a snapshot can be rebuilt from it at any time. Cards carry identities,
 * bounded summaries, applicability labels and typed source refs — never
 * transcripts, artifact bodies, credentials, holdouts, or restricted content.
 */
import { deepFreeze, digestValue } from "../security-boundary";
import type { SynthesisProposal } from "./synthesis-proposal";

export const RESEARCH_MEMORY_SNAPSHOT_SCHEMA = "evok.research-memory-snapshot/v1" as const;
export const RESEARCH_MEMORY_FINDING_CARD_SCHEMA = "evok.research-memory-finding-card/v1" as const;
/** M1-T3: reading cards projected from accepted (unverified) Synthesis Proposals. */
export const SYNTHESIS_HYPOTHESIS_CARD_SCHEMA = "evok.research-memory-hypothesis-card/v1" as const;
export const SYNTHESIS_FINDING_CARD_SCHEMA = "evok.research-memory-synthesis-finding-card/v1" as const;
export const SYNTHESIS_PITFALL_CARD_SCHEMA = "evok.research-memory-pitfall-card/v1" as const;
export const RESEARCH_MEMORY_REVISION = "research-memory/v1" as const;
export const RESEARCH_DECISION_PACKET_SCHEMA = "evok.research-decision-packet/v1" as const;
export const RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION = "research-memory-retrieval/v1" as const;
/** Hard retrieval bound; trusted policy may lower it, never trust an absent value. */
export const RESEARCH_MEMORY_DEFAULT_MAX_CARDS = 8;
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

/** One measured (or failed) Mission Run as the projection sees it. */
export interface ResearchRunFinding {
  readonly runId: string;
  readonly taskId?: string;
  readonly ok: boolean;
  readonly score?: number;
  readonly ruleViolations?: readonly string[];
  readonly negativeEvidence?: boolean;
  readonly error?: string;
  readonly evidenceRefs: readonly string[];
  readonly snapshotDigest?: string;
}

/** The trusted Mission projection a snapshot is derived from. */
export interface ResearchMemorySource {
  readonly missionId: string;
  readonly ledgerRevision: number;
  readonly runs: readonly ResearchRunFinding[];
  /** Already validated, `accepted_for_storage` proposals from Mission history. */
  readonly proposals?: readonly SynthesisProposal[];
  readonly maxCards?: number;
}

/** A presentation projection of one Finding; not a new authoritative entity. */
export interface ResearchFindingCard {
  readonly schema: typeof RESEARCH_MEMORY_FINDING_CARD_SCHEMA;
  readonly cardId: string;
  readonly kind: "finding";
  readonly summary: string;
  readonly ok: boolean;
  readonly applicability: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly lifecycle: ResearchCardLifecycle;
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

export type ResearchMemoryCard =
  | ResearchFindingCard
  | ResearchHypothesisCard
  | ResearchSynthesisFindingCard
  | ResearchPitfallCard;

export interface ResearchMemorySnapshot {
  readonly schema: typeof RESEARCH_MEMORY_SNAPSHOT_SCHEMA;
  readonly missionId: string;
  readonly snapshotId: string;
  readonly ledgerRevision: number;
  readonly memoryRevision: typeof RESEARCH_MEMORY_REVISION;
  readonly retrievalPolicyRevision: typeof RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION;
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
  readonly omittedCardCount: number;
  readonly digest: string;
}

/** Read-only Mission status projection: no card bodies, no restricted refs. */
export interface ResearchMemorySummary {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly ledgerRevision: number;
  readonly cards: {
    readonly finding: number;
    readonly hypothesis?: number;
    readonly pitfall?: number;
  };
  readonly omittedCards: number;
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
  "retrievalPolicyRevision", "maxCards", "cards", "omittedCardCount", "digest",
]);
const CARD_KEYS = new Set(["schema", "cardId", "kind", "summary", "ok", "applicability", "sourceRefs", "lifecycle"]);
const SYNTHESIS_CARD_BASE_KEYS = [
  "schema", "cardId", "kind", "summary", "applicability", "sourceRefs", "lifecycle", "visibility", "epistemicStatus",
];
const HYPOTHESIS_CARD_KEYS = new Set([
  ...SYNTHESIS_CARD_BASE_KEYS, "supportingRefs", "contradictingRefs", "competingRefs", "unknowns", "nextValidation",
]);
const SYNTHESIS_FINDING_CARD_KEYS = new Set([...SYNTHESIS_CARD_BASE_KEYS, "limitations"]);
const PITFALL_CARD_KEYS = new Set([...SYNTHESIS_CARD_BASE_KEYS, "conditions", "avoidance"]);
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

function cardFor(run: ResearchRunFinding, missionId: string): ResearchFindingCard {
  const outcome = run.error !== undefined
    ? `dispatch failed: ${bounded(run.error)}`
    : run.ok
      ? `measured ok=true${typeof run.score === "number" ? ` score=${run.score}` : ""}`
      : `measured ok=false${run.ruleViolations?.length ? ` rules=${bounded(run.ruleViolations.join("; "))}` : ""}`;
  const summary = bounded(`run ${run.runId} ${outcome}${run.negativeEvidence ? " (negative evidence)" : ""}`);
  const applicability = run.taskId ? `task:${run.taskId}` : `mission:${missionId}`;
  const body = {
    schema: RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
    cardId: `finding:${run.runId}`,
    kind: "finding" as const,
    summary,
    ok: run.ok,
    applicability: [assertMemorySafeText("research memory applicability", applicability)],
    sourceRefs: [...run.evidenceRefs],
    lifecycle: (run.ok ? "active" : "contested") as ResearchCardLifecycle,
  };
  // Sensitivity applies to the summary as well as to every label/ref.
  assertMemorySafeText("research memory card summary", body.summary);
  return deepFreeze(body);
}

/**
 * Deterministically projects Mission history into a bounded snapshot. Same
 * source (per card limit) → byte-identical snapshot id and digest, regardless
 * of run ordering; a changed ledger revision or card changes the digest.
 */
export function projectResearchMemorySnapshot(source: ResearchMemorySource): ResearchMemorySnapshot {
  if (!isRecord(source)) throw new ResearchMemoryError("research memory source must be an object");
  assertSafeKeys("research memory source field", Object.keys(source), new Set(["missionId", "ledgerRevision", "runs", "proposals", "maxCards"]));
  const missionId = assertMemorySafeText("research memory missionId", source.missionId);
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
      new Set(["runId", "taskId", "ok", "score", "ruleViolations", "negativeEvidence", "error", "evidenceRefs", "snapshotDigest"]));
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
      ok: run.ok,
      ...(typeof run.score === "number" ? { score: run.score } : {}),
      ...(run.ruleViolations !== undefined ? { ruleViolations: textList("research memory ruleViolations", run.ruleViolations) } : {}),
      ...(run.negativeEvidence === true ? { negativeEvidence: true } : {}),
      ...(run.error !== undefined ? { error: assertMemorySafeText("research memory error", run.error) } : {}),
      evidenceRefs: textList("research memory evidenceRefs", run.evidenceRefs),
      ...(run.snapshotDigest !== undefined ? { snapshotDigest: assertMemorySafeText("research memory snapshotDigest", run.snapshotDigest) } : {}),
    });
  }

  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const proposalCards = new Map<string, ResearchMemoryCard>();
  for (const proposal of source.proposals ?? []) {
    const card = synthesisCardFor(proposal);
    if (!proposalCards.has(card.cardId)) proposalCards.set(card.cardId, card);
  }
  const ordered = [...proposalCards.values()].sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  // Synthesised reading cards are kept ahead of run summary cards: a bounded
  // packet must not lose the competing/contradicting position to sheer Run volume.
  const cards = [...ordered, ...runs.map((run) => cardFor(run, missionId))].slice(0, maxCards);
  const body = {
    schema: RESEARCH_MEMORY_SNAPSHOT_SCHEMA,
    missionId,
    ledgerRevision,
    memoryRevision: RESEARCH_MEMORY_REVISION,
    retrievalPolicyRevision: RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION,
    maxCards,
    cards,
    omittedCardCount: runs.length + ordered.length - cards.length,
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
      return deepFreeze({
        ...base,
        schema: SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
        kind: "hypothesis" as const,
        supportingRefs: proposal.supportingRefs.map(refKey),
        contradictingRefs: proposal.contradictingRefs.map(refKey),
        competingRefs: proposal.competingRefs.map(refKey),
        unknowns: [...proposal.unknowns],
        ...(proposal.nextValidation !== undefined ? { nextValidation: { ...proposal.nextValidation } } : {}),
      });
    case "finding":
      return deepFreeze({
        ...base,
        schema: SYNTHESIS_FINDING_CARD_SCHEMA,
        kind: "finding" as const,
        limitations: [...proposal.limitations],
      });
    case "pitfall":
      return deepFreeze({
        ...base,
        schema: SYNTHESIS_PITFALL_CARD_SCHEMA,
        kind: "pitfall" as const,
        conditions: [...proposal.conditions],
        avoidance: bounded(assertMemorySafeText("research memory card avoidance", proposal.rationale)),
      });
  }
}

/**
 * Projects the decision packet from ONE verified snapshot. The packet is
 * deterministic for the same snapshot and card limit, and can only ever carry
 * cards that snapshot already published.
 */
export function projectResearchDecisionPacket(
  snapshot: ResearchMemorySnapshot,
  options: { readonly maxCards?: number } = {},
): ResearchDecisionPacket {
  const verified = validateResearchMemorySnapshot(snapshot);
  const limit = options.maxCards === undefined
    ? verified.maxCards
    : Math.min(maxCardsOf(options.maxCards), verified.maxCards);
  const cards = verified.cards.slice(0, limit);
  const body = {
    schema: RESEARCH_DECISION_PACKET_SCHEMA,
    missionId: verified.missionId,
    snapshotId: verified.snapshotId,
    snapshotDigest: verified.digest,
    ledgerRevision: verified.ledgerRevision,
    cards,
    omittedCardCount: verified.omittedCardCount + (verified.cards.length - cards.length),
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
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
      textList("research memory card applicability", card.applicability);
      textList("research memory card sourceRefs", card.sourceRefs);
      if (!LIFECYCLES.includes(card.lifecycle as ResearchCardLifecycle)) {
        throw new ResearchMemoryError(`research memory card lifecycle must be one of ${LIFECYCLES.join(", ")}`);
      }
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
  const hypothesis = snapshot.cards.filter((card) => card.kind === "hypothesis").length;
  const pitfall = snapshot.cards.filter((card) => card.kind === "pitfall").length;
  return deepFreeze({
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.digest,
    ledgerRevision: snapshot.ledgerRevision,
    cards: {
      finding: snapshot.cards.filter((card) => card.kind === "finding").length,
      ...(hypothesis > 0 ? { hypothesis } : {}),
      ...(pitfall > 0 ? { pitfall } : {}),
    },
    omittedCards: snapshot.omittedCardCount,
  });
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
  textList("research memory card applicability", card.applicability);
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
