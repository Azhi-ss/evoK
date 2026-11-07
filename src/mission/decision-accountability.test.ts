/**
 * Decision accountability and anti-collapse safeguards (M1-T6 / #215).
 *
 * The projection is read-only: it explains why a direction was rejected, keeps
 * its Memory refs, and never turns an unexecuted alternative into a failure or
 * a Decision Regret. Only a later comparable measured Experiment supplies the
 * counterfactual Evidence that makes regret recordable.
 */
import { describe, expect, test } from "bun:test";
import {
  DIRECTION_CONCENTRATION_MIN_REVISIONS,
  projectDecisionAccountability,
  type DecisionAccountabilitySource,
} from "./decision-accountability";
import type { DecisionRecord, ExperimentTrailEntry } from "./mission-start";
import type { DirectorProposal } from "./mission-director";

const usage = {
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function proposal(objective: string, action: "investigate" | "stop" = "investigate"): DirectorProposal {
  return action === "stop"
    ? { stateVersion: 1, action: "stop", rationale: "nothing left to test", stopReason: "covered" }
    : { stateVersion: 1, action, rationale: `pursue ${objective}`, task: { objective, expectedOutputs: ["answer.txt"] } };
}

function revision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decisionId: "m:director:1:1:revision",
    decisionGroupId: "m:director:1",
    stateVersion: 1,
    attempt: 1,
    accepted: true,
    phase: "revision",
    tokens: usage.tokens,
    cost: 0,
    at: "2026-01-01T00:00:10.000Z",
    proposal: proposal("H2 direction"),
    delta: "replaced",
    revisionReason: "H1 is contradicted by the recorded counterevidence",
    memory: {
      snapshotId: "research-memory:abc",
      snapshotDigest: "abc",
      packetDigest: "def",
      cardRefs: ["hypothesis:synthesis:h2"],
      usedCardRefs: ["hypothesis:synthesis:h2"],
    },
    rejectedAlternatives: [{
      action: "investigate",
      objective: "H1 direction",
      reason: "superseded by the Memory-informed revision (delta replaced)",
      influencingMemoryRefs: ["hypothesis:synthesis:h2"],
      applicability: { declared: ["dataset:train-v1"], status: "declared" },
    }],
    ...overrides,
  };
}

function experiment(overrides: Partial<ExperimentTrailEntry> = {}): ExperimentTrailEntry {
  return {
    runId: "m:exp:2",
    attempt: 2,
    action: "investigate",
    ok: true,
    taskObjective: "H2 direction",
    evaluation: { ok: true, score: 0.8 },
    evidenceRefs: ["runs/m:exp:2/result.json"],
    at: "2026-01-01T00:00:20.000Z",
    ...overrides,
  };
}

function source(overrides: Partial<DecisionAccountabilitySource> = {}): DecisionAccountabilitySource {
  return { decisions: [revision()], experiments: [experiment()], ...overrides };
}

