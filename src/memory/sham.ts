/**
 * Research Memory Sham control projection (M1-T9): Schema-only slots that
 * occupy the same structural position as real cards while carrying no research
 * fact, no ref, no applicability and no directional advice.
 *
 * Kept out of `projection.ts` so a control input can never be produced by
 * accident, and marked `control: "sham"` so no reader can mistake it for
 * Research Memory.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import {
  RESEARCH_CONTROL_CARD_SCHEMA,
  ResearchMemoryError,
  snapshotIdFor,
  validateResearchMemorySnapshot,
  type ResearchControlCard,
  type ResearchDecisionPacket,
  type ResearchMemoryCard,
  type ResearchMemorySnapshot,
} from "./schema";

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
