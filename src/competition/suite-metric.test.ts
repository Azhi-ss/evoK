/**
 * ET-EVAL-SUITE (#172): suite-metric Competition Adapter.
 * Public seams only — Candidate snapshot + evaluation.json contract.
 * Score is a measured pass_rate; model self-score is never an oracle.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SUITE_METRIC_ID,
  SUITE_REPORT_REF,
  createSuiteMetricEvaluator,
  evaluateSuiteMetric,
  normalizeSuiteMetricContract,
  type SuiteMetricContract,
  type SuiteRunner,
} from "./suite-metric";
import * as competitionPacked from "./index";

const MANIFEST_PATH = "suite/cases.json";

const FIVE_CASES = [
  { id: "a", artifact: "answers/a.txt", expected: "ok-a" },
  { id: "b", artifact: "answers/b.txt", expected: "ok-b" },
  { id: "c", artifact: "answers/c.txt", expected: "ok-c" },
  { id: "d", artifact: "answers/d.txt", expected: "ok-d" },
  { id: "e", artifact: "answers/e.txt", expected: "ok-e" },
] as const;

function suiteContract(): SuiteMetricContract {
  return normalizeSuiteMetricContract({
    id: "suite-metric",
    version: "1",
    suite: {
      kind: "local-tests",
      runner: "fixture-manifest",
      cases_glob_or_manifest: MANIFEST_PATH,
    },
    score: { metric: "pass_rate", min: 0, max: 1 },
    artifact_refs: [],
  });
}

function suiteFiles(cases: readonly { id: string; artifact: string; expected: string }[] = FIVE_CASES): Readonly<Record<string, string>> {
  return { [MANIFEST_PATH]: JSON.stringify({ cases }) };
}

function answers(...ids: readonly string[]): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const id of ids) {
    snapshot[`answers/${id}.txt`] = `ok-${id}\n`;
  }
  return snapshot;
}

const dummyContext = {
  missionId: "suite-metric-ac",
  runId: "run-1",
  snapshotDigest: "digest",
  contract: {
    objective: "measure suite pass_rate",
    expectedOutputs: ["answers/"],
    evaluationMethod: "suite-metric",
    hardRules: [],
  },
};

describe("suite-metric Competition Adapter (ET-EVAL-SUITE / #172)", () => {
  test("missing candidate artifacts fail closed and never silently score 1.0", async () => {
    const result = await evaluateSuiteMetric({}, suiteContract(), { suiteFiles: suiteFiles() });
    expect(result.status).toBe("fail");
    expect(result.n_total).toBe(5);
    expect(result.n_pass).toBe(0);
    expect(result.score).toBe(0);
    expect(result.score).not.toBe(1);
    expect(result.report_ref).toBe(SUITE_REPORT_REF);
    expect(result.report.cases.every((item) => item.status === "fail")).toBe(true);

    const measurement = await createSuiteMetricEvaluator(suiteContract(), { suiteFiles: suiteFiles() })
      .evaluate({}, dummyContext);
    expect(measurement.ok).toBe(true);
    expect(measurement.score).toBe(0);
    expect(measurement.score).not.toBe(1);
  });

  test("a partial suite pass yields a mid pass_rate in (0, 1)", async () => {
    const result = await evaluateSuiteMetric(answers("a", "b"), suiteContract(), { suiteFiles: suiteFiles() });
    expect(result.status).toBe("fail");
    expect(result.n_pass).toBe(2);
    expect(result.n_total).toBe(5);
    expect(result.score).toBe(0.4);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  test("every case passing yields pass_rate 1.0", async () => {
    const result = await evaluateSuiteMetric(answers("a", "b", "c", "d", "e"), suiteContract(), {
      suiteFiles: suiteFiles(),
    });
    expect(result.status).toBe("pass");
    expect(result.n_pass).toBe(5);
    expect(result.n_total).toBe(5);
    expect(result.score).toBe(1);
  });

  test("a forged model self-score cannot override the measured suite pass_rate", async () => {
    const snapshot = {
      ...answers("a", "b"),
      score: "1",
      "score.txt": "1.0",
      "answer.txt": "1",
      "model-output.txt": '{"score": 1, "selfVerified": true} I scored 1.0',
    };
    const result = await evaluateSuiteMetric(snapshot, suiteContract(), { suiteFiles: suiteFiles() });
    expect(result.score).toBe(0.4);
    expect(result.score).not.toBe(1);
    expect(result.n_pass).toBe(2);
    expect(result.n_total).toBe(5);
    expect(result.status).toBe("fail");

    const measurement = await createSuiteMetricEvaluator(suiteContract(), { suiteFiles: suiteFiles() })
      .evaluate(snapshot, dummyContext);
    expect(measurement.score).toBe(0.4);
    expect(measurement.facts?.some((fact) => fact.name === "self-score" || fact.source === "score")).toBe(false);
  });

  test("a missing or empty suite is inconclusive, not a pass and not a silent 1.0", async () => {
    const missing = await evaluateSuiteMetric(answers("a"), suiteContract(), { suiteFiles: {} });
    expect(missing.status).toBe("inconclusive");
    expect(missing.n_total).toBe(0);
    expect(missing.score).toBeUndefined();
    expect(missing.score).not.toBe(1);
    expect(missing.score).not.toBe(0);

    const empty = await evaluateSuiteMetric({}, suiteContract(), { suiteFiles: suiteFiles([]) });
    expect(empty.status).toBe("inconclusive");
    expect(empty.n_total).toBe(0);
    expect(empty.score).toBeUndefined();

    const measurement = await createSuiteMetricEvaluator(suiteContract(), { suiteFiles: {} })
      .evaluate({ score: "1" }, dummyContext);
    expect(measurement.ok).toBe(false);
    expect(measurement.score).toBeUndefined();
    expect(measurement.ruleViolations?.some((item) => /inconclusive/i.test(item))).toBe(true);
  });

  test("a crashing or unknown runner fails closed instead of inventing 1.0", async () => {
    const crashing: SuiteRunner = {
      run() {
        throw new Error("fixture runner exploded");
      },
    };
    const crashed = await evaluateSuiteMetric(answers("a", "b", "c", "d", "e"), suiteContract(), {
      runner: crashing,
      suiteFiles: suiteFiles(),
    });
    expect(crashed.status === "fail" || crashed.status === "inconclusive").toBe(true);
    expect(crashed.score).not.toBe(1);

    const unknown = await evaluateSuiteMetric(
      answers("a"),
      normalizeSuiteMetricContract({
        ...suiteContract(),
        suite: { ...suiteContract().suite, runner: "pytest-not-wired" },
      }),
      { suiteFiles: suiteFiles() },
    );
    expect(unknown.status === "fail" || unknown.status === "inconclusive").toBe(true);
    expect(unknown.score).not.toBe(1);
  });

  test("copyable evaluation.json contract expresses suite-metric pass_rate in [0, 1]", async () => {
    const raw = await readFile(join(process.cwd(), "templates/evaluation.suite-metric.json"), "utf8");
    const contract = normalizeSuiteMetricContract(JSON.parse(raw));
    expect(contract.id).toBe(SUITE_METRIC_ID);
    expect(contract.version).toBe("1");
    expect(contract.suite.kind).toBe("local-tests");
    expect(contract.suite.runner).toBe("fixture-manifest");
    expect(contract.suite.cases_glob_or_manifest.includes("..")).toBe(false);
    expect(contract.suite.cases_glob_or_manifest.startsWith("/")).toBe(false);
    expect(contract.score.metric).toBe("pass_rate");
    expect(contract.score.min).toBe(0);
    expect(contract.score.max).toBe(1);
    expect(contract.artifact_refs).toEqual([]);
  });

  test("the competition pack registers suite-metric and does not thaw submit or #40", () => {
    expect(competitionPacked.createSuiteMetricEvaluator).toBe(createSuiteMetricEvaluator);
    expect(competitionPacked.evaluateSuiteMetric).toBe(evaluateSuiteMetric);
    expect(competitionPacked.normalizeSuiteMetricContract).toBe(normalizeSuiteMetricContract);
    const keys = Object.keys(competitionPacked);
    expect(keys).toContain("createSuiteMetricEvaluator");
    expect(keys).not.toContain("submitContest");
    expect(keys).not.toContain("submitToCompetition");
    expect(keys).not.toContain("SELECTION_POLICY_40");
  });
});
