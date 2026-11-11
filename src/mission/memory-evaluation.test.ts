/**
 * M1-T9: deterministic offline replay and the three-arm report.
 *
 * A replay pins every Run to Mission state, stored Proposals and a snapshot that
 * existed BEFORE that Run began; the report reads three durable arms, separates
 * the three readings and never claims a perfect causal control.
 */
import { describe, expect, test } from "bun:test";
import { MissionResumeRejectedError, assertResearchMemoryArmUnchanged, type DecisionRecord, type ExperimentTrailEntry, type MissionRecord } from "./mission-start";
import {
  RESEARCH_MEMORY_CONTROL_CAVEAT,
  RESEARCH_MEMORY_DIRECTION_CAVEAT,
  RESEARCH_MEMORY_EVALUATION_SCHEMA,
  RESEARCH_MEMORY_L2_MIN_L1_DECISION_POINTS,
  compareResearchMemoryArms,
  concludeResearchMemory,
  evaluateResearchMemory,
  initialStateDigestOf,
  replayResearchMemory,
  researchMemoryArmMetrics,
  type ResearchMemoryEvaluationArm,
  type ResearchMemoryEvaluationPlan,
  type ResearchMemoryEvaluationReport,
  type ResearchMemoryL1Signal,
} from "./memory-evaluation";
import { DECISION_POINT_EVALUATION_KIND, DECISION_POINT_MIN_SAMPLE, type DecisionPointEvaluationReport } from "./decision-point-evaluation";
import {
  assertOffRetainsMissionState,
  decisionRetainedState,
  missionRetainedState,
  recordRetainedState,
} from "./mission-director";

const TOKENS = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 };
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, units: "model-USD" };
const AT = { baseline: "2026-01-01T00:00:00.000Z", one: "2026-01-01T00:01:00.000Z", two: "2026-01-01T00:02:00.000Z", three: "2026-01-01T00:03:00.000Z" };

function trail(overrides: Partial<ExperimentTrailEntry> & { runId: string; at: string }): ExperimentTrailEntry {
  return {
    attempt: 1,
    action: "investigate",
    ok: true,
    taskObjective: "materialize answer.txt",
    evidenceRefs: [],
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> & { decisionId: string; at: string }): DecisionRecord {
  return {
    stateVersion: 1,
    attempt: 1,
    accepted: true,
    tokens: TOKENS,
    cost: 0.1,
    ...overrides,
  };
}

function armRecord(id: string, overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    schemaVersion: 1,
    id,
    status: "iteration-limit",
    objective: "evaluate Research Memory deterministically",
    contract: {
      objective: "evaluate Research Memory deterministically",
      expectedOutputs: ["answer.txt"],
      evaluationMethod: "file-answer-deterministic",
      metric: "answer",
      hardRules: [],
    },
    budget: { total: 1, units: "model-USD", consumed: 0.3, remaining: 0.7 },
    reserved: 0,
    usage: { intake: { tokens: TOKENS, cost: COST }, runs: [] },
    runs: {},
    permissions: ["read-project"],
    stopConditions: ["budget exhausted", "evidence conclusive"],
    modelTier: "default",
    tasks: [{ taskId: "task-baseline", objective: "produce the baseline artifact", expectedOutputs: ["answer.txt"], source: "intake" }],
    decisions: [],
    experiments: [],
    history: [],
    createdAt: AT.baseline,
    updatedAt: AT.three,
    ...overrides,
  } as MissionRecord;
}

function history(): MissionRecord {
  return armRecord("m-arm", {
    baselineRunId: "m-arm:baseline:1",
    baseline: {
      runId: "m-arm:baseline:1",
      candidateId: "candidate-baseline",
      snapshotDigest: "snapshot-baseline",
      evaluator: { id: "file-answer-deterministic", version: "1" },
      evaluation: { ok: true, score: 0.5 },
      evidenceRefs: ["evidence:baseline"],
      measuredAt: AT.baseline,
    },
    experiments: [
      trail({ runId: "m-arm:exp:1", at: AT.one, taskObjective: "materialize answer.txt", evaluation: { ok: true, score: 0.7 } }),
      trail({ runId: "m-arm:exp:2", at: AT.two, taskObjective: "probe a competing kernel", evaluation: { ok: true, score: 0.6 } }),
      trail({ runId: "m-arm:exp:3", at: AT.three, taskObjective: "confirm the winning kernel", evaluation: { ok: true, score: 0.8 } }),
    ],
  });
}

