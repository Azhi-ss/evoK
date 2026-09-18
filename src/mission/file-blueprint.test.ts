import { describe, expect, test } from "bun:test";
import {
  BLUEPRINT_FILE_KINDS,
  blueprintFileDigest,
  normalizeBlueprintFile,
  type ExperimentsFile,
  type GoalFile,
  type RulesFile,
  type ScoreboardFile,
} from "./file-blueprint";
import { MissionDirector, type ResearchEvent, type ResearchTask, type TaskCompletion } from "./research-loop";
import { digestValue, generateEvaluationKeyPair, signEvaluationDigest } from "../security-boundary";

const evaluatorKeys = generateEvaluationKeyPair("independent-evaluator");
const trusted = [{ evaluatorId: evaluatorKeys.evaluatorId, publicKey: evaluatorKeys.publicKey }];
const evaluationProof = { evaluatorId: "independent-evaluator", snapshotDigest: "artifact-digest", facts: { score: 1 } };
const evaluationDigest = digestValue(evaluationProof);

const tasks: readonly ResearchTask[] = [
  {
    taskId: "baseline",
    objective: "measure the baseline",
    estimatedCost: 2,
    priority: 3,
    prediction: {
      predictionId: "baseline-prediction",
      hypothesis: "the baseline is measurable",
      expectedObservation: "the evaluator returns a baseline",
      failureModes: ["evaluator unavailable"],
    },
  },
];

function completion(): TaskCompletion {
  return {
    operationId: "baseline-run-1",
    evidence: [
      { id: "hypothesis-1", kind: "hypothesis", summary: "the revised method should improve score" },
      {
        id: "observation-1",
        kind: "observation",
        summary: "the revised method improved the baseline",
        refs: ["hypothesis-1"],
        metadata: {
          evaluation: evaluationProof,
          evaluationDigest,
          signature: signEvaluationDigest(evaluationDigest, evaluatorKeys.privateKey),
        },
      },
    ],
    findings: [{
      id: "finding-1",
      statement: "the loop feels finished",
      evidenceRefs: ["observation-1"],
      verified: true,
      recommendedAction: "Stop",
      stopReason: "scoreboard looks good enough",
    }],
    artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    reconcile: {
      status: "inconclusive",
      observationRefs: ["observation-1"],
      artifactRefs: ["artifact-1"],
      evidenceRefs: ["observation-1"],
      evaluatorId: "independent-evaluator",
      independentEvaluator: true,
      evidenceGatePassed: true,
    },
  };
}

function director(): MissionDirector {
  const loop = new MissionDirector({
    missionId: "blueprint-1",
    objective: "improve the competition result",
    budget: 10,
    tasks,
    trustedEvaluators: trusted,
  });
  loop.selectNextTask();
  loop.completeTask("baseline", completion());
  return loop;
}

