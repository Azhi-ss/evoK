import { describe, expect, test } from "bun:test";
import {
  RESEARCH_MEMORY_DEFAULT_MAX_CARDS,
  ResearchMemoryError,
  RESEARCH_DECISION_PACKET_SCHEMA,
  SYNTHESIS_FINDING_CARD_SCHEMA,
  SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
  OPERATIONAL_PITFALL_CARD_SCHEMA,
  RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
  SYNTHESIS_PITFALL_CARD_SCHEMA,
  assertPacketCardRefs,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  summarizeResearchMemorySnapshot,
  validateResearchMemorySnapshot,
  type ResearchFindingCard,
  type ResearchMemorySource,
} from "./research-memory";
import { SYNTHESIS_PROPOSAL_SCHEMA, validateSynthesisProposal } from "./synthesis-proposal";
import { digestValue } from "../security-boundary";

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
    expect(Object.keys(card).sort()).toEqual([
      "applicability", "cardId", "kind", "lifecycle", "ok", "outcome", "schema", "sourceRefs", "summary",
    ]);
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

describe("research decision packet (#211)", () => {
  test("pins one snapshot and carries only its delivered card refs", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const packet = projectResearchDecisionPacket(snapshot);
    expect(packet.schema).toBe(RESEARCH_DECISION_PACKET_SCHEMA);
    expect(packet.snapshotId).toBe(snapshot.snapshotId);
    expect(packet.snapshotDigest).toBe(snapshot.digest);
    expect(packet.cards.map((card) => card.cardId)).toEqual(snapshot.cards.map((card) => card.cardId));
    expect(packet.digest).toBe(projectResearchDecisionPacket(snapshot).digest);
  });

  test("a trusted card limit truncates the packet and shows the omission count", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const packet = projectResearchDecisionPacket(snapshot, { maxCards: 1 });
    expect(packet.cards).toHaveLength(1);
    expect(packet.omittedCardCount).toBe(snapshot.omittedCardCount + snapshot.cards.length - 1);
    expect(() => projectResearchDecisionPacket(snapshot, { maxCards: 0 })).toThrow(/maxCards/);
  });

  test("used Memory refs outside the delivered packet fail closed", () => {
    const packet = projectResearchDecisionPacket(projectResearchMemorySnapshot(source()));
    const delivered = packet.cards[0]!.cardId;
    expect(() => assertPacketCardRefs(packet, [delivered])).not.toThrow();
    expect(() => assertPacketCardRefs(packet, ["finding:m-other:exp:9"])).toThrow(/not part of the delivered packet/);
  });

  test("a packet cannot be built from a foreign or damaged snapshot", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const tampered = { ...snapshot, cards: [...snapshot.cards, snapshot.cards[0]!] };
    expect(() => projectResearchDecisionPacket(tampered)).toThrow();
  });
});

// ── M1-T3 (#212): accepted Synthesis Proposals become unverified cards ──────

const SYNTHESIS_CONTEXT = {
  missionId: "m-memory",
  taskIds: [],
  runIds: ["m-memory:baseline:1", "m-memory:exp:2"],
  negativeEvidenceRunIds: ["m-memory:exp:2"],
  evidenceRefs: ["runs/m-memory:baseline:1/result.json", "runs/m-memory:exp:2/result.json"],
  accepted: [] as const,
};

function acceptedProposal(overrides: Record<string, unknown> = {}) {
  const decision = validateSynthesisProposal({
    schema: SYNTHESIS_PROPOSAL_SCHEMA,
    proposalId: "p-hypothesis",
    operationId: "op-hypothesis",
    missionId: "m-memory",
    agentId: "researcher@m-memory:exp:2",
    runId: "m-memory:exp:2",
    kind: "hypothesis",
    statement: "a shorter fold window lowers rmse under the same split",
    rationale: "the measured Runs agree",
    supportingRefs: [{ kind: "run", ref: "m-memory:baseline:1" }],
    contradictingRefs: [{ kind: "negative-evidence", ref: "m-memory:exp:2" }],
    competingRefs: [],
    unknowns: ["holdout effect unknown"],
    applicability: ["dataset:train-v1"],
    visibility: "mission",
    limitations: [],
    conditions: [],
    nextValidation: { objective: "ablate the fold window once", advisory: true },
    ...overrides,
  }, SYNTHESIS_CONTEXT);
  if (decision.outcome !== "accepted_for_storage") throw new Error(`fixture rejected: ${decision.reason}`);
  return decision.proposal;
}

