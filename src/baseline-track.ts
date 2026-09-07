import { deepFreeze } from "./security-boundary";
import { ideaTypeKind, requireIdeaType } from "./idea-types";

/**
 * Forced strong-baseline / AutoML track (T43, spec #1 research gap G10):
 * before a mission hands a large budget to fancy/heavy search, it must first
 * run (or beat) a cheap strong-baseline track — LightGBM / AutoGluon / the
 * adapter's choice of tabular baseline.
 *
 * The entry is **adapter-provided**: the harness never binds to one AutoML
 * vendor. The adapter or mission policy declares how to run the baseline and
 * what score counts as success; the harness only enforces ordering
 * (baseline-first), gates heavy/scale search until the success predicate
 * passes, and requires local promotion to clear `baseline + δ`.
 *
 * Vendor-neutral on purpose: `entry` is an opaque command/port name.
 */

/** Idea base kinds considered "heavy/expensive search" (fancy, big-budget). */
const DEFAULT_HEAVY_KINDS: readonly string[] = ["open-search"];

/** Raw declaration face; snake_case and camelCase are both accepted. */
export interface BaselineTrackInput {
  /** Opaque command / entry / port name of the baseline method. Adapter-provided. */
  readonly entry?: string;
  /** Minimum score the baseline must reach to count as established. */
  readonly successScore?: number;
  readonly success_score?: number;
  /** Required improvement over the baseline score for local promotion. Default 0. */
  readonly minImprovementDelta?: number;
  readonly min_improvement_delta?: number;
  /** Idea base kinds treated as heavy search and gated until baseline passes. */
  readonly heavyIdeaKinds?: readonly string[];
  readonly heavy_idea_kinds?: readonly string[];
  readonly [key: string]: unknown;
}

/** Adapter face: the track is exposed via a snake/camel accessor (or field). */
export type BaselineTrackProvider = {
  readonly baseline_track?: (() => BaselineTrackInput | undefined) | BaselineTrackInput;
  readonly baselineTrack?: (() => BaselineTrackInput | undefined) | BaselineTrackInput;
};

/** Normalized, frozen contract. */
export interface BaselineTrackContract {
  readonly entry: string;
  readonly successScore: number;
  readonly minImprovementDelta: number;
  readonly heavyIdeaKinds: readonly string[];
}

/** Result of running the baseline track; `score` absent when it never scored. */
export interface BaselineTrackResult {
  readonly ok: boolean;
  readonly score?: number;
  readonly evidence?: string;
}

/** Decision for a heavy-search / promotion request. */
export interface HeavySearchAuthorization {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly baseline?: BaselineTrackResult;
}

/** True for a normalized baseline contract (frozen, carries canonical fields). */
export function isBaselineTrackContract(value: unknown): value is BaselineTrackContract {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { entry?: unknown }).entry === "string"
    && typeof (value as { successScore?: unknown }).successScore === "number"
    && Array.isArray((value as { heavyIdeaKinds?: unknown }).heavyIdeaKinds);
}

function nonNegativeNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function normaliseHeavyKinds(value: unknown): string[] {
  const raw = value === undefined ? DEFAULT_HEAVY_KINDS : value;
  if (!Array.isArray(raw) || raw.length === 0) throw new RangeError("baseline track heavyIdeaKinds must be a non-empty array");
  return raw.map((kind) => requireIdeaType(kind)).map((kind) => ideaTypeKind(kind)!);
}

/**
 * Resolves and validates the baseline track. Accepted shapes:
 *  1. a plain declaration object;
 *  2. a provider/adapter exposing it via a snake/camel accessor — an adapter
 *     defines `evaluate`, a declaration never does.
 * Absent/undefined → the gate is inactive (no baseline declared for this
 * adapter). A malformed declaration fails closed.
 */
