/**
 * M1-T5 (#214): claim-specific applicability and Memory lifecycle.
 *
 * Applicability is per claim, never a universal fingerprint: a card declares
 * only the dimensions it knows, and Contract digest equality alone is not
 * scientific compatibility. A declared difference on a critical dimension
 * blocks direct-prior use, and an undeclared dimension stays unknown instead
 * of becoming compatibility. Lifecycle (stale/revalidation, superseded,
 * withdrawn) is derived deterministically from the same Mission projection.
 */
import { describe, expect, test } from "bun:test";
import {
  RESEARCH_APPLICABILITY_DIMENSIONS,
  RESEARCH_REVALIDATION_DIMENSIONS,
  ResearchMemoryError,
  evaluateResearchApplicability,
  projectResearchMemorySnapshot,
  retrieveResearchMemory,
  validateResearchMemorySnapshot,
  type ResearchMemorySource,
  type ResearchRunFinding,
} from "../memory";
import {
  SYNTHESIS_APPLICABILITY_DIMENSIONS,
  SYNTHESIS_PROPOSAL_SCHEMA,
  validateSynthesisProposal,
  type SynthesisProposal,
} from "./synthesis-proposal";

const MISSION = "m-lifecycle";

function run(overrides: Partial<ResearchRunFinding> & { runId: string }): ResearchRunFinding {
  return { ok: true, evidenceRefs: [`runs/${overrides.runId}/result.json`], ...overrides };
}

function source(overrides: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: MISSION,
    ledgerRevision: 4,
    runs: [run({ runId: `${MISSION}:baseline:1`, score: 0.7 })],
    maxCards: 32,
    ...overrides,
  };
}

const CONTEXT = {
  missionId: MISSION,
  taskIds: ["task-1"],
  runIds: [`${MISSION}:baseline:1`, `${MISSION}:exp:2`],
  negativeEvidenceRunIds: [`${MISSION}:exp:2`],
  evidenceRefs: [`runs/${MISSION}:baseline:1/result.json`],
  accepted: [] as readonly SynthesisProposal[],
};

function proposal(overrides: Record<string, unknown> = {}, accepted: readonly SynthesisProposal[] = []): SynthesisProposal {
  const decision = validateSynthesisProposal({
    schema: SYNTHESIS_PROPOSAL_SCHEMA,
    proposalId: "p-1",
    operationId: "op-1",
    missionId: MISSION,
    agentId: `researcher@${MISSION}:exp:2`,
    kind: "hypothesis",
    statement: "a shorter fold window lowers rmse under the same split",
    rationale: "the measured Runs agree",
    supportingRefs: [{ kind: "run", ref: `${MISSION}:baseline:1` }],
    contradictingRefs: [],
    competingRefs: [],
    unknowns: ["holdout effect unknown"],
    applicability: ["dataset:train-v1"],
    visibility: "mission",
    limitations: [],
    conditions: [],
    ...overrides,
  }, { ...CONTEXT, accepted });
  if (decision.outcome !== "accepted_for_storage") throw new Error(`fixture rejected: ${decision.reason}`);
  return decision.proposal;
}

function cardById(source: ResearchMemorySource, cardId: string) {
  return projectResearchMemorySnapshot(source).cards.find((card) => card.cardId === cardId)!;
}

// ── Applicability: claim-specific, never a universal fingerprint ────────────