function pitfallProposal() {
  return acceptedProposal({
    proposalId: "p-pitfall",
    operationId: "op-pitfall",
    kind: "pitfall",
    statement: "the workspace OOMs above batch 32",
    rationale: "keep the batch small on a 24GB card",
    applicability: ["runtime:cuda-12"],
    conditions: ["batch size >= 32", "single 24GB GPU"],
    unknowns: [],
  });
}

function findingProposal() {
  return acceptedProposal({
    proposalId: "p-finding",
    operationId: "op-finding",
    kind: "finding",
    statement: "the fold window is the dominant cost term",
    limitations: ["measured on one dataset version"],
  });
}

describe("synthesis proposal cards (#212)", () => {
  test("accepted proposals project into unverified hypothesis/finding/pitfall cards", () => {
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [acceptedProposal(), pitfallProposal(), findingProposal()] }));
    expect(snapshot.cards).toHaveLength(5);
    const hypothesis = snapshot.cards.find((card) => card.kind === "hypothesis")!;
    expect(hypothesis).toEqual({
      schema: SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
      cardId: "hypothesis:synthesis:p-hypothesis",
      kind: "hypothesis",
      summary: "a shorter fold window lowers rmse under the same split",
      applicability: ["dataset:train-v1"],
      sourceRefs: [
        "negative-evidence:m-memory:exp:2",
        "run:m-memory:baseline:1",
      ],
      lifecycle: "provisional",
      visibility: "mission",
      epistemicStatus: "unverified",
      supportingRefs: ["run:m-memory:baseline:1"],
      contradictingRefs: ["negative-evidence:m-memory:exp:2"],
      competingRefs: [],
      unknowns: ["holdout effect unknown"],
      nextValidation: { objective: "ablate the fold window once", advisory: true },
    });
    // The authoritative Run/Evidence payloads are referenced, never copied in.
    expect(JSON.stringify(hypothesis)).not.toContain("runs/m-memory");
    expect(hypothesis).not.toHaveProperty("rationale");

    const pitfall = snapshot.cards.find((card) => card.kind === "pitfall")!;
    expect(pitfall).toMatchObject({
      schema: SYNTHESIS_PITFALL_CARD_SCHEMA,
      cardId: "pitfall:synthesis:p-pitfall",
      conditions: ["batch size >= 32", "single 24GB GPU"],
      avoidance: "keep the batch small on a 24GB card",
      epistemicStatus: "unverified",
    });

    const finding = snapshot.cards.find((card) => card.kind === "finding" && card.schema === SYNTHESIS_FINDING_CARD_SCHEMA)!;
    expect(finding).toMatchObject({
      schema: SYNTHESIS_FINDING_CARD_SCHEMA,
      cardId: "finding:synthesis:p-finding",
      limitations: ["measured on one dataset version"],
    });

    expect(snapshot.cards.map((card) => card.cardId).sort()).toEqual([
      "finding:m-memory:baseline:1",
      "finding:m-memory:exp:2",
      "finding:synthesis:p-finding",
      "hypothesis:synthesis:p-hypothesis",
      "pitfall:synthesis:p-pitfall",
    ]);
  });

  test("projection is deterministic regardless of proposal order or repetition", () => {
    const first = projectResearchMemorySnapshot(source({ proposals: [acceptedProposal(), pitfallProposal(), findingProposal()] }));
    const reordered = projectResearchMemorySnapshot(source({ proposals: [findingProposal(), pitfallProposal(), acceptedProposal(), acceptedProposal()] }));
    expect(reordered.digest).toBe(first.digest);
    expect(reordered.snapshotId).toBe(first.snapshotId);
    expect(first.digest).not.toBe(projectResearchMemorySnapshot(source()).digest);
  });

  test("synthesis cards are not crowded out, and dropped cards are counted", () => {
    const proposals = [acceptedProposal(), pitfallProposal(), findingProposal()];
    const all = projectResearchMemorySnapshot(source({ proposals }));
    const bounded = projectResearchMemorySnapshot(source({ proposals, maxCards: 2 }));
    expect(bounded.cards).toHaveLength(2);
    expect(bounded.cards.every((card) => card.cardId.includes(":synthesis:"))).toBe(true);
    expect(bounded.omittedCardCount).toBe(all.cards.length - 2);
  });

  test("status summary counts synthesis cards by kind", () => {
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [acceptedProposal(), pitfallProposal()] }));
    expect(summarizeResearchMemorySnapshot(snapshot)).toEqual({
      snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.digest,
      ledgerRevision: 3,
      cards: { finding: 2, hypothesis: 1, pitfall: 1 },
      omittedCards: 0,
    });
  });

  test("a run-only snapshot keeps its previous shape and digest (v1 back-compat)", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    expect(Object.keys(snapshot).sort()).toEqual([
      "cards", "digest", "ledgerRevision", "maxCards", "memoryRevision", "missionId", "omittedCardCount",
      "retrievalPolicyRevision", "schema", "snapshotId",
    ]);
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  test("snapshot validation accepts synthesis cards and fails closed on tampering", () => {
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [acceptedProposal(), pitfallProposal(), findingProposal()] }));
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.cards.find((card: { kind: string }) => card.kind === "hypothesis").summary = "a shorter fold window raises rmse";
    expect(() => validateResearchMemorySnapshot(tampered)).toThrow(/digest mismatch/);

    const verified = JSON.parse(JSON.stringify(snapshot));
    verified.cards.find((card: { kind: string }) => card.kind === "hypothesis").epistemicStatus = "verified";
    expect(() => validateResearchMemorySnapshot(verified)).toThrow(/unverified/);

    const unknownKind = JSON.parse(JSON.stringify(snapshot));
    unknownKind.cards.push({ ...unknownKind.cards[0], cardId: "hypothesis:synthesis:p-x", kind: "claim" });
    expect(() => validateResearchMemorySnapshot(unknownKind)).toThrow();
  });

  test("the decision packet carries synthesis cards from the pinned snapshot only", () => {
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [acceptedProposal()] }));
    const packet = projectResearchDecisionPacket(snapshot);
    expect(packet.cards.map((card) => card.kind)).toContain("hypothesis");
    expect(packet.cards.map((card) => card.cardId)).toEqual(snapshot.cards.map((card) => card.cardId));
    expect(() => assertPacketCardRefs(packet, ["hypothesis:synthesis:p-hypothesis"])).not.toThrow();
  });
});

