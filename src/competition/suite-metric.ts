/**
 * Local suite-metric Competition Adapter / Evaluator (ET-EVAL-SUITE / #172).
 *
 * Measures an immutable Candidate snapshot against a trusted local test
 * suite. The score is the observed pass_rate (n_pass / n_total) in [0, 1].
 * A model-authored score file, self-verification claim, Elite scalar, or
 * side-slot rank is never consulted.
 *
 * The default runner is fixture-controlled (`fixture-manifest`) so
 * ET-OPS-DOMAIN can later swap in a real mini-suite via `options.runner`.
 * Missing artifacts, an empty suite, or a crashed runner fail closed —
 * inconclusive is not a pass, and nothing silently becomes 1.0.
 *
 * Does not own Admission / Budget / hang / T48 predicates, does not thaw
 * `#40` or true External Submission, and is not a Promotion key.
 */
import { isAbsolute } from "node:path";
import type { BaselineEvaluator, BaselineMeasurement } from "../mission-start";

export const SUITE_METRIC_ID = "suite-metric" as const;
export const SUITE_REPORT_REF = "suite-report.json";
export const FIXTURE_MANIFEST_RUNNER = "fixture-manifest";

export class SuiteMetricContractError extends Error {
  readonly kind = "suite-metric-contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "SuiteMetricContractError";
  }
}

export type SuiteEvalStatus = "pass" | "fail" | "inconclusive";

export interface SuiteMetricContract {
  readonly id: typeof SUITE_METRIC_ID;
  readonly version: string;
  readonly suite: {
    readonly kind: "local-tests";
    readonly runner: string;
    readonly cases_glob_or_manifest: string;
  };
  readonly score: {
    readonly metric: "pass_rate";
    readonly min: 0;
    readonly max: 1;
  };
  readonly artifact_refs: readonly string[];
}

export interface SuiteCaseResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly reason?: string;
}

export interface SuiteReport {
  readonly id: typeof SUITE_METRIC_ID;
  readonly metric: "pass_rate";
  readonly n_pass: number;
  readonly n_total: number;
  readonly score?: number;
  readonly status: SuiteEvalStatus;
  readonly cases: readonly SuiteCaseResult[];
  readonly reason?: string;
}

export interface SuiteMetricResult {
  readonly score?: number;
  readonly n_pass: number;
  readonly n_total: number;
  readonly status: SuiteEvalStatus;
  readonly report_ref: typeof SUITE_REPORT_REF;
  readonly report: SuiteReport;
}

export interface SuiteRunnerInput {
  readonly snapshot: Readonly<Record<string, string>>;
  readonly contract: SuiteMetricContract;
  readonly suiteFiles?: Readonly<Record<string, string>>;
}

export interface SuiteRunnerOutcome {
  readonly status: "ok" | "fail" | "inconclusive";
  readonly cases: readonly SuiteCaseResult[];
  readonly reason?: string;
}

export interface SuiteRunner {
  run(input: SuiteRunnerInput): SuiteRunnerOutcome | Promise<SuiteRunnerOutcome>;
}

export interface SuiteMetricEvaluateOptions {
  readonly runner?: SuiteRunner;
  readonly suiteFiles?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("..") || isAbsolute(value)) {
    throw new SuiteMetricContractError(`${label} must be a relative file path`);
  }
  return value;
}

/** Validate the copyable `id: suite-metric` evaluation.json contract. */
export function normalizeSuiteMetricContract(value: unknown): SuiteMetricContract {
  if (!isRecord(value)) throw new SuiteMetricContractError("evaluation contract must be a JSON object");
  if (value.id !== SUITE_METRIC_ID) {
    throw new SuiteMetricContractError(`evaluation contract id must be ${JSON.stringify(SUITE_METRIC_ID)}`);
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new SuiteMetricContractError("evaluation contract requires a string version");
  }
  if (!isRecord(value.suite)) throw new SuiteMetricContractError("evaluation contract requires a suite object");
  const { kind, runner, cases_glob_or_manifest } = value.suite;
  if (kind !== "local-tests") throw new SuiteMetricContractError('suite.kind must be "local-tests"');
  if (typeof runner !== "string" || runner.trim() === "") {
    throw new SuiteMetricContractError("suite.runner must be a non-empty string");
  }
  const manifest = relativePath(cases_glob_or_manifest, "suite.cases_glob_or_manifest");
  if (!isRecord(value.score)) throw new SuiteMetricContractError("evaluation contract requires a score object");
  if (value.score.metric !== "pass_rate") throw new SuiteMetricContractError('score.metric must be "pass_rate"');
  if (value.score.min !== 0 || value.score.max !== 1) {
    throw new SuiteMetricContractError("score bounds must be min=0 and max=1");
  }
  const artifact_refs = value.artifact_refs === undefined ? [] : value.artifact_refs;
  if (!Array.isArray(artifact_refs) || artifact_refs.some((item) => typeof item !== "string")) {
    throw new SuiteMetricContractError("artifact_refs must be an array of strings");
  }
  return {
    id: SUITE_METRIC_ID,
    version: value.version,
    suite: { kind: "local-tests", runner, cases_glob_or_manifest: manifest },
    score: { metric: "pass_rate", min: 0, max: 1 },
    artifact_refs,
  };
}

function result(
  status: SuiteEvalStatus,
  cases: readonly SuiteCaseResult[],
  reason?: string,
): SuiteMetricResult {
  const n_total = cases.length;
  const n_pass = cases.filter((item) => item.status === "pass").length;
  const scored = status !== "inconclusive" && n_total > 0;
  const score = scored ? n_pass / n_total : undefined;
  const report: SuiteReport = {
    id: SUITE_METRIC_ID,
    metric: "pass_rate",
    n_pass,
    n_total,
    status,
    cases,
    ...(score !== undefined ? { score } : {}),
    ...(reason ? { reason } : {}),
  };
  return { n_pass, n_total, status, report_ref: SUITE_REPORT_REF, report, ...(score !== undefined ? { score } : {}) };
}

