/**
 * Unit tests for pure T4 start/validation helpers (#112). The cross-module
 * primary-seam suite (controlled model + real local file execution +
 * independent deterministic evaluator) lives under
 * tests/integration/mission-start.test.ts per AGENTS.md.
 */
import { describe, expect, test } from "bun:test";
import { isExplicitStartRequest } from "./mission-start";
import { EvaluationContractError, normalizeFileMetricContract } from "./local-file-evaluator";

describe("isExplicitStartRequest (#112 AC1)", () => {
  const starts = [
    "/start",
    "/start m-ab12",
    "start the mission baseline",
    "please start the baseline now",
    "launch the experiment",
    "kick off the run",
    "BEGIN THE MISSION",
  ];
  for (const text of starts) {
    test(`dispatches a positive imperative: ${JSON.stringify(text)}`, () => {
      expect(isExplicitStartRequest(text)).toBe(true);
    });
  }

  const notStarts = [
    "when can we start the mission?",
    "do not start the mission",
    "don't start the baseline yet",
    "what happens if I start the run?",
    "maybe we should start later",
    "never start the experiment without me",
    "start?",
    "should we start the mission?",
    "I would not start the baseline in this state",
  ];
  for (const text of notStarts) {
    test(`stays a conversation: ${JSON.stringify(text)}`, () => {
      expect(isExplicitStartRequest(text)).toBe(false);
    });
  }
});

describe("normalizeFileMetricContract (#112)", () => {
  test("accepts a minimal artifact contract", () => {
    const c = normalizeFileMetricContract({ id: "file-metric", version: "1", artifact: "answer.txt" });
    expect(c.id).toBe("file-metric");
    expect(c.artifact).toBe("answer.txt");
    expect(c.min).toBeUndefined();
  });

  test("passes metric and finite bounds through", () => {
    const c = normalizeFileMetricContract({ id: "e", version: "2", artifact: "out", metric: "NDCG", min: 0, max: 1 });
    expect(c).toEqual({ id: "e", version: "2", artifact: "out", metric: "NDCG", min: 0, max: 1 });
  });

  const bad: Array<[string, unknown]> = [
    ["not an object", null],
    ["missing id", { version: "1", artifact: "a" }],
    ["missing version", { id: "e", artifact: "a" }],
    ["traversal artifact", { id: "e", version: "1", artifact: "../../etc/passwd" }],
    ["absolute artifact", { id: "e", version: "1", artifact: "/etc/passwd" }],
    ["non-finite min", { id: "e", version: "1", artifact: "a", min: "x" }],
    ["min above max", { id: "e", version: "1", artifact: "a", min: 2, max: 1 }],
  ];
  for (const [label, value] of bad) {
    test(`rejects ${label}`, () => {
      expect(() => normalizeFileMetricContract(value)).toThrow(EvaluationContractError);
    });
  }
});
