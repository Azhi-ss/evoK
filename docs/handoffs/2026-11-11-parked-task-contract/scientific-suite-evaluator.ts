import { isAbsolute } from "node:path";
import type { BaselineEvaluator, BaselineMeasurement } from "./mission-start";
import { EvaluationContractError } from "./local-file-evaluator";

export const SCIENTIFIC_SUITE_ID = "scientific-suite" as const;

export interface ScientificSuiteContract {
  readonly id: typeof SCIENTIFIC_SUITE_ID;
  readonly version: string;
  readonly artifact: string;
  readonly metric: string;
  readonly primaryGroup: string;
  readonly requiredGroups: readonly string[];
  readonly controls: readonly string[];
  readonly requireTrainedAdapter: boolean;
  readonly minRcsCoverage: number;
  readonly rcsTolerance: number;
  readonly mmd: { readonly feature: string; readonly permutations: number; readonly seed: number; readonly estimator: string; readonly maxP: number };
  readonly min?: number;
  readonly max?: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new EvaluationContractError(`${label} must be a non-empty string list`);
  }
  return [...value];
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeScientificSuiteContract(value: unknown): ScientificSuiteContract {
  if (!isRecord(value) || value.id !== SCIENTIFIC_SUITE_ID) throw new EvaluationContractError(`evaluation contract id must be ${SCIENTIFIC_SUITE_ID}`);
  if (typeof value.version !== "string" || value.version.trim() === "") throw new EvaluationContractError("scientific-suite requires a version");
  if (typeof value.artifact !== "string" || !value.artifact || value.artifact.includes("..") || isAbsolute(value.artifact)) {
    throw new EvaluationContractError("scientific-suite artifact must be a relative file path");
  }
  for (const key of ["metric", "primaryGroup"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "") throw new EvaluationContractError(`scientific-suite requires ${key}`);
  }
  if (typeof value.requireTrainedAdapter !== "boolean") throw new EvaluationContractError("requireTrainedAdapter must be boolean");
  if (!finite(value.minRcsCoverage) || value.minRcsCoverage < 0 || value.minRcsCoverage > 1) throw new EvaluationContractError("minRcsCoverage must be in [0,1]");
  if (!finite(value.rcsTolerance) || value.rcsTolerance < 0) throw new EvaluationContractError("rcsTolerance must be non-negative");
  if (!isRecord(value.mmd) || typeof value.mmd.feature !== "string" || typeof value.mmd.estimator !== "string"
    || !Number.isInteger(value.mmd.permutations) || value.mmd.permutations <= 0 || !Number.isInteger(value.mmd.seed)
    || !finite(value.mmd.maxP) || value.mmd.maxP <= 0 || value.mmd.maxP > 1) {
    throw new EvaluationContractError("scientific-suite requires a valid MMD protocol");
  }
  for (const key of ["min", "max"] as const) {
    if (value[key] !== undefined && !finite(value[key])) throw new EvaluationContractError(`${key} must be finite`);
  }
  return {
    id: SCIENTIFIC_SUITE_ID,
    version: value.version,
    artifact: value.artifact,
    metric: value.metric,
    primaryGroup: value.primaryGroup,
    requiredGroups: stringList(value.requiredGroups, "requiredGroups"),
    controls: stringList(value.controls, "controls"),
    requireTrainedAdapter: value.requireTrainedAdapter,
    minRcsCoverage: value.minRcsCoverage,
    rcsTolerance: value.rcsTolerance,
    mmd: {
      feature: value.mmd.feature, permutations: value.mmd.permutations, seed: value.mmd.seed,
      estimator: value.mmd.estimator, maxP: value.mmd.maxP,
    },
    ...(finite(value.min) ? { min: value.min } : {}),
    ...(finite(value.max) ? { max: value.max } : {}),
  };
}

function protocol(violations: string[], message: string) {
  violations.push(`protocol: ${message}`);
}

