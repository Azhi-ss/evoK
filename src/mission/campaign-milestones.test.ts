import { describe, expect, test } from "bun:test";
import {
  MissionDirector,
  type Campaign,
  type ResearchEvent,
  type ResearchTask,
  type TaskCompletion,
} from "./research-loop";
import { digestValue, generateEvaluationKeyPair, signEvaluationDigest } from "../security-boundary";

const evaluatorKeys = generateEvaluationKeyPair("campaign-evaluator");
const trusted = [{ evaluatorId: evaluatorKeys.evaluatorId, publicKey: evaluatorKeys.publicKey }];
const evaluationProof = { evaluatorId: "campaign-evaluator", snapshotDigest: "artifact-digest", facts: { score: 1 } };
const evaluationDigest = digestValue(evaluationProof);

function prediction(taskId: string): ResearchTask["prediction"] {
  return {
    predictionId: `${taskId}-prediction`,
    hypothesis: `${taskId} hypothesis`,
    expectedObservation: `the evaluator returns the ${taskId} score`,
    expectedMetrics: [{ name: "score", min: 0 }],
    failureModes: ["evaluator unavailable"],
  };
}

function macroStep(taskId: string, priority: number, cost = 3): ResearchTask {
  return {
    taskId,
    objective: `macro step ${taskId}`,
    estimatedCost: cost,
    priority,
    ideaType: "systems",
    campaignId: "new-architecture",
    prediction: prediction(taskId),
  };
}

function microTweak(taskId: string, priority: number): ResearchTask {
  return {
    taskId,
    objective: `tune ${taskId}`,
    estimatedCost: 1,
    priority,
    ideaType: "algorithmic",
    prediction: prediction(taskId),
  };
}

const macroCampaign: Campaign = {
  campaignId: "new-architecture",
  goal: "replace the encoder with a new method family",
  ideaTypes: ["systems"],
  budget: 4,
  milestones: [
    { milestoneId: "arch-evidence", description: "arch evidence admitted", condition: { evidenceRefs: ["hypothesis-1", "observation-1"] } },
    { milestoneId: "arch-verifier", description: "verifier score reaches 0.5", condition: { verifierThreshold: { fact: "score", minimum: 0.5 } } },
  ],
  stopConditions: ["arch-evidence", "arch-verifier"],
};

function plainCompletion(taskId: string): TaskCompletion {
  return {
    operationId: `${taskId}-run`,
    evidence: [{ id: `${taskId}-hypothesis`, kind: "hypothesis", summary: `${taskId} hypothesis` }],
    reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
  };
}

function gatedCompletion(taskId: string): TaskCompletion {
  return {
    operationId: `${taskId}-run`,
    evidence: [
      { id: "hypothesis-1", kind: "hypothesis", summary: `${taskId} hypothesis` },
      { id: "observation-1", kind: "observation", summary: "evaluator returned score 1", refs: ["hypothesis-1"], metadata: { evaluation: evaluationProof, evaluationDigest, signature: signEvaluationDigest(evaluationDigest, evaluatorKeys.privateKey) } },
    ],
    artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    reconcile: {
      status: "confirmed",
      observationRefs: ["observation-1"],
      artifactRefs: ["artifact-1"],
      evidenceRefs: ["observation-1"],
      evaluatorId: "campaign-evaluator",
      independentEvaluator: true,
      evidenceGatePassed: true,
    },
  };
}

