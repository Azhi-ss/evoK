import { readHostFile, writeHostFile } from "./artifacts";

/** Explicit run inputs. The gate and the loop do not fill these in. */
export const THRESHOLD_KEYS = [
  "minDelta",
  "ttsBaseline",
  "heldOutFloor",
  "tokenBudget",
  "maxLocalRuns",
  "maxWallS",
  "maxOnlineSubmitsPerDay",
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export type RunThresholds = Record<ThresholdKey, number>;

export const THRESHOLDS_FILE = "thresholds.json";
export const USAGE_FILE = "state/usage.json";

export function missingThresholds(value: Partial<RunThresholds> | undefined): ThresholdKey[] {
  const source = value ?? {};
  return THRESHOLD_KEYS.filter((key) => {
    const item = source[key];
    return typeof item !== "number" || !Number.isFinite(item) || (key === "minDelta" && item <= 0);
  });
}

export function readThresholds(root: string): { readonly ok: true; readonly value: RunThresholds } | { readonly ok: false; readonly missing: readonly string[] } {
  let parsed: Partial<RunThresholds> | undefined;
  try {
    parsed = JSON.parse(readHostFile(root, THRESHOLDS_FILE)) as Partial<RunThresholds>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    return { ok: false, missing: [`${THRESHOLDS_FILE} (${code})`, ...THRESHOLD_KEYS] };
  }
  const missing = missingThresholds(parsed);
  if (missing.length > 0 || !parsed) return { ok: false, missing };
  return { ok: true, value: parsed as RunThresholds };
}

export function writeThresholds(root: string, value: RunThresholds): void {
  const missing = missingThresholds(value);
  if (missing.length > 0) throw new Error(`refusing to write thresholds, missing ${missing.join(", ")}`);
  writeHostFile(root, THRESHOLDS_FILE, `${JSON.stringify(value, null, 2)}\n`);
}

export function readTokensSpent(root: string): { readonly ok: true; readonly tokensSpent: number } | { readonly ok: false; readonly missing: "tokensSpent" } {
  try {
    const parsed = JSON.parse(readHostFile(root, USAGE_FILE)) as { tokensSpent?: unknown };
    if (typeof parsed.tokensSpent !== "number" || !Number.isFinite(parsed.tokensSpent) || parsed.tokensSpent < 0) {
      return { ok: false, missing: "tokensSpent" };
    }
    return { ok: true, tokensSpent: parsed.tokensSpent };
  } catch {
    return { ok: false, missing: "tokensSpent" };
  }
}

export function writeTokensSpent(root: string, tokensSpent: number): void {
  if (!Number.isFinite(tokensSpent) || tokensSpent < 0) {
    throw new Error(`token count ${tokensSpent} is not a non-negative finite number`);
  }
  writeHostFile(root, USAGE_FILE, `${JSON.stringify({ tokensSpent }, null, 2)}\n`);
}
