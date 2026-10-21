import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Frozen externally. The loop reads this unless a run passes another threshold. */
export const DEFAULT_EWI_THRESHOLD_SEC = 600;

export interface EwiObservation {
  readonly task: string;
  readonly seed: string;
  readonly timedOut: boolean;
  /** Latest outputs mtime, seconds. */
  readonly tWrite: number;
  /** `run N done` time from batch.log, seconds. */
  readonly tEnd: number;
  /** assistant_message times, seconds. Messages at or before tWrite are ignored. */
  readonly assistantTs: readonly number[];
}

export interface EwiMetrics {
  readonly task: string;
  readonly seed: string;
  readonly timedOut: boolean;
  readonly postWriteS: number;
  readonly idleS: number;
  readonly gapMaxS: number;
  readonly clause1: boolean;
  readonly clause2: boolean;
  readonly ewi: boolean;
}

export interface RunEwiInput {
  readonly task: string;
  readonly seed: string;
  readonly timedOut: boolean;
  readonly tracePath: string;
  readonly outputsDir: string;
  readonly batchLogPath: string;
  /** Which `run N done` line to read. Default 1. */
  readonly runNumber?: number;
}

/**
 * Python 3 `round(value, 1)`.
 * Half goes to the even tenth. 1.25 → 1.2 and 1.35 → 1.4.
 */
export function roundTenth(value: number): number {
  if (!Number.isFinite(value)) throw new Error("EWI value is not finite");
  if (value === 0) return 0;
  // Python 3.12 round(x, 1) rounds the exact decimal value of the float.
  // Multiplying by 10 in IEEE first hides ties such as 0.05, so scale with
  // the integer significand instead. An exact tie goes to the even tenth.
  const negative = value < 0;
  const { mantissa, exp } = significand(Math.abs(value));
  if (mantissa === 0n) return 0;
  const shift = exp + 1;
  const numerator = mantissa * 5n;
  let tenths: bigint;
  if (shift >= 0) {
    tenths = numerator << BigInt(shift);
  } else {
    const bits = BigInt(-shift);
    const denom = 1n << bits;
    const half = denom >> 1n;
    const quot = numerator >> bits;
    const rem = numerator & (denom - 1n);
    const tieUp = rem === half && (quot & 1n) === 1n;
    tenths = rem > half || tieUp ? quot + 1n : quot;
  }
  const rounded = Number(tenths) / 10;
  return negative ? -rounded : rounded;
}

/** One run, using the preregistration definitions of idle, gap_max, and the two clauses. */
export function measureEwi(observation: EwiObservation, thresholdSec: number): EwiMetrics {
  if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) {
    throw new Error("EWI threshold must be a positive number of seconds");
  }
  const after = observation.assistantTs.filter((stamp) => stamp > observation.tWrite);
  const points = [observation.tWrite, ...after, observation.tEnd];
  let gap = points[1]! - points[0]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    gap = Math.max(gap, points[index + 1]! - points[index]!);
  }
  const last = Math.max(observation.tWrite, ...after);
  const postWriteS = roundTenth(observation.tEnd - observation.tWrite);
  const idleS = roundTenth(observation.tEnd - last);
  const gapMaxS = roundTenth(gap);
  const clause1 = idleS >= thresholdSec;
  const clause2 = observation.timedOut && gapMaxS >= thresholdSec;
  return {
    task: observation.task,
    seed: observation.seed,
    timedOut: observation.timedOut,
    postWriteS,
    idleS,
    gapMaxS,
    clause1,
    clause2,
    ewi: clause1 || clause2,
  };
}

/** Read one run directory the way ewi_idle.py reads a batch row. */
export function measureRunEwi(input: RunEwiInput, thresholdSec: number): EwiMetrics {
  return measureEwi({
    task: input.task,
    seed: input.seed,
    timedOut: input.timedOut,
    tWrite: latestOutputMtime(input.outputsDir),
    tEnd: readBatchDone(readFileSync(input.batchLogPath, "utf8"), input.runNumber ?? 1),
    assistantTs: assistantTimestamps(input.tracePath),
  }, thresholdSec);
}

function significand(value: number): { readonly mantissa: bigint; readonly exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0) return { mantissa: fraction, exp: -1022 - 52 };
  return { mantissa: (1n << 52n) | fraction, exp: biased - 1023 - 52 };
}

function latestOutputMtime(outputsDir: string): number {
  let latest = Number.NEGATIVE_INFINITY;
  let files = 0;
  const stack = [outputsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      latest = Math.max(latest, statSync(full).mtimeMs / 1000);
    }
  }
  if (files === 0) throw new Error(`outputs has no files: ${outputsDir}`);
  return latest;
}

function assistantTimestamps(tracePath: string): number[] {
  const stamps: number[] = [];
  for (const raw of readFileSync(tracePath, "utf8").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; ts?: unknown };
      if (parsed.type === "assistant_message" && typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
        stamps.push(parsed.ts / 1000);
      }
    } catch {
      /* a truncated trace line is not an assistant timestamp */
    }
  }
  return stamps;
}

function readBatchDone(log: string, runNumber: number): number {
  let found: number | undefined;
  for (const line of log.split("\n")) {
    const match = /^(\S+) run (\d+) done\b/.exec(line);
    if (!match || Number(match[2]) !== runNumber) continue;
    const stamp = Date.parse(match[1] ?? "");
    if (!Number.isFinite(stamp)) throw new Error(`batch.log timestamp is not readable: ${match[1]}`);
    found = stamp / 1000;
  }
  if (found === undefined) throw new Error(`batch.log has no run ${runNumber} done line`);
  return found;
}
