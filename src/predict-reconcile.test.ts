import { describe, expect, test } from "bun:test";
import { digestValue, generateEvaluationKeyPair, signEvaluationDigest } from "./security-boundary";
import { MissionDirector, type ResearchTask, type TaskCompletion } from "./research-loop";

const prediction = {
  predictionId: "hypothesis:better-split",
  hypothesis: "the better split improves score",
  expectedObservation: "score improves",
  expectedObservations: ["score improves"],
  expectedMetrics: [{ name: "score", min: 0.8 }],
  failureModes: ["score regresses", "evaluation is inconclusive"],
} as const;

// The evaluator holds the private key; the mission only registers its public key, so the caller cannot
// forge a passing proof even with a self-consistent digest chain.
const evaluatorKeys = generateEvaluationKeyPair("independent-evaluator");
const trusted = [{ evaluatorId: evaluatorKeys.evaluatorId, publicKey: evaluatorKeys.publicKey }];

// Signed evaluation proof bound to the registered "run-output" artifact digest.
const proofFor = (score: number) => ({
  evaluatorId: "independent-evaluator",
  snapshotDigest: "run-digest",
  facts: { score },
});

const task = (taskId: string, overrides: Partial<ResearchTask> = {}): ResearchTask => ({
  taskId, objective: "test the split", estimatedCost: 1, prediction, ...overrides,
});

function completion(reconcile: TaskCompletion["reconcile"], score = 0.4): TaskCompletion {
  const evaluationDigest = digestValue(proofFor(score));
  return {
    operationId: "complete-1",
    evidence: [{ id: "observation", kind: "observation", summary: `score was ${score}`, verified: true, metadata: { evaluation: proofFor(score), evaluationDigest, signature: signEvaluationDigest(evaluationDigest, evaluatorKeys.privateKey) } }],
    artifacts: [{ artifactId: "run-output", digest: "run-digest" }],
    reconcile,
  };
}

