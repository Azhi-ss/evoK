import { describe, expect, test } from "bun:test";
import { MissionDirector, type ResearchTask, type TaskCompletion } from "./research-loop";

function pred(taskId: string): ResearchTask["prediction"] {
  return {
    predictionId: `${taskId}-prediction`,
    hypothesis: `${taskId} hypothesis`,
    expectedObservation: `the evaluator returns a ${taskId} score`,
    failureModes: ["evaluator unavailable"],
  };
}

function completionFor(taskId: string): TaskCompletion {
  return {
    operationId: `run-${taskId}-1`,
    evidence: [
      { id: `hypo-${taskId}`, kind: "hypothesis", summary: "the approach should improve score" },
      { id: `obs-${taskId}`, kind: "observation", summary: "the approach produced a score", refs: [`hypo-${taskId}`] },
    ],
    artifacts: [{ artifactId: `artifact-${taskId}`, digest: `artifact-digest-${taskId}` }],
    reconcile: {
      status: "inconclusive", observationRefs: [`obs-${taskId}`], artifactRefs: [`artifact-${taskId}`],
      evidenceRefs: [`obs-${taskId}`], independentEvaluator: false, evidenceGatePassed: false,
    },
  };
}

function director(tasks: readonly ResearchTask[], baselineTrack?: unknown) {
  return new MissionDirector({
    missionId: "baseline-first-director",
    objective: "win the tabular competition",
    budget: 100,
    ...(baselineTrack === undefined ? {} : { baselineTrack: baselineTrack as never }),
    tasks,
  });
}

const tasks: readonly ResearchTask[] = [
  { taskId: "t-baseline", objective: "run LightGBM/AutoGluon strong baseline", estimatedCost: 1, tags: ["baseline_track"], prediction: pred("t-baseline") },
  { taskId: "t-cheap", objective: "cheap data cleanup", estimatedCost: 1, ideaType: "systems", prediction: pred("t-cheap") },
  { taskId: "t-heavy-search", objective: "large-budget fancy open-ended search", estimatedCost: 20, ideaType: "open-search", prediction: pred("t-heavy-search") },
];

describe("T43 Mission Director baseline-first task ordering", () => {
  test("a heavy open-search task is not ready before the baseline; baseline and cheap tasks are", () => {
    const d = director(tasks, { entry: "lightgbm", success_score: 0.7 });
    const readyIds = d.readyTasks().map((t) => t.taskId);
    expect(readyIds).toContain("t-baseline");
    expect(readyIds).toContain("t-cheap");
    expect(readyIds).not.toContain("t-heavy-search");

    // Selection never picks the heavy task while the baseline is unfinished.
    for (let i = 0; i < 3; i += 1) {
      const picked = d.selectNextTask();
      expect(picked?.taskId).not.toBe("t-heavy-search");
    }
  });

  test("heavy task becomes eligible after the baseline task completes", () => {
    const d = director(tasks, { entry: "lightgbm", success_score: 0.7 });
    d.selectNextTask(); // baseline selected first
    d.completeTask("t-baseline", completionFor("t-baseline"));

    const readyIds = d.readyTasks().map((t) => t.taskId);
    expect(readyIds).toContain("t-heavy-search");
  });

  test("without a declared baseline track, ordering is unchanged (gate inactive)", () => {
    const d = director(tasks);
    const readyIds = d.readyTasks().map((t) => t.taskId);
    expect(readyIds).toContain("t-heavy-search");
    expect(readyIds).toContain("t-baseline");
    expect(readyIds).toContain("t-cheap");
  });
});