describe("claim-specific applicability (#214)", () => {
  test("retrieval supports declared dimensions without requiring every dimension on every card", () => {
    const snapshot = projectResearchMemorySnapshot(source({
      proposals: [proposal({ applicability: ["dataset:train-v1", "method:gbdt"] })],
    }));
    const only = retrieveResearchMemory(snapshot, {
      conditions: ["dataset:train-v1", "method:gbdt", "runtime:cuda-12"],
      critical: ["dataset", "method"],
    });
    const verdict = only.verdicts.find((entry) => entry.card.cardId === `hypothesis:synthesis:p-1`)!;
    // Runtime is relevant to the retrieval but this card never had to declare it.
    expect(verdict).toMatchObject({ state: "direct-prior", conflicts: [], unknowns: [] });

    // Declaring the same runtime dimension critical makes the silence unknown.
    const stricter = evaluateResearchApplicability(verdict.card, {
      conditions: ["dataset:train-v1", "method:gbdt", "runtime:cuda-12"],
      critical: ["dataset", "method", "runtime"],
    });
    expect(stricter).toMatchObject({ state: "unknown", unknowns: ["runtime"] });
  });

  test("a declared conflict on a critical dimension blocks direct-prior use even when Contract digest matches", () => {
    const card = cardById(source({
      proposals: [proposal({ applicability: ["contract:abc123", "dataset:train-v1"] })],
    }), `hypothesis:synthesis:p-1`);
    const verdict = evaluateResearchApplicability(card, {
      conditions: ["contract:abc123", "dataset:train-v2"],
      critical: ["dataset"],
    });
    expect(verdict).toMatchObject({
      state: "conflict",
      conflicts: ["dataset"],
      unknowns: [],
      directPrior: false,
    });
  });

  test("unknown applicability stays unknown and is never silently compatible", () => {
    const card = cardById(source({
      proposals: [proposal({ applicability: ["dataset:train-v1"] })],
    }), `hypothesis:synthesis:p-1`);

    // The retrieval runs under a condition the card never declared.
    expect(evaluateResearchApplicability(card, {
      conditions: ["dataset:train-v1", "evaluation:rmse-v2"],
      critical: ["evaluation"],
    })).toMatchObject({ state: "unknown", unknowns: ["evaluation"], directPrior: false });

    // A retrieval condition the card declares but the query does not supply is
    // equally unknown: an absent value is not a match.
    expect(evaluateResearchApplicability(card, { conditions: [], critical: [] }))
      .toMatchObject({ state: "unknown", unknowns: ["dataset"], directPrior: false });

    // A card that declares nothing at all can never be compatible.
    const undeclared = { ...card, applicability: [] };
    expect(evaluateResearchApplicability(undeclared, { conditions: ["dataset:train-v1"] }))
      .toMatchObject({ state: "unknown", directPrior: false });
  });

  test("Contract digest equality alone never establishes scientific applicability", () => {
    const card = cardById(source({
      proposals: [proposal({ applicability: ["contract:abc123"] })],
    }), `hypothesis:synthesis:p-1`);
    expect(evaluateResearchApplicability(card, {
      conditions: ["contract:abc123"],
      critical: ["objective", "dataset"],
    })).toMatchObject({ state: "unknown", unknowns: ["objective", "dataset"], directPrior: false });
  });

  test("the same Contract under a different Objective blocks the prior", () => {
    const card = cardById(source({
      proposals: [proposal({ applicability: ["contract:abc123", "objective:raise-rmse"] })],
    }), `hypothesis:synthesis:p-1`);
    expect(evaluateResearchApplicability(card, {
      conditions: ["contract:abc123", "objective:lower-latency"],
    })).toMatchObject({ state: "conflict", conflicts: ["objective"], directPrior: false });
  });

  test("applicability dimensions include every dimension a Proposal may declare", () => {
    for (const dimension of SYNTHESIS_APPLICABILITY_DIMENSIONS) {
      expect(RESEARCH_APPLICABILITY_DIMENSIONS).toContain(dimension);
    }
    // Mission/Task are scope: a scope change is not a critical condition change.
    expect(RESEARCH_APPLICABILITY_DIMENSIONS).toContain("mission");
    expect(RESEARCH_REVALIDATION_DIMENSIONS).not.toContain("task" as never);
    expect(RESEARCH_REVALIDATION_DIMENSIONS).not.toContain("mission" as never);
    expect(RESEARCH_REVALIDATION_DIMENSIONS).toContain("dataset");
  });

  test("a supplied critical condition is required by default, so a measured Finding cannot be silently reused", () => {
    const snapshot = projectResearchMemorySnapshot(source({
      conditions: ["objective:raise-rmse", "evaluation:rmse-v1"],
    }));
    const finding = snapshot.cards.find((card) => card.cardId === `finding:${MISSION}:baseline:1`)!;
    expect(finding.lifecycle).toBe("active");
    // The card only declares its Task/Mission scope: under a supplied scientific
    // condition it is unknown, never compatible by default.
    expect(retrieveResearchMemory(snapshot, { conditions: ["objective:raise-rmse", "evaluation:rmse-v1"] })
      .verdicts.find((entry) => entry.card.cardId === finding.cardId))
      .toMatchObject({ state: "unknown", unknowns: ["objective", "evaluation"], directPrior: false });
    // An explicit policy can still specialise what it needs.
    expect(retrieveResearchMemory(snapshot, { conditions: ["objective:raise-rmse"], critical: [] })
      .verdicts.find((entry) => entry.card.cardId === finding.cardId)!.directPrior).toBe(true);
  });

  test("a different Task or Mission scope is not applicable instead of a scientific conflict", () => {
    const card = cardById(source(), `finding:${MISSION}:baseline:1`);
    expect(card.applicability).toEqual([`mission:${MISSION}`]);
    // The snapshot is already Mission-scoped, so a retrieval names its Mission.
    expect(evaluateResearchApplicability(card, { missionId: MISSION }))
      .toMatchObject({ state: "direct-prior", directPrior: true });
    expect(evaluateResearchApplicability(card, { missionId: "other-mission" }))
      .toMatchObject({ state: "not-applicable", directPrior: false });

    const taskCard = { ...card, applicability: ["task:task-1"] };
    expect(evaluateResearchApplicability(taskCard, { missionId: MISSION, conditions: ["task:task-2"] }))
      .toMatchObject({ state: "not-applicable", directPrior: false });
    expect(evaluateResearchApplicability(taskCard, { missionId: MISSION, conditions: ["task:task-1"] }))
      .toMatchObject({ state: "direct-prior", directPrior: true });
    // A supplied scientific condition is critical by default: silence is unknown.
    expect(evaluateResearchApplicability(taskCard, { missionId: MISSION, conditions: ["task:task-1", "objective:raise-score"] }))
      .toMatchObject({ state: "unknown", unknowns: ["objective"], directPrior: false });
  });

  test("visibility is a separate filter that applicability can never widen", () => {
    const card = cardById(source({
      proposals: [proposal({ applicability: ["dataset:train-v1"] })],
    }), `hypothesis:synthesis:p-1`);
    for (const query of [
      { conditions: ["dataset:train-v1"] },
      { conditions: ["dataset:train-v2"] },
      { conditions: [], critical: ["dataset" as const] },
    ]) {
      expect(evaluateResearchApplicability(card, query).visible).toBe(true);
    }
    // A derived record can never declare more visibility than its Mission source.
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [proposal()] }));
    const widened = JSON.parse(JSON.stringify(snapshot));
    widened.cards.find((card: { kind: string }) => card.kind === "hypothesis").visibility = "global";
    expect(() => validateResearchMemorySnapshot(widened)).toThrow();
  });

  test("only an active, matching, visible card is a direct prior", () => {
    const snapshot = projectResearchMemorySnapshot(source({
      proposals: [proposal({ applicability: ["task:task-1"] })],
    }));
    const finding = snapshot.cards.find((card) => card.cardId === `finding:${MISSION}:baseline:1`)!;
    const hypothesis = snapshot.cards.find((card) => card.kind === "hypothesis")!;
    expect(finding.lifecycle).toBe("active");
    expect(hypothesis.lifecycle).toBe("provisional");

    const retrieval = retrieveResearchMemory(snapshot, { conditions: ["task:task-1"] });
    expect(retrieval.verdicts.find((entry) => entry.card.cardId === finding.cardId)!.directPrior).toBe(true);
    // A provisional/unverified card answers the query but is not reusable as one.
    expect(retrieval.verdicts.find((entry) => entry.card.cardId === hypothesis.cardId))
      .toMatchObject({ state: "direct-prior", directPrior: false });
  });

  test("retrieval fails closed on a damaged snapshot and reports its pinned identity", () => {
    const snapshot = projectResearchMemorySnapshot(source());
    const retrieval = retrieveResearchMemory(snapshot, { conditions: [] });
    expect(retrieval).toMatchObject({
      missionId: MISSION,
      snapshotId: snapshot.snapshotId,
      snapshotDigest: snapshot.digest,
      ledgerRevision: snapshot.ledgerRevision,
    });
    expect(() => retrieveResearchMemory({ ...snapshot, digest: "0".repeat(64) }, { conditions: [] }))
      .toThrow(/digest mismatch/);
    expect(() => evaluateResearchApplicability(
      { ...snapshot.cards[0]!, applicability: ["hardware:rtx4090"] },
      { conditions: [] },
    )).toThrow(ResearchMemoryError);
  });
});

