import { describe, expect, test } from "bun:test";
import {
  MissionDirector,
  type ResearchEvent,
  type ResearchTask,
  type TaskCompletion,
} from "./research-loop";import { digestValue, generateEvaluationKeyPair, signEvaluationDigest } from "./security-boundary";

// Signed independent-evaluator proof bound to the registered "artifact-1" digest; missions register only
// the evaluator's public key, so completions cannot forge the gate.
const evaluatorKeys = generateEvaluationKeyPair("independent-evaluator");
const trusted = [{ evaluatorId: evaluatorKeys.evaluatorId, publicKey: evaluatorKeys.publicKey }];
const evaluationProof = { evaluatorId: "independent-evaluator", snapshotDigest: "artifact-digest", facts: { score: 1 } };
const evaluationDigest = digestValue(evaluationProof);

const tasks: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3, prediction: {
    predictionId: "baseline-prediction", hypothesis: "the baseline is measurable", expectedObservation: "the evaluator returns a baseline", failureModes: ["evaluator unavailable"],
  } },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2, prediction: {
    predictionId: "cheap-prediction", hypothesis: "the cheap alternative works", expectedObservation: "the evaluator returns a score", failureModes: ["evaluation fails"],
  } },
];

function completion(): TaskCompletion {
  return {
    operationId: "baseline-run-1",
    evidence: [
      { id: "hypothesis-1", kind: "hypothesis", summary: "the revised method should improve score" },
      { id: "observation-1", kind: "observation", summary: "the revised method improved the baseline", refs: ["hypothesis-1"], metadata: { evaluation: evaluationProof, evaluationDigest, signature: signEvaluationDigest(evaluationDigest, evaluatorKeys.privateKey) } },
    ],
    findings: [{
      id: "finding-1",
      statement: "the revised method is worth testing next",
      evidenceRefs: ["observation-1"],
      verified: true,
      relatedTaskIds: ["generated-task"],
      priorityDelta: 10,
      recommendedAction: "Continue",
    }],
    negativeEvidence: [{
      id: "negative-1",
      statement: "the old split leaks validation data",
      category: "rule-violation",
      evidenceRefs: ["observation-1"],
      relatedTaskIds: ["generated-task"],
    }],
    pitfalls: [{
      id: "pitfall-1",
      pattern: "validation leakage through a shared preprocessing step",
      answerAgnostic: true,
      evidenceRefs: ["negative-1"],
      tags: ["data-leakage"],
      scope: { competition: "demo", environment: "cpu" },
    }],
    candidates: [{ candidateId: "candidate-1", digest: "candidate-digest" }],
    artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    reconcile: {
      status: "inconclusive", observationRefs: ["observation-1"], artifactRefs: ["artifact-1"], evidenceRefs: ["observation-1"],
      evaluatorId: "independent-evaluator", independentEvaluator: true, evidenceGatePassed: true,
    },
  };
}

const typedTasks: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3, ideaType: "systems", prediction: {
    predictionId: "baseline-prediction", hypothesis: "the baseline is measurable", expectedObservation: "the evaluator returns a baseline", failureModes: ["evaluator unavailable"],
  } },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2, ideaType: "algorithmic", prediction: {
    predictionId: "cheap-prediction", hypothesis: "the cheap alternative works", expectedObservation: "the evaluator returns a cheaper score", failureModes: ["evaluator unavailable"],
  } },
  { taskId: "open-search", objective: "search the open space", estimatedCost: 1, priority: 1, ideaType: "open-search", prediction: {
    predictionId: "search-prediction", hypothesis: "open search finds something", expectedObservation: "the evaluator returns a search score", failureModes: ["evaluator unavailable"],
  } },
];

function typedPrediction(taskId: string): ResearchTask["prediction"] {
  return {
    predictionId: `${taskId}-prediction`,
    hypothesis: `${taskId} hypothesis`,
    expectedObservation: `the evaluator returns the ${taskId} score`,
    failureModes: ["evaluator unavailable"],
  };
}