// ── M1-T4 (#213): scientific and operational outcomes stay distinct ─────────

function outcomeSource(overrides: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return source({
    runs: [
      { runId: "m-memory:baseline:1", ok: true, score: 0.75, evidenceRefs: ["runs/baseline/result.json"] },
      {
        runId: "m-memory:exp:2", taskId: "task-exp-2", taskObjective: "Materialize answer.txt with value 0.5",
        ok: false, ruleViolations: ["answer.txt is missing"],
        evidenceRefs: ["runs/exp-2/result.json"],
      },
      {
        runId: "m-memory:exp:3", taskId: "task-exp-3", ok: false,
        error: "CUDA error: out of memory while allocating 2.5 GiB",
        evidenceRefs: [],
      },
      { runId: "m-memory:exp:4", taskId: "task-exp-4", ok: false, error: "Run timed out after 900000ms", evidenceRefs: [] },
      { runId: "m-memory:exp:5", taskId: "task-exp-5", ok: false, evidenceRefs: ["runs/exp-5/result.json"] },
      {
        runId: "m-memory:exp:6", taskId: "task-exp-6", taskObjective: "materialize answer.txt with value 0.5",
        ok: false, score: 0.2, evidenceRefs: ["runs/exp-6/result.json"],
      },
    ],
    // Enough headroom that every fixture card (and derived Pitfall) is delivered.
    maxCards: 16,
    ...overrides,
  });
}

