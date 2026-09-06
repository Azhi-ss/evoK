import { describe, expect, test } from "bun:test";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type EvaluationFeedbackView,
  type ToyAgentRuntime,
} from "./toy-harness";

const prediction = {
  predictionId: "feedback-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

function runtime(seen: Array<EvaluationFeedbackView | undefined>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { score: "7" } }),
    falsify: ({ feedbackView }) => {
      seen.push(feedbackView);
      return { ok: true, objections: [] };
    },
  };
}

function mission(missionId: string, options: { readonly evaluationFeedback?: { readonly enabled: boolean }; readonly seen: Array<EvaluationFeedbackView | undefined> }) {
  return new ToyCompetitionHarness({
    prediction,
    missionId,
    taskContract: { objective: "maximize" },
    runtime: runtime(options.seen),
    adapter: new ScoreFileToyCompetitionAdapter(),
    ...(options.evaluationFeedback === undefined ? {} : { evaluationFeedback: options.evaluationFeedback }),
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
  });
}

describe("evaluation information flow", () => {
  test("keeps the EnvHarness-style feedback channel disabled by default", async () => {
    const seen: Array<EvaluationFeedbackView | undefined> = [];
    const harness = mission("feedback-off", { seen });

    await harness.run();

    expect(harness.state().evaluationFeedbackEnabled).toBe(false);
    expect(seen).toEqual([undefined]);
    expect(harness.events().some((event) => event.type === "FEEDBACK_VIEW_CREATED")).toBe(false);
  });

  test("exposes a feedback view to agent roles without changing the trusted score", async () => {
    const seen: Array<EvaluationFeedbackView | undefined> = [];
    const harness = mission("feedback-on", { seen, evaluationFeedback: { enabled: true } });

    await harness.run();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "feedback_view", score: 7 });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(harness.events().some((event) => event.type === "FEEDBACK_VIEW_CREATED")).toBe(true);
    expect(harness.state().branches["candidate-1"]?.trustedScore).toMatchObject({ kind: "trusted_score", score: 7 });
  });

  test("preserves the trusted evaluator result for identical snapshot and contract", async () => {
    const offSeen: Array<EvaluationFeedbackView | undefined> = [];
    const onSeen: Array<EvaluationFeedbackView | undefined> = [];
    const off = mission("feedback-equivalence", { seen: offSeen });
    const on = mission("feedback-equivalence", { seen: onSeen, evaluationFeedback: { enabled: true } });

    await off.run();
    await on.run();

    expect(on.state().branches["candidate-1"]?.evaluation?.score)
      .toBe(off.state().branches["candidate-1"]?.evaluation?.score);
    expect(on.state().branches["candidate-1"]?.evaluation?.evaluationDigest)
      .toBe(off.state().branches["candidate-1"]?.evaluation?.evaluationDigest);
    expect(on.state().branches["candidate-1"]?.trustedScore)
      .toEqual(off.state().branches["candidate-1"]?.trustedScore);
    expect(on.state().branches["candidate-1"]?.trustedScore?.snapshotDigest)
      .toBe(off.state().branches["candidate-1"]?.trustedScore?.snapshotDigest);
    expect(on.state().branches["candidate-1"]?.trustedScore?.contractDigest)
      .toBe(off.state().branches["candidate-1"]?.trustedScore?.contractDigest);
  });

  test("exposes feedback to harness-side verification hooks when enabled", async () => {
    let seen: Record<string, unknown> | undefined;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "feedback-hook-channel",
      taskContract: { objective: "maximize" },
      branchIds: ["candidate-1"],
      runtime: {
        selfVerify: () => ({ ok: true }),
        propose: () => ({ files: { score: "7" } }),
        falsify: () => ({ ok: true, objections: [] }),
      },
      adapter: new ScoreFileToyCompetitionAdapter(),
      evaluationFeedback: { enabled: true },
      verification: {
        falsifier: (input) => {
          seen = input as unknown as Record<string, unknown>;
          return { ok: true, objections: [] };
        },
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    await harness.run();

    expect(seen?.feedbackView).toMatchObject({ kind: "feedback_view", score: 7 });
  });

  test("labels trusted scores and feedback views separately in the ledger", async () => {
    const seen: Array<EvaluationFeedbackView | undefined> = [];
    const harness = mission("feedback-ledger", { seen, evaluationFeedback: { enabled: true } });

    await harness.run();

    const scoreEvent = harness.events().find((event) => event.type === "EVALUATOR_SUCCEEDED");
    const feedbackEvent = harness.events().find((event) => event.type === "FEEDBACK_VIEW_CREATED");
    expect(scoreEvent?.payload.trusted_score).toMatchObject({ kind: "trusted_score", score: 7 });
    expect(feedbackEvent?.payload.feedback_view).toMatchObject({ kind: "feedback_view", score: 7 });
    expect(harness.state().branches["candidate-1"]?.feedbackView).toMatchObject({ kind: "feedback_view" });
  });
});