describe("predict and reconcile", () => {
  test("requires a prediction before selecting an expensive task", () => {
    const director = new MissionDirector({ missionId: "prediction-gate", objective: "learn", budget: 1, tasks: [{ taskId: "experiment", objective: "test the split", estimatedCost: 1 }], trustedEvaluators: trusted });
    expect(director.selectNextTask()).toBeUndefined();
    expect(director.state().budget.consumed).toBe(0);
    expect(director.recordPrediction("experiment", prediction).predictionId).toBe(prediction.predictionId);
    expect(director.selectNextTask()?.status).toBe("RUNNING");
  });

  test("failed prediction is reconciled, gated into WORLD_MODEL, and avoids the same hypothesis", () => {
    const director = new MissionDirector({ missionId: "refuted", objective: "learn", budget: 2, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "refuted", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
    }));
    const state = director.state();
    expect(state.reconciles[0]?.status).toBe("refuted");
    expect(director.state().worldModel).toHaveLength(1);
    expect(state.worldModel[0]?.hypothesis).toBe(prediction.hypothesis);
    expect(director.readyTasks()).toEqual([]);
    // The refuted hypothesis is also retrievable as #8 Negative Evidence, not only as a WORLD_MODEL claim.
    expect(director.evidenceMemory().searchNegativeEvidence("better split").map((entry) => entry.category)).toContain("hypothesis-refuted");

    const followUp = task("follow-up", { prediction: { ...prediction, hypothesis: prediction.hypothesis, predictionId: "hypothesis:better-split-follow-up" }, dependencies: undefined });
    const planned = new MissionDirector({ missionId: "refuted-plan", objective: "learn", budget: 3, tasks: [task("experiment"), followUp], trustedEvaluators: trusted });
    planned.selectNextTask();
    planned.completeTask("experiment", completion({
      status: "refuted", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
    }));
    expect(planned.readyTasks()).toEqual([]);
  });

  test("rejects a forged WORLD_MODEL event during replay", () => {
    const director = new MissionDirector({ missionId: "forged-world-model", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    director.completeTask("experiment", completion({ status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true }, 0.9));
    const events = director.events().filter((event) => event.type !== "WORLD_MODEL_UPDATED").map((event, index) => ({ ...event, sequence: index + 1 }));
    const claim = director.state().reconciles[0]!.claim;
    const forged = { sequence: events.length + 1, eventId: "forged-world-model-event", type: "WORLD_MODEL_UPDATED" as const, payload: { missionId: "forged-world-model", operationId: "forged-world-model-op", taskId: "experiment", claim: { ...claim, evaluatorId: "forged" } } };
    expect(() => MissionDirector.replay([...events, forged])).toThrow("does not match its reconcile");
  });

  test("rejects a forged RECONCILED event whose gate is not backed by evaluator evidence", () => {
    const director = new MissionDirector({ missionId: "forged-reconcile", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "inconclusive", observationRefs: [], artifactRefs: ["run-output"], evidenceRefs: [], evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false,
    }));
    const events = director.events().filter((event) => event.type !== "RECONCILED").map((event, index) => ({ ...event, sequence: index + 1 }));
    const forged = {
      sequence: events.length + 1, eventId: "forged-reconcile-event", type: "RECONCILED" as const,
      payload: {
        missionId: "forged-reconcile", operationId: "forged-reconcile-op", taskId: "experiment",
        reconcile: { reconcileId: "experiment:reconcile", predictionId: prediction.predictionId, status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "forged", independentEvaluator: true, evidenceGatePassed: true },
      },
    };
    expect(() => MissionDirector.replay([...events, forged])).toThrow("without matching independent evaluator evidence");
  });

  test("restart preserves predictions, reconciles, and world model exactly once", () => {
    const options = { missionId: "restart", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted };
    const director = new MissionDirector(options);
    director.selectNextTask();
    director.completeTask("experiment", completion({ status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true }, 0.9));
    expect(director.state().worldModel).toHaveLength(1);
    const events = director.events();
    const restarted = MissionDirector.fromEvents(options, events);
    expect(restarted.state()).toEqual(director.state());
    expect(restarted.state().predictions).toHaveLength(1);
    expect(restarted.state().reconciles).toHaveLength(1);
    expect(restarted.state().worldModel).toHaveLength(1);
    restarted.completeTask("experiment", completion({ status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true }, 0.9));
    expect(restarted.events()).toHaveLength(events.length);
  });

  test("recovers a completion checkpointed before its reconcile admission events", () => {
    const options = { missionId: "crash", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted };
    const director = new MissionDirector(options);
    director.selectNextTask();
    director.completeTask("experiment", completion({ status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true }, 0.9));
    const checkpoint = director.events()
      .filter((event) => event.type !== "RECONCILED" && event.type !== "WORLD_MODEL_UPDATED")
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    const restarted = MissionDirector.fromEvents(options, checkpoint);
    expect(restarted.state().reconciles).toHaveLength(1);
    expect(restarted.state().worldModel).toHaveLength(0);
    const gateInput = completion({ status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true }, 0.9).reconcile!;
    const persisted = restarted.reconcileTask("experiment", gateInput);
    expect(persisted.status).toBe("confirmed");
    expect(restarted.state().worldModel).toHaveLength(1);
    const again = MissionDirector.fromEvents(options, restarted.events());
    expect(again.state().worldModel).toHaveLength(1);
    expect(again.events()).toHaveLength(restarted.events().length);
  });

  test("raw self-report cannot update WORLD_MODEL and replay is idempotent", () => {
    const director = new MissionDirector({ missionId: "gated", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false,
    }));
    const before = director.events();
    expect(director.state().worldModel).toEqual([]);
    const restarted = MissionDirector.fromEvents({ missionId: "gated", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted }, before);
    expect(restarted.state().reconciles).toHaveLength(1);
    expect(restarted.state().worldModel).toEqual([]);
    expect(restarted.reconcileTask("experiment", { status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false })).toEqual(restarted.state().reconciles[0]);
    expect(restarted.events()).toHaveLength(before.length);
  });

  test("an ungated self-reported refutation cannot block future planning", () => {
    const followUp = task("follow-up", { prediction: { ...prediction, predictionId: "hypothesis:better-split-follow-up" } });
    const director = new MissionDirector({ missionId: "ungated-refuted", objective: "learn", budget: 2, tasks: [task("experiment"), followUp] });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "refuted", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: [],
      evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false,
    }));
    expect(director.state().worldModel).toEqual([]);
    expect(director.evidenceMemory().searchNegativeEvidence("better split")).toEqual([]);
    expect(director.readyTasks().map((entry) => entry.taskId)).toEqual(["follow-up"]);
  });

  test("rejects a forged evaluator proof whose digest does not verify", () => {
    const director = new MissionDirector({ missionId: "forged-proof", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    expect(() => director.completeTask("experiment", {
      operationId: "forged-proof-completion",
      evidence: [{
        id: "forged-observation", kind: "observation", summary: "score was 0.4", verified: true,
        metadata: { evaluation: { ...proofFor(0.4), facts: { score: 0.9 } }, evaluationDigest: digestValue(proofFor(0.4)), signature: signEvaluationDigest(digestValue(proofFor(0.4)), evaluatorKeys.privateKey) },
      }],
      artifacts: [{ artifactId: "run-output", digest: "run-digest" }],
      reconcile: {
        status: "confirmed", observationRefs: ["forged-observation"], artifactRefs: ["run-output"], evidenceRefs: ["forged-observation"],
        evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
      },
    })).toThrow("without matching independent evaluator evidence");
  });

  test("rejects a proof signed outside the mission trust root", () => {
    const forger = generateEvaluationKeyPair("forger");
    const director = new MissionDirector({ missionId: "forged-signature", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    expect(() => director.completeTask("experiment", {
      operationId: "forged-signature-completion",
      evidence: [{
        id: "forged-observation", kind: "observation", summary: "score was 0.4", verified: true,
        metadata: { evaluation: proofFor(0.9), evaluationDigest: digestValue(proofFor(0.9)), signature: signEvaluationDigest(digestValue(proofFor(0.9)), forger.privateKey) },
      }],
      artifacts: [{ artifactId: "run-output", digest: "run-digest" }],
      reconcile: {
        status: "confirmed", observationRefs: ["forged-observation"], artifactRefs: ["run-output"], evidenceRefs: ["forged-observation"],
        evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
      },
    })).toThrow("without matching independent evaluator evidence");
  });

  test("rejects a gated reconcile whose status contradicts the signed facts", () => {
    const director = new MissionDirector({ missionId: "relabeled", objective: "learn", budget: 1, tasks: [task("experiment")], trustedEvaluators: trusted });
    director.selectNextTask();
    // The signed facts (score 0.4 vs min 0.8) derive "refuted"; a caller with a valid proof cannot relabel them as confirmed.
    expect(() => director.completeTask("experiment", completion({
      status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
    }, 0.4))).toThrow("without matching independent evaluator evidence");
  });
});
