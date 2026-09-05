import { describe, expect, test } from "bun:test";
import {
  InfrastructureError,
  NoisyScoreToyCompetitionAdapter,
  ToyCompetitionHarness,
  createTrustedSnapshot,
  normalizeEvaluationContract,
  TrustViolation,
  type CandidateSnapshot,
  type EvaluationRunContext,
  type EvaluationResult,
  type MissionEvent,
  type PromotionPolicy,
  type ToyAgentRuntime,
  type ToyCompetitionAdapter,
} from "./toy-harness";

const noiseContract = {
  protocol_version: "noise-v1",
  noise_model: { kind: "stochastic", tolerance: 0.05 },
  required_repeats: 3,
  escalation_ladder: [
    "single",
    { stage: "best_of_n", n: 3 },
    { stage: "paired", repeats: 3 },
  ],
  margin_policy: { micro_gain: 0.01, tight_margin: 0.05 },
};

function runtimeFor(scores: Record<string, number>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: ({ branchId }) => ({ files: { score: String(scores[branchId]) } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

function adapterFor(score: (branchId: string, context: EvaluationRunContext) => number, calls: EvaluationRunContext[] = []): ToyCompetitionAdapter {
  return {
    name: "noisy-test",
    evaluation_contract: noiseContract,
    evaluate(snapshot, context) {
      if (!context) throw new Error("evaluation context is required");
      calls.push(context);
      return {
        score: score(snapshot.branchId, context),
        evaluatorId: "noisy-test-evaluator",
        evaluatorVersion: "noise-evaluator-v1",
        facts: [{ name: "stage", value: context.stage }, { name: "side", value: context.side }],
      };
    },
  };
}

function mission(
  scores: Record<string, number>,
  adapter: ToyCompetitionAdapter,
  promotionPolicy?: PromotionPolicy,
) {
  return new ToyCompetitionHarness({
    missionId: `noise-${Object.keys(scores).join("-")}`,
    taskContract: { objective: "maximize" },
    branchIds: Object.keys(scores),
    runtime: runtimeFor(scores),
    adapter,
    promotionPolicy,
    policy: { maxBranches: Object.keys(scores).length, maxParallelBranches: 1, quorum: 1 },
  });
}

describe("evaluation noise protocol", () => {
  test("normalizes the adapter contract and keeps the protocol outside the task objective", () => {
    const contract = normalizeEvaluationContract(noiseContract);

    expect(contract.version).toBe("noise-v1");
    expect(contract.noiseModel).toEqual({ kind: "stochastic", tolerance: 0.05 });
    expect(contract.requiredRepeats).toBe(3);
    expect(contract.escalationLadder.map((step) => step.stage)).toEqual(["single", "best-of-n", "symmetric-a-b"]);
    expect(contract.escalationLadder.map((step) => step.repeats)).toEqual([1, 3, 3]);
    expect(contract.marginPolicy).toMatchObject({ microGain: 0.01, tightMargin: 0.05 });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.noiseModel)).toBe(true);
    expect(Object.isFrozen(contract.escalationLadder)).toBe(true);
  });

  test("requires the complete ordered ladder for every evaluation contract", () => {
    expect(() => normalizeEvaluationContract({
      version: "incomplete",
      noiseModel: "deterministic",
      escalationLadder: ["single"],
    })).toThrow("single, best-of-n, and symmetric-a-b");
    expect(() => normalizeEvaluationContract({
      version: "optional-stage",
      noiseModel: "deterministic",
      escalationLadder: [
        "single",
        { stage: "best-of-n", required: false },
        "symmetric-a-b",
      ],
    })).toThrow("must be required");
  });

  test("runs the complete ladder with independent run facts and rejects a single-score outlier", async () => {
    const calls: EvaluationRunContext[] = [];
    const adapter = adapterFor((branchId, context) => {
      if (branchId === "candidate" && context.stage === "single") return 14;
      if (context.stage === "symmetric-a-b" && context.side === "candidate") return branchId === "candidate" ? 8 : 10;
      return branchId === "candidate" ? 8 : 10;
    }, calls);
    const harness = mission({ baseline: 10, candidate: 8 }, adapter);

    const result = await harness.run();
    const state = harness.state();
    const candidate = state.branches.candidate;
    const candidateEvaluation = candidate.evaluation!;
    const ladder = candidateEvaluation.ladder!;
    const runFacts = ladder.runs;

    expect(result.champion?.branchId).toBe("baseline");
    expect(candidate.status).toBe("REJECTED");
    expect(candidateEvaluation.officialScore).toBe(14);
    expect(candidateEvaluation.promotionScore).toBe(8);
    expect(ladder.complete).toBe(true);
    expect(ladder.completedStages).toEqual(["single", "best-of-n", "symmetric-a-b"]);
    expect(runFacts.length).toBe(10);
    expect(new Set(runFacts.map((run) => run.runId)).size).toBe(runFacts.length);
    expect(new Set(runFacts.map((run) => run.seed)).size).toBeGreaterThan(1);
    expect(runFacts.every((run) => run.digest.length > 0)).toBe(true);
    expect(runFacts.every((run) => run.evaluationContractDigest === state.evaluationContractDigest)).toBe(true);
    expect(runFacts.every((run) => run.evaluatorVersion === "noise-evaluator-v1")).toBe(true);
    expect(calls.every((context) => Object.isFrozen(context) && Object.isFrozen(context.evaluationContract))).toBe(true);
    expect(harness.events().some((event) => event.type === "EVALUATION_RUN_COMPLETED")).toBe(true);
    expect(harness.events().some((event) => event.type === "BRANCH_REJECTED" && event.payload.reason === "promotion policy rejected")).toBe(true);
    expect(ToyCompetitionHarness.replay(harness.events())).toEqual(state);
  });

  test("passes the ladder to promotion policy, banks micro-gains, and preserves the champion", async () => {
    const seen: EvaluationResult[] = [];
    const adapter = adapterFor((_branchId, context) => {
      if (context.stage === "single") return context.side === "control" ? 10 : 10.005;
      if (context.stage === "symmetric-a-b") return context.side === "control" ? 10 : 10.005;
      return context.side === "control" ? 10 : 10.005;
    });
    const harness = mission(
      { baseline: 10, candidate: 10.005 },
      adapter,
      ({ candidate }) => {
        if (candidate.evaluation) seen.push(candidate.evaluation);
        return true;
      },
    );

    const result = await harness.run();
    const state = harness.state();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((evaluation) => evaluation.ladder?.complete === true)).toBe(true);
    expect(result.champion?.branchId).toBe("baseline");
    expect(state.branches.candidate.status).toBe("SCORED");
    expect(state.gainBank?.[0]).toMatchObject({ branchId: "candidate", amount: 0.005 });
    expect(harness.events().some((event) => event.type === "GAIN_BANKED")).toBe(true);
  });

  test("does not silently champion a tight official margin when symmetric A/B disagrees", async () => {
    const adapter = adapterFor((branchId, context) => {
      if (branchId === "candidate" && context.stage === "single") return 10.02;
      if (context.stage === "symmetric-a-b") return context.side === "control" ? 10 : branchId === "candidate" ? 9.98 : 10;
      return branchId === "candidate" ? 10.02 : 10;
    });
    const harness = mission({ baseline: 10, candidate: 10.02 }, adapter);

    const result = await harness.run();
    const candidate = harness.state().branches.candidate;

    expect(result.champion?.branchId).toBe("baseline");
    expect(candidate.status).toBe("REJECTED");
    expect(candidate.rejectionReason).toBe("official-a-b-disagreement");
    expect(harness.events().some((event) => event.type === "BRANCH_REJECTED" && event.payload.reason === "official-a-b-disagreement")).toBe(true);
  });

  test("never promotes an incomplete ladder", async () => {
    let calls = 0;
    const adapter = adapterFor((_branchId, context) => {
      calls += 1;
      if (context.stage !== "single") throw new InfrastructureError("ladder stopped");
      return 99;
    });
    const harness = mission({ candidate: 99 }, adapter);

    const result = await harness.run();

    expect(calls).toBe(2);
    expect(result.champion).toBeUndefined();
    expect(result.branches.candidate.status).not.toBe("PROMOTED_LOCAL");
    expect(harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
  });

  test("provides an injectable noisy toy adapter fixture", () => {
    const adapter = new NoisyScoreToyCompetitionAdapter({
      noise: ({ stage, side }) => stage === "single" && side === "candidate" ? 5 : 0,
    });

    expect(adapter.evaluation_contract().escalationLadder.map((step) => step.stage)).toEqual([
      "single", "best-of-n", "symmetric-a-b",
    ]);
    expect(adapter.evaluation_contract().noiseModel.tolerance).toBeGreaterThan(0);
  });

  test("proves with the fixture that one noisy high score cannot crown a champion", async () => {
    const adapter = new NoisyScoreToyCompetitionAdapter({
      noise: ({ stage, side, ordinal }) => stage === "single" && side === "candidate" ? 5 + ordinal : 0,
    });
    const harness = new ToyCompetitionHarness({
      missionId: "fixture-noise",
      taskContract: { objective: "maximize" },
      branchIds: ["baseline", "candidate"],
      runtime: runtimeFor({ baseline: 10, candidate: 10 }),
      adapter,
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();
    const evaluation = result.branches.candidate.evaluation!;

    expect(result.champion?.branchId).toBe("baseline");
    expect(evaluation.officialScore).toBe(15);
    expect(evaluation.promotionScore).toBe(10);
    expect(evaluation.ladder?.complete).toBe(true);
    expect(result.branches.candidate.status).toBe("REJECTED");
    expect(result.branches.candidate.rejectionReason).toBe("promotion policy rejected");
  });

  test("resumes a partially completed ladder without rerunning finished runs", async () => {
    const contexts: EvaluationRunContext[] = [];
    const source = mission({ candidate: 12 }, adapterFor((_branchId, context) => {
      contexts.push(context);
      return context.side === "control" ? 10 : 12;
    }));
    await source.run();
    const sourceEvents = [...source.events()];
    const runEvents = sourceEvents.filter((event) => event.type === "EVALUATION_RUN_COMPLETED");
    expect(runEvents.length).toBe(10);

    const cutoff = sourceEvents.findIndex((event) => event.type === "EVALUATION_RUN_COMPLETED") + 5;
    let resumedCalls = 0;
    const resumedContexts: EvaluationRunContext[] = [];
    const resumed = ToyCompetitionHarness.fromEvents(
      {
        missionId: source.events()[0].payload.missionId as string,
        taskContract: { objective: "maximize" },
        branchIds: ["candidate"],
        runtime: runtimeFor({ candidate: 12 }),
        adapter: adapterFor((_branchId, context) => {
          resumedCalls += 1;
          resumedContexts.push(context);
          return context.side === "control" ? 10 : 12;
        }),
        policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
      },
      sourceEvents.slice(0, cutoff) as MissionEvent[],
    );

    const result = await resumed.resume();

    expect(resumedCalls).toBe(5);
    expect(resumedContexts.map((context) => context.ordinal)).toEqual([5, 6, 7, 8, 9]);
    expect(contexts.map((context) => context.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.champion?.branchId).toBe("candidate");
    expect(resumed.events().filter((event) => event.type === "EVALUATION_RUN_COMPLETED")).toHaveLength(10);
  });

  test("evaluates symmetric A/B against a configured control snapshot", async () => {
    const taskContract = { objective: "maximize" };
    const controlSnapshot = createTrustedSnapshot({
      missionId: "control-mission",
      branchId: "control",
      attempt: 1,
      files: { score: "10" },
      contract: taskContract,
      provenance: { runId: "control-mission:control:1", candidateId: "control:1", fencingToken: 1 },
    }) as CandidateSnapshot;
    const contexts: EvaluationRunContext[] = [];
    const harness = new ToyCompetitionHarness({
      missionId: "control-mission",
      taskContract,
      branchIds: ["candidate"],
      runtime: runtimeFor({ candidate: 11 }),
      adapter: adapterFor((_branchId, context) => {
        contexts.push(context);
        return context.side === "control" ? Number(context.controlSnapshot!.files.score) : 11;
      }),
      evaluationControlSnapshot: controlSnapshot,
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();
    const state = harness.state();

    expect(state.evaluationControlSnapshotDigest).toBe(controlSnapshot.digest);
    const controlRuns = contexts.filter((context) => context.side === "control");
    expect(controlRuns).toHaveLength(3);
    expect(controlRuns.every((context) => context.snapshotDigest === controlSnapshot.digest)).toBe(true);
    expect(result.branches.candidate.evaluation?.ladder?.symmetricAB?.controlScore).toBe(10);
    expect(result.champion?.branchId).toBe("candidate");
  });

  test("rejects a tampered control snapshot at construction", () => {
    const taskContract = { objective: "maximize" };
    const controlSnapshot = createTrustedSnapshot({
      missionId: "tampered-mission",
      branchId: "control",
      attempt: 1,
      files: { score: "10" },
      contract: taskContract,
      provenance: { runId: "tampered-mission:control:1", candidateId: "control:1", fencingToken: 1 },
    }) as CandidateSnapshot;
    const tampered = { ...controlSnapshot, files: { score: "99" } } as CandidateSnapshot;

    expect(() => new ToyCompetitionHarness({
      missionId: "tampered-mission",
      taskContract,
      branchIds: ["candidate"],
      runtime: runtimeFor({ candidate: 11 }),
      adapter: adapterFor(() => 11),
      evaluationControlSnapshot: tampered,
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    })).toThrow(TrustViolation);
  });

  test("records the promotion policy's rejection reason", async () => {
    const harness = mission(
      { candidate: 12 },
      adapterFor(() => 12),
      () => ({ approved: false, reason: "insufficient margin over noise tolerance" }),
    );

    const result = await harness.run();

    expect(result.champion).toBeUndefined();
    expect(result.branches.candidate.status).toBe("REJECTED");
    expect(result.branches.candidate.rejectionReason).toBe("insufficient margin over noise tolerance");
    expect(ToyCompetitionHarness.replay(harness.events())).toEqual(harness.state());
  });

  test("quarantines an evaluator that forges a run digest or rebinds a run", async () => {
    const cases: Array<(context: EvaluationRunContext) => Record<string, unknown>> = [
      (context) => ({ score: 12, evaluatorId: "noisy-test-evaluator", evaluatorVersion: "noise-evaluator-v1", digest: "forged" }),
      (context) => ({ score: 12, evaluatorId: "noisy-test-evaluator", evaluatorVersion: "noise-evaluator-v1", runId: `${context.runId}:forged` }),
      (context) => ({ score: 12, evaluatorId: "noisy-test-evaluator", evaluatorVersion: "noise-evaluator-v1", seed: context.seed + 1 }),
    ];
    for (const override of cases) {
      const adapter: ToyCompetitionAdapter = {
        name: "noisy-test",
        evaluation_contract: noiseContract,
        evaluate(_snapshot, context) {
          if (!context) throw new Error("evaluation context is required");
          return { score: 12, evaluatorId: "noisy-test-evaluator", evaluatorVersion: "noise-evaluator-v1", facts: [], ...override(context) } as EvaluationResult;
        },
      };
      const harness = mission({ candidate: 12 }, adapter);

      const result = await harness.run();

      expect(result.branches.candidate.status).toBe("QUARANTINED");
      expect(result.champion).toBeUndefined();
      expect(harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
    }
  });
});
