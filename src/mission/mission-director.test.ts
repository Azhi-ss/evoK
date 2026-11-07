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
  buildDirectorPrompt,
  deriveDecisionDelta,
  validateDirectorProposal,
  type DirectorInput,
  type DirectorProposal,
} from "./mission-director";
import { projectResearchDecisionPacket, projectResearchMemorySnapshot } from "../evidence/research-memory";
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

  test("a dispatch failure (no measurement) keeps its Run Outcome as an OPERATIONAL observation, never a refutation", () => {
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
        runId: "m-t5:exp:2", attempt: 2, action: "retry", ok: false,
        taskObjective: "retry", error: "CUDA error: out of memory", evidenceRefs: [],
        at: "2026-09-11T00:00:02.000Z",
      }],
    };
    const projected = buildDirectorInput(crashed, { permissions: [], hardRules: [], stopConditions: [] });
    const observation = projected.observations.find((o) => o.runId === "m-t5:exp:2")!;
    expect(observation.ok).toBe(false);
    expect(observation.error).toMatch(/out of memory/);
    // Operational, visibly distinct, and never scientific Negative Evidence (#213).
    expect(observation).toMatchObject({ outcome: "operational", failure: "out-of-memory" });
    expect(observation.negativeEvidence).toBeUndefined();
  });

  test("replication and critical-ablation proposals stay eligible without a Memory veto (#213)", () => {
    const projected = buildDirectorInput(record(), { permissions: [], hardRules: [], stopConditions: [] });
    const priorRun = projected.observations[0]!.runId;
    // Seed replication: the SAME objective again is a bounded retry, not a duplicate.
    const replication = validateDirectorProposal({
      stateVersion: projected.stateVersion,
      action: "retry",
      rationale: "replicate the baseline approach to measure seed variance",
      task: { objective: "materialize answer.txt with value 0.4", expectedOutputs: ["answer.txt"] },
      expectedCost: 0.01,
      basedOn: [priorRun],
    }, projected);
    expect(replication.action).toBe("retry");
    // Critical ablation: a materially different, narrower run referencing the prior one.
    const ablation = validateDirectorProposal({
      stateVersion: projected.stateVersion,
      action: "change-direction",
      rationale: "ablate the single dominant term to test whether it carries the measured result",
      task: { objective: "materialize answer.txt with the dominant term removed", expectedOutputs: ["answer.txt"] },
      expectedCost: 0.01,
      basedOn: [priorRun],
    }, projected);
    expect(ablation.action).toBe("change-direction");
  });
});

// ── M1-T2 (#211): Memory-blind Proposal → Memory-informed Revision ──────────

const task = (objective: string, outputs: readonly string[] = ["answer.txt"]) => ({ objective, expectedOutputs: [...outputs] });

const proposal = (action: DirectorProposal["action"], objective: string, rest: Partial<DirectorProposal> = {}): DirectorProposal => ({
  stateVersion: 1,
  action,
  rationale: "measured evidence drives this action",
  ...(action === "stop" ? { stopReason: "bounded demo complete" } : { task: task(objective) }),
  ...rest,
});

