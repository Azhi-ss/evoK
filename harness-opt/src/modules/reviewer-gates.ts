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
  readonly reward: number | null;
  readonly baselineReward: number | null;
}

export interface ReviewerGateReport {
  readonly gates: readonly GateRow[];
  readonly verdict: "anti_forgery" | "reject" | "accept";
  readonly rejectCode?: string;
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

function activeLeaves(input: ReviewerGateInput): { readonly pass: boolean; readonly code?: string } {
  if (input.changed.length === 0) return { pass: false, code: "inactive_key" };
  for (const leaf of input.changed) {
    if (!input.effective || !sameValue(input.effective[leaf.path], leaf.value)) {
      return { pass: false, code: "inactive_key" };
    }
    const bound = RUN_END_BOUNDS[leaf.path];
    if (bound && (!input.runEnd || !bound(leaf.value, input.runEnd))) {
      return { pass: false, code: "inactive_key" };
    }
  }
  return { pass: true };
}

/** Host verdict. G0 failure is anti_forgery. Later failures reject. The first failure wins. */
export function evaluateReviewerGates(input: ReviewerGateInput): ReviewerGateReport {
  const g0 = input.evidenceOk;
  const g1 = input.gapCitedPrevious && pathsIntersect(input.knobPaths, input.patchPaths);
  const g2 = activeLeaves(input);
  const g3 = input.scored && !input.timedOut && input.reward !== null && input.baselineReward !== null && input.reward >= input.baselineReward;
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
