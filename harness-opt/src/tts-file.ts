import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TtsStatus } from "./modules/evidence-gate";

/** Real matched-budget comparison. Anything else stays unread so the gate is not-run. */
export const TTS_COMPARISON_FILE = "state/tts-comparison.json";

export function readMatchedBudgetTts(root: string): Exclude<TtsStatus, "not-run"> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, TTS_COMPARISON_FILE), "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const body = parsed as { source?: unknown; status?: unknown };
  if (body.source !== "matched-budget") return undefined;
  if (body.status === "passed" || body.status === "failed") return body.status;
  return undefined;
}
