import { describe, expect, test } from "bun:test";
import {
  canReadScore,
  authorizePublicProbe,
  normaliseValidationLevel,
  resolveValidationLadder,
  publicProbesUsedFromEvents,
  type ValidationEventLike,
  type ValidationLevel,
} from "./validation-ladder";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  levelCanChampion,
  type ToyAgentRuntime,
} from "./toy-harness";

/**
 * Adapter that declares a validation ladder. A candidate may also pin the
 * validation level its evaluator scores come from via a `validationLevel`
 * field on the returned evaluation.
 */
class LadderAdapter extends ScoreFileToyCompetitionAdapter {
  constructor(
    private readonly declaration?: Record<string, unknown>,
    private readonly evaluationLevel?: string,
  ) {
    super("score");
  }
  validation_ladder() {
    return this.declaration;
  }
  validationLadder() {
    return this.declaration;
  }
  evaluate(snapshot: Readonly<{ files: Record<string, string> }>): { score: number; validationLevel?: ValidationLevel } {
    const result = super.evaluate(snapshot as never);
    return this.evaluationLevel === undefined ? result : { ...result, validationLevel: this.evaluationLevel as ValidationLevel };
  }
}

const prediction = {
  predictionId: "ladder-prediction",
  hypothesis: "the candidate scores on a declared validation level",
  expectedObservation: "promotion follows the validation ladder",
  expectedObservations: ["promotion follows the validation ladder"],
  failureModes: ["promotion is based on the wrong level"],
} as const;

const contract = { objective: "maximize" };
const policy = { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 3, quorum: 1 };

function runtime(score: string): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { score } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

function mission(missionId: string, adapter: ScoreFileToyCompetitionAdapter) {
  return new ToyCompetitionHarness({
    prediction,
    missionId,
    taskContract: contract,
    branchIds: ["candidate-1"],
    runtime: runtime("7"),
    adapter,
    policy,
  });
}

describe("T41 validation ladder contract face", () => {
  test("declares three validation levels with default readers when the adapter opts in", () => {
    const ladder = resolveValidationLadder({ promotionBasis: "outer_holdout", publicProbeCap: 1 });
    expect(ladder?.promotionBasis).toBe("outer_holdout");
    expect(ladder?.levels.inner_cv.purpose).toBe("search");
    expect(ladder?.levels.outer_holdout.purpose).toBe("promotion");
    expect(ladder?.levels.public_lb.purpose).toBe("public_lb_probe");
    // Default cap is fail-closed (no probe without an explicit budget).
    expect(resolveValidationLadder({})?.publicProbeCap).toBe(0);
  });

  test("camelCase and snake_case declaration forms both resolve", () => {
    expect(resolveValidationLadder({ promotion_basis: "outer-holdout", public_probe_cap: 2 })?.publicProbeCap).toBe(2);
    expect(resolveValidationLadder({ promotionBasis: "outer_holdout", publicProbeCap: 2 })?.promotionBasis).toBe("outer_holdout");
  });

  test("absent declaration leaves the ladder inactive; partial/declared on adapter works", () => {
    expect(resolveValidationLadder(undefined)).toBeUndefined();
    expect(resolveValidationLadder(new ScoreFileToyCompetitionAdapter())).toBeUndefined();
    const ladder = resolveValidationLadder(new LadderAdapter({ publicProbeCap: 1 }));
    expect(ladder?.publicProbeCap).toBe(1);
  });

  test("a non-outer-holdout promotion basis is a configuration error (fail closed)", () => {
    expect(() => resolveValidationLadder({ promotionBasis: "public_lb" })).toThrow(/promotion basis/);
    expect(() => resolveValidationLadder({ promotion_basis: "inner_cv" })).toThrow(/promotion basis/);
  });

  test("public probe cap must be a non-negative integer", () => {
    expect(() => resolveValidationLadder({ publicProbeCap: -1 })).toThrow(/[Cc]ap/);
    expect(() => resolveValidationLadder({ publicProbeCap: 1.5 })).toThrow(/[Cc]ap/);
    expect(() => resolveValidationLadder({ publicProbeCap: "2" })).toThrow(/[Cc]ap/);
  });
});

