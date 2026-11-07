import { describe, expect, test } from "bun:test";
import {
  RESEARCH_MEMORY_DEFAULT_MAX_CARDS,
  ResearchMemoryError,
  projectResearchMemorySnapshot,
  summarizeResearchMemorySnapshot,
  validateResearchMemorySnapshot,
  type ResearchMemorySource,
} from "./research-memory";

function source(overrides: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-memory",
    ledgerRevision: 3,
    runs: [
      { runId: "m-memory:baseline:1", ok: true, score: 0.75, evidenceRefs: ["runs/m-memory:baseline:1/result.json"] },
      {
        runId: "m-memory:exp:2",
        ok: false,
        ruleViolations: ["answer.txt is missing"],
        negativeEvidence: true,
        evidenceRefs: ["runs/m-memory:exp:2/result.json"],
      },
    ],
    ...overrides,
  };
}

describe("research memory projection (#210)", () => {
  test("is deterministic and order-independent for the same Mission history", () => {
    const first = projectResearchMemorySnapshot(source());
    const second = projectResearchMemorySnapshot(source());
    const reordered = projectResearchMemorySnapshot(source({ runs: [...source().runs].reverse() }));

    expect(second).toEqual(first);
    expect(reordered.digest).toBe(first.digest);
    expect(reordered.snapshotId).toBe(first.snapshotId);
    expect(first.snapshotId).toBe(`research-memory:${first.digest}`);
    // Sorted by runId, not input order.
    expect(first.cards.map((card) => card.cardId)).toEqual(["finding:m-memory:baseline:1", "finding:m-memory:exp:2"]);
  });

  test("a changed ledger revision or observation changes the content address", () => {
    const base = projectResearchMemorySnapshot(source());
    expect(projectResearchMemorySnapshot(source({ ledgerRevision: 4 })).digest).not.toBe(base.digest);
    expect(projectResearchMemorySnapshot(source({
      runs: [{ ...source().runs[0]!, score: 0.5 }],
    })).digest).not.toBe(base.digest);
  });

  test("retrieval is bounded with an explicit omission count", () => {
    const runs = Array.from({ length: RESEARCH_MEMORY_DEFAULT_MAX_CARDS + 3 }, (_, index) => ({
      runId: `m-memory:exp:${index + 2}`,
      ok: true,
      evidenceRefs: [`runs/exp-${index + 2}/result.json`],
    }));
    const snapshot = projectResearchMemorySnapshot(source({ runs }));
    expect(snapshot.cards).toHaveLength(RESEARCH_MEMORY_DEFAULT_MAX_CARDS);
    expect(snapshot.omittedCardCount).toBe(3);

    const narrow = projectResearchMemorySnapshot(source({ runs, maxCards: 2 }));
    expect(narrow.cards).toHaveLength(2);
    expect(narrow.omittedCardCount).toBe(runs.length - 2);
    // A stricter limit is part of the content address and the status summary.
    expect(narrow.digest).not.toBe(snapshot.digest);
    expect(summarizeResearchMemorySnapshot(narrow)).toEqual({
      snapshotId: narrow.snapshotId,
      snapshotDigest: narrow.digest,
      ledgerRevision: 3,
      cards: { finding: 2 },
      omittedCards: runs.length - 2,
    });
  });

  test("missing or invalid limits fail closed", () => {
    for (const maxCards of [0, -1, 1.5, Number.NaN, 10_000, "8" as unknown as number]) {
      expect(() => projectResearchMemorySnapshot(source({ maxCards }))).toThrow(ResearchMemoryError);
    }
  });

  test("cards carry bounded summaries and typed refs, never transcripts or bodies", () => {
    const card = projectResearchMemorySnapshot(source()).cards[0]!;
    expect(Object.keys(card).sort()).toEqual(["applicability", "cardId", "kind", "lifecycle", "ok", "schema", "sourceRefs", "summary"]);
    expect(card.summary).toBe("run m-memory:baseline:1 measured ok=true score=0.75");
    expect(card.applicability).toEqual(["mission:m-memory"]);
    expect(card.sourceRefs).toEqual(["runs/m-memory:baseline:1/result.json"]);
    expect(card.lifecycle).toBe("active");
    expect(JSON.stringify(card)).not.toContain("prompt");
  });

  test("summaries are hard-bounded even when a rule failure is very long", () => {
    const long = "x".repeat(400);
    const card = projectResearchMemorySnapshot(source({
      runs: [{ runId: "m-memory:exp:9", ok: false, ruleViolations: [long], evidenceRefs: [] }],
    })).cards[0]!;
    expect(card.summary.length).toBeLessThanOrEqual(240);
    expect(card.summary.endsWith("…")).toBe(true);
  });

  test("sensitive values are rejected before storage", () => {
    expect(() => projectResearchMemorySnapshot(source({
      runs: [{ runId: "m-memory:exp:2", ok: false, error: "api_key=sk-live-123456", evidenceRefs: [] }],
    }))).toThrow(/secret-like/);
    expect(() => projectResearchMemorySnapshot(source({
      runs: [{ runId: "m-memory:exp:2", ok: false, ruleViolations: ["token: ghp_abcdef123456"], evidenceRefs: [] }],
    }))).toThrow(/secret-like/);
  });

  test("sensitive field names are rejected", () => {
    const raw = { ...source(), transcript: "private conversation" } as unknown as ResearchMemorySource;
    expect(() => projectResearchMemorySnapshot(raw)).toThrow(/sensitive/);
  });
});

describe("research memory snapshot validation (#210)", () => {
  test("round-trips a projected snapshot", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  test("tampering with a digest, card, or schema fails closed", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const tamperedScore = JSON.parse(JSON.stringify(snapshot));
    tamperedScore.cards[0].summary = "run m-memory:baseline:1 measured ok=true score=1";
    expect(() => validateResearchMemorySnapshot(tamperedScore)).toThrow(/digest mismatch/);

    const wrongSchema = { ...snapshot, schema: "evok.research-memory-snapshot/v2" };
    expect(() => validateResearchMemorySnapshot(wrongSchema)).toThrow(/schema/);

    const wrongId = { ...snapshot, snapshotId: "research-memory:not-the-digest" };
    expect(() => validateResearchMemorySnapshot(wrongId)).toThrow(/id does not match/);
  });

  test("a snapshot carrying a sensitive field is rejected", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    expect(() => validateResearchMemorySnapshot({ ...snapshot, transcript: "raw chat" })).toThrow(/sensitive/);
  });
});