describe("File Blueprint mission state (#22)", () => {
  test("missing SCOREBOARD or GOAL means the Mission Director cannot silently Stop", () => {
    const loop = director();

    expect(loop.state().phase).toBe("RUNNING");
    expect(loop.state().stopReason).toBeUndefined();
    expect(loop.state().blueprint?.files.GOAL).toBeUndefined();
    expect(loop.state().blueprint?.files.SCOREBOARD).toBeUndefined();

    expect(() => loop.decide({
      action: "Stop",
      evidenceRefs: ["finding-1"],
      reason: "the files are missing so we must be done",
    })).toThrow(/GOAL|SCOREBOARD/);

    expect(loop.state().phase).toBe("RUNNING");
    expect(loop.state().stopReason).toBeUndefined();
  });

  test("documents the minimal file set and required fields", () => {
    expect(BLUEPRINT_FILE_KINDS).toEqual(["GOAL", "RULES", "EXPERIMENTS", "SCOREBOARD"]);

    const goal = normalizeBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
      constraints: ["no test-set leakage"],
    }) as GoalFile;
    const rules = normalizeBlueprintFile({
      kind: "RULES",
      competitionId: "demo",
      allowed: ["local evaluation"],
      forbidden: ["external submission"],
      evaluationContractRef: "observation-1",
    }) as RulesFile;
    const experiments = normalizeBlueprintFile({
      kind: "EXPERIMENTS",
      entries: [{
        experimentId: "exp-1",
        hypothesis: "the revised method should improve score",
        candidateRef: "candidate-1",
        evidenceRefs: ["observation-1"],
        outcome: "improved the baseline",
        recordedAt: 1,
      }],
    }) as ExperimentsFile;
    const scoreboard = normalizeBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "candidate-1",
        metric: "score",
        value: 1,
        evaluationRef: "observation-1",
        evidenceRefs: ["finding-1"],
      }],
    }) as ScoreboardFile;

    expect(goal.objective).toBe("improve the competition result");
    expect(goal.successCriteria).toEqual(["beat the verified baseline"]);
    expect(rules.forbidden).toEqual(["external submission"]);
    expect(experiments.entries[0]?.evidenceRefs).toEqual(["observation-1"]);
    expect(scoreboard.rows[0]?.evaluationRef).toBe("observation-1");
    expect(() => normalizeBlueprintFile({ kind: "GOAL", objective: "x", successCriteria: [] })).toThrow(/successCriteria/);
  });

  test("writes Cross-review outputs as content-addressed refs later Tasks can read", () => {
    const loop = director();
    loop.commitBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
    });
    const scoreboard = loop.commitBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "candidate-1",
        metric: "score",
        value: 1,
        evaluationRef: "observation-1",
        evidenceRefs: ["finding-1"],
      }],
    });
    expect(loop.pendingCrossReviewSubjects()).toEqual(["blueprint:GOAL", scoreboard.artifactId]);

    const review = loop.recordCrossReview({
      reviewId: "review-1",
      phase: "author",
      subjectRefs: [scoreboard.artifactId],
      findings: ["the scoreboard row cites the evaluator observation"],
      evidenceRefs: ["finding-1"],
    });
    const reviewer = loop.recordCrossReview({
      reviewId: "review-2",
      phase: "reviewer",
      subjectRefs: [review.artifactId],
      findings: ["author notes are consistent with the evidence refs"],
      evidenceRefs: ["cross-review:review-1"],
    });

    expect(loop.pendingCrossReviewSubjects()).toEqual(["blueprint:GOAL"]);
    expect(review.authoritative).toBe(false);
    expect(reviewer.authoritative).toBe(false);
    expect(review.digest).toBe(digestValue({
      reviewId: review.reviewId,
      phase: review.phase,
      subjectRefs: review.subjectRefs,
      findings: review.findings,
      evidenceRefs: review.evidenceRefs,
    }));
    expect(loop.evidenceMemory().has("cross-review:review-1")).toBe(true);
    expect(loop.evidenceMemory().has("cross-review:review-2")).toBe(true);
    expect(loop.state().artifacts.some((artifact) => artifact.digest === review.digest)).toBe(true);

    const generated = loop.generateTasks({
      sourceTaskId: "baseline",
      evidenceRefs: ["cross-review:review-2"],
      tasks: [{
        taskId: "follow-up",
        objective: "repair from the cross-review",
        dependencies: ["baseline"],
        estimatedCost: 1,
        prediction: {
          predictionId: "follow-up-prediction",
          hypothesis: "the review points at a repair",
          expectedObservation: "the evaluator re-scores the repair",
          failureModes: ["evaluation fails"],
        },
      }],
      operationId: "gen-from-review",
    });
    expect(generated.map((task) => task.taskId)).toEqual(["follow-up"]);
  });

  test("File Blueprint and Cross-review cannot bypass the independent evaluator gate", () => {
    const loop = director();
    loop.commitBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
    });
    loop.commitBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "candidate-1",
        metric: "score",
        value: 99,
        evaluationRef: "observation-1",
        evidenceRefs: ["finding-1"],
      }],
      championRef: "candidate-1",
    });
    expect(() => loop.recordCrossReview({
      reviewId: "reviewer-only",
      phase: "reviewer",
      subjectRefs: ["blueprint:SCOREBOARD"],
      findings: ["promote this candidate"],
    })).toThrow(/author Cross-review/);
    const author = loop.recordCrossReview({
      reviewId: "promote-please-author",
      phase: "author",
      subjectRefs: ["blueprint:SCOREBOARD"],
      findings: ["scoreboard cites evaluator evidence"],
    });
    loop.recordCrossReview({
      reviewId: "promote-please",
      phase: "reviewer",
      subjectRefs: [author.artifactId],
      findings: ["promote this candidate"],
    });

    expect(loop.state().blueprint.files.SCOREBOARD?.digest).toBeDefined();
    expect(loop.state().candidates.some((candidate) => candidate.promoted === true)).toBe(false);
    expect(loop.state().worldModel).toHaveLength(1);
    expect(loop.state().worldModel[0]?.next).not.toBe("promote-eligible");

    const ungated = new MissionDirector({
      missionId: "blueprint-ungated",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    ungated.selectNextTask();
    ungated.completeTask("baseline", {
      operationId: "ungated-run",
      evidence: [{ id: "self-report", kind: "observation", summary: "the agent says it won" }],
      findings: [{
        id: "self-finding",
        statement: "promote from the scoreboard file",
        evidenceRefs: ["self-report"],
        verified: true,
        recommendedAction: "Stop",
      }],
      reconcile: {
        status: "inconclusive",
        observationRefs: ["self-report"],
        artifactRefs: [],
        evidenceRefs: ["self-report"],
        independentEvaluator: false,
        evidenceGatePassed: false,
      },
    });
    ungated.commitBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["feel done"],
    });
    expect(() => ungated.commitBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "self",
        metric: "score",
        value: 100,
        evaluationRef: "self-report",
        evidenceRefs: ["self-finding"],
      }],
      championRef: "self",
    })).toThrow(/independent evaluator observation/);
    ungated.commitBlueprintFile({ kind: "SCOREBOARD", rows: [] });
    expect(ungated.state().worldModel).toHaveLength(0);
    expect(() => ungated.decide({
      action: "Stop",
      evidenceRefs: ["self-finding"],
      reason: "scoreboard file names a champion",
    })).not.toThrow();
    expect(ungated.state().worldModel).toHaveLength(0);
  });

  test("checkpoint restart keeps blueprint digests aligned with evidence refs", () => {
    const options = {
      missionId: "blueprint-1",
      objective: "improve the competition result",
      budget: 10,
      tasks,
      trustedEvaluators: trusted,
    } as const;
    const loop = director();
    const goal = loop.commitBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
    });
    loop.commitBlueprintFile({
      kind: "RULES",
      allowed: ["local evaluation"],
      forbidden: ["external submission"],
      evaluationContractRef: "observation-1",
    });
    const experiments = loop.commitBlueprintFile({
      kind: "EXPERIMENTS",
      entries: [{
        experimentId: "exp-1",
        hypothesis: "the revised method should improve score",
        evidenceRefs: ["observation-1"],
        outcome: "improved the baseline",
      }],
    });
    const scoreboard = loop.commitBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "candidate-1",
        metric: "score",
        value: 1,
        evaluationRef: "observation-1",
        evidenceRefs: ["finding-1"],
      }],
    });
    const review = loop.recordCrossReview({
      reviewId: "review-ckpt",
      phase: "author",
      subjectRefs: [scoreboard.artifactId],
      findings: ["scoreboard cites evaluator evidence"],
      evidenceRefs: ["finding-1"],
    });

    const checkpoint = loop.checkpoint();
    const restarted = MissionDirector.fromEvents(options, loop.events());
    expect(restarted.state().blueprint).toEqual(loop.state().blueprint);
    expect(restarted.state().blueprint.files.GOAL?.digest).toBe(goal.digest);
    expect(restarted.state().blueprint.files.EXPERIMENTS?.digest).toBe(experiments.digest);
    expect(restarted.state().blueprint.files.SCOREBOARD?.digest).toBe(scoreboard.digest);
    expect(restarted.state().blueprint.crossReviews[0]?.digest).toBe(review.digest);
    expect(restarted.evidenceMemory().has("cross-review:review-ckpt")).toBe(true);
    expect(restarted.state().artifacts.find((artifact) => artifact.artifactId === goal.artifactId)?.digest).toBe(goal.digest);
    expect(checkpoint.state.blueprint).toEqual(restarted.state().blueprint);

    const forged: ResearchEvent = {
      sequence: loop.events().length + 1,
      eventId: "forged-blueprint",
      type: "BLUEPRINT_COMMITTED",
      payload: {
        missionId: options.missionId,
        operationId: "forged-scoreboard",
        file: { kind: "SCOREBOARD", rows: [] },
        ref: {
          kind: "SCOREBOARD",
          artifactId: "blueprint:SCOREBOARD",
          digest: "not-the-real-digest",
          evidenceRefs: ["missing-evidence"],
        },
      },
    };
    expect(() => MissionDirector.replay([...loop.events(), forged])).toThrow(/evidence|digest/);
  });

  test("Stop is allowed only after GOAL and SCOREBOARD are committed against evidence", () => {
    const loop = director();
    loop.commitBlueprintFile({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
    });
    expect(() => loop.decide({
      action: "Stop",
      evidenceRefs: ["finding-1"],
      reason: "only GOAL is present",
    })).toThrow(/SCOREBOARD/);

    loop.commitBlueprintFile({
      kind: "SCOREBOARD",
      rows: [{
        candidateId: "candidate-1",
        metric: "score",
        value: 1,
        evaluationRef: "observation-1",
        evidenceRefs: ["finding-1"],
      }],
    });
    loop.decide({ action: "Stop", evidenceRefs: ["finding-1"], reason: "blueprint is complete and evidence remains" });
    expect(loop.state().phase).toBe("STOPPED");
    expect(loop.state().blueprint.files.GOAL?.digest).toBe(blueprintFileDigest({
      kind: "GOAL",
      objective: "improve the competition result",
      successCriteria: ["beat the verified baseline"],
    }));
  });

  test("the experiments log can grow without colliding with the previous digest", () => {
    const loop = director();
    const first = loop.commitBlueprintFile({
      kind: "EXPERIMENTS",
      entries: [{
        experimentId: "exp-1",
        hypothesis: "first hypothesis",
        evidenceRefs: ["observation-1"],
        outcome: "first outcome",
      }],
    });
    const second = loop.commitBlueprintFile({
      kind: "EXPERIMENTS",
      entries: [
        {
          experimentId: "exp-1",
          hypothesis: "first hypothesis",
          evidenceRefs: ["observation-1"],
          outcome: "first outcome",
        },
        {
          experimentId: "exp-2",
          hypothesis: "second hypothesis",
          evidenceRefs: ["finding-1"],
          outcome: "second outcome",
        },
      ],
    });
    expect(second.digest).not.toBe(first.digest);
    expect(loop.state().blueprint.files.EXPERIMENTS?.digest).toBe(second.digest);
    expect(loop.state().artifacts.find((artifact) => artifact.artifactId === "blueprint:EXPERIMENTS")?.digest).toBe(second.digest);
  });
});