describe("controller-derived decision delta (#211)", () => {
  test("an identical revised proposal is unchanged", () => {
    const blind = proposal("investigate", "materialize answer.txt with value 0.8");
    expect(deriveDecisionDelta(blind, structuredClone(blind))).toBe("unchanged");
  });

  test("keeping the same options but choosing a different head is reordered", () => {
    const alternate = { action: "repair" as const, objective: "fix answer.txt parsing", expectedOutputs: ["answer.txt"] };
    const blind = proposal("investigate", "materialize answer.txt with value 0.8", { alternatives: [alternate] });
    const revised = proposal("repair", "fix answer.txt parsing", {
      alternatives: [{ action: "investigate", objective: "materialize answer.txt with value 0.8", expectedOutputs: ["answer.txt"] }],
    });
    expect(deriveDecisionDelta(blind, revised)).toBe("reordered");
  });

  test("a different action or task is a replacement", () => {
    expect(deriveDecisionDelta(
      proposal("investigate", "materialize answer.txt with value 0.8"),
      proposal("change-direction", "materialize answer.txt with value 0.9"),
    )).toBe("replaced");
  });

  test("a revised stop withdraws the blind action instead of replacing it", () => {
    expect(deriveDecisionDelta(
      proposal("investigate", "materialize answer.txt with value 0.8"),
      proposal("stop", "unused"),
    )).toBe("withdrawn");
    expect(deriveDecisionDelta(proposal("stop", "unused"), proposal("stop", "unused"))).toBe("unchanged");
    expect(deriveDecisionDelta(proposal("stop", "unused"), proposal("investigate", "materialize answer.txt"))).toBe("replaced");
  });

  test("widening the dispatched action is an expansion; adding an undispatched alternative is not", () => {
    const added = { action: "repair" as const, objective: "fix answer.txt parsing", expectedOutputs: ["answer.txt"] };
    const blind = proposal("investigate", "materialize answer.txt with value 0.8");
    // The dispatched action did not change, so the delta is unchanged; the
    // extra alternative is audited as a rejected alternative instead.
    const withAlternative = proposal("investigate", "materialize answer.txt with value 0.8", { alternatives: [added] });
    expect(deriveDecisionDelta(blind, withAlternative)).toBe("unchanged");
    // The same action/objective with a wider declared output set is an
    // expansion that still has to pass the existing action/Task validation.
    const wider = proposal("investigate", "materialize answer.txt with value 0.8", { task: task("materialize answer.txt with value 0.8", ["answer.txt", "notes.md"]) });
    expect(deriveDecisionDelta(blind, wider)).toBe("expanded_via_existing_search");
  });

  test("a model-declared delta field is ignored: the controller compares proposals", () => {
    const blind = proposal("investigate", "materialize answer.txt with value 0.8");
    const revised = { ...proposal("change-direction", "materialize answer.txt with value 0.9"), delta: "unchanged" } as unknown as DirectorProposal;
    expect(deriveDecisionDelta(blind, revised)).toBe("replaced");
  });

  test("alternatives are bounded and validated by the same rules as the head", () => {
    expect(() => validateDirectorProposal({
      stateVersion: 1,
      action: "investigate",
      rationale: "with a malformed alternative",
      task: task("materialize answer.txt"),
      alternatives: [{ action: "submission", objective: "submit externally" }],
    }, input())).toThrow(/alternative/);
    expect(() => validateDirectorProposal({
      stateVersion: 1,
      action: "investigate",
      rationale: "too many",
      task: task("materialize answer.txt"),
      alternatives: Array.from({ length: 5 }, (_, index) => ({ action: "investigate", objective: `option ${index}` })),
    }, input())).toThrow(/alternatives/);
    const accepted = validateDirectorProposal({
      stateVersion: 1,
      action: "investigate",
      rationale: "one bounded alternative",
      task: task("materialize answer.txt"),
      alternatives: [{ action: "repair", objective: "fix the parsing path" }],
    }, input());
    expect(accepted.alternatives).toEqual([{ action: "repair", objective: "fix the parsing path" }]);
  });
});

describe("two-stage decision prompt (#211)", () => {
  const packet = projectResearchDecisionPacket(projectResearchMemorySnapshot({
    missionId: "m-t5",
    ledgerRevision: 1,
    runs: [{ runId: "m-t5:baseline:1", ok: true, score: 0.4, evidenceRefs: ["runs/m-t5:baseline:1/result.json"] }],
  }));

  test("the blind prompt carries the trusted state and no Research Memory projection", () => {
    const blind = buildDirectorPrompt(input());
    expect(blind).toContain("CURRENT AUTHORITATIVE MISSION STATE (JSON):");
    expect(blind).not.toContain("RESEARCH DECISION PACKET");
    expect(blind).not.toContain("BLIND PROPOSAL");
  });

  test("the revision prompt adds ONLY the frozen proposal and the pinned packet", () => {
    const blind = buildDirectorPrompt(input());
    const blindProposal = proposal("investigate", "materialize answer.txt with value 0.8");
    const revision = buildDirectorPrompt(input({
      decisionPhase: { blindProposal, memoryPacket: packet },
    }));
    expect(revision.startsWith(blind)).toBe(true);
    const added = revision.slice(blind.length);
    expect(added).toContain("RESEARCH DECISION PACKET");
    expect(added).toContain(packet.cards[0]!.cardId);
    expect(added).toContain(JSON.stringify(blindProposal));
    // nothing else about the trusted state changed between the two stages
    expect(added).not.toContain('"observations"');
    expect(added).not.toContain('"stopConditions"');
    expect(added).not.toContain('"budget"');
    expect(added).not.toContain('"contract"');
  });

  test("a revision without a pinned packet still freezes and re-reads the blind proposal", () => {
    const revision = buildDirectorPrompt(input({
      decisionPhase: { blindProposal: proposal("investigate", "materialize answer.txt") },
    }));
    expect(revision).toContain("BLIND PROPOSAL");
    expect(revision).toContain("no Research Memory snapshot is pinned");
  });
});
