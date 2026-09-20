/**
 * ET-OPS-DOMAIN (#173): local-js-exports suite runner.
 * Executes trusted cases against Candidate JS exports. Never reads a self-score.
 */
import { describe, expect, test } from "bun:test";
import {
  LOCAL_JS_EXPORTS_RUNNER,
  evaluateSuiteMetric,
  normalizeSuiteMetricContract,
  type SuiteMetricContract,
} from "./suite-metric";

function contract(): SuiteMetricContract {
  return normalizeSuiteMetricContract({
    id: "suite-metric",
    version: "1",
    suite: {
      kind: "local-tests",
      runner: LOCAL_JS_EXPORTS_RUNNER,
      cases_glob_or_manifest: "suite/cases.json",
    },
    score: { metric: "pass_rate", min: 0, max: 1 },
    artifact_refs: [],
  });
}

const CASES = {
  module: "src/solve.js",
  cases: [
    { id: "double", export: "double", args: [21], expected: 42 },
    { id: "isEven", export: "isEven", args: [4], expected: true },
    { id: "sum", export: "sum", args: [2, 3], expected: 5 },
    { id: "max", export: "max", args: [2, 9], expected: 9 },
    { id: "clamp", export: "clamp", args: [15, 0, 10], expected: 10 },
  ],
};

function suiteFiles(body: unknown = CASES): Readonly<Record<string, string>> {
  return { "suite/cases.json": JSON.stringify(body) };
}

describe("local-js-exports suite runner (ET-OPS-DOMAIN / #173)", () => {
  test("partially correct exports yield a measured mid pass_rate of 0.4", async () => {
    const snapshot = {
      "src/solve.js": [
        "function double(n) { return n * 2; }",
        "function isEven(n) { return n % 2 === 0; }",
        "function sum(a) { return a; }",
        "function max(a) { return a; }",
        "function clamp(n) { return n; }",
        "module.exports = { double, isEven, sum, max, clamp };",
        "",
      ].join("\n"),
    };
    const result = await evaluateSuiteMetric(snapshot, contract(), { suiteFiles: suiteFiles() });
    expect(result.status).toBe("fail");
    expect(result.n_pass).toBe(2);
    expect(result.n_total).toBe(5);
    expect(result.score).toBe(0.4);
  });

  test("missing candidate module fails closed and is not a silent 1.0", async () => {
    const result = await evaluateSuiteMetric({}, contract(), { suiteFiles: suiteFiles() });
    expect(result.status).toBe("fail");
    expect(result.n_total).toBe(5);
    expect(result.n_pass).toBe(0);
    expect(result.score).toBe(0);
    expect(result.score).not.toBe(1);
  });

  test("every export matching yields pass_rate 1.0", async () => {
    const snapshot = {
      "src/solve.js": [
        "function double(n) { return n * 2; }",
        "function isEven(n) { return n % 2 === 0; }",
        "function sum(a, b) { return a + b; }",
        "function max(a, b) { return a > b ? a : b; }",
        "function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }",
        "module.exports = { double, isEven, sum, max, clamp };",
        "",
      ].join("\n"),
    };
    const result = await evaluateSuiteMetric(snapshot, contract(), { suiteFiles: suiteFiles() });
    expect(result.status).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.n_pass).toBe(5);
  });
});
