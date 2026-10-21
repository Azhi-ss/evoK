export interface ChangedLeaf {
  readonly path: string;
  readonly value: unknown;
}

export interface GateRow {
  readonly id: "G0" | "G1" | "G2" | "G3";
  readonly pass: boolean;
  readonly code?: string;
}

export interface ReviewerGateInput {
  /** Signatures, the relay record, and the reward signature all verify. */
  readonly evidenceOk: boolean;
  /** The gap cited the previous round's trace. */
  readonly gapCitedPrevious: boolean;
  readonly knobPaths: readonly string[];
  readonly patchPaths: readonly string[];
  readonly changed: readonly ChangedLeaf[];
  readonly effective: Readonly<Record<string, unknown>> | null;
  readonly runEnd: Readonly<Record<string, unknown>> | null;
  readonly scored: boolean;
  readonly timedOut: boolean;
  /** Host clock for the real run, in seconds. */
  readonly wallS: number | null;
  /** Official `[agent].timeout_sec` from the task's task.toml. Missing is not a pass. */
  readonly officialTimeoutSec: number | null;
  readonly reward: number | null;
  readonly baselineReward: number | null;
  /**
   * Relay, mount, and session evidence. Hashless requests, such as compaction,
   * are already ignored. A matching effective value alone is not enough.
   */
  readonly patchActive: boolean;
  /**
   * Effective config of the previous round, the baseline this run is compared
   * against. A changed leaf equal to this value did not take effect.
   */
  readonly baselineEffective: Readonly<Record<string, unknown>> | null;
}

export interface ReviewerGateReport {
  readonly gates: readonly GateRow[];
  readonly verdict: "anti_forgery" | "reject" | "accept";
  readonly rejectCode?: string;
}

export interface PreflightGateReport {
  readonly preflight: true;
  readonly final: false;
  readonly gates: readonly GateRow[];
}

/** run_end fields the harness writes for a knob. The observed value must stay within the new setting. */
const RUN_END_BOUNDS: Readonly<Record<string, (value: unknown, runEnd: Readonly<Record<string, unknown>>) => boolean>> = {
  "goal.maxContinuationTurns": (value, runEnd) => {
    const cap = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
    const seen = runEnd.goalContinuationTurns;
    return typeof seen === "number" && Number.isFinite(seen) && seen <= cap;
  },
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathsIntersect(knobs: readonly string[], patches: readonly string[]): boolean {
  if (knobs.length === 0 || patches.length === 0) return false;
  return knobs.some((knob) => patches.some((path) => path === knob || path.startsWith(`${knob}.`) || knob.startsWith(`${path}.`)));
}

/** `[agent].timeout_sec` from a task.toml body. No default. */
export function parseAgentTimeoutSec(toml: string): number | null {
  let section = "";
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim();
      continue;
    }
    if (section !== "agent") continue;
    const value = /^\s*timeout_sec\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?$/.exec(line);
    if (!value?.[1]) continue;
    const parsed = Number(value[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function withinOfficialTimeout(wallS: number | null, timeoutSec: number | null): boolean {
  if (wallS === null || timeoutSec === null) return false;
  if (!Number.isFinite(wallS) || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return false;
  return wallS < timeoutSec;
}

function repeatsBaseline(baseline: Readonly<Record<string, unknown>> | null, leaf: ChangedLeaf): boolean {
  if (!baseline || !Object.prototype.hasOwnProperty.call(baseline, leaf.path)) return false;
  return sameValue(baseline[leaf.path], leaf.value);
}

/**
 * The single activation measure. G2 passes exactly when this is true, and
 * closure.patchActive stores the same boolean.
 */
export function patchTookEffect(input: {
  readonly evidenceActive: boolean;
  readonly changed: readonly ChangedLeaf[];
  readonly effective: Readonly<Record<string, unknown>> | null;
  readonly baselineEffective: Readonly<Record<string, unknown>> | null;
  readonly runEnd: Readonly<Record<string, unknown>> | null;
}): boolean {
  if (!input.evidenceActive) return false;
  if (input.changed.length === 0) return false;
  for (const leaf of input.changed) {
    if (repeatsBaseline(input.baselineEffective, leaf)) return false;
    if (!input.effective || !sameValue(input.effective[leaf.path], leaf.value)) return false;
    const bound = RUN_END_BOUNDS[leaf.path];
    if (bound && (!input.runEnd || !bound(leaf.value, input.runEnd))) return false;
  }
  return true;
}

function activeLeaves(input: ReviewerGateInput): { readonly pass: boolean; readonly code?: string } {
  const pass = patchTookEffect({
    evidenceActive: input.patchActive,
    changed: input.changed,
    effective: input.effective,
    baselineEffective: input.baselineEffective,
    runEnd: input.runEnd,
  });
  return pass ? { pass: true } : { pass: false, code: "inactive_key" };
}

/** Host verdict. G0 failure is anti_forgery. Later failures reject. The first failure wins. */
export function evaluateReviewerGates(input: ReviewerGateInput): ReviewerGateReport {
  const g0 = input.evidenceOk;
  const g1 = input.gapCitedPrevious && pathsIntersect(input.knobPaths, input.patchPaths);
  const g2 = activeLeaves(input);
  const g3 = input.scored
    && !input.timedOut
    && withinOfficialTimeout(input.wallS, input.officialTimeoutSec)
    && input.reward !== null
    && input.baselineReward !== null
    && input.reward >= input.baselineReward;
  const gates: GateRow[] = [
    { id: "G0", pass: g0 },
    { id: "G1", pass: g1 },
    { id: "G2", pass: g2.pass, ...(g2.code && !g2.pass ? { code: g2.code } : {}) },
    { id: "G3", pass: g3 },
  ];
  if (!g0) return { gates, verdict: "anti_forgery" };
  if (!g1) return { gates, verdict: "reject" };
  if (!g2.pass) return { gates, verdict: "reject", rejectCode: "inactive_key" };
  if (!g3) return { gates, verdict: "reject" };
  return { gates, verdict: "accept" };
}

/**
 * Gates that can be decided before once/docker. G0 and G3 stay out.
 * Static G2 checks each changed leaf against the whitelist and the harness
 * `effective["..."]` keys. It does not read a run.
 */
export function evaluatePreflightGates(input: {
  readonly gapCitedPrevious: boolean;
  readonly knobPaths: readonly string[];
  readonly patchPaths: readonly string[];
  readonly changed: readonly ChangedLeaf[];
  readonly whitelist: readonly string[];
  readonly harnessKeys: readonly string[];
}): PreflightGateReport {
  const g1 = input.gapCitedPrevious && pathsIntersect(input.knobPaths, input.patchPaths);
  const allowed = new Set(input.whitelist);
  const present = new Set(input.harnessKeys);
  let g2 = input.changed.length > 0;
  for (const leaf of input.changed) {
    if (!allowed.has(leaf.path) || !present.has(leaf.path)) {
      g2 = false;
      break;
    }
  }
  const gates: GateRow[] = [
    { id: "G1", pass: g1 },
    { id: "G2", pass: g2, ...(g2 ? {} : { code: "inactive_key" }) },
  ];
  return { preflight: true, final: false, gates };
}