describe("offline replay (M1-T9 AC4)", () => {
  test("Run N sees only state produced before it began, never a later Run", () => {
    const replay = replayResearchMemory({ record: history(), mode: "real" });
    expect(replay.map((run) => run.runId)).toEqual(["m-arm:baseline:1", "m-arm:exp:1", "m-arm:exp:2", "m-arm:exp:3"]);
    // The baseline Run began before any result existed.
    expect(replay[0]!.visibleRunIds).toEqual([]);
    expect(replay[0]!.snapshotId).toBeDefined();
    expect(replay[1]!.visibleRunIds).toEqual(["m-arm:baseline:1"]);
    expect(replay[2]!.visibleRunIds).toEqual(["m-arm:baseline:1", "m-arm:exp:1"]);
    expect(replay[3]!.visibleRunIds).toEqual(["m-arm:baseline:1", "m-arm:exp:1", "m-arm:exp:2"]);
    // Deterministic: same record, byte-identical replay.
    expect(replayResearchMemory({ record: history(), mode: "real" })).toEqual(replay);
  });

  test("a concurrently-finished Branch is invisible to a Run that began first", () => {
    // exp:2 finishes BEFORE exp:1 does, but it began AFTER exp:1 did: replay must
    // key visibility on dispatch time, not on the completion stamp.
    const record = armRecord("m-arm", {
      experiments: [
        trail({ runId: "m-arm:exp:1", at: AT.two, taskObjective: "long branch", evaluation: { ok: true, score: 0.7 } }),
        trail({ runId: "m-arm:exp:2", at: AT.one, taskObjective: "short concurrent branch", evaluation: { ok: true, score: 0.6 } }),
      ],
      runs: {
        "m-arm:exp:1": { runId: "m-arm:exp:1", intentId: "i1", attempt: 1, status: "measured", workspace: "", dispatchedAt: AT.one, finishedAt: AT.two },
        "m-arm:exp:2": { runId: "m-arm:exp:2", intentId: "i2", attempt: 2, status: "measured", workspace: "", dispatchedAt: AT.one, finishedAt: AT.one },
      },
    });
    const replay = replayResearchMemory({ record, mode: "real" });
    expect(replay[1]!.visibleRunIds).not.toContain("m-arm:exp:2");
  });

  // A straight-line Mission's prefix ordinal happens to equal the revision it was
  // served, so this fixture forces the divergence (served 7 vs ordinal 1): the
  // integration test proves the wiring, this proves the preference.
  test("replay pins the durable ledger revision a Run was served, not the prefix ordinal", () => {
    const servedRecord: MissionRecord = {
      ...history(),
      runs: {
        "m-arm:exp:1": {
          runId: "m-arm:exp:1", intentId: "i1", attempt: 1, status: "measured", workspace: "",
          dispatchedAt: AT.one, finishedAt: AT.two,
          researchMemory: { snapshotId: "research-memory:served", snapshotDigest: "served", sliceDigest: "slice", ledgerRevision: 7 },
        },
      },
    };
    const served = replayResearchMemory({ record: servedRecord, mode: "real" }).find((run) => run.runId === "m-arm:exp:1")!;
    expect(served.ledgerRevision).toBe(7);
    // A legacy Run record carries no served revision, so it keeps the ordinal.
    const legacy = replayResearchMemory({ record: history(), mode: "real" }).find((run) => run.runId === "m-arm:exp:1")!;
    expect(legacy.ledgerRevision).toBe(1);
    // The ledger revision is part of the snapshot body, so it changes the identity.
    expect(served.snapshotDigest).not.toBe(legacy.snapshotDigest);
  });

  test("the replayed packet carries no run id that did not exist yet", () => {
    const replay = replayResearchMemory({ record: history(), mode: "real" });
    // The replay itself fails closed on leakage, so a completed replay of a
    // widening history is the proof; assert the visible prefix it pinned to.
    const third = replay[2]!;
    expect(third.visibleRunIds).not.toContain("m-arm:exp:2");
    expect(third.cardCount).toBeGreaterThan(0);
  });

  test("Off delivers no Memory; Sham delivers the same number of control slots", () => {
    const off = replayResearchMemory({ record: history(), mode: "off" });
    expect(off.every((run) => run.snapshotId === undefined && run.cardCount === 0)).toBe(true);
    const real = replayResearchMemory({ record: history(), mode: "real" });
    const sham = replayResearchMemory({ record: history(), mode: "sham" });
    expect(sham.map((run) => run.cardCount)).toEqual(real.map((run) => run.cardCount));
    expect(sham.every((run) => run.control)).toBe(true);
    expect(real.every((run) => !run.control)).toBe(true);
    // The Sham arm serves the control snapshot, so its pinned identity is its
    // own — never the real snapshot's address.
    expect(sham[2]!.snapshotDigest).not.toBe(real[2]!.snapshotDigest);
    expect(sham[2]!.packetDigest).not.toBe(real[2]!.packetDigest);
  });
});

