import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StageReport {
  readonly round: number;
  readonly stage: string;
  readonly explanation: string;
  readonly output: unknown;
}

const ROUND_STAGES = ["select", "gap", "propose", "run", "review", "backprop", "gate"] as const;

export function reportsDir(root: string, round: number): string {
  return join(root, "reports", `round-${round}`);
}

export function writeStageReport(root: string, report: StageReport): string {
  const dir = reportsDir(root, report.round);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.stage}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export function readStageReport(root: string, round: number, stage: string): StageReport | undefined {
  try {
    return JSON.parse(readFileSync(join(reportsDir(root, round), `${stage}.json`), "utf8")) as StageReport;
  } catch {
    return undefined;
  }
}

export interface E2EFinding {
  readonly stage: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * End-of-round reviewer. It checks that every stage was invoked and left a
 * report, and that the trace, gap, and patch artifacts are shaped as promised.
 */
export function reviewRoundE2E(root: string, round: number): { readonly ok: boolean; readonly findings: readonly E2EFinding[] } {
  const findings: E2EFinding[] = [];
  for (const stage of ROUND_STAGES) {
    const report = readStageReport(root, round, stage);
    findings.push(report
      ? { stage, ok: true, detail: report.explanation }
      : { stage, ok: false, detail: `no report for ${stage}` });
  }
  findings.push(traceFinding(root));
  findings.push(jsonFinding(root, "gaps.json", "gap artifact", (value) => Array.isArray((value as { gaps?: unknown }).gaps)));
  findings.push(jsonFinding(root, "patch.json", "patch artifact", (value) => typeof (value as { summary?: unknown }).summary === "string"));
  findings.push(jsonFinding(root, "review.json", "review artifact", (value) => typeof (value as { accept?: unknown }).accept === "boolean"));
  const ok = findings.every((item) => item.ok);
  const report: StageReport = {
    round,
    stage: "e2e",
    explanation: ok
      ? "e2e reviewer saw every stage report and the trace, gap, patch, and review artifacts"
      : `e2e reviewer failed: ${findings.filter((item) => !item.ok).map((item) => item.stage).join(", ")}`,
    output: { ok, findings },
  };
  writeStageReport(root, report);
  return { ok, findings };
}

export function listStageReports(root: string, round: number): string[] {
  try {
    return readdirSync(reportsDir(root, round)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function traceFinding(root: string): E2EFinding {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, "traces")).filter((name) => name.endsWith(".json"));
  } catch {
    return { stage: "trace", ok: false, detail: "traces/ is missing" };
  }
  if (names.length === 0) return { stage: "trace", ok: false, detail: "no trace file" };
  try {
    const body = JSON.parse(readFileSync(join(root, "traces", names[0] as string), "utf8")) as { steps?: unknown };
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return { stage: "trace", ok: false, detail: "trace has no steps" };
    }
    const tool = (steps[0] as { tool?: unknown }).tool;
    if (typeof tool !== "string" || tool === "") return { stage: "trace", ok: false, detail: "trace step has no tool" };
    return { stage: "trace", ok: true, detail: `${names[0]} has ${steps.length} steps` };
  } catch (error) {
    return { stage: "trace", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function jsonFinding(root: string, file: string, stage: string, accept: (value: unknown) => boolean): E2EFinding {
  try {
    const value = JSON.parse(readFileSync(join(root, file), "utf8")) as unknown;
    return accept(value)
      ? { stage, ok: true, detail: file }
      : { stage, ok: false, detail: `${file} has the wrong shape` };
  } catch (error) {
    return { stage, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
