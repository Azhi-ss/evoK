import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGapReport, parsePatchFile } from "./schemas";

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
  let review: StageReport | undefined;
  for (const stage of ROUND_STAGES) {
    const report = readStageReport(root, round, stage);
    if (stage === "review") review = report;
    findings.push(stageFinding(stage, report));
  }
  findings.push(traceFinding(root));
  findings.push(gapArtifactFinding(root));
  findings.push(patchArtifactFinding(root));
  findings.push(reviewArtifactFinding(root));
  findings.push(evidencePackFinding(root, review));
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

function stageFinding(stage: string, report: StageReport | undefined): E2EFinding {
  if (!report) return { stage, ok: false, detail: `no report for ${stage}` };
  if (report.stage !== stage) return { stage, ok: false, detail: `${stage} report stage field does not match` };
  if (typeof report.explanation !== "string" || report.explanation.trim() === "") {
    return { stage, ok: false, detail: `${stage} explanation is empty` };
  }
  if (!isRecord(report.output) || Object.keys(report.output).length === 0) {
    return { stage, ok: false, detail: `${stage} output is empty` };
  }
  const shape = stageShape(stage, report.output);
  if (shape) return { stage, ok: false, detail: shape };
  return { stage, ok: true, detail: report.explanation };
}

function stageShape(stage: string, output: Record<string, unknown>): string | undefined {
  if (stage === "select" && typeof output.node !== "string") return "select output has no node";
  if (stage === "gap") {
    try {
      const gaps = parseGapReport(output);
      if (gaps.gaps.length < 1) return "gap output has no gaps";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (stage === "propose" && (typeof output.summary !== "string" || output.summary.trim() === "" || typeof output.configPath !== "string")) {
    return "propose output is missing summary or configPath";
  }
  if (stage === "run" && (!Array.isArray(output.devScores) || output.devScores.length === 0)) return "run output has no devScores";
  if (stage === "review" && (typeof output.accept !== "boolean" || typeof output.reason !== "string" || output.reason.trim() === "")) {
    return "review output is missing accept or reason";
  }
  if (stage === "backprop" && typeof output.node !== "string") return "backprop output has no node";
  if (stage === "gate") {
    if (typeof output.ok !== "boolean" || typeof output.node !== "string") return "gate output is missing node or ok";
    if (output.ok !== true) return "gate did not pass";
  }
  return undefined;
}

function gapArtifactFinding(root: string): E2EFinding {
  try {
    const gaps = parseGapReport(JSON.parse(readFileSync(join(root, "gaps.json"), "utf8")) as unknown);
    if (gaps.gaps.length < 1) return { stage: "gap artifact", ok: false, detail: "gaps.json has no gaps" };
    return { stage: "gap artifact", ok: true, detail: `gaps.json has ${gaps.gaps.length} gaps` };
  } catch (error) {
    return { stage: "gap artifact", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function patchArtifactFinding(root: string): E2EFinding {
  try {
    parsePatchFile(JSON.parse(readFileSync(join(root, "patch.json"), "utf8")) as unknown);
    return { stage: "patch artifact", ok: true, detail: "patch.json" };
  } catch (error) {
    return { stage: "patch artifact", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function reviewArtifactFinding(root: string): E2EFinding {
  try {
    const value = JSON.parse(readFileSync(join(root, "review.json"), "utf8")) as { accept?: unknown; reason?: unknown };
    if (typeof value.accept !== "boolean" || typeof value.reason !== "string" || value.reason.trim() === "") {
      return { stage: "review artifact", ok: false, detail: "review.json is missing accept or reason" };
    }
    return { stage: "review artifact", ok: true, detail: "review.json" };
  } catch (error) {
    return { stage: "review artifact", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function evidencePackFinding(root: string, review: StageReport | undefined): E2EFinding {
  const kept = review !== undefined && isRecord(review.output) && review.output.accept === true;
  const packPath = join(root, "evidence_pack", "pack.json");
  const notePath = join(root, "evidence_pack", "change-note.md");
  if (!kept && !existsSync(packPath)) {
    return { stage: "evidence_pack", ok: true, detail: "candidate was not promoted; evidence_pack is absent" };
  }
  try {
    const pack = JSON.parse(readFileSync(packPath, "utf8")) as Record<string, unknown>;
    const note = existsSync(notePath) ? readFileSync(notePath, "utf8") : "";
    if (!isRecord(pack) || typeof pack.modelId !== "string" || pack.modelId === ""
      || typeof pack.changeNote !== "string" || pack.changeNote.trim() === ""
      || !Array.isArray(pack.traceIndex) || pack.traceIndex.length === 0
      || note.trim() === "") {
      return { stage: "evidence_pack", ok: false, detail: "evidence_pack/pack.json is missing model, change note, or trace index" };
    }
    return { stage: "evidence_pack", ok: true, detail: "evidence_pack has model, change note, and trace index" };
  } catch (error) {
    return { stage: "evidence_pack", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
