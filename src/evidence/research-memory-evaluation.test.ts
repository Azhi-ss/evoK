/**
 * M1-T9: the Schema-only Sham projection and the trusted arm selector.
 *
 * These are unit-level proofs of the projection algebra: a Sham carries exactly
 * the structural shape of the real projection (same card count, order, kinds,
 * bounds and omission counts) while carrying no research fact, Evidence ref, or
 * directional advice, and it is marked as a control input.
 */
import { describe, expect, test } from "bun:test";
import {
  RESEARCH_CONTROL_CARD_SCHEMA,
  RESEARCH_MEMORY_EVALUATION_MODES,
  ResearchMemoryError,
  assertPacketCardRefs,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  researchMemoryModeOf,
  shamResearchDecisionPacket,
  shamResearchMemorySnapshot,
  summarizeResearchMemorySnapshot,
  validateResearchMemorySnapshot,
  type ResearchMemorySnapshot,
  type ResearchMemorySource,
} from "../memory";

function source(overrides: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-eval",
    ledgerRevision: 4,
    conditions: ["evaluation:file-answer-deterministic"],
    maxCards: 8,
    runs: [
      { runId: "m-eval:baseline:1", ok: true, score: 0.75, evidenceRefs: ["evidence:baseline-impact"] },
      {
        runId: "m-eval:exp:1",
        taskId: "task-exp-1",
        taskObjective: "materialize answer.txt with the new kernel",
        ok: false,
        score: 0.2,
        ruleViolations: ["below the acceptance threshold"],
        evidenceRefs: ["evidence:exp-1-impact"],
      },
    ],
    ...overrides,
  };
}

function realSnapshot(): ResearchMemorySnapshot {
  return projectResearchMemorySnapshot(source());
}

describe("Research Memory evaluation arm selection (M1-T9 AC1)", () => {
  test("the trusted configuration selects exactly one arm", () => {
    expect(RESEARCH_MEMORY_EVALUATION_MODES).toEqual(["off", "sham", "real"]);
    expect(researchMemoryModeOf(undefined)).toBe("real");
    expect(researchMemoryModeOf(true)).toBe("real");
    expect(researchMemoryModeOf("real")).toBe("real");
    expect(researchMemoryModeOf("sham")).toBe("sham");
    expect(researchMemoryModeOf("off")).toBe("off");
    expect(researchMemoryModeOf(false)).toBe("off");
  });

  test("an unknown arm fails closed instead of silently choosing one", () => {
    for (const value of ["Real", "memory-on", 1, {}, null]) {
      expect(() => researchMemoryModeOf(value)).toThrow(ResearchMemoryError);
    }
  });
});

describe("Schema-only Sham projection (M1-T9 AC2)", () => {
  test("it matches card structure, kinds, order and bounds but carries no research content", () => {
    const real = realSnapshot();
    const sham = shamResearchMemorySnapshot(real);

    expect(sham.missionId).toBe(real.missionId);
    expect(sham.ledgerRevision).toBe(real.ledgerRevision);
    expect(sham.maxCards).toBe(real.maxCards);
    expect(sham.omittedCardCount).toBe(real.omittedCardCount);
    expect(sham.conditions).toEqual(real.conditions);
    expect(sham.cards.map((card) => card.kind)).toEqual(real.cards.map((card) => card.kind));
    expect(sham.cards.length).toBe(real.cards.length);

    for (const card of sham.cards) {
      if (card.schema !== RESEARCH_CONTROL_CARD_SCHEMA) throw new Error("expected a control card");
      expect(card.control).toBe("sham");
      expect(card.applicability).toEqual([]);
      expect(card.sourceRefs).toEqual([]);
      expect(card.lifecycle).toBe("provisional");
    }
    // No research fact, Evidence ref or directional advice survives.
    const body = JSON.stringify(sham.cards);
    for (const leak of ["m-eval:baseline:1", "m-eval:exp:1", "evidence:", "0.75", "0.2", "kernel", "threshold"]) {
      expect(body).not.toContain(leak);
    }
  });

  test("a Sham snapshot is a valid snapshot with its own content address", () => {
    const real = realSnapshot();
    const sham = shamResearchMemorySnapshot(real);
    expect(sham.digest).not.toBe(real.digest);
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(sham)))).toEqual(sham);
    // Control slots are counted apart from research cards in the status summary.
    const summary = summarizeResearchMemorySnapshot(sham);
    expect(summary.cards.finding).toBe(0);
    expect(summary.controlCards).toBe(sham.cards.length);
    expect(summarizeResearchMemorySnapshot(real).controlCards).toBeUndefined();
  });

  test("a Sham snapshot fails closed if it carries a fact, a ref or a claim", () => {
    const sham = shamResearchMemorySnapshot(realSnapshot());
    const tampered = JSON.parse(JSON.stringify(sham)) as { cards: Record<string, unknown>[] };
    tampered.cards[0]!.sourceRefs = ["evidence:leak"];
    expect(() => validateResearchMemorySnapshot(tampered)).toThrow(ResearchMemoryError);
    const unmarked = JSON.parse(JSON.stringify(sham)) as { cards: Record<string, unknown>[] };
    delete unmarked.cards[0]!.control;
    expect(() => validateResearchMemorySnapshot(unmarked)).toThrow(ResearchMemoryError);
  });

  test("the Sham decision packet keeps bounds and omission counts but leaks no reserved category", () => {
    const real = realSnapshot();
    const packet = projectResearchDecisionPacket(real);
    const sham = shamResearchDecisionPacket(packet);

    expect(sham.control).toBe("sham");
    expect(sham.snapshotId).toBe(packet.snapshotId);
    expect(sham.snapshotDigest).toBe(packet.snapshotDigest);
    expect(sham.truncated).toBe(packet.truncated);
    expect(sham.omittedCardCount).toBe(packet.omittedCardCount);
    expect(sham.omissions).toEqual(packet.omissions);
    expect(sham.cards.length).toBe(packet.cards.length);
    expect(sham.cards.every((card) => card.schema === RESEARCH_CONTROL_CARD_SCHEMA)).toBe(true);
    // Naming WHICH cards contradict or compete would leak directional research
    // state, so the control packet keeps the counts but no reserved ids.
    expect(sham.reserved).toEqual({ contradictingEvidence: [], competingHypotheses: [] });
    expect(packet.reserved.contradictingEvidence.length + packet.reserved.competingHypotheses.length).toBeGreaterThan(0);
    const delivered = new Set(sham.cards.map((card) => card.cardId));
    expect(() => assertPacketCardRefs(sham, [...delivered])).not.toThrow();
    // Deterministic: the same packet always yields the same control packet.
    expect(shamResearchDecisionPacket(packet)).toEqual(sham);
  });

  test("a truncated packet stays truncated after the Sham transform", () => {
    const real = projectResearchMemorySnapshot(source({ maxCards: 1 }));
    const packet = projectResearchDecisionPacket(real);
    const sham = shamResearchDecisionPacket(packet);
    expect(packet.truncated).toBe(true);
    expect(sham.truncated).toBe(true);
    expect(sham.cards.length).toBe(1);
    expect(sham.omittedCardCount).toBe(packet.omittedCardCount);
  });
});
