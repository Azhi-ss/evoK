import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Frozen externally. Under EWI-relay-v1 this number is not yet calibrated. */
export const DEFAULT_EWI_THRESHOLD_SEC = 600;

/** The 600s cutoff is carried over. It is not a calibrated cutoff for relay timings. */
export const EWI_THRESHOLD_LABEL = "新口径下未校准";

/** sha256 of the packaged `scripts/ewi_idle.py`. Reference only. Scoring does not use it. */
export const EWI_IDLE_SHA = "8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69";

/** Preregistered final result, relative to the run's outputs directory. */
export const PREREGISTERED_RESULT_FILE = "answer.txt";

/**
 * Packaged `ewi_idle.py` only. `EWI_IDLE_SCRIPT` and a caller path are rejected.
 */
export function resolveEwiIdleScript(configured?: string): string {
  const chosen = (configured ?? process.env.EWI_IDLE_SCRIPT ?? "").trim();
  if (chosen !== "") throw new Error("EWI_IDLE_SCRIPT override is rejected");
  return fileURLToPath(new URL("../../scripts/ewi_idle.py", import.meta.url));
}

/** Host observation of the preregistered result file. Null means the host did not see a write. */
export interface ResultWriteSnapshot {
  readonly tFirst: number | null;
  readonly tLastWrite: number | null;
}

/**
 * Host-side watcher. Inotify inside the container is unverified, so the loop
 * takes this interface instead of assuming a kernel event source.
 */
export interface ResultWriteWatcher {
  arm(resultFile: string): void;
  snapshot(): ResultWriteSnapshot;
}

/** No host observation. Scoring then stays 「EWI不可判」. */
export function absentResultWatcher(): ResultWriteWatcher {
  return {
    arm() {},
    snapshot() {
      return { tFirst: null, tLastWrite: null };
    },
  };
}

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

export interface RelayEwiInput {
  readonly tFirst: number | null;
  readonly tLastWrite: number | null;
  readonly responseEnds: readonly number[] | null;
  readonly tEnd: number | null;
  readonly timedOut: boolean;
  readonly thresholdSec: number;
}

export interface ReferenceEwi {
  readonly idleS: number;
  readonly gapMaxS: number;
  readonly postWriteS: number;
  readonly ewi: boolean;
}

export interface ScoredRelayEwi {
  readonly version: "EWI-relay-v1";
  readonly verdict: "EWI不可判" | boolean;
  readonly ewi: boolean | null;
  readonly idleS: number | null;
  readonly gapMaxS: number | null;
  readonly thresholdSec: number;
  readonly thresholdLabel: typeof EWI_THRESHOLD_LABEL;
  /** Container trace column from ewi_idle.py. Never the scored verdict. */
  readonly ewi_trace_ref: ReferenceEwi | null;
}

/**
 * Reference column from the approved `ewi_idle.py`. Not the scored verdict.
 * The summary is written in a temp directory so the run dir stays untouched.
 */
export function measureRunEwi(input: RunEwiInput, thresholdSec: number): EwiMetrics {
  if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) {
    throw new Error("EWI threshold must be a positive number of seconds");
  }
  const script = resolveEwiIdleScript();
  const digest = createHash("sha256").update(readFileSync(script)).digest("hex");
  if (digest !== EWI_IDLE_SHA) throw new Error("ewi_idle.py sha does not match the approved script");
  const temp = mkdtempSync(join(tmpdir(), "ewi-ref-"));
  try {
    copyFileSync(input.batchLogPath, join(temp, "batch.log"));
    const timed = input.timedOut ? "True" : "False";
    writeFileSync(join(temp, "summary.csv"), `task,seed,n,timed_out,trace\n${input.task},${input.seed},${input.runNumber ?? 1},${timed},${input.tracePath}\n`);
    const proc = spawnSync("python3", [script, temp], { encoding: "utf8" });
    if (proc.status !== 0) {
      throw new Error(`${proc.stderr || ""}${proc.stdout || ""}`.trim() || "ewi_idle.py failed");
    }
    const line = proc.stdout.split("\n").find((item) => item.startsWith("{"));
    if (!line) throw new Error(proc.stdout || "ewi_idle.py printed nothing");
    const row = JSON.parse(line) as { task: string; seed: string; timed_out: string; post_write: number; idle: number; gap_max: number };
    const timedOut = row.timed_out === "True";
    const clause1 = row.idle >= thresholdSec;
    const clause2 = timedOut && row.gap_max >= thresholdSec;
    return {
      task: row.task,
      seed: String(row.seed),
      timedOut,
      postWriteS: row.post_write,
      idleS: row.idle,
      gapMaxS: row.gap_max,
      clause1,
      clause2,
      ewi: clause1 || clause2,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Scored EWI. Host timings only. A missing t_first is 「EWI不可判」, never a clear run. */
export function scoreRelayEwi(input: RelayEwiInput): Omit<ScoredRelayEwi, "ewi_trace_ref"> {
  if (!Number.isFinite(input.thresholdSec) || input.thresholdSec <= 0) {
    throw new Error("EWI threshold must be a positive number of seconds");
  }
  const script = fileURLToPath(new URL("../../relay/ewi_relay.py", import.meta.url));
  const proc = spawnSync("python3", [script], {
    input: JSON.stringify({
      t_first: input.tFirst,
      t_last_write: input.tLastWrite,
      response_ends: input.responseEnds,
      t_end: input.tEnd,
      timed_out: input.timedOut,
      threshold: input.thresholdSec,
    }),
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "ewi_relay.py failed").trim());
  }
  const row = JSON.parse(proc.stdout) as { verdict?: unknown; ewi?: unknown; idle?: unknown; gap_max?: unknown };
  const undecided = row.verdict === "EWI不可判" || row.ewi === null || row.ewi === undefined;
  return {
    version: "EWI-relay-v1",
    verdict: undecided ? "EWI不可判" : row.ewi === true,
    ewi: undecided ? null : row.ewi === true,
    idleS: typeof row.idle === "number" ? row.idle : null,
    gapMaxS: typeof row.gap_max === "number" ? row.gap_max : null,
    thresholdSec: input.thresholdSec,
    thresholdLabel: EWI_THRESHOLD_LABEL,
  };
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
