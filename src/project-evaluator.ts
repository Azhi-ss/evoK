/**
 * Start-path evaluator dispatch (ET-OPS-DOMAIN / #173).
 *
 * Reads `<project>/.evok/evaluation.json` and returns the independent
 * BaselineEvaluator declared there: file-metric (artifact number) or
 * suite-metric (measured pass_rate). Trusted suite files stay on the
 * project side; the Candidate snapshot never defines the cases.
 *
 * Does not own Admission / Budget / hang / T48 predicates and does not
 * thaw External Submission.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaselineEvaluator } from "./mission-start";
import {
  EvaluationContractError,
  createFileMetricEvaluator,
  evaluationContractPath,
  normalizeFileMetricContract,
  type FileMetricContract,
} from "./local-file-evaluator";
import {
  SUITE_METRIC_ID,
  SuiteMetricContractError,
  createSuiteMetricEvaluator,
  normalizeSuiteMetricContract,
  type SuiteMetricContract,
} from "./competition/suite-metric";

export type ProjectEvaluationContract =
  | { readonly kind: "file-metric"; readonly contract: FileMetricContract }
  | { readonly kind: "suite-metric"; readonly contract: SuiteMetricContract };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readEvaluationJson(projectRoot: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(evaluationContractPath(projectRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EvaluationContractError(
        `no independent evaluator contract at ${evaluationContractPath(projectRoot)}; refusing to run a baseline that cannot be measured`,
      );
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new EvaluationContractError(`evaluation contract is not valid JSON: ${(error as Error).message}`);
  }
}

/** Read and classify the project's local evaluation contract. */
export async function loadProjectEvaluationContract(projectRoot: string): Promise<ProjectEvaluationContract> {
  const parsed = await readEvaluationJson(projectRoot);
  if (isRecord(parsed) && parsed.id === SUITE_METRIC_ID) {
    try {
      return { kind: "suite-metric", contract: normalizeSuiteMetricContract(parsed) };
    } catch (error) {
      if (error instanceof SuiteMetricContractError) {
        throw new EvaluationContractError(error.message);
      }
      throw error;
    }
  }
  return { kind: "file-metric", contract: normalizeFileMetricContract(parsed) };
}

/** Trusted project-side suite files. Missing manifest → empty map (fail closed later). */
export async function loadTrustedSuiteFiles(
  projectRoot: string,
  relativePath: string,
): Promise<Readonly<Record<string, string>>> {
  try {
    return { [relativePath]: await readFile(join(projectRoot, relativePath), "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Independent BaselineEvaluator for the project's declared contract. */
export async function createProjectBaselineEvaluator(projectRoot: string): Promise<BaselineEvaluator> {
  const loaded = await loadProjectEvaluationContract(projectRoot);
  if (loaded.kind === "file-metric") return createFileMetricEvaluator(loaded.contract);
  const suiteFiles = await loadTrustedSuiteFiles(projectRoot, loaded.contract.suite.cases_glob_or_manifest);
  return createSuiteMetricEvaluator(loaded.contract, { suiteFiles });
}