describe("campaign milestones and macro/micro budgets", () => {
  test("declares zero or more campaigns and validates tasks, idea types, and stop conditions", () => {
    const plain = new MissionDirector({ missionId: "c-0", objective: "learn", budget: 5, tasks: [microTweak("u1", 1)] });
    expect(plain.state().campaigns).toEqual([]);
    expect(plain.state().spend).toEqual({ micro: 0, macro: 0 });

    expect(() => new MissionDirector({ missionId: "c-1", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [{ ...macroStep("m1", 1), campaignId: "missing" }] })).toThrow(/unknown campaign/);
    expect(() => new MissionDirector({ missionId: "c-2", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [{ ...macroStep("m1", 1), ideaType: "algorithmic" }] })).toThrow(/not allowed/);
    expect(() => new MissionDirector({ missionId: "c-3", objective: "learn", budget: 10, campaigns: [{ ...macroCampaign, stopConditions: ["missing-milestone"] }], tasks: [macroStep("m1", 1)] })).toThrow(/unknown milestone/);
    expect(() => new MissionDirector({ missionId: "c-4", objective: "learn", budget: 10, campaigns: [{ ...macroCampaign, milestones: [{ milestoneId: "empty", description: "nothing to check", condition: {} }] }], tasks: [macroStep("m1", 1)] })).toThrow(/condition requires/);

    const director = new MissionDirector({ missionId: "c-5", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [macroStep("m1", 1), microTweak("u1", 9)] });
    expect(director.state().campaigns[0]?.goal).toBe("replace the encoder with a new method family");
    expect(director.state().campaigns[0]?.milestones).toHaveLength(2);
    expect(director.state().campaigns[0]?.milestones.every((milestone) => !milestone.completed)).toBe(true);
  });

  test("macro tasks draw the campaign envelope; exhaustion stops them without burning the micro budget", () => {
    const director = new MissionDirector({
      missionId: "c-env", objective: "learn", budget: 10, campaigns: [macroCampaign],
      tasks: [microTweak("u1", 9), macroStep("m1", 5), macroStep("m2", 4)],
    });
    expect(director.selectNextTask()?.taskId).toBe("u1");
    expect(director.selectNextTask()?.taskId).toBe("m1");
    expect(director.readyTasks()).toEqual([]);
    expect(director.selectNextTask()).toBeUndefined();

    const state = director.state();
    expect(state.spend).toEqual({ micro: 1, macro: 3 });
    expect(state.budget.consumed).toBe(4);
    expect(state.campaigns[0]?.budget).toEqual({ total: 4, consumed: 3, remaining: 1 });
    expect(state.campaigns[0]?.exhausted).toBe(false);

    const selections = director.events().filter((event) => event.type === "TASK_SELECTED");
    expect(selections.map((event) => event.payload.spend)).toEqual(["micro", "macro"]);
    expect(selections[1]?.payload.campaignId).toBe("new-architecture");

    // A forged selection beyond the envelope is rejected on replay instead of silently charging the micro budget.
    const forged: ResearchEvent = {
      sequence: director.events().length + 1,
      eventId: "forged-selection",
      type: "TASK_SELECTED",
      payload: { taskId: "m2", operationId: "forged-selection" },
    };
    expect(() => MissionDirector.replay([...director.events(), forged])).toThrow(/campaign budget/);
  });

  test("milestones complete from evidence, WORLD_MODEL claims, and verifier thresholds without leaderboard gains", () => {
    const forger = generateEvaluationKeyPair("forger");
    const forgedProof = { ...evaluationProof, facts: { score: 5 } };
    const forgedDigest = digestValue(forgedProof);
    const campaign: Campaign = {
      campaignId: "arch",
      goal: "ship the new encoder",
      ideaTypes: ["systems"],
      budget: 10,
      milestones: [
        { milestoneId: "m-evidence", description: "evidence admitted", condition: { evidenceRefs: ["hypothesis-1", "observation-1"] } },
        { milestoneId: "m-world", description: "claim admitted to WORLD_MODEL", condition: { worldModelClaimIds: ["encoder-rework:reconcile:claim"] } },
        { milestoneId: "m-verifier", description: "signed verifier score >= 0.5", condition: { verifierThreshold: { fact: "score", minimum: 0.5 } } },
        { milestoneId: "m-unmet", description: "verifier score >= 2", condition: { verifierThreshold: { fact: "score", minimum: 2 } } },
        { milestoneId: "m-forged", description: "forged signature must not count", condition: { verifierThreshold: { fact: "score", minimum: 4 } } },
        { milestoneId: "m-unregistered", description: "snapshot outside the artifact registry must not count", condition: { verifierThreshold: { fact: "score", minimum: 1.2 } } },
      ],
      stopConditions: ["m-evidence", "m-world", "m-verifier"],
    };
    const director = new MissionDirector({
      missionId: "c-milestones", objective: "learn", budget: 10, trustedEvaluators: trusted, campaigns: [campaign],
      tasks: [{ ...macroStep("encoder-rework", 1), campaignId: "arch" }],
    });
    expect(director.state().campaigns[0]?.milestones.map((milestone) => milestone.completed)).toEqual([false, false, false, false, false, false]);
    expect(director.selectNextTask()?.taskId).toBe("encoder-rework");
    const completion = gatedCompletion("encoder-rework");
    const unregisteredProof = { ...evaluationProof, snapshotDigest: "unregistered-snapshot", facts: { score: 1.5 } };
    const unregisteredDigest = digestValue(unregisteredProof);
    director.completeTask("encoder-rework", {
      ...completion,
      evidence: [...(completion.evidence ?? []), {
        id: "forged-obs",
        kind: "observation",
        summary: "forged score 5",
        refs: ["hypothesis-1"],
        metadata: { evaluation: forgedProof, evaluationDigest: forgedDigest, signature: signEvaluationDigest(forgedDigest, forger.privateKey) },
      }, {
        id: "unregistered-obs",
        kind: "observation",
        summary: "signed score for an unregistered snapshot",
        refs: ["hypothesis-1"],
        metadata: { evaluation: unregisteredProof, evaluationDigest: unregisteredDigest, signature: signEvaluationDigest(unregisteredDigest, evaluatorKeys.privateKey) },
      }],
    });

    const milestones = director.state().campaigns[0]!.milestones;
    const byId = Object.fromEntries(milestones.map((milestone) => [milestone.milestoneId, milestone]));
    expect(byId["m-evidence"]?.completed).toBe(true);
    expect(byId["m-evidence"]?.completedVia).toEqual(["evidence"]);
    expect(byId["m-world"]?.completed).toBe(true);
    expect(byId["m-world"]?.completedVia).toEqual(["world-model"]);
    expect(byId["m-verifier"]?.completed).toBe(true);
    expect(byId["m-verifier"]?.completedVia).toEqual(["verifier"]);
    expect(byId["m-unmet"]?.completed).toBe(false);
    expect(byId["m-forged"]?.completed).toBe(false);
    expect(byId["m-unregistered"]?.completed).toBe(false);
    expect(director.state().campaigns[0]?.stopConditionsMet).toBe(true);
    // No decision was forced on the Director: milestones never gate anything by themselves.
    expect(director.state().decisions).toEqual([]);
  });

  test("decisions reference campaign state; unknown campaigns are rejected", () => {
    const director = new MissionDirector({ missionId: "c-dec", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [macroStep("m1", 1), microTweak("u1", 9)] });
    expect(() => director.decide({ action: "Scale", campaignIds: ["missing"], evidenceRefs: ["no-such-evidence"], reason: "x" })).toThrow(/unknown evidence/);
    expect(director.selectNextTask()?.taskId).toBe("u1");
    director.completeTask("u1", plainCompletion("u1"));
    expect(() => director.decide({ action: "Scale", campaignIds: ["missing"], evidenceRefs: ["u1-hypothesis"], reason: "x" })).toThrow(/unknown campaign/);
    director.decide({ action: "Scale", campaignIds: ["new-architecture"], evidenceRefs: ["u1-hypothesis"], reason: "scale while margin remains" });
    director.decide({ action: "Continue", evidenceRefs: ["u1-hypothesis"], reason: "keep tuning" });

    const recorded = director.state().decisions[0]!;
    expect(recorded.action).toBe("Scale");
    expect(recorded.campaignIds).toEqual(["new-architecture"]);
    expect(recorded.scope).toBe("macro");
    expect(director.state().decisions[1]?.scope).toBe("micro");
    const event = director.events().find((entry) => entry.type === "DECISION_RECORDED");
    expect(event?.payload.decision).toMatchObject({ action: "Scale", campaignIds: ["new-architecture"], scope: "macro" });
  });

  test("Scale prefers expanding campaigns with remaining margin over deepening micro search", () => {
    const director = new MissionDirector({
      missionId: "c-scale", objective: "learn", budget: 10, campaigns: [macroCampaign],
      tasks: [macroStep("m1", 1), macroStep("m2", 1), microTweak("u1", 9), microTweak("u2", 8)],
    });
    expect(director.selectNextTask()?.taskId).toBe("u1");
    director.completeTask("u1", plainCompletion("u1"));
    director.decide({ action: "Scale", campaignIds: ["new-architecture"], evidenceRefs: ["u1-hypothesis"], reason: "scale the macro branch" });

    // A lower-priority campaign task with envelope margin beats the higher-priority micro task.
    expect(director.selectNextTask()?.taskId).toBe("m1");
    director.completeTask("m1", plainCompletion("m1"));
    // Envelope margin after m1 is 1 < m2's cost of 3: no campaign margin remains, so selection
    // falls back to the micro backlog instead of overrunning the envelope.
    expect(director.selectNextTask()?.taskId).toBe("u2");
    expect(director.state().spend).toEqual({ micro: 2, macro: 3 });
  });

  test("high local micro scores with incomplete milestones do not block Revise from opening a new macro branch", () => {
    const director = new MissionDirector({
      missionId: "c-seam", objective: "learn", budget: 12,
      campaigns: [{ ...macroCampaign, budget: 3 }],
      tasks: [macroStep("m1", 1), microTweak("u1", 9)],
    });
    expect(director.selectNextTask()?.taskId).toBe("u1");
    director.completeTask("u1", {
      operationId: "u1-run",
      evidence: [{ id: "hypothesis-1", kind: "hypothesis", summary: "lr tweak hypothesis" }],
      findings: [{ id: "finding-high", statement: "local score jumped", evidenceRefs: ["hypothesis-1"], verified: true, priorityDelta: 100 }],
      candidates: [{ candidateId: "tweak-candidate", digest: "tweak-digest", ideaType: "algorithmic", promoted: true }],
      reconcile: { status: "inconclusive", observationRefs: [], artifactRefs: [], evidenceRefs: [], independentEvaluator: false, evidenceGatePassed: false },
    });

    const before = director.state();
    expect(before.candidates).toHaveLength(1);
    expect(before.campaigns[0]!.milestones.every((milestone) => !milestone.completed)).toBe(true);

    director.decide({ action: "Revise", campaignIds: ["new-architecture"], evidenceRefs: ["finding-high"], reason: "local tweaks plateaued; open a new macro branch" });
    expect(director.state().decisions.at(-1)?.action).toBe("Revise");

    director.replan({
      parentPlanDigest: before.planDigest,
      objective: "learn",
      totalBudget: 12,
      evidenceRefs: ["finding-high"],
      reason: "open a new macro branch within the mission budget",
      campaigns: [{ ...macroCampaign, budget: 7 }],
      tasks: [microTweak("u1", 9), macroStep("m1", 1), macroStep("m2", 2)],
    });

    const next = director.selectNextTask();
    expect(next?.taskId).toBe("m2"); // the new macro branch
    expect(next?.campaignId).toBe("new-architecture");
    expect(director.state().campaigns[0]?.budget).toEqual({ total: 7, consumed: 3, remaining: 4 });
    expect(director.state().spend).toEqual({ micro: 1, macro: 3 });
    expect(director.state().campaigns[0]?.milestones.every((milestone) => !milestone.completed)).toBe(true);
  });

  test("re-plan cannot drop or shrink a campaign that already spent its envelope", () => {
    const director = new MissionDirector({ missionId: "c-replan", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [macroStep("m1", 5), microTweak("u1", 1)] });
    expect(director.selectNextTask()?.taskId).toBe("m1");
    const state = director.state();
    const base = {
      parentPlanDigest: state.planDigest,
      objective: "learn",
      totalBudget: 10,
      evidenceRefs: [],
      reason: "adjust campaigns",
      tasks: [macroStep("m1", 5), microTweak("u1", 1)],
    } as const;
    expect(() => director.replan({ ...base, campaigns: [] })).toThrow(/unknown campaign/);
    expect(() => director.replan({ ...base, campaigns: [{ ...macroCampaign, budget: 2 }] })).toThrow(/shrink/);
    director.replan({ ...base, campaigns: [macroCampaign] });
    expect(director.state().campaigns[0]?.budget.total).toBe(4);
  });

  test("restarts preserve campaign declarations and consumed envelopes", () => {
    const options = { missionId: "c-restart", objective: "learn", budget: 10, campaigns: [macroCampaign], tasks: [macroStep("m1", 5), microTweak("u1", 1)] } as const;
    const director = new MissionDirector(options);
    director.selectNextTask();
    const restarted = MissionDirector.fromEvents(options, director.events());
    expect(restarted.state().campaigns[0]?.budget.consumed).toBe(3);
    expect(restarted.state().spend).toEqual({ micro: 0, macro: 3 });
    expect(() => MissionDirector.fromEvents({ ...options, campaigns: [] }, director.events())).toThrow(/campaign declaration/);
  });
});
