/**
 * Research Memory projection: the deterministic, pure projection of Mission
 * history into a bounded snapshot of reading cards, plus the applicability and
 * retrieval reads over one already-published snapshot.
 *
 * Derived, never authoritative: nothing here writes Mission history, and the
 * same source always produces the same snapshot id and digest.
 *
 * Two reads are deliberately different (#214): a Decision Packet (`packet.ts`)
 * is bounded research CONTEXT and keeps competing/contradicting history even
 * when it is not directly applicable, while `retrieveResearchMemory` answers
 * "which card may be REUSED as a direct prior under these conditions". Neither
 * read grants authority, and neither can widen visibility.
 */
import { deepFreeze, digestValue } from "../security-boundary";
import { classifyRunOutcome, type RunOutcomeState } from "../evidence/run-outcome";
import type { SynthesisProposal } from "../evidence/synthesis-proposal";
import {
  OPERATIONAL_PITFALL_CARD_SCHEMA,
  RESEARCH_APPLICABILITY_DIMENSIONS,
  RESEARCH_MEMORY_DEFAULT_MAX_CARDS,
  RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
  RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION,
  RESEARCH_MEMORY_REVISION,
  RESEARCH_MEMORY_SNAPSHOT_SCHEMA,
  RESEARCH_REVALIDATION_DIMENSIONS,
  ResearchMemoryError,
  SYNTHESIS_FINDING_CARD_SCHEMA,
  SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
  SYNTHESIS_PITFALL_CARD_SCHEMA,
  WITHDRAWAL_KEYS,
  applicabilityMap,
  assertMemorySafeText,
  assertSafeKeys,
  isCompetingHypothesisCard,
  isContradictingEvidenceCard,
  isRecord,
  maxCardsOf,
  normalizedApplicability,
  sameApplicabilityValue,
  snapshotIdFor,
  textList,
  validateResearchMemorySnapshot,
  type ResearchApplicabilityDimension,
  type ResearchCardLifecycle,
  type ResearchCardLineage,
  type ResearchFindingCard,
  type ResearchMemoryCard,
  type ResearchMemorySnapshot,
  type ResearchMemorySource,
  type ResearchOperationalPitfallCard,
  type ResearchPriorQuery,
  type ResearchPriorState,
  type ResearchPriorVerdict,
  type ResearchReplicationContext,
  type ResearchRetrieval,
  type ResearchRunFinding,
} from "./schema";

const MAX_SUMMARY_LENGTH = 240;

/** Scope dimensions answer "is this about my Task at all", not a scientific conflict. */
const SCOPE_DIMENSIONS: ReadonlySet<ResearchApplicabilityDimension> = new Set(["mission", "task"]);

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

const LIFECYCLE_FOR: Readonly<Record<RunOutcomeState, ResearchCardLifecycle>> = {
  positive: "active",
  negative: "contested",
  operational: "provisional",
};

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
