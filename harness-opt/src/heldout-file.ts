import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Single held-out convention for the empty run and the Pi gate. */
export const HELD_OUT_SCORE_FILE = "sealed/heldout-score.json";

export class HeldOutReadError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`held-out read failed: ${file}: ${detail}`);
    this.name = "HeldOutReadError";
  }
}

export function readHeldOutScore(root: string): { readonly score: number; readonly tokens: number } {
  const file = HELD_OUT_SCORE_FILE;
  const abs = join(root, file);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new HeldOutReadError(file, code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HeldOutReadError(file, "invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HeldOutReadError(file, "score file is not an object");
  }
  const score = (parsed as { score?: unknown }).score;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new HeldOutReadError(file, "score is missing or not a finite number");
  }
  return { score, tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0 };
}
