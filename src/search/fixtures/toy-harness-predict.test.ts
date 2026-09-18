import { describe, expect, test } from "bun:test";
import { InfrastructureError, ToyCompetitionHarness, type MissionEvent, type ToyAgentRuntime } from "./toy-harness";

const contract = { objective: "maximize the score" };

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns an improved score",
  expectedObservations: ["the evaluator returns an improved score"],
  expectedMetrics: [{ name: "score", min: 0.8 }],
  failureModes: ["the score does not improve"],
} as const;

function runtimeFor(score: string): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { score } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

describe("prediction gate and trusted reconcile seam", () => {
  test("finalizes a candidate with a Claim card and three-way reconciliation status", async () => {
    const cases = [
      { score: "0.9", expectedMetrics: [{ name: "score", min: 0.8 }], status: "confirmed" },
      { score: "0.4", expectedMetrics: [{ name: "score", min: 0.8 }], status: "violated" },
      { score: "0.9", expectedMetrics: undefined, status: "unknown" },
    ] as const;
    for (const entry of cases) {
      const harness = new ToyCompetitionHarness({
        missionId: `claim-${entry.status}`,
        taskContract: contract,
        branchIds: ["a"],
        runtime: runtimeFor(entry.score),
        prediction: { ...prediction, expectedMetrics: entry.expectedMetrics },
        evaluate: () => ({ score: Number(entry.score) }),
        policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
      });
      const result = await harness.run();
      expect(result.branches.a.claimCard).toMatchObject({
        claim: prediction.hypothesis,
        prediction: { predictionId: prediction.predictionId },
        status: entry.status,
        score: Number(entry.score),
        objections: [],
      });
      expect(result.branches.a.claimCard?.evidenceRefs.length).toBeGreaterThan(0);
      expect(ToyCompetitionHarness.replay(harness.events()).branches.a.claimCard).toEqual(result.branches.a.claimCard);
    }
  });

  test("uncleared claim objections block promotion and a forged verdict cannot champion them away", async () => {
    const runtime: ToyAgentRuntime = {
      selfVerify: () => ({ ok: true }),
      propose: () => ({ files: { score: "0.9" } }),
      falsify: () => ({ ok: true, objections: ["fails on the cold-start edge case"] }),
    };
    const harness = new ToyCompetitionHarness({
      missionId: "objection-gate",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      prediction,
      evaluate: () => ({ score: 0.9 }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    // Emission seam: a role that passes but raises objections leaves them uncleared on the card,
    // so the claim-card gate rejects the promotion regardless of score.
    expect(result.champion).toBeUndefined();
    expect(result.branches.a.status).toBe("REJECTED");
    expect(result.branches.a.rejectionReason).toContain("uncleared claim objections");
    expect(result.branches.a.claimCard?.objections[0]).toMatchObject({
      source: "Falsifier",
      statement: "fails on the cold-start edge case",
    });
    // Replay seam: splice a payload-perfect PROMOTED_LOCAL after the Falsifier has verified the
    // snapshot (so every other projector check passes); only the claim-card gate, which sees the
    // uncleared Falsifier objection on the card, may refuse the champion.
    const source = harness.events().filter((event) =>
      !["PROMOTED_LOCAL", "BRANCH_REJECTED", "MISSION_STOPPED", "MISSION_COMPLETED", "EDGE_TRAVERSED"].includes(event.type));
    const evaluatorEvent = source.find((event) => event.type === "EVALUATOR_SUCCEEDED")!;
    const branch = harness.state().branches.a;
    const forged = {
      type: "PROMOTED_LOCAL" as const,
      payload: {
        branchId: "a",
        fencingToken: branch.fencingToken,
        snapshot: branch.snapshot,
        snapshotDigest: branch.snapshot!.digest,
        contractDigest: branch.snapshot!.contractDigest,
        score: branch.score,
        facts: branch.facts,
        evaluationRef: evaluatorEvent.payload.evaluationDigest,
        evidenceIds: evaluatorEvent.payload.evidenceIds,
      },
    };
    const verificationIndex = source.findIndex((event) => event.type === "FALSIFIER_COMPLETED");
    const spliced = [...source.slice(0, verificationIndex + 1), forged, ...source.slice(verificationIndex + 1)]
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    expect(ToyCompetitionHarness.replay(spliced as MissionEvent[]).champion).toBeUndefined();
  });

  test("blocks expensive execution without an explicit prediction", async () => {
    let evaluations = 0;
    const harness = new ToyCompetitionHarness({
      missionId: "no-prediction",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.9"),
      evaluate: () => { evaluations += 1; return { score: 0.9 }; },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();

    expect(result.branches.a.status).toBe("REJECTED");
    expect(result.branches.a.rejectionReason).toBe("prediction required before expensive execution");
    expect(evaluations).toBe(0);
    expect(harness.events().some((event) => event.type === "SNAPSHOT_COMMITTED")).toBe(false);
    expect(harness.events().some((event) => event.type === "EVALUATION_STARTED")).toBe(false);
    expect(harness.events().some((event) => event.type === "RECONCILED")).toBe(false);
  });

  test("records an inconclusive reconcile when the evaluator fails", async () => {
    const harness = new ToyCompetitionHarness({
      missionId: "evaluator-failure",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.9"),
      prediction,
      evaluate: () => { throw new InfrastructureError("evaluator unavailable"); },
      policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 2, quorum: 1 },
    });

    const result = await harness.run();
    const reconcile = result.branches.a.reconcile;

    expect(result.branches.a.status).toBe("REJECTED");
    expect(reconcile?.status).toBe("inconclusive");
    expect(reconcile?.evidenceGatePassed).toBe(false);
    expect(reconcile?.observationRefs.length).toBeGreaterThan(0);
    expect(harness.events().some((event) => event.type === "EVALUATOR_FAILED")).toBe(true);
    // The failure reconcile must survive replay: it is re-derived, not re-trusted.
    expect(ToyCompetitionHarness.replay(harness.events()).branches.a.reconcile).toEqual(reconcile);
  });

  test("records a refuted reconcile derived from verified evaluator facts after every evaluation", async () => {
    const harness = new ToyCompetitionHarness({
      missionId: "refuted-seam",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.4"),
      prediction,
      adapter: {
        name: "independent-evaluator",
        evaluate: (snapshot) => ({ score: 0.4, facts: [{ name: "score", value: 0.4, source: "score-file" }] }),
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();
    const reconcile = result.branches.a.reconcile;

    expect(reconcile?.status).toBe("refuted");
    expect(reconcile?.evaluatorId).toBe("independent-evaluator");
    expect(reconcile?.independentEvaluator).toBe(true);
    expect(reconcile?.evidenceGatePassed).toBe(true);
    expect(reconcile?.observationRefs.length).toBeGreaterThan(0);
    expect(reconcile?.artifactRefs.length).toBeGreaterThan(0);
    expect(reconcile?.claim.hypothesis).toBe(prediction.hypothesis);
    expect(harness.events().some((event) => event.type === "RECONCILED")).toBe(true);
    // The ledger replay must reconstruct the same trusted reconcile, not re-trust the payload.
    expect(ToyCompetitionHarness.replay(harness.events()).branches.a.reconcile).toEqual(reconcile);
  });

  test("rejects a forged RECONCILED event that claims another evaluator", async () => {
    const harness = new ToyCompetitionHarness({
      missionId: "forged-reconcile-seam",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.4"),
      prediction,
      adapter: {
        name: "independent-evaluator",
        evaluate: (snapshot) => ({ score: 0.4, facts: [{ name: "score", value: 0.4, source: "score-file" }] }),
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    await harness.run();
    // Insert the forged reconcile directly after the verified evaluation so rejection must come from
    // the RECONCILED validation itself, not from a later terminal phase gate.
    const events = harness.events().filter((event) => event.type !== "RECONCILED");
    const evalIndex = events.findIndex((event) => event.type === "EVALUATOR_SUCCEEDED");
    const reconcile = harness.state().branches.a.reconcile!;
    const forged = {
      type: "RECONCILED" as const,
      payload: {
        branchId: "a",
        fencingToken: harness.state().branches.a.fencingToken,
        snapshotDigest: harness.state().branches.a.snapshot!.digest,
        reconcile: { ...reconcile, evaluatorId: "forged", claim: { ...reconcile.claim, evaluatorId: "forged" } },
      },
    };
    const spliced = [...events.slice(0, evalIndex + 1), forged, ...events.slice(evalIndex + 1)]
      .map((event, index) => ({ ...event, sequence: index + 1 }));

    const replayed = ToyCompetitionHarness.replay(spliced as MissionEvent[]);

    expect(replayed.branches.a.reconcile).toBeUndefined();
  });

  test("rejects a forged RECONCILED event that relabels the verified verdict", async () => {
    const harness = new ToyCompetitionHarness({
      missionId: "forged-verdict-seam",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.4"),
      prediction,
      adapter: {
        name: "independent-evaluator",
        evaluate: (snapshot) => ({ score: 0.4, facts: [{ name: "score", value: 0.4, source: "score-file" }] }),
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    await harness.run();
    const events = harness.events().filter((event) => event.type !== "RECONCILED");
    const evalIndex = events.findIndex((event) => event.type === "EVALUATOR_SUCCEEDED");
    const reconcile = harness.state().branches.a.reconcile!;
    expect(reconcile.status).toBe("refuted");
    const forged = {
      type: "RECONCILED" as const,
      payload: {
        branchId: "a",
        fencingToken: harness.state().branches.a.fencingToken,
        snapshotDigest: harness.state().branches.a.snapshot!.digest,
        reconcile: { ...reconcile, status: "confirmed" as const, claim: { ...reconcile.claim, reconcileStatus: "confirmed" as const } },
      },
    };
    const spliced = [...events.slice(0, evalIndex + 1), forged, ...events.slice(evalIndex + 1)]
      .map((event, index) => ({ ...event, sequence: index + 1 }));

    const replayed = ToyCompetitionHarness.replay(spliced as MissionEvent[]);

    expect(replayed.branches.a.reconcile).toBeUndefined();
  });

  test("restart preserves the prediction and reconcile exactly once", async () => {
    const harness = new ToyCompetitionHarness({
      missionId: "restart-seam",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.9"),
      prediction,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score), facts: [{ name: "score", value: 0.9, source: "score-file" }] }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    await harness.run();
    const before = harness.events();
    expect(harness.state().branches.a.reconcile?.status).toBe("confirmed");

    const restarted = ToyCompetitionHarness.fromEvents({
      missionId: "restart-seam",
      taskContract: contract,
      branchIds: ["a"],
      runtime: runtimeFor("0.9"),
      prediction,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score), facts: [{ name: "score", value: 0.9, source: "score-file" }] }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    }, before);
    await restarted.resume();

    expect(restarted.state().branches.a.prediction?.predictionId).toBe(prediction.predictionId);
    expect(restarted.state().branches.a.reconcile?.status).toBe("confirmed");
    expect(restarted.events().filter((event) => event.type === "RECONCILED")).toHaveLength(1);
    expect(restarted.events()).toHaveLength(before.length);
  });
});
