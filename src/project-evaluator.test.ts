/**
 * ET-OPS-DOMAIN (#173): start-path evaluator dispatch + demo-suite baseline.
 * Public seams only — project evaluation.json + Candidate snapshot.
 * Score is a measured suite pass_rate, never a file-metric seed of 0.4.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileMetricEvaluator } from "./local-file-evaluator";
import { DEMO_SUITE_RELATIVE_PATH } from "./mission/start-hard-gates";
import {
  createProjectBaselineEvaluator,
  loadProjectEvaluationContract,
} from "./project-evaluator";
import {
  evaluateSuiteMetric,
  normalizeSuiteMetricContract,
  SUITE_METRIC_ID,
} from "./competition/suite-metric";

const dummyContext = {
  missionId: "demo-suite",
  runId: "run-1",
  snapshotDigest: "digest",
  contract: {
    objective: "measure suite pass_rate",
    expectedOutputs: ["src/solve.js"],
    evaluationMethod: "suite-metric",
    hardRules: [],
  },
};

async function shippedDemoSnapshot(): Promise<Record<string, string>> {
  const demo = join(process.cwd(), DEMO_SUITE_RELATIVE_PATH);
  return {
    "src/solve.js": await readFile(join(demo, "src", "solve.js"), "utf8"),
  };
}

describe("createProjectBaselineEvaluator (ET-OPS-DOMAIN / #173)", () => {
  test("the shipped demo-suite baseline measures pass_rate 0.4 from a real suite, not a seed text score", async () => {
    const demo = join(process.cwd(), DEMO_SUITE_RELATIVE_PATH);
    const loaded = await loadProjectEvaluationContract(demo);
    expect(loaded.kind).toBe("suite-metric");
    if (loaded.kind !== "suite-metric") throw new Error("expected suite-metric");
    expect(loaded.contract.id).toBe(SUITE_METRIC_ID);

    const snapshot = await shippedDemoSnapshot();
    expect(snapshot["src/solve.js"]).toBeDefined();
    expect(snapshot["src/solve.js"]).not.toMatch(/^\s*0\.4\s*$/m);
    expect(Object.keys(snapshot)).not.toContain("answer.txt");

    const evaluator = await createProjectBaselineEvaluator(demo);
    expect(evaluator.id).toBe(SUITE_METRIC_ID);
    const measurement = await evaluator.evaluate(snapshot, dummyContext);
    expect(measurement.ok).toBe(true);
    expect(measurement.score).toBe(0.4);
    expect(measurement.score).not.toBe(1);
    expect(measurement.facts?.some((fact) => fact.name === "pass_rate" && fact.value === 0.4)).toBe(true);
    expect(measurement.facts?.some((fact) => fact.name === "n_pass" && fact.value === 2)).toBe(true);
    expect(measurement.facts?.some((fact) => fact.name === "n_total" && fact.value === 5)).toBe(true);
    expect(measurement.facts?.some((fact) => fact.name === "self-score" || fact.source === "score")).toBe(false);

    const suiteFiles = {
      "suite/cases.json": await readFile(join(demo, "suite", "cases.json"), "utf8"),
    };
    const direct = await evaluateSuiteMetric(snapshot, loaded.contract, { suiteFiles });
    expect(direct.status).toBe("fail");
    expect(direct.n_pass).toBe(2);
    expect(direct.n_total).toBe(5);
    expect(direct.score).toBe(0.4);
  });

  test("a forged model self-score in the demo snapshot cannot override the measured 0.4", async () => {
    const demo = join(process.cwd(), DEMO_SUITE_RELATIVE_PATH);
    const snapshot = {
      ...(await shippedDemoSnapshot()),
      score: "1",
      "score.txt": "1.0",
      "answer.txt": "1",
      "model-output.txt": '{"score": 1} I scored 1.0',
    };
    const measurement = await (await createProjectBaselineEvaluator(demo)).evaluate(snapshot, dummyContext);
    expect(measurement.score).toBe(0.4);
    expect(measurement.score).not.toBe(1);
  });

  test("a file-metric project still uses the independent artifact number, not suite-metric", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-project-eval-"));
    try {
      await mkdir(join(project, ".evok"), { recursive: true });
      await writeFile(join(project, ".evok", "evaluation.json"), JSON.stringify({
        id: "file-metric",
        version: "1",
        artifact: "answer.txt",
        metric: "answer",
        min: 0,
        max: 1,
      }));
      const loaded = await loadProjectEvaluationContract(project);
      expect(loaded.kind).toBe("file-metric");
      const evaluator = await createProjectBaselineEvaluator(project);
      const measurement = await evaluator.evaluate({ "answer.txt": "0.9\n" }, dummyContext);
      expect(evaluator.id).toBe("file-metric");
      expect(measurement.score).toBe(0.9);
      expect(createFileMetricEvaluator(loaded.kind === "file-metric" ? loaded.contract : { id: "x", version: "1", artifact: "answer.txt" }).id).toBe("file-metric");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("copyable demo-suite evaluation.json is a valid suite-metric contract", async () => {
    const raw = await readFile(join(process.cwd(), DEMO_SUITE_RELATIVE_PATH, ".evok", "evaluation.json"), "utf8");
    const contract = normalizeSuiteMetricContract(JSON.parse(raw));
    expect(contract.suite.runner).toBe("local-js-exports");
    expect(contract.suite.cases_glob_or_manifest.includes("..")).toBe(false);
    expect(contract.suite.cases_glob_or_manifest.startsWith("/")).toBe(false);
  });
});