describe("counterfactual status (#215 AC3/AC4/AC5)", () => {
  test("an unexecuted alternative stays unobserved and is never a failure or regret", () => {
    const view = projectDecisionAccountability(source());
    const entry = view.decisions[0]!;
    expect(entry.rejected).toHaveLength(1);
    const rejected = entry.rejected[0]!;
    expect(rejected).toMatchObject({
      action: "investigate",
      objective: "H1 direction",
      counterfactualStatus: "unobserved",
      counterfactualRunIds: [],
    });
    expect(rejected.decisionRegret).toBeUndefined();
    // The revision itself keeps its Memory refs, applicability and reason.
    expect(entry.influencingMemoryRefs).toEqual(["hypothesis:synthesis:h2"]);
    expect(entry.reason).toContain("H1 is contradicted");
    expect(rejected.influencingMemoryRefs).toEqual(["hypothesis:synthesis:h2"]);
    expect(rejected.applicability).toEqual({ declared: ["dataset:train-v1"], status: "declared" });
  });

  test("a later comparable measured Experiment makes regret recordable", () => {
    const view = projectDecisionAccountability(source({
      experiments: [experiment(), experiment({
        runId: "m:exp:3",
        attempt: 3,
        taskObjective: "h1  DIRECTION",
        at: "2026-01-01T00:01:00.000Z",
      })],
    }));
    const rejected = view.decisions[0]!.rejected[0]!;
    expect(rejected.counterfactualStatus).toBe("observed");
    expect(rejected.counterfactualRunIds).toEqual(["m:exp:3"]);
    expect(rejected.decisionRegret).toEqual({ observedFrom: ["m:exp:3"] });
  });

  test("a comparable Run measured BEFORE the decision is not counterfactual evidence", () => {
    const view = projectDecisionAccountability(source({
      experiments: [experiment({ runId: "m:exp:0", attempt: 0, taskObjective: "H1 direction", at: "2026-01-01T00:00:01.000Z" })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("unobserved");
  });

  test("an operational failure supplies no counterfactual Evidence", () => {
    const view = projectDecisionAccountability(source({
      experiments: [experiment({
        runId: "m:exp:4",
        attempt: 4,
        taskObjective: "H1 direction",
        ok: false,
        error: "out of memory",
        at: "2026-01-01T00:02:00.000Z",
      })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("unobserved");
    expect(view.decisions[0]!.rejected[0]!.decisionRegret).toBeUndefined();
  });

  test("a comparable Run that refutes the rejected direction is observed but NOT regret", () => {
    const view = projectDecisionAccountability(source({
      experiments: [experiment({
        runId: "m:exp:5",
        attempt: 5,
        taskObjective: "H1 direction",
        ok: false,
        evaluation: { ok: false, ruleViolations: ["metric regression"] },
        at: "2026-01-01T00:03:00.000Z",
      })],
    }));
    const rejected = view.decisions[0]!.rejected[0]!;
    expect(rejected.counterfactualStatus).toBe("observed");
    expect(rejected.counterfactualOutcomes).toEqual(["negative"]);
    expect(rejected.decisionRegret).toBeUndefined();
  });

  test("the declared Task configuration is compared with the Run's own label format", () => {
    const twoConstraints = revision({
      rejectedAlternatives: [{
        action: "investigate",
        objective: "H1 fold window direction",
        reason: "superseded",
        proposal: {
          stateVersion: 1,
          action: "investigate",
          rationale: "h1",
          task: { objective: "H1 fold window direction", constraints: { dataset: "train-v1", method: "ridge" } },
        },
      }],
    });
    const view = projectDecisionAccountability(source({
      decisions: [twoConstraints],
      experiments: [experiment({
        runId: "m:exp:8",
        attempt: 8,
        taskObjective: "H1 fold window direction",
        // Exactly what configurationLabel produces for those constraints.
        configuration: "dataset=train-v1; method=ridge",
        at: "2026-01-01T00:05:00.000Z",
      })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("observed");
  });

  test("an undeclared Run configuration is not compatible with a declared one", () => {
    const declared = revision({
      rejectedAlternatives: [{
        action: "investigate",
        objective: "H1 fold window direction",
        reason: "superseded",
        proposal: {
          stateVersion: 1,
          action: "investigate",
          rationale: "h1",
          task: { objective: "H1 fold window direction", constraints: { dataset: "train-v1" } },
        },
      }],
    });
    const view = projectDecisionAccountability(source({
      decisions: [declared],
      experiments: [experiment({ runId: "m:exp:9", attempt: 9, taskObjective: "H1 fold window direction", at: "2026-01-01T00:06:00.000Z" })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("unobserved");
  });

  test("a different declared Task configuration is not a comparable Experiment", () => {
    const rejectConstraints = revision({
      rejectedAlternatives: [{
        action: "investigate",
        objective: "H1 fold window direction",
        reason: "superseded",
        proposal: {
          stateVersion: 1,
          action: "investigate",
          rationale: "h1",
          task: { objective: "H1 fold window direction", constraints: { dataset: "train-v1" } },
        },
      }],
    });
    const view = projectDecisionAccountability(source({
      decisions: [rejectConstraints],
      experiments: [experiment({
        runId: "m:exp:6",
        attempt: 6,
        taskObjective: "H1 fold window direction",
        configuration: "dataset=train-v2",
        at: "2026-01-01T00:04:00.000Z",
      })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("unobserved");
  });

  test("an unreadable timestamp cannot supply counterfactual Evidence", () => {
    const view = projectDecisionAccountability(source({
      experiments: [experiment({
        runId: "m:exp:7",
        attempt: 7,
        taskObjective: "H1 direction",
        at: "not-a-timestamp",
      })],
    }));
    expect(view.decisions[0]!.rejected[0]!.counterfactualStatus).toBe("unobserved");
  });

  test("a legacy record without a counterfactual status defaults to unobserved", () => {
    const legacy = revision();
    const view = projectDecisionAccountability(source({
      decisions: [{ ...legacy, rejectedAlternatives: [{ action: "investigate", objective: "H1 direction", reason: "not selected" }] }],
    }));
    expect(view.decisions[0]!.rejected[0]!).toMatchObject({
      counterfactualStatus: "unobserved",
      influencingMemoryRefs: [],
      applicability: { declared: [], status: "unknown" },
    });
  });
});

describe("diversity and concentration (#215 AC6/AC7)", () => {
  const changed = (index: number, objective: string, at: string) => revision({
    decisionId: `m:director:${index}:1:revision`,
    decisionGroupId: `m:director:${index}`,
    at,
    proposal: proposal(objective),
  });

  test("hypothesis diversity and branch coverage are measurable across Runs", () => {
    const view = projectDecisionAccountability({
      decisions: [changed(1, "H2 direction", "2026-01-01T00:00:10.000Z"), changed(2, "H3 direction", "2026-01-01T00:01:10.000Z")],
      experiments: [
        experiment({ runId: "m:exp:2", attempt: 2, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:3", attempt: 3, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:4", attempt: 4, taskObjective: "H3 direction" }),
      ],
    });
    expect(view.diversity.memoryInformedDecisions).toBe(2);
    expect(view.diversity.memoryChangedDecisions).toBe(2);
    expect(view.diversity.objectives).toEqual(["h2 direction", "h3 direction"]);
    expect(view.diversity.branches).toEqual([
      { objective: "h2 direction", runIds: ["m:exp:2", "m:exp:3"] },
      { objective: "h3 direction", runIds: ["m:exp:4"] },
    ]);
    expect(view.diversity.runs).toBe(3);
    expect(view.concentration).toEqual([]);
  });

  test("repeated Memory-driven concentration without new discriminating Evidence triggers one advisory review", () => {
    const view = projectDecisionAccountability({
      decisions: [changed(1, "H2 direction", "2026-01-01T00:00:10.000Z"), changed(2, "H2 direction", "2026-01-01T00:01:10.000Z")],
      experiments: [
        experiment({ runId: "m:exp:2", attempt: 2, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:3", attempt: 3, taskObjective: "H2 direction" }),
      ],
    });
    expect(view.concentration).toHaveLength(1);
    expect(view.concentration[0]).toMatchObject({
      kind: "direction-concentration",
      objective: "h2 direction",
      decisionGroupIds: ["m:director:1", "m:director:2"],
      memoryChangedDecisions: DIRECTION_CONCENTRATION_MIN_REVISIONS,
      advisory: true,
    });
    expect(view.concentration[0]!.recommendation).toMatch(/reevaluate/);
  });

  test("a refutation OF the concentrated direction clears the signal", () => {
    const view = projectDecisionAccountability({
      decisions: [changed(1, "H2 direction", "2026-01-01T00:00:10.000Z"), changed(2, "H2 direction", "2026-01-01T00:01:10.000Z")],
      experiments: [
        experiment({ runId: "m:exp:2", attempt: 2, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:3", attempt: 3, taskObjective: "H2 direction", ok: false, evaluation: { ok: false, ruleViolations: ["metric regression"] } }),
      ],
    });
    expect(view.concentration).toEqual([]);
  });

  test("a refutation somewhere else is not discriminating Evidence about this direction", () => {
    const view = projectDecisionAccountability({
      decisions: [changed(1, "H2 direction", "2026-01-01T00:00:10.000Z"), changed(2, "H2 direction", "2026-01-01T00:01:10.000Z")],
      experiments: [
        experiment({ runId: "m:exp:2", attempt: 2, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:3", attempt: 3, taskObjective: "H2 direction" }),
        experiment({ runId: "m:exp:4", attempt: 4, taskObjective: "an unrelated direction", ok: false, evaluation: { ok: false, ruleViolations: ["metric regression"] } }),
      ],
    });
    expect(view.concentration).toHaveLength(1);
  });

  test("an unchanged revision is not concentration, and a legacy record without Memory is never counted", () => {
    const view = projectDecisionAccountability({
      decisions: [
        changed(1, "H2 direction", "2026-01-01T00:00:10.000Z"),
        { ...changed(2, "H2 direction", "2026-01-01T00:01:10.000Z"), delta: "unchanged" as const },
        { ...changed(3, "H2 direction", "2026-01-01T00:02:10.000Z"), memory: undefined },
      ],
      experiments: [experiment()],
    });
    expect(view.diversity.memoryChangedDecisions).toBe(1);
    expect(view.concentration).toEqual([]);
  });
});