describe("T41 level normalisation", () => {
  test("snake/camel/kebab aliases map to the canonical three levels", () => {
    expect(normaliseValidationLevel("inner_cv")).toBe("inner_cv");
    expect(normaliseValidationLevel("innerCV")).toBe("inner_cv");
    expect(normaliseValidationLevel("inner-cv")).toBe("inner_cv");
    expect(normaliseValidationLevel("outer_holdout")).toBe("outer_holdout");
    expect(normaliseValidationLevel("outerHoldout")).toBe("outer_holdout");
    expect(normaliseValidationLevel("public_probe")).toBe("public_lb");
    expect(normaliseValidationLevel("public_lb")).toBe("public_lb");
    expect(normaliseValidationLevel("publicLB")).toBe("public_lb");
    expect(normaliseValidationLevel("leaderboard")).toBe("public_lb");
  });

  test("an unknown level is rejected", () => {
    expect(() => normaliseValidationLevel("private_holdout")).toThrow(/validation level/);
  });
});

describe("T41 score visibility — who may read which level", () => {
  test("inner CV scores are readable by the search engine; outer holdout is not", () => {
    expect(canReadScore("inner_cv", "candidate_search")).toBe(true);
    // Spec story 11: the leaderboard-optimizing search engine never sees the outer holdout.
    expect(canReadScore("outer_holdout", "candidate_search")).toBe(false);
    expect(canReadScore("public_lb", "candidate_search")).toBe(false);
  });

  test("outer holdout is readable by the promotion gate and Mission Director", () => {
    expect(canReadScore("outer_holdout", "promotion_gate")).toBe(true);
    expect(canReadScore("outer_holdout", "mission_director")).toBe(true);
    expect(canReadScore("inner_cv", "promotion_gate")).toBe(false);
  });

  test("public LB scores are readable only by the operator / submission broker, never the promotion gate", () => {
    expect(canReadScore("public_lb", "operator")).toBe(true);
    expect(canReadScore("public_lb", "submission_broker")).toBe(true);
    expect(canReadScore("public_lb", "promotion_gate")).toBe(false);
    expect(canReadScore("public_lb", "candidate_search")).toBe(false);
  });
});

describe("T41 Public LB probe budget", () => {
  test("probes within the cap are authorised; the next probe once exhausted is refused", () => {
    const ladder = resolveValidationLadder({ publicProbeCap: 2 })!;
    expect(authorizePublicProbe(ladder, 0)).toEqual({ allowed: true });
    expect(authorizePublicProbe(ladder, 1)).toEqual({ allowed: true });
    const refused = authorizePublicProbe(ladder, 2);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/probe.*exhausted|cap/);
  });

  test("the default cap of zero refuses every probe", () => {
    const ladder = resolveValidationLadder({})!;
    expect(authorizePublicProbe(ladder, 0).allowed).toBe(false);
  });

  test("spent probes are counted from evaluator-succeeded events at the public level", () => {
    const events: readonly ValidationEventLike[] = [
      { type: "EVALUATOR_SUCCEEDED", payload: { validationLevel: "outer_holdout" } },
      { type: "EVALUATOR_SUCCEEDED", payload: { validationLevel: "public_lb" } },
      { type: "PUBLIC_PROBE_REFUSED", payload: {} },
      { type: "EVALUATOR_SUCCEEDED", payload: {} },
    ];
    expect(publicProbesUsedFromEvents(events)).toBe(1);
  });
});

describe("T41 promotion basis", () => {
  test("only outer holdout may be the local promotion basis", () => {
    expect(levelCanChampion("outer_holdout")).toBe(true);
    expect(levelCanChampion("inner_cv")).toBe(false);
    expect(levelCanChampion("public_lb")).toBe(false);
  });
});

