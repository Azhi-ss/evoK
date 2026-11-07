import { describe, expect, test } from "bun:test";
import { classifyRunOutcome } from "./run-outcome";

describe("run outcome classification (#213)", () => {
  test("an OOM dispatch failure is operational, never scientific negative evidence", () => {
    const outcome = classifyRunOutcome({
      ok: false,
      error: "CUDA error: out of memory while allocating 2.5 GiB on the visible device",
    });
    expect(outcome.state).toBe("operational");
    expect(outcome.failure).toBe("out-of-memory");
    expect(outcome.scientificNegativeEvidence).toBe(false);
    expect(outcome.conditions).toContain("failure:out-of-memory");
    expect(outcome.conditions.some((condition) => condition.includes("out of memory"))).toBe(true);
  });

  test("a timeout is an operational failure with its observed condition", () => {
    const outcome = classifyRunOutcome({ ok: false, error: "Run timed out after 900000ms (ETIMEDOUT)" });
    expect(outcome.state).toBe("operational");
    expect(outcome.failure).toBe("timeout");
    expect(outcome.scientificNegativeEvidence).toBe(false);
    expect(outcome.conditions).toContain("failure:timeout");
  });

  test("any other infrastructure/protocol error stays operational", () => {
    const outcome = classifyRunOutcome({ ok: false, error: "dependency resolution failed: no such package" });
    expect(outcome).toMatchObject({ state: "operational", failure: "protocol-failure", scientificNegativeEvidence: false });
  });

  test("a measurement with no score and no rule violation is invalid, not a refutation", () => {
    const outcome = classifyRunOutcome({ ok: false });
    expect(outcome).toMatchObject({ state: "operational", failure: "invalid-measurement", scientificNegativeEvidence: false });
  });

  test("a valid measured rule failure stays scientific Negative Evidence with its conditions", () => {
    const outcome = classifyRunOutcome({ ok: false, ruleViolations: ["answer.txt is missing"] });
    expect(outcome.state).toBe("negative");
    expect(outcome.scientificNegativeEvidence).toBe(true);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.conditions).toEqual(["answer.txt is missing"]);
  });

  test("a measured low score is a scientific negative outcome", () => {
    expect(classifyRunOutcome({ ok: false, score: 0.1 })).toMatchObject({
      state: "negative", scientificNegativeEvidence: true, conditions: [],
    });
  });

  test("a positive measurement is scientific and never negative evidence", () => {
    expect(classifyRunOutcome({ ok: true, score: 0.9 })).toMatchObject({
      state: "positive", scientificNegativeEvidence: false, conditions: [],
    });
  });

  test("the declared Task configuration is carried for the Pitfall projection", () => {
    const outcome = classifyRunOutcome({
      ok: false,
      error: "killed: out of memory",
      configuration: "batch=64; device=single 24GB GPU",
    });
    expect(outcome.conditions).toEqual([
      "failure:out-of-memory",
      "configuration:batch=64; device=single 24GB GPU",
      "observed:killed: out of memory",
    ]);
  });

  test("an unbounded error message is bounded before it can enter memory", () => {
    const outcome = classifyRunOutcome({ ok: false, error: `timed out ${"x".repeat(2000)}` });
    expect(outcome.conditions.every((condition) => condition.length <= 240)).toBe(true);
  });
});
