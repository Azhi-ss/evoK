import type { PredictionArtifact } from "../predict-reconcile";
import type { ResearchTask } from "../research-loop";

/** Explicit test input; production callers must declare their own prediction. */
export const RESEARCH_PREDICTION: PredictionArtifact = {
  predictionId: "fixture-prediction",
  hypothesis: "the candidate can be independently evaluated under the declared rules",
  expectedObservation: "the evaluator returns the candidate score",
  failureModes: ["invalid candidate", "split or OOF verification fails"],
};

export const RESEARCH_TASKS: readonly ResearchTask[] = [
  {
    taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3,
    prediction: { ...RESEARCH_PREDICTION, predictionId: "baseline-prediction" },
  },
  {
    taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2,
    prediction: { ...RESEARCH_PREDICTION, predictionId: "cheap-check-prediction" },
  },
];