describe("long-running research loop", () => {
  test("uses a completed Task evidence chain to generate and select the next ready Task", () => {
    const director = new MissionDirector({
      missionId: "loop-1", trustedEvaluators: trusted,
      objective: "improve the competition result",
      budget: 10,
      scope: { competition: "demo", environment: "cpu" },
      tasks,
    });

    expect(director.selectNextTask()?.taskId).toBe("baseline");
    director.completeTask("baseline", completion());
    const generation = {
      sourceTaskId: "baseline",
      evidenceRefs: ["finding-1", "negative-1"],
      tasks: [{ taskId: "generated-task", objective: "test the revised method", dependencies: ["baseline"], requiredEvidence: ["pitfall-1"], estimatedCost: 2, prediction: {
        predictionId: "generated-prediction", hypothesis: "the revised method works", expectedObservation: "the evaluator confirms the revised method", failureModes: ["evaluation fails"],
      } }],
      operationId: "generation-1",
    } as const;
    director.generateTasks(generation);
    const eventCount = director.events().length;
    director.generateTasks(generation);

    expect(director.events()).toHaveLength(eventCount);
    expect(director.readyTasks().map((task) => task.taskId)).toEqual(["generated-task", "cheap-check"]);
    expect(director.selectNextTask()?.taskId).toBe("generated-task");
    expect(director.state().budget.consumed).toBe(4);
  });

  test("keeps only verified Findings in memory and retrieves scoped Negative Evidence and Pitfalls", () => {
    const director = new MissionDirector({ missionId: "loop-2", objective: "learn", budget: 5, tasks, trustedEvaluators: trusted });
    expect(director.recordFinding({ id: "draft", statement: "unverified", evidenceRefs: [], verified: false })).toBe(false);
    expect(director.evidenceMemory().getFinding("draft")).toBeUndefined();

    director.selectNextTask();
    director.completeTask("baseline", completion());
    const memory = director.evidenceMemory();
    expect(memory.getFinding("finding-1")?.verified).toBe(true);
    expect(memory.searchNegativeEvidence("leaks")).toHaveLength(1);
    expect(memory.searchPitfalls({ text: "preprocessing", scope: { competition: "demo", environment: "cpu" } })).toHaveLength(1);
    expect(memory.searchPitfalls({ scope: { competition: "other", environment: "cpu" } })).toHaveLength(0);
    expect(memory.chain("finding-1").map((item) => item.id)).toEqual(["hypothesis-1", "observation-1", "finding-1"]);
  });

  test("records evidence-backed Continue, Revise, Scale, and Stop decisions", () => {
    const director = new MissionDirector({ missionId: "loop-3", objective: "learn", budget: 5, tasks, trustedEvaluators: trusted });
    director.selectNextTask();
    director.completeTask("baseline", completion());

    for (const action of ["Continue", "Revise", "Scale"] as const) {
      director.decide({ action, evidenceRefs: ["finding-1"], reason: `${action} from evidence` });
    }
    expect(() => director.decide({ action: "Stop", evidenceRefs: [], reason: "missing evidence" })).toThrow();
    director.decide({ action: "Stop", evidenceRefs: ["negative-1"], reason: "rule risk is unresolved" });

    expect(director.state().phase).toBe("STOPPED");
    expect(director.state().stopReason).toBe("rule risk is unresolved");
    expect(director.state().decisions.map((decision) => decision.action)).toEqual(["Continue", "Revise", "Scale", "Stop"]);
  });

  test("restarts from a checkpoint without losing verified evidence or duplicating a completion", () => {
    const options = { missionId: "loop-4", objective: "learn", budget: 5, tasks, trustedEvaluators: trusted } as const;
    const director = new MissionDirector(options);
    director.selectNextTask();
    director.completeTask("baseline", completion());
    const before = director.events();
    const restarted = MissionDirector.fromEvents({ missionId: options.missionId, objective: options.objective, budget: options.budget, trustedEvaluators: trusted }, before);

    expect(restarted.evidenceMemory().getFinding("finding-1")).toEqual(director.evidenceMemory().getFinding("finding-1"));
    expect(restarted.state().tasks.baseline.candidateRefs).toEqual([{ candidateId: "candidate-1", digest: "candidate-digest" }]);
    expect(restarted.state().tasks.baseline.artifactRefs).toEqual([{ artifactId: "artifact-1", digest: "artifact-digest" }]);
    expect(restarted.state().candidates).toEqual([{ candidateId: "candidate-1", digest: "candidate-digest" }]);
    expect(restarted.state().artifacts).toEqual([{ artifactId: "artifact-1", digest: "artifact-digest" }]);
    restarted.completeTask("baseline", completion());
    expect(restarted.events()).toHaveLength(before.length);
    expect(restarted.state().candidates).toHaveLength(1);
    expect(restarted.state().artifacts).toHaveLength(1);
  });

  test("bounds coordinator re-plan to the original objective, budget, and evidence", () => {
    const director = new MissionDirector({ missionId: "loop-5", objective: "learn", budget: 5, tasks });
    const parentPlanDigest = director.state().planDigest;
    const replannedTasks = [
      tasks[0]!,
      { ...tasks[1]!, objective: "check a cheaper alternative", priority: 9 },
    ];
    const proposal = (overrides: Record<string, unknown> = {}) => ({
      parentPlanDigest,
      objective: "learn",
      totalBudget: 5,
      evidenceRefs: [],
      reason: "re-plan from current evidence",
      tasks: replannedTasks,
      operationId: "replan-1",
      ...overrides,
    });

    expect(() => director.replan(proposal({ objective: "change the mission" }))).toThrow();
    expect(() => director.replan(proposal({ totalBudget: 6 }))).toThrow();
    const result = director.replan(proposal());
    const eventCount = director.events().length;
    expect(director.replan(proposal()).planVersion).toBe(2);
    expect(director.events()).toHaveLength(eventCount);
    expect(result.planVersion).toBe(2);
    expect(director.state().objective).toBe("learn");
    expect(director.state().tasks["cheap-check"]?.objective).toBe("check a cheaper alternative");
    expect(director.state().tasks["cheap-check"]?.priority).toBe(9);
    expect(director.state().budget.total).toBe(5);
  });

  test("rejects operation-id reuse for a different mutation and refuses a corrupted ledger tail", () => {
    const director = new MissionDirector({ missionId: "loop-6", objective: "learn", budget: 5, tasks });
    director.selectNextTask();
    expect(() => director.completeTask("baseline", { operationId: "select-baseline-1", reconcile: completion().reconcile })).toThrow("different research operation");

    const malformed: ResearchEvent = {
      sequence: 4,
      eventId: "corrupt-event",
      type: "TASK_SELECTED",
      payload: { taskId: "baseline", operationId: "corrupt" },
    };
    expect(() => MissionDirector.replay([...director.events(), malformed])).toThrow("sequence gap");
  });

  test("turns an executor failure into reusable Negative Evidence", async () => {
    const director = new MissionDirector({ missionId: "loop-7", objective: "learn", budget: 2, tasks: [tasks[0]!] });
    const result = await director.run(() => { throw new Error("evaluator unavailable"); });
    expect(result.tasks.baseline?.status).toBe("FAILED");
    expect(result.reconciles).toHaveLength(1);
    expect(result.reconciles[0]?.status).toBe("inconclusive");
    expect(result.reconciles[0]?.observationRefs.length).toBeGreaterThan(0);
    expect(result.negativeEvidence).toHaveLength(1);
    expect(result.negativeEvidence[0]?.statement).toBe("evaluator unavailable");
  });

  test("deduplicates content-addressed Candidates and Artifacts across Tasks", () => {
    const director = new MissionDirector({ missionId: "loop-8", objective: "learn", budget: 5, tasks });
    director.selectNextTask();
    director.completeTask("baseline", {
      operationId: "baseline-candidate", candidates: [{ candidateId: "candidate-1", digest: "candidate-digest" }],
      artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: ["artifact-1"], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    });
    director.selectNextTask();
    director.completeTask("cheap-check", {
      operationId: "cheap-candidate", candidates: [{ candidateId: "candidate-1", digest: "candidate-digest" }],
      artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: ["artifact-1"], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    });
    expect(director.state().candidates).toHaveLength(1);
    expect(director.state().artifacts).toHaveLength(1);
  });

  test("task and candidate idea types must be registered; candidate promotion flags are booleans", () => {
    expect(() => new MissionDirector({
      missionId: "typed-registry", objective: "learn", budget: 5,
      tasks: [{ ...typedTasks[0]!, ideaType: "vibes" }],
    })).toThrow(/registered idea type/);

    const director = new MissionDirector({ missionId: "typed-registry-2", objective: "learn", budget: 5, tasks: typedTasks });
    director.selectNextTask();
    expect(() => director.completeTask("baseline", {
      operationId: "typed-candidate",
      candidates: [{ candidateId: "candidate-1", digest: "candidate-digest", ideaType: "unregistered" }],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    })).toThrow(/registered idea type/);
    expect(() => director.completeTask("baseline", {
      operationId: "typed-candidate-2",
      candidates: [{ candidateId: "candidate-1", digest: "candidate-digest", ideaType: "systems", promoted: "yes" as unknown as boolean }],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    })).toThrow(/promoted/);
  });

  test("mission status counts attempts and promotion rates per idea type for bias audit", () => {
    const director = new MissionDirector({ missionId: "typed-stats", objective: "learn", budget: 20, tasks: typedTasks });
    director.selectNextTask();
    director.completeTask("baseline", {
      operationId: "typed-stats-completion",
      candidates: [
        { candidateId: "sys-1", digest: "sys-digest-1", ideaType: "systems" },
        { candidateId: "sys-2", digest: "sys-digest-2", ideaType: "systems", promoted: true },
        { candidateId: "alg-1", digest: "alg-digest-1", ideaType: "algorithmic", promoted: true },
      ],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    });
    expect(director.state().ideaTypeStats).toEqual([
      { ideaType: "algorithmic", attempts: 1, promoted: 1, promotionRate: 1 },
      { ideaType: "systems", attempts: 2, promoted: 1, promotionRate: 0.5 },
    ]);
  });

  test("default soft preference admits algorithmic and open-search tasks into selection", () => {
    const director = new MissionDirector({
      missionId: "typed-soft", objective: "learn", budget: 20,
      tasks: [
        { taskId: "sys-1", objective: "tune", estimatedCost: 1, priority: 9, ideaType: "systems", prediction: typedPrediction("sys-1") },
        { taskId: "sys-2", objective: "tune more", estimatedCost: 1, priority: 8, ideaType: "systems", prediction: typedPrediction("sys-2") },
        { taskId: "alg-1", objective: "new algorithm", estimatedCost: 1, priority: 1, ideaType: "algorithmic", prediction: typedPrediction("alg-1") },
      ],
    });
    expect(director.selectNextTask()?.taskId).toBe("sys-1");
    expect(director.selectNextTask()?.taskId).toBe("alg-1");
    expect(director.selectNextTask()?.taskId).toBe("sys-2");
  });

  test("explicit idea type preference overrides the default rotation", () => {
    const director = new MissionDirector({
      missionId: "typed-explicit", objective: "learn", budget: 20,
      ideaTypePreference: ["open-search"],
      tasks: [
        { taskId: "sys-1", objective: "tune", estimatedCost: 1, priority: 9, ideaType: "systems", prediction: typedPrediction("sys-1") },
        { taskId: "search-1", objective: "open search", estimatedCost: 1, priority: 1, ideaType: "open-search", prediction: typedPrediction("search-1") },
      ],
    });
    expect(director.selectNextTask()?.taskId).toBe("search-1");
  });
});