describe("durable evaluation arm (M1-T9 AC1)", () => {
  test("an accepted Mission's arm may be restated but never switched", () => {
    expect(() => assertResearchMemoryArmUnchanged("sham", "sham")).not.toThrow();
    expect(() => assertResearchMemoryArmUnchanged("sham", undefined)).not.toThrow();
    expect(() => assertResearchMemoryArmUnchanged(false, "off")).not.toThrow();
    expect(() => assertResearchMemoryArmUnchanged("sham", "real")).toThrow(MissionResumeRejectedError);
    expect(() => assertResearchMemoryArmUnchanged(undefined, "off")).toThrow(MissionResumeRejectedError);
  });
});

describe("arm metrics and readings (M1-T9 AC5/AC6/AC7)", () => {
  function armWithDivergentRevision(): MissionRecord {
    return armRecord("m-arm", {
      experiments: [
        trail({ runId: "m-arm:exp:1", at: AT.one, taskObjective: "materialize answer.txt", evaluation: { ok: true, score: 0.7 } }),
        // A later comparable measurement of the rejected direction.
        trail({ runId: "m-arm:exp:2", at: AT.three, taskObjective: "probe the rejected kernel", evaluation: { ok: true, score: 0.9 } }),
      ],
      decisions: [
        decision({ decisionId: "d1:1", decisionGroupId: "d1", phase: "blind", at: AT.one, cost: 0.1 }),
        decision({
          decisionId: "d1:1:revision",
          decisionGroupId: "d1",
          phase: "revision",
          at: AT.one,
          cost: 0.2,
          delta: "replaced",
          memory: {
            snapshotId: "research-memory:real",
            snapshotDigest: "real",
            packetDigest: "packet",
            cardRefs: ["finding:m-arm:exp:1"],
            usedCardRefs: ["finding:m-arm:exp:1"],
          },
          rejectedAlternatives: [
            { action: "investigate", objective: "probe the rejected kernel", reason: "superseded by the revision", counterfactualStatus: "unobserved" },
          ],
        }),
      ],
    });
  }

  test("divergence, rejected-direction exposure, both stage costs and Evidence per budget are reported", () => {
    const metrics = researchMemoryArmMetrics({ mode: "real", record: armWithDivergentRevision() });
    expect(metrics.decisionCalls).toBe(2);
    expect(metrics.stageCalls).toEqual({ blind: 1, revision: 1 });
    expect(metrics.stageCosts).toEqual({ blind: 0.1, revision: 0.2 });
    expect(metrics.decisionDivergence).toBe(1);
    expect(metrics.rejectedDirections).toBe(1);
    expect(metrics.hypothesisDiversity).toBe(2);
    expect(metrics.branchCoverage).toBe(2);
    expect(metrics.validEvidence).toBe(2);
    expect(metrics.validEvidencePerBudget).toBeCloseTo(2 / 0.3, 10);
  });

  test("a rejected direction is unobserved until a later comparable Run is measured", () => {
    const record = armWithDivergentRevision();
    const withoutCounterfactual = { ...record, experiments: [record.experiments![0]!] };
    const early = researchMemoryArmMetrics({ mode: "real", record: withoutCounterfactual });
    expect(early.rejectedDirections).toBe(1);
    expect(early.rejectedDirectionsObserved).toBe(0);
    expect(early.observedDecisionRegret).toBe(0);

    const observed = researchMemoryArmMetrics({ mode: "real", record });
    expect(observed.rejectedDirectionsObserved).toBe(1);
    expect(observed.observedDecisionRegret).toBe(1);
  });

  test("An Off arm attributes no change to Memory it never saw", () => {
    const metrics = researchMemoryArmMetrics({ mode: "off", record: armRecord("m-off") });
    expect(metrics.decisionDivergence).toBe(0);
    expect(metrics.rejectedDirectionsObserved).toBe(0);
    expect(metrics.observedDecisionRegret).toBe(0);
  });
});