describe("T41 harness wiring", () => {
  test("an outer-holdout candidate champions normally", async () => {
    const adapter = new LadderAdapter({ promotionBasis: "outer_holdout", publicProbeCap: 1 }, "outer_holdout");
    const result = await mission("wiring-outer", adapter).run();
    expect(result.branches["candidate-1"]?.status).toBe("PROMOTED_LOCAL");
  });

  test("an inner-CV-only improvement can never champion (no outer evidence)", async () => {
    const adapter = new LadderAdapter({ promotionBasis: "outer_holdout" }, "inner_cv");
    const harness = mission("wiring-inner", adapter);
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("REJECTED");
    expect(result.champion).toBeUndefined();
    const rejection = harness.events().find((event) => event.type === "BRANCH_REJECTED");
    expect(rejection?.payload.reason).toMatch(/outer.?holdout|inner.?cv|validation/i);
  });

  test("a Public LB score can never champion, even when higher", async () => {
    const adapter = new LadderAdapter({ promotionBasis: "outer_holdout", publicProbeCap: 2 }, "public_lb");
    const harness = mission("wiring-public", adapter);
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("REJECTED");
    expect(result.champion).toBeUndefined();
    const rejection = harness.events().find((event) => event.type === "BRANCH_REJECTED");
    expect(rejection?.payload.reason).toMatch(/public|lb|validation/i);
  });

  test("public probes within the cap leave a succeeded evaluation; exhausted probes are refused", async () => {
    // cap 1: the single candidate's public evaluation is allowed but cannot promote.
    const ok = mission("probe-ok", new LadderAdapter({ publicProbeCap: 1 }, "public_lb"));
    const okResult = await ok.run();
    expect(okResult.publicProbesUsed).toBe(1);
    expect(ok.events().some((event) => event.type === "PUBLIC_PROBE_REFUSED")).toBe(false);

    // cap 0: the probe is refused before any public score is recorded; the branch rejects.
    const refused = mission("probe-refused", new LadderAdapter({ publicProbeCap: 0 }, "public_lb"));
    const refusedResult = await refused.run();
    expect(refusedResult.publicProbesUsed).toBe(0);
    const refusalEvent = refused.events().find((event) => event.type === "PUBLIC_PROBE_REFUSED");
    expect(refusalEvent).toBeDefined();
    expect(refusalEvent?.payload.reason).toMatch(/exhausted|cap/);
    expect(refusedResult.branches["candidate-1"]?.status).toBe("REJECTED");
  });

  test("with the ladder active, an evaluation that declares no validation level is rejected", async () => {
    // Ladder declared but the adapter's evaluation carries no level -> fail closed.
    const adapter = new LadderAdapter({ promotionBasis: "outer_holdout" }, undefined);
    const harness = mission("wiring-no-level", adapter);
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("REJECTED");
  });

  test("with no ladder declared, legacy missions promote exactly as before", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "wiring-legacy",
      taskContract: contract,
      branchIds: ["candidate-1"],
      runtime: runtime("7"),
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy,
    });
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("PROMOTED_LOCAL");
    expect(result.validationLadder).toBeUndefined();
  });

  test("the ladder contract and probe spend survive ledger replay (crash recovery)", async () => {
    const harness = mission("wiring-replay", new LadderAdapter({ publicProbeCap: 2 }, "public_lb"));
    const live = await harness.run();
    const replayed = ToyCompetitionHarness.replay(harness.events());
    expect(replayed.validationLadder?.publicProbeCap).toBe(2);
    expect(replayed.publicProbesUsed).toBe(1);
    expect(replayed.branches["candidate-1"]?.status).toBe(live.branches["candidate-1"]?.status);
  });

  test("a cap of 1 admits one public probe then refuses every further probe", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "probe-cap-multi",
      taskContract: contract,
      branchIds: ["probe-1", "probe-2", "probe-3"],
      runtime: {
        selfVerify: () => ({ ok: true }),
        propose: () => ({ files: { score: "9" } }),
        falsify: () => ({ ok: true, objections: [] }),
      },
      adapter: new LadderAdapter({ promotionBasis: "outer_holdout", publicProbeCap: 1 }, "public_lb"),
      policy: { maxBranches: 3, maxParallelBranches: 1, maxAttempts: 3, quorum: 1 },
    });
    const result = await harness.run();

    const refusals = harness.events().filter((event) => event.type === "PUBLIC_PROBE_REFUSED");
    // One probe succeeds (branch 1); the next two probes are refused at the cap.
    expect(result.publicProbesUsed).toBe(1);
    expect(refusals.length).toBe(2);
    // No public-LB branch ever champions.
    expect(result.champion).toBeUndefined();
    expect(Object.values(result.branches).every((branch) => branch.status === "REJECTED")).toBe(true);
  });
});