describe("scientific vs operational outcomes (#213)", () => {
  test("OOM and timeout keep their Run Outcome and project Operational Pitfalls with conditions", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource());
    const oom = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:3")!;
    expect(oom).toMatchObject({
      kind: "finding",
      ok: false,
      outcome: "operational",
      failure: "out-of-memory",
      lifecycle: "provisional",
    });
    expect(oom.summary).toContain("operational");
    expect(oom.summary).toContain("not scientific negative evidence");

    const timeoutPitfall = snapshot.cards.find((card) => card.cardId === "pitfall:run:m-memory:exp:4")!;
    expect(timeoutPitfall).toEqual({
      schema: OPERATIONAL_PITFALL_CARD_SCHEMA,
      cardId: "pitfall:run:m-memory:exp:4",
      kind: "pitfall",
      summary: timeoutPitfall.summary,
      failure: "timeout",
      conditions: ["failure:timeout", "observed:Run timed out after 900000ms"],
      applicability: ["task:task-exp-4"],
      sourceRefs: [],
      lifecycle: "provisional",
    });
    const oomPitfall = snapshot.cards.find((card) => card.cardId === "pitfall:run:m-memory:exp:3")!;
    expect(oomPitfall.kind === "pitfall" && oomPitfall.conditions[0]).toBe("failure:out-of-memory");
  });

  test("a measured rule failure stays scientific Negative Evidence and produces no Pitfall", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource());
    const negative = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:2")!;
    expect(negative).toMatchObject({ ok: false, outcome: "negative", lifecycle: "contested" });
    expect(negative).not.toHaveProperty("failure");
    expect(negative.summary).toContain("(negative evidence)");
    expect(snapshot.cards.find((card) => card.cardId === "pitfall:run:m-memory:exp:2")).toBeUndefined();
  });

  test("an invalid measurement is operational and cannot become Negative Evidence", () => {
    const invalid = projectResearchMemorySnapshot(outcomeSource()).cards
      .find((card) => card.cardId === "finding:m-memory:exp:5")!;
    expect(invalid).toMatchObject({ outcome: "operational", failure: "invalid-measurement" });
    expect(invalid.summary).not.toContain("(negative evidence)");
  });

  test("a repeated Experiment match carries replication-value context instead of a veto", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource());
    const first = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:2")!;
    const repeat = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:6")!;
    expect(first).not.toHaveProperty("replication");
    expect(repeat).toMatchObject({
      replication: {
        objective: "materialize answer.txt with value 0.5",
        priorRunIds: ["m-memory:exp:2"],
        priorOutcomes: ["negative"],
        advisory: true,
      },
    });
    // Both conflicting measured outcomes survive with their own source conditions.
    expect(first.applicability).toEqual(["task:task-exp-2"]);
    expect(repeat.applicability).toEqual(["task:task-exp-6"]);
    expect((first as { summary: string }).summary).toContain("rule");
    expect((repeat as { summary: string }).summary).toContain("score=0.2");
  });

  test("Negative Evidence keeps its independent identity inside a Hypothesis Card", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource({
      proposals: [acceptedProposal({ contradictingRefs: [{ kind: "negative-evidence", ref: "m-memory:exp:2" }] })],
    }));
    const hypothesis = snapshot.cards.find((card) => card.kind === "hypothesis")!;
    expect(hypothesis.sourceRefs).toContain("negative-evidence:m-memory:exp:2");
    // The authoritative Run reading is still projected as its own card.
    const negative = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:2")!;
    expect(negative).toMatchObject({ ok: false, outcome: "negative" });
    expect(Object.keys(negative)).not.toContain("epistemicStatus");
  });

  test("operational and scientific cards are visibly distinct inside a Decision Packet", () => {
    const packet = projectResearchDecisionPacket(projectResearchMemorySnapshot(outcomeSource()));
    const findings = packet.cards.filter((card) => card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA);
    const operational = findings.filter((card) => card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA && card.outcome === "operational");
    const scientific = findings.filter((card) => card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA && card.outcome === "negative");
    expect(operational.map((card) => card.cardId)).toEqual(["finding:m-memory:exp:3", "finding:m-memory:exp:4", "finding:m-memory:exp:5"]);
    expect(scientific.map((card) => card.cardId)).toEqual(["finding:m-memory:exp:2", "finding:m-memory:exp:6"]);
  });

  test("snapshots with operational cards and Pitfalls round-trip and fail closed on tampering", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource());
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

    const unknownOutcome = JSON.parse(JSON.stringify(snapshot));
    unknownOutcome.cards.find((card: { cardId: string }) => card.cardId === "finding:m-memory:exp:3").outcome = "maybe";
    expect(() => validateResearchMemorySnapshot(unknownOutcome)).toThrow(/outcome must be one of/);

    const forgedPitfall = JSON.parse(JSON.stringify(snapshot));
    forgedPitfall.cards.push({ ...forgedPitfall.cards[0], schema: OPERATIONAL_PITFALL_CARD_SCHEMA, cardId: "pitfall:run:x" });
    expect(() => validateResearchMemorySnapshot(forgedPitfall)).toThrow();
  });
});