describe("three-arm report (M1-T9 AC3/AC5)", () => {
  const CONTROLS = {
    modelVersion: "default",
    basePromptRevision: "director-prompt/v1",
    tools: ["read"],
    experimentBudget: 1,
    retryBudget: 1,
    evaluationBudget: 1,
  };

  function arms(): ResearchMemoryEvaluationArm[] {
    return (["off", "sham", "real"] as const).map((mode) => ({ mode, origin: "new-run" as const, record: armRecord(`m-${mode}`), controls: CONTROLS }));
  }

  function l1Signal(): ResearchMemoryL1Signal {
    return {
      kind: "decision-point-counterfactual",
      decisionPoints: DECISION_POINT_MIN_SAMPLE,
      directionOnly: true,
      statisticalSignificance: "none",
      directions: [
        { metric: "matched-action-taken", baseline: "off", treatment: "real", direction: "treatment-higher" },
        { metric: "matched-action-taken", baseline: "sham", treatment: "real", direction: "treatment-higher" },
      ],
    };
  }

  function plan(): ResearchMemoryEvaluationPlan {
    const record = armRecord("m-plan");
    return {
      modelVersion: "default",
      basePromptRevision: "director-prompt/v1",
      tools: ["read"],
      decisionCalls: 0,
      budgets: { token: 1, experiment: 1, retry: 1, evaluation: 1 },
      stoppingConditions: record.stopConditions!,
      initialStateDigest: initialStateDigestOf(record),
    };
  }

  test("one arm per mode yields the three separated readings without a causal claim", () => {
    const report = evaluateResearchMemory({ plan: plan(), arms: arms(), l1Signal: l1Signal() });
    expect(report.schema).toBe(RESEARCH_MEMORY_EVALUATION_SCHEMA);
    expect(report.arms.map((arm) => arm.mode)).toEqual(["off", "sham", "real"]);
    expect(report.comparisons.map((entry) => entry.reading)).toEqual(["overall-benefit", "content-contribution", "context-effect"]);
    expect(report.comparisons.every((entry) => entry.perfectCausalControl === false)).toBe(true);
    expect(report.comparisons.every((entry) => entry.caveat === RESEARCH_MEMORY_CONTROL_CAVEAT)).toBe(true);
    expect(report.assumptions).toContain(RESEARCH_MEMORY_CONTROL_CAVEAT);
    expect(report.integrity.modes.map((entry) => entry.mode)).toEqual(["off", "sham", "real"]);
  });

  test("the report is a whole-mission-comparison and its replay is labelled integrity, not value", () => {
    const report = evaluateResearchMemory({ plan: plan(), arms: arms(), l1Signal: l1Signal() });
    expect(report.kind).toBe("whole-mission-comparison");
    expect(report.integrity.claim).toBe("integrity");
    // The note says out loud what the section can and cannot answer.
    expect(report.integrity.note).toContain("not value evidence");
    // The old section name would let a reader take replay as a value reading.
    expect("replay" in report).toBe(false);
  });

  test("replaying one MissionRecord as every arm is refused instead of reporting a zero delta", () => {
    const record = armRecord("m-shared");
    const shared = (["off", "sham", "real"] as const).map((mode) => ({ mode, origin: "new-run" as const, record, controls: CONTROLS }));
    const refused = /independently produced arms: modes \[off,sham,real\] all derive from the same MissionRecord "m-shared".*zero-delta report/;
    expect(() => evaluateResearchMemory({ plan: plan(), arms: shared, l1Signal: l1Signal() })).toThrow(refused);
    // Stamping the arm onto a copy is how one record becomes three arms; the
    // label cannot make the underlying decisions/experiments any different.
    const stamped = (["off", "sham", "real"] as const).map((mode) => ({ mode, origin: "new-run" as const, record: { ...record, researchMemoryMode: mode }, controls: CONTROLS }));
    expect(() => evaluateResearchMemory({ plan: plan(), arms: stamped, l1Signal: l1Signal() })).toThrow(refused);
    // Two arms on one record are just as unmeasurable as three.
    const partial = arms();
    partial[1] = { mode: "sham", origin: "new-run", record: partial[0]!.record, controls: CONTROLS };
    expect(() => evaluateResearchMemory({ plan: plan(), arms: partial, l1Signal: l1Signal() })).toThrow(/zero-delta report/);
    // The lower-level comparison seam refuses it too, not only the report entry.
    expect(() => compareResearchMemoryArms(shared)).toThrow(refused);
  });

  test("the report records every controlled dimension and whether the arms kept it", () => {
    const report = evaluateResearchMemory({ plan: plan(), arms: arms(), l1Signal: l1Signal() });
    const controls = report.controls.map((entry) => entry.control);
    expect(controls).toEqual([
      "model-version",
      "base-prompts",
      "tools",
      "decision-calls",
      "token-budget",
      "experiment-budget",
      "retry-budget",
      "evaluation-budget",
      "stopping-conditions",
      "initial-state",
    ]);
    expect(report.controls.every((entry) => entry.matched)).toBe(true);
  });

  test("a drifted arm or a missing arm refuses to produce a reading", () => {
    const drifted = arms();
    drifted[2] = { mode: "real", origin: "new-run", record: armRecord("m-real", { budget: { total: 2, units: "model-USD", consumed: 0.3, remaining: 1.7 } }) };
    expect(() => evaluateResearchMemory({ plan: plan(), arms: drifted, l1Signal: l1Signal() })).toThrow(/token-budget/);

    // An undeclared control cannot be assumed matched either.
    const undeclared = arms();
    delete (undeclared[1] as { controls?: unknown }).controls;
    expect(() => evaluateResearchMemory({ plan: plan(), arms: undeclared, l1Signal: l1Signal() })).toThrow(/base-prompts/);

    expect(() => evaluateResearchMemory({ plan: plan(), arms: arms().slice(0, 2), l1Signal: l1Signal() })).toThrow(/one arm per mode/);
    expect(() => evaluateResearchMemory({ plan: plan(), arms: [...arms(), arms()[0]!], l1Signal: l1Signal() })).toThrow(/duplicate/);
  });

  test("comparisons are treatment minus control, never an absolute score", () => {
    const comparisons = compareResearchMemoryArms(arms());
    expect(comparisons).toHaveLength(3);
    for (const comparison of comparisons) {
      expect(typeof comparison.delta.validEvidencePerBudget).toBe("number");
      expect(comparison.baseline).not.toBe(comparison.treatment);
    }
    // A missing arm yields no reading rather than a fabricated one.
    expect(compareResearchMemoryArms(arms().slice(1))).toHaveLength(1);
  });

  test("the report refuses an off arm whose decision state lost the measured scoreboard (F5 / #231)", () => {
    const lost = arms();
    // A measured baseline that the trusted projection cannot carry: the off arm
    // would be decided on a Mission with no current best at all.
    lost[0] = {
      mode: "off",
      origin: "new-run",
      controls: CONTROLS,
      record: armRecord("m-off", {
        baseline: {
          runId: "m-off:baseline:1",
          candidateId: "candidate-baseline",
          snapshotDigest: "snapshot-baseline",
          evaluator: { id: "file-answer-deterministic", version: "1" },
          evaluation: { ok: true, score: 0.5 },
          evidenceRefs: ["evidence:baseline"],
          measuredAt: AT.baseline,
        },
      }),
    };
    expect(() => evaluateResearchMemory({ plan: plan(), arms: lost, l1Signal: l1Signal() })).toThrow(/lost the Mission scoreboard/);
  });
});