export function resolveBaselineTrack(provider: unknown): BaselineTrackContract | undefined {
  let input: unknown = provider;
  const face = provider !== null && typeof provider === "object" && !Array.isArray(provider)
    ? provider as Partial<BaselineTrackProvider>
    : undefined;
  if (face && (face.baseline_track !== undefined || face.baselineTrack !== undefined)) {
    const accessor = face.baseline_track ?? face.baselineTrack;
    input = typeof accessor === "function" ? (accessor as () => unknown).call(provider) : accessor;
  }
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("baseline track must be an object");

  const declaration = input as BaselineTrackInput;
  // An empty declaration (no entry, no score) means the gate is inactive.
  if (declaration.entry === undefined && declaration.successScore === undefined && declaration.success_score === undefined) {
    return undefined;
  }
  const entry = declaration.entry;
  if (typeof entry !== "string" || entry.trim() === "") {
    throw new RangeError("baseline track requires a non-empty entry (adapter-provided baseline command/port)");
  }
  const scoreRaw = declaration.successScore ?? declaration.success_score;
  if (typeof scoreRaw !== "number") {
    throw new RangeError("baseline track requires a numeric successScore predicate");
  }
  const successScore = nonNegativeNumber("baseline track successScore", scoreRaw);
  const minImprovementDelta = nonNegativeNumber(
    "baseline track minImprovementDelta",
    declaration.minImprovementDelta ?? declaration.min_improvement_delta ?? 0,
  );
  const heavyIdeaKinds = normaliseHeavyKinds(declaration.heavyIdeaKinds ?? declaration.heavy_idea_kinds);

  return deepFreeze({ entry: entry.trim(), successScore, minImprovementDelta, heavyIdeaKinds: Object.freeze(heavyIdeaKinds) }) as BaselineTrackContract;
}

/** Whether a candidate score meets the baseline's success predicate. */
export function baselinePassed(contract: BaselineTrackContract, result?: BaselineTrackResult): boolean {
  return result?.ok === true && typeof result.score === "number" && result.score >= contract.successScore;
}

/** True when an idea type belongs to a declared heavy-search kind. */
export function isHeavyIdea(contract: BaselineTrackContract, ideaType: string | undefined): boolean {
  if (ideaType === undefined) return false;
  let kind: string | undefined;
  try {
    requireIdeaType(ideaType);
    kind = ideaTypeKind(ideaType);
  } catch {
    return false;
  }
  return kind !== undefined && contract.heavyIdeaKinds.includes(kind);
}

/**
 * Policy Guard for heavy/scale search: refused until a baseline run clears its
 * success predicate. Cheap (non-heavy) idea kinds are never gated. An inactive
 * contract (no baseline declared) allows everything.
 */
export function authorizeHeavySearch(
  contract: BaselineTrackContract | undefined,
  baseline: BaselineTrackResult | undefined,
  ideaType: string | undefined,
): HeavySearchAuthorization {
  if (contract === undefined) return { allowed: true };
  if (!isHeavyIdea(contract, ideaType)) return { allowed: true };
  if (baselinePassed(contract, baseline)) return { allowed: true, baseline };
  return {
    allowed: false,
    reason: baseline !== undefined
      ? `baseline track '${contract.entry}' did not meet its success predicate (score ${baseline.score ?? "n/a"} < ${contract.successScore}); heavy search budget is refused`
      : `baseline track '${contract.entry}' has not been run; a strong baseline must be established before heavy/scale search`,
  };
}

/**
 * Local-promotion gate (≥ baseline + δ): a candidate may only promote when it
 * beats the established baseline score by the configured margin. No passing
 * baseline → no promotion (fail closed).
 */
export function baselineSatisfied(
  contract: BaselineTrackContract | undefined,
  baseline: BaselineTrackResult | undefined,
  candidateScore: number,
): HeavySearchAuthorization {
  if (contract === undefined) return { allowed: true };
  if (!baselinePassed(contract, baseline)) {
    return { allowed: false, reason: "no passing strong baseline established; promotion blocked until the baseline track clears" };
  }
  if (typeof candidateScore !== "number" || !Number.isFinite(candidateScore)) {
    return { allowed: false, reason: "candidate score is not a finite number; cannot compare against baseline + δ" };
  }
  const floor = (baseline as BaselineTrackResult).score! + contract.minImprovementDelta;
  if (candidateScore < floor) {
    return { allowed: false, reason: `candidate score ${candidateScore} is below required baseline + δ (${floor})` };
  }
  return { allowed: true, baseline };
}

/**
 * Director task-selection gate: a heavy-kind task is ineligible until the
 * baseline is established. The baseline task itself (tagged `baseline_track`)
 * and non-heavy tasks stay eligible, so a trivial baseline can always be run
 * first. Inactive contract → everything eligible.
 */
export function directorAuthorizeHeavyTask(
  contract: BaselineTrackContract | undefined,
  ideaType: string | undefined,
  baselineEstablished: boolean,
  tags?: readonly string[],
): HeavySearchAuthorization {
  if (contract === undefined) return { allowed: true };
  if (tags?.includes("baseline_track")) return { allowed: true };
  if (!isHeavyIdea(contract, ideaType)) return { allowed: true };
  if (baselineEstablished) return { allowed: true };
  return {
    allowed: false,
    reason: `baseline-first policy: baseline track '${contract.entry}' must be established before heavy (${ideaType}) tasks are selected`,
  };
}