interface SuiteCaseSpec {
  readonly id: string;
  readonly artifact: string;
  readonly expected: string;
}

function parseManifestCases(raw: string): { specs: SuiteCaseSpec[] } | { inconclusive: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { inconclusive: `suite manifest is not valid JSON: ${(error as Error).message}` };
  }
  const list = isRecord(parsed) ? parsed.cases : parsed;
  if (!Array.isArray(list)) return { inconclusive: "suite manifest must contain a cases array" };
  if (list.length === 0) return { inconclusive: "suite manifest has zero cases" };
  const specs: SuiteCaseSpec[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") {
      return { inconclusive: "suite manifest cases require a string id" };
    }
    try {
      const artifact = relativePath(item.artifact, `case ${item.id} artifact`);
      if (typeof item.expected !== "string") {
        return { inconclusive: `case ${item.id} expected must be a string` };
      }
      specs.push({ id: item.id, artifact, expected: item.expected });
    } catch (error) {
      return { inconclusive: (error as Error).message };
    }
  }
  return { specs };
}

function compareArtifact(actual: string, expected: string): boolean {
  return actual.replace(/\r?\n$/, "").trim() === expected.replace(/\r?\n$/, "").trim();
}

const fixtureManifestRunner: SuiteRunner = {
  run(input) {
    const path = input.contract.suite.cases_glob_or_manifest;
    // Trusted suite files only — the Candidate snapshot cannot define the cases.
    const raw = input.suiteFiles?.[path];
    if (raw === undefined) {
      return { status: "inconclusive", cases: [], reason: `missing trusted suite manifest ${path}` };
    }
    const parsed = parseManifestCases(raw);
    if ("inconclusive" in parsed) {
      return { status: "inconclusive", cases: [], reason: parsed.inconclusive };
    }
    const cases: SuiteCaseResult[] = parsed.specs.map((spec) => {
      const actual = input.snapshot[spec.artifact];
      if (actual === undefined) {
        return { id: spec.id, status: "fail", reason: `required artifact ${spec.artifact} is missing from the candidate snapshot` };
      }
      if (compareArtifact(actual, spec.expected)) return { id: spec.id, status: "pass" };
      return { id: spec.id, status: "fail", reason: `artifact ${spec.artifact} did not match the expected fixture` };
    });
    return { status: "ok", cases };
  },
};

function resolveBuiltinRunner(name: string): SuiteRunner | undefined {
  if (name === FIXTURE_MANIFEST_RUNNER) return fixtureManifestRunner;
  return undefined;
}

function summarize(outcome: SuiteRunnerOutcome): SuiteMetricResult {
  if (outcome.status === "inconclusive") {
    return result("inconclusive", outcome.cases, outcome.reason ?? "suite produced no measurable cases");
  }
  if (outcome.cases.length === 0) {
    return result(
      outcome.status === "fail" ? "fail" : "inconclusive",
      [],
      outcome.reason ?? (outcome.status === "fail" ? "suite runner failed" : "suite produced no measurable cases"),
    );
  }
  const n_pass = outcome.cases.filter((item) => item.status === "pass").length;
  const status: SuiteEvalStatus = n_pass === outcome.cases.length ? "pass" : "fail";
  return result(status, outcome.cases, outcome.reason);
}

/**
 * Run the declared local suite against a Candidate snapshot.
 * `suiteFiles` is the trusted project-side suite (never the snapshot).
 */
export async function evaluateSuiteMetric(
  snapshot: Readonly<Record<string, string>>,
  contract: SuiteMetricContract,
  options: SuiteMetricEvaluateOptions = {},
): Promise<SuiteMetricResult> {
  try {
    const runner = options.runner ?? resolveBuiltinRunner(contract.suite.runner);
    if (!runner) {
      return result(
        "inconclusive",
        [],
        `unknown suite runner ${JSON.stringify(contract.suite.runner)}; no implementation was supplied`,
      );
    }
    return summarize(await runner.run({ snapshot, contract, suiteFiles: options.suiteFiles }));
  } catch (error) {
    return result("fail", [], `suite runner failed: ${(error as Error).message}`);
  }
}

/** BaselineEvaluator port over the same measured pass_rate. */
export function createSuiteMetricEvaluator(
  contract: SuiteMetricContract,
  options: SuiteMetricEvaluateOptions = {},
): BaselineEvaluator {
  return {
    id: contract.id,
    version: contract.version,
    async evaluate(snapshot): Promise<BaselineMeasurement> {
      const measured = await evaluateSuiteMetric(snapshot, contract, options);
      if (measured.status === "inconclusive" || measured.score === undefined) {
        const detail = measured.report.reason ?? `suite-metric is ${measured.status}`;
        return {
          ok: false,
          ruleViolations: [
            measured.status === "inconclusive"
              ? `inconclusive: ${detail}`
              : detail,
          ],
        };
      }
      return {
        ok: true,
        score: measured.score,
        facts: [
          { name: "pass_rate", value: measured.score, source: SUITE_REPORT_REF },
          { name: "n_pass", value: measured.n_pass, source: SUITE_REPORT_REF },
          { name: "n_total", value: measured.n_total, source: SUITE_REPORT_REF },
          { name: "status", value: measured.status, source: SUITE_REPORT_REF },
        ],
      };
    },
  };
}