describe("off arm retains Mission state (F5 / #231)", () => {
  test("both evaluation scopes carry the current best and the whole scoreboard", () => {
    const record = history();
    const durable = recordRetainedState(record);
    expect(durable.scoreboard.map((row) => row.runId)).toEqual(["m-arm:baseline:1", "m-arm:exp:1", "m-arm:exp:2", "m-arm:exp:3"]);
    expect(durable.currentBest?.runId).toBe("m-arm:exp:3");
    // What the decision projection hands the model must be the durable state.
    const projected = decisionRetainedState(record);
    expect(projected.digest).toBe(durable.digest);
    for (const scope of ["decision-point", "whole-mission"] as const) {
      expect(() => assertOffRetainsMissionState({ mode: "off", scope, retained: projected, expected: durable })).not.toThrow();
    }
    // Only the Memory-denied arm can lose state by construction; the other
    // arms are not asserted here.
    expect(() => assertOffRetainsMissionState({ mode: "sham", scope: "whole-mission", retained: { scoreboard: [], digest: "none" }, expected: durable })).not.toThrow();
  });

  test("an off arm that lacks the scoreboard or the current best fails in both scopes", () => {
    const expected = recordRetainedState(history());
    for (const scope of ["decision-point", "whole-mission"] as const) {
      expect(() => assertOffRetainsMissionState({ mode: "off", scope, retained: { scoreboard: [], digest: "empty" }, expected })).toThrow(/lost the Mission scoreboard/);
      // Rows present but the current best dropped is still amnesia, not Memory.
      expect(() => assertOffRetainsMissionState({
        mode: "off",
        scope,
        retained: { scoreboard: expected.scoreboard, digest: expected.digest },
        expected,
      })).toThrow(/current best/);
      // A partially retained scoreboard is refused too.
      expect(() => assertOffRetainsMissionState({
        mode: "off",
        scope,
        retained: { scoreboard: expected.scoreboard.slice(0, 1), digest: "partial" },
        expected,
      })).toThrow(/m-arm:exp/);
    }
  });

  test("the decision point refuses an off arm whose handed state was stripped", () => {
    const record = history();
    // The controller hands one base state to every arm of a decision point, so
    // the reference is that shared state, not a second read of the arm's own
    // projection. An off arm that strips observations loses the scoreboard here.
    const baseState = decisionRetainedState(record);
    const stripped = missionRetainedState([]);
    expect(() => assertOffRetainsMissionState({ mode: "off", scope: "decision-point", retained: stripped, expected: baseState })).toThrow(/lost the Mission scoreboard/);
    // Keeping only the baseline (dropping the measured Experiments) is refused too.
    expect(() => assertOffRetainsMissionState({
      mode: "off",
      scope: "decision-point",
      retained: decisionRetainedState({ ...record, experiments: [] }),
      expected: baseState,
    })).toThrow(/m-arm:exp/);
    // Handing the same base state passes, and replay still reports Off as fully
    // Memory-blind rather than state-blind.
    expect(() => assertOffRetainsMissionState({ mode: "off", scope: "decision-point", retained: baseState, expected: baseState })).not.toThrow();
    const replay = replayResearchMemory({ record, mode: "off" });
    expect(replay.map((entry) => entry.cardCount)).toEqual([0, 0, 0, 0]);
  });
});