// ── Lifecycle: deterministic downgrade, replay, withdrawal ─────────────────

describe("memory lifecycle projections (#214)", () => {
  test("a critical condition change downgrades an earlier card to stale with revalidation required", () => {
    const proposals = [proposal({ applicability: ["dataset:train-v1"] })];
    const before = projectResearchMemorySnapshot(source({ proposals }));
    const after = projectResearchMemorySnapshot(source({ proposals, conditions: ["dataset:train-v2"] }));

    expect(before.cards.find((card) => card.kind === "hypothesis")).toMatchObject({ lifecycle: "provisional" });
    const stale = after.cards.find((card) => card.kind === "hypothesis")!;
    expect(stale).toMatchObject({ lifecycle: "stale", revalidationRequired: true });
    expect(after.digest).not.toBe(before.digest);
    // Same source projects the same next Snapshot: downgrading is deterministic.
    expect(projectResearchMemorySnapshot(source({ proposals, conditions: ["dataset:train-v2"] })).digest).toBe(after.digest);

    // The earlier published snapshot is historical and still validates unchanged.
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(before)))).toEqual(before);

    // A stale card is never an active direct prior, even for its own conditions.
    const verdict = retrieveResearchMemory(after, { conditions: ["dataset:train-v1"] })
      .verdicts.find((entry) => entry.card.cardId === stale.cardId)!;
    expect(verdict).toMatchObject({ state: "direct-prior", directPrior: false });
  });

  test("Dataset and Evaluation drift both downgrade an earlier card to stale", () => {
    const proposals = [proposal({ applicability: ["dataset:train-v1", "evaluation:rmse-v1"] })];
    const snapshot = projectResearchMemorySnapshot(source({
      proposals,
      conditions: ["dataset:train-v2", "evaluation:rmse-v1"],
    }));
    expect(snapshot.cards.find((card) => card.kind === "hypothesis")).toMatchObject({
      lifecycle: "stale",
      revalidationRequired: true,
    });
    const evaluationDrift = projectResearchMemorySnapshot(source({
      proposals,
      conditions: ["dataset:train-v1", "evaluation:rmse-v2"],
    }));
    expect(evaluationDrift.cards.find((card) => card.kind === "hypothesis"))
      .toMatchObject({ lifecycle: "stale", revalidationRequired: true });
    // The retrieval under the new conditions is a declared conflict, not a prior.
    expect(evaluateResearchApplicability(
      snapshot.cards.find((card) => card.kind === "hypothesis")!,
      { conditions: ["dataset:train-v2", "evaluation:rmse-v1"] },
    )).toMatchObject({ state: "conflict", conflicts: ["dataset"] });
  });

  test("lifecycle precedence is monotone: retirement wins over staleness and conflict", () => {
    const proposals = [
      proposal({ proposalId: "p-1", applicability: ["dataset:train-v1"] }),
      proposal({ proposalId: "p-2", operationId: "op-2", applicability: ["dataset:train-v1"] }),
    ];
    const projected = projectResearchMemorySnapshot(source({
      proposals,
      conditions: ["dataset:train-v2"],
      withdrawals: [{ cardId: `hypothesis:synthesis:p-2`, reason: "superseded approach was withdrawn" }],
    }));
    const superseded = projected.cards.find((card) => card.cardId === `hypothesis:synthesis:p-1`)!;
    const withdrawn = projected.cards.find((card) => card.cardId === `hypothesis:synthesis:p-2`)!;
    expect(superseded).toMatchObject({ lifecycle: "superseded" });
    expect(withdrawn).toMatchObject({ lifecycle: "withdrawn" });
    expect(withdrawn).not.toHaveProperty("revalidationRequired");
  });

  test("the next Snapshot records the conditions it was projected under", () => {
    const proposals = [proposal({ applicability: ["dataset:train-v1"] })];
    const snapshot = projectResearchMemorySnapshot(source({ proposals, conditions: ["dataset:train-v2"] }));
    expect(snapshot.conditions).toEqual(["dataset:train-v2"]);
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    // A snapshot published before conditions were recorded still loads.
    const legacy = projectResearchMemorySnapshot(source({ proposals }));
    expect(legacy).not.toHaveProperty("conditions");
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
  });

  test("withdrawal retires a card for future reads without rewriting Evidence or old snapshots", () => {
    const runs = [run({ runId: `${MISSION}:exp:2`, ok: false, ruleViolations: ["answer.txt is missing"] })];
    const before = projectResearchMemorySnapshot(source({ runs }));
    const withdrawn = projectResearchMemorySnapshot(source({
      runs,
      withdrawals: [{ cardId: `finding:${MISSION}:exp:2`, reason: "the measurement harness was wrong" }],
    }));

    const retired = withdrawn.cards.find((card) => card.cardId === `finding:${MISSION}:exp:2`)!;
    expect(retired).toMatchObject({ lifecycle: "withdrawn", ok: false, outcome: "negative" });
    // Historical Evidence identity and the old snapshot are untouched.
    expect(retired.sourceRefs).toEqual([`runs/${MISSION}:exp:2/result.json`]);
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(before)))).toEqual(before);
    expect(before.cards.find((card) => card.cardId === `finding:${MISSION}:exp:2`)).toMatchObject({ lifecycle: "contested" });

    // Withdrawal affects future reads only: not an active direct prior.
    expect(retrieveResearchMemory(withdrawn, { conditions: [] })
      .verdicts.find((entry) => entry.card.cardId === `finding:${MISSION}:exp:2`)!.directPrior).toBe(false);
  });

  test("every lifecycle view replays through validation and retrieval", () => {
    const snapshot = projectResearchMemorySnapshot(source({
      runs: [
        run({ runId: `${MISSION}:baseline:1`, score: 0.7 }),
        run({ runId: `${MISSION}:exp:2`, ok: false, ruleViolations: ["answer.txt is missing"] }),
        run({ runId: `${MISSION}:exp:3`, ok: false, error: "Run timed out after 900000ms" }),
        run({ runId: `${MISSION}:exp:4`, taskId: "task-1" }),
      ],
      proposals: [
        proposal({ proposalId: "p-active", applicability: ["task:task-1"] }),
        proposal({ proposalId: "p-rev-1", operationId: "op-rev-1", applicability: ["dataset:train-v1"] }),
        proposal({ proposalId: "p-rev-2", operationId: "op-rev-2", applicability: ["dataset:train-v1"] }),
        proposal({ proposalId: "p-stale", operationId: "op-stale", applicability: ["dataset:train-v9"] }),
      ],
      conditions: ["dataset:train-v1"],
      withdrawals: [{ cardId: `finding:${MISSION}:exp:4` }],
    }));
    const lifecycleOf = (cardId: string) => snapshot.cards.find((card) => card.cardId === cardId)!.lifecycle;
    expect(lifecycleOf(`finding:${MISSION}:baseline:1`)).toBe("active");
    expect(lifecycleOf(`finding:${MISSION}:exp:3`)).toBe("provisional");
    expect(lifecycleOf(`finding:${MISSION}:exp:2`)).toBe("contested");
    expect(lifecycleOf(`finding:${MISSION}:exp:4`)).toBe("withdrawn");
    expect(lifecycleOf("hypothesis:synthesis:p-stale")).toBe("stale");
    expect(lifecycleOf("hypothesis:synthesis:p-rev-1")).toBe("superseded");

    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

    const retrieval = retrieveResearchMemory(snapshot, { conditions: [], critical: [] });
    expect(retrieval.verdicts.map((verdict) => verdict.card.cardId).sort())
      .toEqual(snapshot.cards.map((card) => card.cardId).sort());
    expect(retrieval.verdicts.filter((verdict) => verdict.directPrior).map((verdict) => verdict.card.cardId))
      .toEqual([`finding:${MISSION}:baseline:1`]);
  });
});

