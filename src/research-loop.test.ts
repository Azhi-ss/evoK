import { describe, expect, test } from "bun:test";
import {
  MissionDirector,
  type ResearchEvent,
  type ResearchTask,
  type TaskCompletion,
} from "./research-loop";

const tasks: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
  { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
];

function completion(): TaskCompletion {
  return {
    operationId: "baseline-run-1",
    evidence: [
      { id: "hypothesis-1", kind: "hypothesis", summary: "the revised method should improve score" },
      { id: "observation-1", kind: "observation", summary: "the revised method improved the baseline", refs: ["hypothesis-1"] },
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
  };
}

describe("long-running research loop", () => {
  test("uses a completed Task evidence chain to generate and select the next ready Task", () => {
    const director = new MissionDirector({
      missionId: "loop-1",
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
      tasks: [{ taskId: "generated-task", objective: "test the revised method", dependencies: ["baseline"], requiredEvidence: ["pitfall-1"], estimatedCost: 2 }],
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
    const director = new MissionDirector({ missionId: "loop-2", objective: "learn", budget: 5, tasks });
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
    const director = new MissionDirector({ missionId: "loop-3", objective: "learn", budget: 5, tasks });
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
    const options = { missionId: "loop-4", objective: "learn", budget: 5, tasks } as const;
    const director = new MissionDirector(options);
    director.selectNextTask();
    director.completeTask("baseline", completion());
    const before = director.events();
    const restarted = MissionDirector.fromEvents({ missionId: options.missionId, objective: options.objective, budget: options.budget }, before);

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
    expect(() => director.completeTask("baseline", { operationId: "select-baseline-1" })).toThrow("different research operation");

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
    expect(result.negativeEvidence).toHaveLength(1);
    expect(result.negativeEvidence[0]?.statement).toBe("evaluator unavailable");
  });

  test("deduplicates content-addressed Candidates and Artifacts across Tasks", () => {
    const director = new MissionDirector({ missionId: "loop-8", objective: "learn", budget: 5, tasks });
    director.selectNextTask();
    director.completeTask("baseline", {
      operationId: "baseline-candidate",
      candidates: [{ candidateId: "candidate-1", digest: "candidate-digest" }],
      artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    });
    director.selectNextTask();
    director.completeTask("cheap-check", {
      operationId: "cheap-candidate",
      candidates: [{ candidateId: "candidate-1", digest: "candidate-digest" }],
      artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    });
    expect(director.state().candidates).toHaveLength(1);
    expect(director.state().artifacts).toHaveLength(1);
  });
});
