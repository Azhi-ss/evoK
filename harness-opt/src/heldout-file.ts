import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeHostFile } from "./artifacts";

/** Single held-out convention for the empty run and the Pi gate. */
export const HELD_OUT_SCORE_FILE = "sealed/heldout-score.json";

export class HeldOutReadError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`held-out read failed: ${file}: ${detail}`);
    this.name = "HeldOutReadError";
  }
}

export type HeldOutSource = "hand-filled" | "evaluated";

interface HeldOutEntry {
  readonly score: number;
  readonly source: HeldOutSource;
}

/**
 * Top-level numeric score. The empty-run fixture stores `{ score, tokens }`.
 * A hand-filled product file stores `declaredScore` and is not a per-candidate
 * measurement; callers that need a green gate must use `readEvaluatedHeldOut`.
 */
export function readHeldOutScore(root: string): { readonly score: number; readonly tokens: number } {
  const parsed = readHeldOutObject(root);
  const score = typeof parsed.score === "number" ? parsed.score : parsed.declaredScore;
  const tokens = parsed.tokens;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new HeldOutReadError(HELD_OUT_SCORE_FILE, "score is missing or not a finite number");
  }
  return { score, tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0 };
}

/**
 * Score stored for one config path. Does not fall back to a global number,
 * so a parent and a child cannot accidentally read the same hand-filled value.
 */
export function readHeldOutEntry(root: string, configPath: string): HeldOutEntry {
  const parsed = readHeldOutObject(root);
  const entries = isRecord(parsed.entries) ? parsed.entries : undefined;
  const raw = entries?.[configPath];
  if (isRecord(raw) && typeof raw.score === "number" && Number.isFinite(raw.score)) {
    return { score: raw.score, source: raw.source === "evaluated" ? "evaluated" : "hand-filled" };
  }
  if (parsed.source === "hand-filled" || typeof parsed.declaredScore === "number") {
    throw new HeldOutReadError(HELD_OUT_SCORE_FILE, `手填 score is not an evaluated measurement for ${configPath}`);
  }
  throw new HeldOutReadError(HELD_OUT_SCORE_FILE, `no evaluated entry for ${configPath}`);
}

/** Gate and milestone read. A hand-filled entry throws and does not count as green. */
export function readEvaluatedHeldOut(root: string, configPath: string): number {
  const entry = readHeldOutEntry(root, configPath);
  if (entry.source !== "evaluated") {
    throw new HeldOutReadError(HELD_OUT_SCORE_FILE, `手填 score for ${configPath} does not count as a measurement`);
  }
  return entry.score;
}

/** `--heldout-score` on start. The panel must show 手填; it is not a candidate eval. */
export function writeHandFilledHeldOut(root: string, declaredScore: number): void {
  writeHostFile(root, HELD_OUT_SCORE_FILE, `${JSON.stringify({
    source: "hand-filled",
    declaredScore,
    entries: {},
    tokens: 0,
  }, null, 2)}\n`);
}

/** Record one real per-candidate measurement. The sample executor does not call this. */
export function recordEvaluatedHeldOut(root: string, configPath: string, score: number): void {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new HeldOutReadError(HELD_OUT_SCORE_FILE, "score is missing or not a finite number");
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = readHeldOutObject(root);
  } catch (error) {
    if (!(error instanceof HeldOutReadError) || !error.message.includes("ENOENT")) throw error;
  }
  const entries = isRecord(parsed.entries) ? { ...parsed.entries } : {};
  entries[configPath] = { score, source: "evaluated" };
  writeHostFile(root, HELD_OUT_SCORE_FILE, `${JSON.stringify({ ...parsed, entries }, null, 2)}\n`);
}

function readHeldOutObject(root: string): Record<string, unknown> {
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
  if (!isRecord(parsed)) throw new HeldOutReadError(file, "score file is not an object");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
