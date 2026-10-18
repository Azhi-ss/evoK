import { isAttributionLabel, type GapReport, type HarnessPart, isHarnessPart, type PatchProposal } from "./types";

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

/** Innovator output. Fields are the part, the motivation, and the failure class it expects to fix. */
export function parsePatchFile(value: unknown): PatchProposal & { readonly summary: string } {
  if (!isRecord(value)) throw new Error("patch.json must be an object");
  const part = value.part;
  const motivation = value.motivation;
  const expectedFailureClass = value.expectedFailureClass;
  const summary = value.summary;
  if (typeof part !== "string" || !isHarnessPart(part)) throw new Error("patch.json part is not a harness part");
  if (typeof motivation !== "string" || motivation.trim() === "") throw new Error("patch.json motivation is missing");
  if (typeof expectedFailureClass !== "string" || !isAttributionLabel(expectedFailureClass)) {
    throw new Error("patch.json expectedFailureClass is not an attribution label");
  }
  if (typeof summary !== "string" || summary.trim() === "") throw new Error("patch.json summary is missing");
  const patch: PatchProposal & { readonly summary: string } = {
    part: part as HarnessPart,
    motivation,
    expectedFailureClass,
    summary,
    changes: isRecord(value.changes) ? value.changes : {},
  };
  return patch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
