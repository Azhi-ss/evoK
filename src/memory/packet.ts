/**
 * Research Memory decision packet: the bounded CONTEXT one Memory-informed
 * decision stage receives, projected from exactly ONE already-published
 * snapshot.
 *
 * A packet is a presentation projection, never a store: it can only ever carry
 * cards that its snapshot already published, keeps the reserved
 * contradicting-Evidence and competing-Hypothesis categories ahead of support
 * (#215), and explains every omission it makes.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import {
  RESEARCH_DECISION_PACKET_SCHEMA,
  isCompetingHypothesisCard,
  isContradictingEvidenceCard,
  ResearchMemoryError,
  maxCardsOf,
  validateResearchMemorySnapshot,
  type ResearchDecisionPacket,
  type ResearchMemoryCard,
  type ResearchMemorySnapshot,
} from "./schema";

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

/** Used Memory refs must belong to the delivered packet, never another one. */
export function assertPacketCardRefs(packet: ResearchDecisionPacket, usedRefs: readonly string[]): void {
  const delivered = new Set(packet.cards.map((card) => card.cardId));
  for (const ref of usedRefs) {
    if (!delivered.has(ref)) {
      throw new ResearchMemoryError(`Memory ref "${ref}" is not part of the delivered packet`);
    }
  }
}