// ── Equivalence, conflict, lineage, idempotency ────────────────────────────

describe("hypothesis equivalence and lineage (#214)", () => {
  test("equivalent hypotheses are revised with explicit supersedes lineage", () => {
    const proposals = [
      proposal({ proposalId: "p-1", operationId: "op-1" }),
      proposal({ proposalId: "p-2", operationId: "op-2" }),
    ];
    const snapshot = projectResearchMemorySnapshot(source({ proposals }));
    const earlier = snapshot.cards.find((card) => card.cardId === "hypothesis:synthesis:p-1")!;
    const later = snapshot.cards.find((card) => card.cardId === "hypothesis:synthesis:p-2")!;
    expect(earlier).toMatchObject({
      lifecycle: "superseded",
      lineage: { revision: 1, supersededBy: "hypothesis:synthesis:p-2" },
    });
    expect(later).toMatchObject({
      lifecycle: "provisional",
      lineage: { revision: 2, supersedes: ["hypothesis:synthesis:p-1"] },
    });
    expect(projectResearchMemorySnapshot(source({ proposals })).digest).toBe(snapshot.digest);
  });

  test("different conditions stay separate even for an identical statement", () => {
    const snapshot = projectResearchMemorySnapshot(source({
      proposals: [
        proposal({ proposalId: "p-1", applicability: ["dataset:train-v1"] }),
        proposal({ proposalId: "p-2", operationId: "op-2", applicability: ["dataset:train-v2"] }),
      ],
    }));
    const cards = snapshot.cards.filter((card) => card.kind === "hypothesis");
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.lifecycle)).toEqual(["provisional", "provisional"]);
    expect(cards.every((card) => !("lineage" in card))).toBe(true);
  });

  test("same-condition conflicting claims coexist as contested and never last-write-win", () => {
    const first = proposal({ proposalId: "p-1", applicability: ["dataset:train-v1"] });
    // The second cites the stored claim, so it is validated against accepted state.
    const second = proposal({
      proposalId: "p-2",
      operationId: "op-2",
      statement: "a shorter fold window raises rmse under the same split",
      competingRefs: [{ kind: "claim", ref: "p-1" }],
    }, [first]);
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [first, second] }));
    expect(snapshot.cards.find((card) => card.cardId === "hypothesis:synthesis:p-1")).toMatchObject({ lifecycle: "contested" });
    expect(snapshot.cards.find((card) => card.cardId === "hypothesis:synthesis:p-2")).toMatchObject({ lifecycle: "contested" });
    // Both survive in either input order; nothing is overwritten.
    const reversed = projectResearchMemorySnapshot(source({ proposals: [second, first] }));
    expect(reversed.cards.filter((card) => card.kind === "hypothesis")).toHaveLength(2);
    expect(reversed.digest).toBe(snapshot.digest);
  });

  test("a competing claim under different conditions is not a same-condition conflict", () => {
    const first = proposal({ proposalId: "p-1", applicability: ["dataset:train-v1"] });
    const second = proposal({
      proposalId: "p-2",
      operationId: "op-2",
      statement: "a shorter fold window raises rmse under the same split",
      applicability: ["dataset:train-v2"],
      competingRefs: [{ kind: "claim", ref: "p-1" }],
    }, [first]);
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [first, second] }));
    expect(snapshot.cards.filter((card) => card.kind === "hypothesis").map((card) => card.lifecycle))
      .toEqual(["provisional", "provisional"]);
  });

  test("one operation id stays one card, so a replay can never mint a revision", () => {
    const accepted = proposal();
    const snapshot = projectResearchMemorySnapshot(source({ proposals: [accepted, accepted] }));
    expect(snapshot.cards.filter((card) => card.kind === "hypothesis")).toHaveLength(1);
    // A replay of the same operation is the same stored payload, not a revision.
    const replayed = { ...accepted, proposalId: "p-replay", statement: accepted.statement };
    const once = projectResearchMemorySnapshot(source({ proposals: [accepted, replayed] }));
    expect(once.cards.filter((card) => card.kind === "hypothesis").map((card) => card.cardId))
      .toEqual(["hypothesis:synthesis:p-1"]);
  });

  test("identical replays and concurrent Branch outcomes stay idempotent and coexist", () => {
    const accepted = proposal();
    const replay = projectResearchMemorySnapshot(source({ proposals: [accepted, accepted] }));
    expect(replay.cards.filter((card) => card.kind === "hypothesis")).toHaveLength(1);
    expect(replay.digest).toBe(projectResearchMemorySnapshot(source({ proposals: [accepted] })).digest);

    const branchA = run({ runId: `${MISSION}:exp:2`, taskId: "task-1", taskObjective: "widen the fold window", score: 0.8 });
    const branchB = run({
      runId: `${MISSION}:exp:3`, taskId: "task-1", taskObjective: "widen the fold window", ok: false,
      ruleViolations: ["metric below target"],
    });
    const merged = projectResearchMemorySnapshot(source({ runs: [branchA, branchB] }));
    const reversed = projectResearchMemorySnapshot(source({ runs: [branchB, branchA] }));
    const findings = (snapshot: ReturnType<typeof projectResearchMemorySnapshot>) => snapshot.cards
      .filter((card) => card.kind === "finding")
      .map((card) => `${card.cardId}:${card.lifecycle}`)
      .sort();
    // Both Branch outcomes survive either completion order; nothing is overwritten.
    expect(findings(reversed)).toEqual(findings(merged));
    expect(merged.cards.find((card) => card.cardId === `finding:${MISSION}:exp:2`)).toMatchObject({ lifecycle: "active" });
    expect(merged.cards.find((card) => card.cardId === `finding:${MISSION}:exp:3`)).toMatchObject({ lifecycle: "contested" });
    // A replayed Branch observation never rewrites the first identity.
    const duplicate = projectResearchMemorySnapshot(source({
      runs: [branchA, branchB, { ...branchA, score: 0.1 }],
    }));
    expect(duplicate.digest).toBe(merged.digest);
    expect(duplicate.cards.find((card) => card.cardId === `finding:${MISSION}:exp:2`)).toMatchObject({ ok: true });
  });
});
