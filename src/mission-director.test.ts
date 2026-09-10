/**
 * Unit tests for the Mission Director decision seam (#113, T5):
 *  - strict validation/bounding of model proposals (no objective/permission/
 *    budget expansion, no self-asserted success, stale/unsupported/over-budget
 *    proposals rejected without execution);
 *  - the trusted observation/evidence projection built from the durable
 *    Mission record (the model sees real evaluator observations, Positive and
 *    Negative Evidence, objective/policy, remaining budget);
 *  - the Pi-backed director adapter is a READ-ONLY decision boundary: one
 *    fresh session per decision and no coding/write authority.
 *
 * The controlled-model primary seam (different observations => different
 * next actions => different dispatched work, with real local execution) lives
 * under tests/integration/mission-continue.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  DirectorProposalRejectedError,
  buildDirectorInput,
  validateDirectorProposal,
  type DirectorInput,
  type DirectorProposal,
} from "./mission-director";
import type { MissionRecord } from "./mission-start";

function input(overrides: Partial<DirectorInput> = {}): DirectorInput {
  return {
    missionId: "m-t5",
    stateVersion: 1,
    objective: "raise the measured answer toward 0.9 without cheating",
    contract: {
      objective: "raise the measured answer toward 0.9 without cheating",
      expectedOutputs: ["answer.txt"],
      evaluationMethod: "file-answer-deterministic",
      metric: "answer in [0,1]",
      hardRules: ["no external submission"],
    },
    policy: {
      permissions: ["read-project", "isolated-workspace-write", "local-shell-in-workspace"],
      hardRules: ["no external submission", "no network"],
    },
    budget: { total: 1, units: "model-USD", consumed: 0.01, remaining: 0.99, reserved: 0 },
    stopConditions: ["budget exhausted", "user interruption"],
    tasks: [{ taskId: "baseline", objective: "materialize answer.txt with value 0.4" }],
    observations: [
      {
        runId: "m-t5:baseline:1",
        attempt: 1,
        kind: "baseline",
        action: "baseline",
        ok: true,
        score: 0.4,
        evidenceRefs: ["runs/m-t5:baseline:1/snapshot", "runs/m-t5:baseline:1/result.json"],
        dispatchedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

const validTaskProposal = {
  stateVersion: 1,
  action: "change-direction",
  rationale: "0.4 is far from the 0.9 target; try a materially different transform",
  task: {
    objective: "materialize answer.txt with value 0.8 using a different approach",
    expectedOutputs: ["answer.txt"],
  },
  expectedCost: 0.01,
  basedOn: ["runs/m-t5:baseline:1/snapshot"],
};

describe("validateDirectorProposal (#113 AC4)", () => {
  test("accepts a bounded in-policy follow-up for every non-stop action", () => {
    for (const action of ["investigate", "repair", "retry", "change-direction"] as const) {
      const proposal = validateDirectorProposal({ ...validTaskProposal, action }, input());
      expect(proposal.action).toBe(action);
      expect(proposal.task?.objective).toContain("0.8");
    }
  });

  test("a stop proposal is bounded advice: it carries no task, cost, or self-asserted result", () => {
    const proposal = validateDirectorProposal({
      stateVersion: 1,
      action: "stop",
      rationale: "the measured 0.4 cannot be improved within the remaining budget",
      stopReason: "insufficient remaining budget for another bounded Experiment",
    }, input());
    expect(proposal.action).toBe("stop");
    expect(proposal.task).toBeUndefined();
  });

  const malformed: Array<[string, unknown]> = [
    ["not an object", "do this instead"],
    ["null", null],
    ["a list", []],
    ["missing action", { stateVersion: 1, rationale: "x" }],
    ["unsupported action", { ...validTaskProposal, action: "submit" }],
    ["unknown action", { ...validTaskProposal, action: "promote" }],
    ["missing rationale", { stateVersion: 1, action: "stop" }],
    ["non-string rationale", { ...validTaskProposal, rationale: 4 }],
    ["empty rationale", { ...validTaskProposal, rationale: "   " }],
    ["stateVersion wrong type", { ...validTaskProposal, stateVersion: "1" }],
    ["non-object task", { ...validTaskProposal, task: "write answer.txt" }],
    ["task without objective", { ...validTaskProposal, task: { expectedOutputs: ["answer.txt"] } }],
    ["blank task objective", { ...validTaskProposal, task: { objective: "   " } }],
    ["expectedOutputs not strings", { ...validTaskProposal, task: { objective: "x", expectedOutputs: [1] } }],
    ["constraints not an object", { ...validTaskProposal, task: { objective: "x", constraints: [] } }],
    ["non-scalar constraint value", { ...validTaskProposal, task: { objective: "x", constraints: { k: {} } } }],
    ["expectedCost negative", { ...validTaskProposal, expectedCost: -0.01 }],
    ["expectedCost non-finite", { ...validTaskProposal, expectedCost: NaN }, ],
    ["expectedCost wrong type", { ...validTaskProposal, expectedCost: "0.01" }],
    ["basedOn not a string list", { ...validTaskProposal, basedOn: ["snapshot", 7] }],
    ["stopReason non-string", { stateVersion: 1, action: "stop", rationale: "x", stopReason: 1 }],
  ];
  for (const [label, raw] of malformed) {
    test(`rejects malformed proposal: ${label}`, () => {
      expect(() => validateDirectorProposal(raw, input())).toThrow(DirectorProposalRejectedError);
    });
  }

  test("a stale stateVersion is rejected (the proposal answers an older state)", () => {
    expect(() => validateDirectorProposal({ ...validTaskProposal, stateVersion: 0 }, input()))
      .toThrow(/stateVersion|stale/i);
    expect(() => validateDirectorProposal({ ...validTaskProposal, stateVersion: 9 }, input()))
      .toThrow(/stateVersion|stale/i);
  });

  test("an over-budget proposal is rejected without executing it", () => {
    expect(() => validateDirectorProposal({ ...validTaskProposal, expectedCost: 5 }, input()))
      .toThrow(/budget/i);
  });

  test("retry/repair must reference the prior attempt they act on", () => {
    for (const action of ["retry", "repair"] as const) {
      expect(() => validateDirectorProposal(
        { stateVersion: 1, action, rationale: "again", task: { objective: "redo answer.txt" } },
        input(),
      )).toThrow(/basedOn/i);
    }
    // an unknown reference is also rejected
    expect(() => validateDirectorProposal(
      { ...validTaskProposal, action: "retry", basedOn: ["runs/does-not-exist/snapshot"] },
      input(),
    )).toThrow(/basedOn|unknown|reference/i);
  });

  test("the model cannot expand its own mandate: objective/permission/budget keys are rejected", () => {
    const expansions: Array<[string, Record<string, unknown>]> = [
      ["top-level objective", { ...validTaskProposal, objective: "a different objective" }],
      ["top-level permissions", { ...validTaskProposal, permissions: ["external-submission"] }],
      ["top-level budget", { ...validTaskProposal, budget: { total: 999 } }],
      ["grant inside constraints", { ...validTaskProposal, task: { objective: "x", permissions: ["network"] } }],
      ["network inside constraints", { ...validTaskProposal, task: { objective: "x", constraints: { network: "open" } } }],
      ["submission inside constraints", { ...validTaskProposal, task: { objective: "x", constraints: { submit: "external" } } }],
      ["forbidden permission as constraint value", { ...validTaskProposal, task: { objective: "x", constraints: { mode: "external submission ok" } } }],
    ];
    for (const [label, proposalRaw] of expansions) {
      expect(() => validateDirectorProposal(proposalRaw, input())).toThrow(/objectiv|permission|budget|network|submi|authority/i);
    }
  });

  test("unsupported success/result claims are rejected: only the evaluator establishes results", () => {
    const claims: Array<[string, Record<string, unknown>]> = [
      ["top-level success", { ...validTaskProposal, success: true }],
      ["top-level score", { ...validTaskProposal, score: 1 }],
      ["top-level result", { ...validTaskProposal, result: { score: 1 } }],
      ["top-level verified", { ...validTaskProposal, verified: true }],
      ["task-level claimed score", { ...validTaskProposal, task: { objective: "x", score: 0.99 } }],
      ["task-level verified", { ...validTaskProposal, task: { objective: "x", verified: true } }],
    ];
    for (const [label, claimRaw] of claims) {
      expect(() => validateDirectorProposal(claimRaw, input())).toThrow(/success|score|result|verified|claim/i);
    }
  });
});

describe("buildDirectorInput (#113 AC2/AC5)", () => {
  function record(): MissionRecord {
    return {
      schemaVersion: 1,
      id: "m-t5",
      status: "baseline-complete",
      objective: "raise the measured answer toward 0.9 without cheating",
      contract: {
        objective: "raise the measured answer toward 0.9 without cheating",
        expectedOutputs: ["answer.txt"],
        evaluationMethod: "file-answer-deterministic",
        metric: "answer in [0,1]",
        hardRules: ["no external submission"],
      },
      budget: { total: 1, units: "model-USD", consumed: 0.02, remaining: 0.98 },
      reserved: 0,
      usage: {
        intake: { tokens: { input: 1, output: 1, total: 2 }, cost: { total: 0.001, units: "model-USD" } },
        runs: [],
      },
      runs: {
        "m-t5:baseline:1": {
          runId: "m-t5:baseline:1", intentId: "i", attempt: 1, status: "measured",
          workspace: "/tmp/ws-1", snapshotRef: "runs/m-t5:baseline:1/snapshot",
          resultRef: "runs/m-t5:baseline:1/result.json",
          dispatchedAt: "2026-09-11T00:00:00.000Z", finishedAt: "2026-09-11T00:00:01.000Z",
        },
      },
      baselineRunId: "m-t5:baseline:1",
      baseline: {
        runId: "m-t5:baseline:1",
        candidateId: "candidate:aaa",
        snapshotDigest: "aaa",
        evaluator: { id: "file-answer-deterministic", version: "1" },
        evaluation: { ok: true, score: 0.4, facts: [{ name: "answer", value: 0.4, source: "answer.txt" }] },
        evidenceRefs: ["runs/m-t5:baseline:1/snapshot", "runs/m-t5:baseline:1/result.json"],
        measuredAt: "2026-09-11T00:00:01.000Z",
      },
      experiments: [],
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt with value 0.4" }],
      decisions: [],
      stateVersion: 1,
      history: [],
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:01.000Z",
    };
  }

  test("projects objective, policy, remaining budget, tasks, and real observations", () => {
    const projected = buildDirectorInput(record(), {
      permissions: ["read-project", "isolated-workspace-write"],
      hardRules: ["no external submission", "no network"],
      stopConditions: ["budget exhausted"],
    });
    expect(projected.stateVersion).toBe(1);
    expect(projected.objective).toContain("0.9");
    expect(projected.policy.permissions).toEqual(["read-project", "isolated-workspace-write"]);
    expect(projected.budget.remaining).toBeCloseTo(0.98, 6);
    expect(projected.budget.units).toBe("model-USD");
    expect(projected.observations).toHaveLength(1);
    expect(projected.observations[0]).toMatchObject({ runId: "m-t5:baseline:1", kind: "baseline", ok: true, score: 0.4 });
  });

  test("failed and inconclusive attempts are projected as Negative Evidence with their references", () => {
    const failed = record();
    const withNegative: MissionRecord = {
      ...failed,
      stateVersion: 2,
      experiments: [{
        runId: "m-t5:exp:2",
        attempt: 2,
        action: "change-direction",
        ok: false,
        negativeEvidence: true,
        taskObjective: "try again",
        ruleViolations: ["answer.txt is missing"],
        evaluation: { ok: false, ruleViolations: ["answer.txt is missing"] },
        evidenceRefs: ["runs/m-t5:exp:2/snapshot", "runs/m-t5:exp:2/result.json"],
        at: "2026-09-11T00:00:02.000Z",
      }],
    };
    const projected = buildDirectorInput(withNegative, {
      permissions: [], hardRules: [], stopConditions: [],
    });
    expect(projected.observations).toHaveLength(2);
    const negative = projected.observations.find((o) => o.runId === "m-t5:exp:2")!;
    expect(negative.ok).toBe(false);
    expect(negative.negativeEvidence).toBe(true);
    expect(negative.evidenceRefs).toContain("runs/m-t5:exp:2/result.json");
    expect(projected.stateVersion).toBe(2);
  });

  test("a dispatch failure (no measurement) is still retained as Negative Evidence, never dropped", () => {
    const crashed: MissionRecord = {
      ...record(),
      stateVersion: 2,
      runs: {
        ...record().runs,
        "m-t5:exp:2": {
          runId: "m-t5:exp:2", intentId: "i2", attempt: 2, status: "failed",
          workspace: "/tmp/ws-2", error: "model provider returned 500",
          dispatchedAt: "2026-09-11T00:00:02.000Z", finishedAt: "2026-09-11T00:00:02.000Z",
        },
      },
      experiments: [{
        runId: "m-t5:exp:2", attempt: 2, action: "retry", ok: false, negativeEvidence: true,
        taskObjective: "retry", error: "model provider returned 500", evidenceRefs: [],
        at: "2026-09-11T00:00:02.000Z",
      }],
    };
    const projected = buildDirectorInput(crashed, { permissions: [], hardRules: [], stopConditions: [] });
    const negative = projected.observations.find((o) => o.runId === "m-t5:exp:2")!;
    expect(negative.ok).toBe(false);
    expect(negative.error).toMatch(/500/);
  });
});