describe("review hardening for #213", () => {
  test("a snapshot persisted before #213 still loads instead of looking corrupt", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    // Rebuild the exact bytes a pre-upgrade publish produced: cards that only
    // ever carried `ok`, under their own content address.
    const { digest: _digest, snapshotId: _snapshotId, ...snapshotBody } = snapshot;
    const cards = JSON.parse(JSON.stringify(snapshotBody.cards)).map((card: Record<string, unknown>) => {
      delete card.outcome;
      return card;
    });
    const legacyBody = { ...snapshotBody, cards };
    const legacyDigest = digestValue(legacyBody);
    const legacy = { ...legacyBody, snapshotId: `research-memory:${legacyDigest}`, digest: legacyDigest };
    const reloaded = validateResearchMemorySnapshot(legacy);
    expect(reloaded.cards.find((card) => card.cardId === "finding:m-memory:baseline:1")).not.toHaveProperty("outcome");
    // An unknown outcome value is still refused as corruption.
    const corrupted = JSON.parse(JSON.stringify(snapshot));
    corrupted.cards[0].outcome = "maybe";
    expect(() => validateResearchMemorySnapshot(corrupted)).toThrow(/outcome must be one of/);
  });

  test("replication context follows Mission history order past a two-digit attempt", () => {
    const runs = [
      { runId: "m-memory:exp:2", taskObjective: "materialize answer.txt", ok: true, score: 0.4, evidenceRefs: [] },
      { runId: "m-memory:exp:10", taskObjective: "materialize answer.txt", ok: true, score: 0.35, evidenceRefs: [] },
    ];
    const snapshot = projectResearchMemorySnapshot(source({ runs, maxCards: 8 }));
    // `:exp:10` sorts BEFORE `:exp:2`, so a lexicographic comparison would
    // attribute the later Run as the prior one.
    const later = snapshot.cards.find((card): card is ResearchFindingCard => card.cardId === "finding:m-memory:exp:10")!;
    expect(later.replication).toMatchObject({ priorRunIds: ["m-memory:exp:2"] });
    const earlier = snapshot.cards.find((card) => card.cardId === "finding:m-memory:exp:2")!;
    expect(earlier).not.toHaveProperty("replication");
  });

  test("operational pitfalls are counted apart from proposal-derived pitfalls", () => {
    const snapshot = projectResearchMemorySnapshot(outcomeSource({ proposals: [pitfallProposal()] }));
    expect(summarizeResearchMemorySnapshot(snapshot).cards).toEqual({
      finding: 6,
      pitfall: 1,
      operationalPitfall: 3,
    });
  });
});
