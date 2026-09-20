/**
 * Trusted local-js-exports suite runner (ET-OPS-DOMAIN / #173).
 *
 * Executes a Candidate CommonJS module from the immutable snapshot against
 * project-side cases. The score is observed pass/fail — a model-authored
 * score file is never consulted. The Candidate cannot define the cases.
 */
import { createContext, Script } from "node:vm";
import { isAbsolute } from "node:path";
import type { SuiteCaseResult, SuiteRunner } from "./suite-metric";

export const LOCAL_JS_EXPORTS_RUNNER = "local-js-exports" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("..") || isAbsolute(value)) {
    throw new Error(`${label} must be a relative file path`);
  }
  return value;
}

function sameValue(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function loadExports(source: string): Record<string, unknown> | { error: string } {
  const module = { exports: {} as Record<string, unknown> };
  const context = createContext({ module, exports: module.exports });
  try {
    new Script(source, { filename: "candidate-module.js" }).runInContext(context, { timeout: 200 });
  } catch (error) {
    return { error: `candidate module failed: ${(error as Error).message}` };
  }
  const exported = (context as { module: { exports: unknown } }).module.exports;
  if (!isRecord(exported)) return { error: "candidate module.exports must be an object" };
  return exported;
}

interface JsCaseSpec {
  readonly id: string;
  readonly exportName: string;
  readonly args: readonly unknown[];
  readonly expected: unknown;
}

function parseCases(raw: string): { modulePath: string; specs: JsCaseSpec[] } | { inconclusive: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { inconclusive: `suite manifest is not valid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { inconclusive: "suite manifest must be a JSON object" };
  let modulePath: string;
  try {
    modulePath = relativePath(parsed.module, "suite manifest module");
  } catch (error) {
    return { inconclusive: (error as Error).message };
  }
  if (!Array.isArray(parsed.cases)) return { inconclusive: "suite manifest must contain a cases array" };
  if (parsed.cases.length === 0) return { inconclusive: "suite manifest has zero cases" };
  const specs: JsCaseSpec[] = [];
  for (const item of parsed.cases) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") {
      return { inconclusive: "suite manifest cases require a string id" };
    }
    if (typeof item.export !== "string" || item.export.trim() === "") {
      return { inconclusive: `case ${item.id} export must be a non-empty string` };
    }
    if (!Array.isArray(item.args)) {
      return { inconclusive: `case ${item.id} args must be an array` };
    }
    if (!("expected" in item)) {
      return { inconclusive: `case ${item.id} requires an expected value` };
    }
    specs.push({
      id: item.id,
      exportName: item.export,
      args: item.args,
      expected: item.expected,
    });
  }
  return { modulePath, specs };
}

export const localJsExportsRunner: SuiteRunner = {
  run(input) {
    const path = input.contract.suite.cases_glob_or_manifest;
    const raw = input.suiteFiles?.[path];
    if (raw === undefined) {
      return { status: "inconclusive", cases: [], reason: `missing trusted suite manifest ${path}` };
    }
    const parsed = parseCases(raw);
    if ("inconclusive" in parsed) {
      return { status: "inconclusive", cases: [], reason: parsed.inconclusive };
    }
    const source = input.snapshot[parsed.modulePath];
    if (source === undefined) {
      return {
        status: "ok",
        cases: parsed.specs.map((spec) => ({
          id: spec.id,
          status: "fail" as const,
          reason: `required module ${parsed.modulePath} is missing from the candidate snapshot`,
        })),
      };
    }
    const loaded = loadExports(source);
    if ("error" in loaded) {
      return {
        status: "ok",
        cases: parsed.specs.map((spec) => ({
          id: spec.id,
          status: "fail" as const,
          reason: loaded.error,
        })),
      };
    }
    const cases: SuiteCaseResult[] = parsed.specs.map((spec) => {
      const fn = loaded[spec.exportName];
      if (typeof fn !== "function") {
        return { id: spec.id, status: "fail", reason: `export ${spec.exportName} is not a function` };
      }
      try {
        const actual = (fn as (...args: unknown[]) => unknown)(...spec.args);
        if (sameValue(actual, spec.expected)) return { id: spec.id, status: "pass" };
        return {
          id: spec.id,
          status: "fail",
          reason: `export ${spec.exportName} returned ${JSON.stringify(actual)}`,
        };
      } catch (error) {
        return {
          id: spec.id,
          status: "fail",
          reason: `export ${spec.exportName} threw: ${(error as Error).message}`,
        };
      }
    });
    return { status: "ok", cases };
  },
};
