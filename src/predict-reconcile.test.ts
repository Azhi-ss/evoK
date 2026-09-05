import { describe, expect, test } from "bun:test";
import { MissionDirector, type ResearchTask, type TaskCompletion } from "./research-loop";

const prediction = {
  predictionId: "hypothesis:better-split",
  hypothesis: "the better split improves score",
  expectedObservation: "score improves",
  expectedObservations: ["score improves"],
  expectedMetrics: [{ name: "score", min: 0.8 }],
  failureModes: ["score regresses", "evaluation is inconclusive"],
} as const;

const task = (taskId: string, overrides: Partial<ResearchTask> = {}): ResearchTask => ({
  taskId, objective: "test the split", estimatedCost: 1, prediction, ...overrides,
});

function completion(reconcile: TaskCompletion["reconcile"]): TaskCompletion {
  return {
    operationId: "complete-1",
    evidence: [{ id: "observation", kind: "observation", summary: "score was 0.4" }],
    artifacts: [{ artifactId: "run-output", digest: "run-digest" }],
    reconcile,
  };
}

describe("predict and reconcile", () => {
  test("requires a prediction before selecting an expensive task", () => {
    const director = new MissionDirector({ missionId: "prediction-gate", objective: "learn", budget: 1, tasks: [task("experiment")] });
    const events = director.events();
    const selected = { sequence: events.length + 1, eventId: "forged-select", type: "TASK_SELECTED" as const, payload: { missionId: "prediction-gate", taskId: "experiment", operationId: "forged-select" } };
    expect(MissionDirector.replay([...events, selected]).tasks.experiment.status).toBe("RUNNING");
    expect(director.selectNextTask()?.status).toBe("RUNNING");
  });

  test("failed prediction is reconciled, gated into WORLD_MODEL, and avoids the same hypothesis", () => {
    const director = new MissionDirector({ missionId: "refuted", objective: "learn", budget: 2, tasks: [task("experiment")] });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "refuted", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
    }));
    const state = director.state();
    expect(state.reconciles[0]?.status).toBe("refuted");
    expect(state.worldModel[0]?.claimId).toBe("experiment:reconcile:claim");
    expect(state.worldModel[0]?.hypothesis).toBe(prediction.hypothesis);
    expect(director.readyTasks()).toEqual([]);
  });

  test("raw self-report cannot update WORLD_MODEL and replay is idempotent", () => {
    const director = new MissionDirector({ missionId: "gated", objective: "learn", budget: 1, tasks: [task("experiment")] });
    director.selectNextTask();
    director.completeTask("experiment", completion({
      status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"],
      evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false,
    }));
    const before = director.events();
    expect(director.state().worldModel).toEqual([]);
    const restarted = MissionDirector.fromEvents({ missionId: "gated", objective: "learn", budget: 1, tasks: [task("experiment")] }, before);
    expect(restarted.state().reconciles).toHaveLength(1);
    expect(restarted.state().worldModel).toEqual([]);
    expect(restarted.reconcileTask("experiment", { status: "confirmed", observationRefs: ["observation"], artifactRefs: ["run-output"], evidenceRefs: ["observation"], evaluatorId: "agent", independentEvaluator: false, evidenceGatePassed: false })).toEqual(restarted.state().reconciles[0]);
    expect(restarted.events()).toHaveLength(before.length);
  });
});
