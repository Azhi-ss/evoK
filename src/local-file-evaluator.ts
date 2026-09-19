/**
 * Local file-metric Competition Adapter / Evaluator for the v1 baseline
 * (#112, T4; spec #108 US25/30/34).
 *
 * The declared evaluation contract lives in the research project at
 * `<project>/.evok/evaluation.json`. A copyable template is
 * `templates/evaluation.json` (ET-OPS-START):
 *
 * ```json
 * {
 *   "id": "file-metric",
 *   "version": "1",
 *   "artifact": "answer.txt",
 *   "metric": "answer",
 *   "min": 0,
 *   "max": 1
 * }
 * ```
 *
 * The evaluator measures the IMMUTABLE Candidate snapshot bytes: it reads the
 * declared artifact itself, applies the numeric rule, and returns the trusted
 * measurement. A pre-filled `score` file, model text, or self-verification is
 * never consulted. This is the bounded local acceptance scenario from #112;
 * richer Competition Adapters plug into the same BaselineEvaluator port.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { BaselineEvaluator, BaselineMeasurement } from "./mission-start";

export const EVALUATION_CONTRACT_FILENAME = "evaluation.json";

export class EvaluationContractError extends Error {
  readonly kind = "evaluation-contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "EvaluationContractError";
  }
}

export interface FileMetricContract {
  /** Evaluator identity recorded on every result (must be a non-empty string). */
  readonly id: string;
  readonly version: string;
  /** Required candidate artifact path, relative to the snapshot root. */
  readonly artifact: string;
  readonly metric?: string;
  readonly min?: number;
  readonly max?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evaluationContractPath(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new TypeError("projectRoot must be absolute");
  return join(projectRoot, ".evok", EVALUATION_CONTRACT_FILENAME);
}

export function normalizeFileMetricContract(value: unknown): FileMetricContract {
  if (!isRecord(value)) throw new EvaluationContractError("evaluation contract must be a JSON object");
  const { id, version, artifact } = value;
  if (typeof id !== "string" || id.trim() === "") throw new EvaluationContractError("evaluation contract requires a string id");
  if (typeof version !== "string" || version.trim() === "") throw new EvaluationContractError("evaluation contract requires a string version");
  if (typeof artifact !== "string" || artifact.trim() === "" || artifact.includes("..") || isAbsolute(artifact)) {
    throw new EvaluationContractError("evaluation contract artifact must be a relative file path");
  }
  for (const key of ["min", "max"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      throw new EvaluationContractError(`evaluation contract ${key} must be a finite number`);
    }
  }
  if (value.min !== undefined && value.max !== undefined && (value.min as number) > (value.max as number)) {
    throw new EvaluationContractError("evaluation contract min cannot exceed max");
  }
  return {
    id,
    version,
    artifact,
    ...(typeof value.metric === "string" ? { metric: value.metric } : {}),
    ...(typeof value.min === "number" ? { min: value.min } : {}),
    ...(typeof value.max === "number" ? { max: value.max } : {}),
  };
}

/** Read and validate the project's local evaluation contract. */
export async function loadEvaluationContract(projectRoot: string): Promise<FileMetricContract> {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EvaluationContractError(`evaluation contract is not valid JSON: ${(error as Error).message}`);
  }
  return normalizeFileMetricContract(parsed);
}

/** The trusted local evaluator: measures the frozen snapshot, never the model. */
export function createFileMetricEvaluator(contract: FileMetricContract): BaselineEvaluator {
  return {
    id: contract.id,
    version: contract.version,
    evaluate(snapshot, context): BaselineMeasurement {
      const raw = snapshot[contract.artifact];
      if (raw === undefined) {
        return { ok: false, ruleViolations: [`required artifact ${contract.artifact} is missing from the candidate snapshot`] };
      }
      const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
      const value = Number(firstLine);
      if (!Number.isFinite(value)) {
        return { ok: false, ruleViolations: [`${contract.artifact} first line must be a finite number, got ${JSON.stringify(firstLine)}`] };
      }
      if (contract.min !== undefined && value < contract.min) {
        return { ok: false, ruleViolations: [`${contract.metric ?? "value"} ${value} is below the declared minimum ${contract.min}`] };
      }
      if (contract.max !== undefined && value > contract.max) {
        return { ok: false, ruleViolations: [`${contract.metric ?? "value"} ${value} exceeds the declared maximum ${contract.max}`] };
      }
      return {
        ok: true,
        score: value,
        facts: [{ name: contract.metric ?? "value", value, source: contract.artifact }],
      };
    },
  };
}