/** Independent suite gate: protocol validity first, scientific comparisons second. */
export function createScientificSuiteEvaluator(contract: ScientificSuiteContract): BaselineEvaluator {
  return {
    id: SCIENTIFIC_SUITE_ID,
    version: contract.version,
    evaluate(snapshot): BaselineMeasurement {
      const raw = snapshot[contract.artifact];
      if (raw === undefined) return { ok: false, ruleViolations: [`protocol: required artifact ${contract.artifact} is missing`] };
      let suite: Record<string, any>;
      try { suite = JSON.parse(raw); } catch { return { ok: false, ruleViolations: [`protocol: ${contract.artifact} is not valid JSON`] }; }
      const violations: string[] = [];
      if (!isRecord(suite) || !isRecord(suite.groups)) {
        return { ok: false, ruleViolations: ["protocol: suite must contain a groups object"] };
      }
      for (const name of contract.requiredGroups) {
        if (!isRecord(suite.groups[name])) protocol(violations, `required group ${name} is missing`);
      }
      const primary = suite.groups[contract.primaryGroup];
      if (isRecord(primary)) {
        if (contract.requireTrainedAdapter && primary.protocol?.adapter_trained !== true) {
          protocol(violations, `${contract.primaryGroup} adapter_trained must be true`);
        }
      }
      for (const name of contract.requiredGroups) {
        const group = suite.groups[name];
        if (!isRecord(group)) continue;
        const coverage = group.metrics?.rcs_coverage;
        if (!finite(coverage)) protocol(violations, `${name} metrics.rcs_coverage must be finite`);
        else if (coverage < contract.minRcsCoverage) protocol(violations, `${name} RCS coverage ${coverage} < ${contract.minRcsCoverage}`);
        if (!finite(group.metrics?.rcs)) protocol(violations, `${name} metrics.rcs must be finite`);
        if (!finite(group.metrics?.[contract.metric])) protocol(violations, `${name} metrics.${contract.metric} must be finite`);
      }
      if (suite.matched_budget !== true) protocol(violations, "matched_budget must be true for all compared groups");
      const mmd = suite.mmd;
      if (!isRecord(mmd)) protocol(violations, "mmd result is missing");
      else {
        for (const key of ["feature", "permutations", "seed", "estimator"] as const) {
          if (mmd[key] !== contract.mmd[key]) protocol(violations, `mmd.${key} must be ${contract.mmd[key]}`);
        }
        if (!finite(mmd.p_value)) protocol(violations, "mmd.p_value must be finite");
      }

      const score = isRecord(primary) && finite(primary.metrics?.[contract.metric]) ? primary.metrics[contract.metric] : undefined;
      const scientificViolations: string[] = [];
      if (isRecord(primary)) {
        for (const control of contract.controls) {
          const other = suite.groups[control];
          if (!isRecord(other)) continue;
          if (finite(score) && finite(other.metrics?.[contract.metric]) && score <= other.metrics[contract.metric]) {
            scientificViolations.push(`${contract.primaryGroup} ${contract.metric} ${score} is not above ${control} ${other.metrics[contract.metric]}`);
          }
          if (finite(primary.metrics?.rcs) && finite(other.metrics?.rcs)
            && primary.metrics.rcs + contract.rcsTolerance < other.metrics.rcs) {
            scientificViolations.push(`${contract.primaryGroup} RCS is more than ${contract.rcsTolerance} below ${control}`);
          }
        }
      }
      if (isRecord(mmd) && finite(mmd.p_value) && mmd.p_value >= contract.mmd.maxP) {
        scientificViolations.push(`mmd.p_value ${mmd.p_value} is not below ${contract.mmd.maxP}`);
      }
      if (score !== undefined && contract.min !== undefined && score < contract.min) scientificViolations.push(`${contract.metric} ${score} < ${contract.min}`);
      if (score !== undefined && contract.max !== undefined && score > contract.max) scientificViolations.push(`${contract.metric} ${score} > ${contract.max}`);

      const facts = contract.requiredGroups.flatMap((name) => {
        const group = suite.groups[name];
        return isRecord(group) && finite(group.metrics?.[contract.metric])
          ? [{ name: `${name}.${contract.metric}`, value: group.metrics[contract.metric], source: contract.artifact }]
          : [];
      });
      const allViolations = [...violations, ...scientificViolations];
      return {
        ok: allViolations.length === 0,
        ...(score !== undefined ? { score } : {}),
        ...(allViolations.length > 0 ? { ruleViolations: allViolations } : {}),
        facts,
      };
    },
  };
}
