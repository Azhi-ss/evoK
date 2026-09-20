/**
 * Search-owned one-circle suite lift harness (ET-RSI-LIFT / #174).
 *
 * Opt-in: Mission `/research continue` may call this after a measured
 * suite-metric baseline. It is not a second control plane, not Promotion
 * authority, and not a Pi Run. Default parent selection stays `fixed_uct`.
 * Progressive / `#40` stay off unless Mission or config explicitly opts in.
 *
 * The harness proposes a Candidate snapshot. An independent Evaluator
 * (owned by competition/) must measure pass_rate. A model self-score
 * cannot replace that measurement.
 */
import {
  resolveSearchSelection,
  type MissionSearchSelectionSource,
} from "./progressive-opt-in";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  type SearchParentCandidate,
  type SearchParentSelection,
  type SearchSelectionAdapterId,
  type SelectionPolicy40State,
} from "./search-selection-port";

export const SUITE_LIFT_CIRCLE_ID = "suite_lift_one_circle" as const;
export const DEFAULT_SUITE_LIFT_TARGET = 0.8 as const;

export interface SuiteLiftProposal {
  readonly files: Readonly<Record<string, string>>;
  readonly note: string;
  readonly selectionId: SearchSelectionAdapterId;
  readonly selectionPolicy40: SelectionPolicy40State;
}

export type SuiteLiftPropose = (baselineFiles: Readonly<Record<string, string>>) => SuiteLiftProposal;

export interface SuiteLiftCircleInput {
  readonly baselineFiles: Readonly<Record<string, string>>;
  readonly baselineScore?: number;
  readonly liftTarget?: number;
  readonly propose?: SuiteLiftPropose;
  /** Explicit Mission/config Progressive opt-in. Absent stays `fixed_uct`. */
  readonly searchSelection?: MissionSearchSelectionSource;
}

export interface SuiteLiftCircleResult {
  readonly circleId: typeof SUITE_LIFT_CIRCLE_ID;
  readonly selectionId: SearchSelectionAdapterId;
  readonly selectionPolicy40: SelectionPolicy40State;
  readonly liftTarget: number;
  readonly selectedNodeId: "identity" | "helper-completion";
  readonly selection: SearchParentSelection;
  readonly proposal: SuiteLiftProposal;
}

const LOCAL_HELPER_COMPLETION = `/**
 * Local helper-completion proposal for a suite-metric continue circle.
 * Independent suite-metric must measure pass_rate. This file is not a score.
 */
function double(n) {
  return n * 2;
}

function isEven(n) {
  return n % 2 === 0;
}

function sum(a, b) {
  return a + b;
}

function max(a, b) {
  return a >= b ? a : b;
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

module.exports = { double, isEven, sum, max, clamp };
`;

function looksLikeLocalHelperModule(source: string): boolean {
  return /function\s+sum\s*\(/.test(source)
    && /function\s+max\s*\(/.test(source)
    && /function\s+clamp\s*\(/.test(source);
}

/** Default opt-in proposer: complete the known local helpers. Identity otherwise. */
export function proposeSuiteLiftCandidate(
  baselineFiles: Readonly<Record<string, string>>,
): SuiteLiftProposal {
  const current = baselineFiles["src/solve.js"];
  if (typeof current === "string" && looksLikeLocalHelperModule(current)) {
    return {
      files: { ...baselineFiles, "src/solve.js": LOCAL_HELPER_COMPLETION },
      note: "local helper-completion proposal; independent suite-metric must measure",
      selectionId: DEFAULT_SEARCH_SELECTION_ID,
      selectionPolicy40: SELECTION_POLICY_40,
    };
  }
  return {
    files: { ...baselineFiles },
    note: "no local helper-completion applicable; identity proposal",
    selectionId: DEFAULT_SEARCH_SELECTION_ID,
    selectionPolicy40: SELECTION_POLICY_40,
  };
}

function sameFiles(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * One authorized search circle. Default parent selection is `fixed_uct`
 * (unvisited helper-completion is preferred). Progressive / `#40` only when
 * `searchSelection` is an explicit Mission/config opt-in.
 */
export function runSuiteLiftCircle(input: SuiteLiftCircleInput): SuiteLiftCircleResult {
  const liftTarget = input.liftTarget ?? DEFAULT_SUITE_LIFT_TARGET;
  const propose = input.propose ?? proposeSuiteLiftCandidate;
  const proposed = propose(input.baselineFiles);
  const resolved = resolveSearchSelection(input.searchSelection);
  const identityProposal: SuiteLiftProposal = {
    files: { ...input.baselineFiles },
    note: "identity baseline snapshot",
    selectionId: resolved.selectionId,
    selectionPolicy40: resolved.selectionPolicy40,
  };
  const distinct = !sameFiles(proposed.files, input.baselineFiles);
  const nodes: SearchParentCandidate[] = [
    { nodeId: "identity", visits: 1, value: 0, parentVisits: distinct ? 2 : 1 },
    ...(distinct
      ? [{ nodeId: "helper-completion", visits: 0, value: 0, parentVisits: 2 } satisfies SearchParentCandidate]
      : []),
  ];
  const selection = resolved.port.selectParent({ nodes });
  const selectedNodeId = selection.parentId === "helper-completion" ? "helper-completion" : "identity";
  const proposal = selectedNodeId === "helper-completion" ? {
    ...proposed,
    selectionId: resolved.selectionId,
    selectionPolicy40: resolved.selectionPolicy40,
  } : identityProposal;
  return {
    circleId: SUITE_LIFT_CIRCLE_ID,
    selectionId: resolved.selectionId,
    selectionPolicy40: resolved.selectionPolicy40,
    liftTarget,
    selectedNodeId,
    selection,
    proposal,
  };
}
