import { isAttributionLabel, type GapReport } from "./types";

/** Gap Finder output. `gaps.md` is this object rendered with the same fields. */
export function parseGapReport(value: unknown): GapReport {
  if (!isRecord(value) || !Array.isArray(value.gaps)) throw new Error("gaps.json must contain a gaps array");
  const gaps = value.gaps.map((gap, index) => {
    if (!isRecord(gap)) throw new Error(`gaps[${index}] is not an object`);
    const id = gap.id;
    const failureClass = gap.failureClass;
    const summary = gap.summary;
    const traceIds = gap.traceIds;
    if (typeof id !== "string" || id === "") throw new Error(`gaps[${index}].id is missing`);
    if (typeof failureClass !== "string" || !isAttributionLabel(failureClass)) {
      throw new Error(`gaps[${index}].failureClass is not an attribution label`);
    }
    if (typeof summary !== "string" || summary.trim() === "") throw new Error(`gaps[${index}].summary is missing`);
    if (!Array.isArray(traceIds) || traceIds.some((id) => typeof id !== "string")) {
      throw new Error(`gaps[${index}].traceIds must be strings`);
    }
    return { id, failureClass, summary, traceIds };
  });
  return { gaps };
}

export function renderGapsMarkdown(report: GapReport): string {
  const lines = ["# gaps", ""];
  for (const gap of report.gaps) {
    lines.push(`- id: ${gap.id}`);
    lines.push(`  failureClass: ${gap.failureClass}`);
    lines.push(`  summary: ${gap.summary}`);
    lines.push(`  traceIds: ${gap.traceIds.join(",")}`);
  }
  return `${lines.join("\n")}\n`;
}

export { parsePatchFile } from "./modules/proposer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
