import { describe, expect, test } from "bun:test";
import { createScientificSuiteEvaluator, normalizeScientificSuiteContract } from "./scientific-suite-evaluator";
import { classifyRunOutcome } from "./evidence/run-outcome";

const contract = normalizeScientificSuiteContract({
  id: "scientific-suite",
  version: "1",
  artifact: "suite.json",
  metric: "scaffold_diversity",
  primaryGroup: "trained_nose",
  requiredGroups: ["trained_nose", "random", "shuffled", "text"],
  controls: ["random", "shuffled", "text"],
  requireTrainedAdapter: true,
  minRcsCoverage: 0.9,
  rcsTolerance: 0.05,
  mmd: { feature: "morgan", permutations: 1000, seed: 42, estimator: "unbiased", maxP: 0.05 },
});

function suite() {
  return {
    matched_budget: true,
    groups: {
      trained_nose: { protocol: { adapter_trained: true }, metrics: { scaffold_diversity: 0.5, rcs_coverage: 0.95, rcs: 0.8 } },
      random: { protocol: { adapter_trained: false }, metrics: { scaffold_diversity: 0.3, rcs_coverage: 0.95, rcs: 0.7 } },
      shuffled: { protocol: { adapter_trained: true }, metrics: { scaffold_diversity: 0.2, rcs_coverage: 0.95, rcs: 0.6 } },
      text: { metrics: { scaffold_diversity: 0.1, rcs_coverage: 0.95, rcs: 0.7 } },
    },
    mmd: { feature: "morgan", permutations: 1000, seed: 42, estimator: "unbiased", p_value: 0.001 },
  };
}

function evaluate(value: unknown) {
  return createScientificSuiteEvaluator(contract).evaluate({ "suite.json": JSON.stringify(value) }, {} as never);
}

describe("scientific suite evaluator", () => {
  test("accepts a valid controlled measurement", async () => {
    const result = await evaluate(suite());
    expect(result.ok).toBe(true);
    expect(result.score).toBe(0.5);
    expect(result.ruleViolations).toBeUndefined();
  });

  test("an untrained adapter or insufficient RCS coverage is a protocol failure", async () => {
    for (const mutate of [
      (s: any) => { s.groups.trained_nose.protocol.adapter_trained = false; },
      (s: any) => { s.groups.trained_nose.metrics.rcs_coverage = 0.02; },
    ]) {
      const value = suite();
      mutate(value);
      const result = await evaluate(value);
      expect(result.ok).toBe(false);
      expect(result.ruleViolations?.some((v) => v.startsWith("protocol:"))).toBe(true);
      expect(classifyRunOutcome({ ok: false, score: result.score, ruleViolations: result.ruleViolations }).state).toBe("operational");
    }
  });

  test("a valid experiment that loses to a control is scientific negative evidence", async () => {
    const value = suite();
    value.groups.trained_nose.metrics.scaffold_diversity = 0.05;
    const result = await evaluate(value);
    expect(result.ok).toBe(false);
    expect(result.ruleViolations?.some((v) => v.startsWith("protocol:"))).toBe(false);
    expect(classifyRunOutcome({ ok: false, score: result.score, ruleViolations: result.ruleViolations }).scientificNegativeEvidence).toBe(true);
  });

  test("a non-significant MMD is negative only after the protocol passes", async () => {
    const value = suite();
    value.mmd.p_value = 0.2;
    const result = await evaluate(value);
    expect(result.ruleViolations?.some((v) => v.startsWith("mmd.p_value"))).toBe(true);
    value.groups.trained_nose.protocol.adapter_trained = false;
    const invalid = await evaluate(value);
    expect(classifyRunOutcome({ ok: false, score: invalid.score, ruleViolations: invalid.ruleViolations }).state).toBe("operational");
  });
});