describe("L2 online multi-arm gating (B4 / #233)", () => {
  const CONTROLS = {
    modelVersion: "default",
    basePromptRevision: "director-prompt/v1",
    tools: ["read"],
    experimentBudget: 1,
    retryBudget: 1,
    evaluationBudget: 1,
  };

  /** One L1 reading: directional only, no significance, enough points to state a direction. */
  function l1Signal(overrides: Partial<ResearchMemoryL1Signal> = {}): ResearchMemoryL1Signal {
    return {
      kind: "decision-point-counterfactual",
      decisionPoints: DECISION_POINT_MIN_SAMPLE,
      directionOnly: true,
      statisticalSignificance: "none",
      directions: [
        { metric: "matched-action-taken", baseline: "off", treatment: "real", direction: "treatment-higher" },
        { metric: "matched-action-taken", baseline: "sham", treatment: "real", direction: "treatment-higher" },
      ],
      ...overrides,
    };
  }

  /** One arm record whose exploration width is the number of distinct objectives. */
  function exploredArm(id: string, objectives: readonly string[]): MissionRecord {
    return armRecord(id, {
      experiments: objectives.map((taskObjective, index) =>
        trail({ runId: `${id}:exp:${index + 1}`, at: AT.one, taskObjective, evaluation: { ok: true, score: 0.6 } })),
    });
  }

  function arms(prefix = "m-off", objectives: readonly string[] = ["materialize answer.txt"]): ResearchMemoryEvaluationArm[] {
    return (["off", "sham", "real"] as const).map((mode) => ({
      mode,
      origin: "new-run" as const,
      record: exploredArm(`${prefix}-${mode}`, objectives),
      controls: CONTROLS,
    }));
  }

  function plan(decisionCalls = 0): ResearchMemoryEvaluationPlan {
    const record = armRecord("m-plan");
    return {
      modelVersion: "default",
      basePromptRevision: "director-prompt/v1",
      tools: ["read"],
      decisionCalls,
      budgets: { token: 1, experiment: 1, retry: 1, evaluation: 1 },
      stoppingConditions: record.stopConditions!,
      initialStateDigest: initialStateDigestOf(record),
    };
  }

  function replicate(prefix: string, widths: { readonly off: number; readonly sham: number; readonly real: number }): ResearchMemoryEvaluationReport {
    const all: ResearchMemoryEvaluationArm[] = (["off", "sham", "real"] as const).map((mode) => ({
      mode,
      origin: "new-run" as const,
      record: exploredArm(`${prefix}-${mode}`, Array.from({ length: widths[mode] }, (_, index) => `objective ${index}`)),
      controls: CONTROLS,
    }));
    return evaluateResearchMemory({ plan: plan(), arms: all, l1Signal: l1Signal() });
  }

  test("L2 refuses to run without an L1 directional-benefit signal", () => {
    const run = (signal: ResearchMemoryL1Signal | undefined) =>
      evaluateResearchMemory({ plan: plan(), arms: arms(), l1Signal: signal as ResearchMemoryL1Signal });

    expect(() => run(undefined)).toThrow(/requires an L1 directional-signal input/);
    // A flat or negative L1 reading is not a signal to spend L2 budget on.
    const directions = (direction: "treatment-higher" | "treatment-lower" | "flat") => [
      { metric: "matched-action-taken" as const, baseline: "off" as const, treatment: "real" as const, direction },
    ];
    expect(() => run(l1Signal({ directions: directions("flat") }))).toThrow(/directional benefit/);
    expect(() => run(l1Signal({ directions: directions("treatment-lower") }))).toThrow(/directional benefit/);
    // An under-powered or significance-claiming L1 report cannot gate L2 either.
    expect(() => run(l1Signal({ decisionPoints: DECISION_POINT_MIN_SAMPLE - 1 }))).toThrow(/at least 50/);
    expect(() => run(l1Signal({ statisticalSignificance: "reported" as never }))).toThrow(/no significance/);
    expect(() => run(l1Signal({ kind: "whole-mission-comparison" as never }))).toThrow(/decision-point/);

    const report = run(l1Signal());
    expect(report.l1).toEqual({ decisionPoints: DECISION_POINT_MIN_SAMPLE, overallBenefitDirection: "treatment-higher" });
    // L2 inherits L1's sample floor rather than inventing a second one.
    expect(RESEARCH_MEMORY_L2_MIN_L1_DECISION_POINTS).toBe(DECISION_POINT_MIN_SAMPLE);
    // The gate speaks L1's own kind, and a real L1 report satisfies the signal
    // type structurally: a rename on either side is a type or test failure.
    expect(l1Signal().kind).toBe(DECISION_POINT_EVALUATION_KIND);
    const asSignal = (report: DecisionPointEvaluationReport): ResearchMemoryL1Signal => report;
    expect(typeof asSignal).toBe("function");
  });

  test("a report mixing historical-replay arms with newly-run arms is rejected", () => {
    const mixed = arms();
    mixed[2] = { ...mixed[2]!, origin: "historical-replay" };
    const mixedError = /historical-replay arms cannot be mixed with newly-run arms/;
    expect(() => evaluateResearchMemory({ plan: plan(), arms: mixed, l1Signal: l1Signal() })).toThrow(mixedError);
    // The lower-level comparison seam refuses it too, so no reading escapes.
    expect(() => compareResearchMemoryArms(mixed)).toThrow(mixedError);
    // L2 is new Missions only: an all-replay report is not a comparison either.
    const replayed = arms().map((arm) => ({ ...arm, origin: "historical-replay" as const }));
    expect(() => evaluateResearchMemory({ plan: plan(), arms: replayed, l1Signal: l1Signal() })).toThrow(/needs newly-run Missions/);
  });

  test("both Director stages are counted in every arm, including off", () => {
    const staged = arms().map((arm) => ({
      ...arm,
      record: armRecord(arm.record.id, {
        experiments: [trail({ runId: `${arm.record.id}:exp:1`, at: AT.two, taskObjective: "materialize answer.txt", evaluation: { ok: true, score: 0.7 } })],
        decisions: [
          decision({ decisionId: `${arm.record.id}:d1:blind`, decisionGroupId: "d1", phase: "blind", at: AT.one, cost: 0.1 }),
          decision({ decisionId: `${arm.record.id}:d1:revision`, decisionGroupId: "d1", phase: "revision", at: AT.two, cost: 0.2 }),
        ],
      }),
    }));
    const report = evaluateResearchMemory({ plan: plan(2), arms: staged, l1Signal: l1Signal() });
    for (const arm of report.arms) {
      expect(arm.stageCalls).toEqual({ blind: 1, revision: 1 });
      expect(arm.stageCosts).toEqual({ blind: 0.1, revision: 0.2 });
    }
    // The Memory-denied arm pays for both stages too: a win from extra thinking
    // is not a Memory result.
    const off = report.arms.find((arm) => arm.mode === "off")!;
    expect(off.stageCosts.blind).toBeGreaterThan(0);
    expect(off.stageCosts.revision).toBeGreaterThan(0);
    // Every cost delta is the sum of both stages, never one of them.
    expect(report.comparisons.every((comparison) => comparison.delta.decisionCost === 0)).toBe(true);
  });

  test("only directional metrics are reported and a conclusion needs 2–3 agreeing Missions", () => {
    const first = replicate("r1", { off: 1, sham: 1, real: 2 });
    const second = replicate("r2", { off: 1, sham: 1, real: 2 });

    // The reading itself never claims significance and carries both caveats.
    expect(first.directionOnly).toBe(true);
    expect(first.statisticalSignificance).toBe("none");
    expect(first.assumptions).toContain(RESEARCH_MEMORY_CONTROL_CAVEAT);
    expect(first.assumptions).toContain(RESEARCH_MEMORY_DIRECTION_CAVEAT);

    const conclusion = concludeResearchMemory({ reports: [first, second] });
    expect(conclusion.directionOnly).toBe(true);
    expect(conclusion.statisticalSignificance).toBe("none");
    expect(conclusion.replicates).toBe(2);
    expect(conclusion.conclusion).toBe("stated");
    expect(conclusion.agreed.every((entry) => entry.direction !== "flat")).toBe(true);
    expect(conclusion.agreed.map((entry) => entry.metric)).toContain("hypothesisDiversity");
    expect(conclusion.caveats).toContain(RESEARCH_MEMORY_CONTROL_CAVEAT);
    expect(conclusion.caveats).toContain(RESEARCH_MEMORY_DIRECTION_CAVEAT);
    // Direction words only: no effect size and no significance field anywhere.
    expect(JSON.stringify(conclusion)).not.toMatch(/p-value|confidence|significan(?!ce)/);

    // One replicate is not enough to state a direction; four is more than the
    // declared 2–3 replicate budget.
    expect(() => concludeResearchMemory({ reports: [first] })).toThrow(/2–3/);
    expect(() => concludeResearchMemory({ reports: [first, second, replicate("r3", { off: 1, sham: 1, real: 2 }), replicate("r4", { off: 1, sham: 1, real: 2 })] })).toThrow(/2–3/);
    // The same Mission reported twice is not a replicate.
    expect(() => concludeResearchMemory({ reports: [first, first] })).toThrow(/distinct Missions/);

    // Opposite directions across Missions state no conclusion at all.
    const opposite = replicate("r5", { off: 2, sham: 1, real: 1 });
    const split = concludeResearchMemory({ reports: [first, opposite] });
    expect(split.conclusion).toBe("none");
    expect(split.agreed).toEqual([]);
    expect(split.statement).toContain("no conclusion is stated");
  });
});
