import { deepFreeze } from "./security-boundary";

/**
 * Validation ladder (T41, spec #1 research gap G2): a three-level *data-split /
 * leaderboard policy* contract that keeps one val/Public score from deciding a
 * champion.
 *
 * - **inner CV** — the repeated/inner search signal; feeds parameter/model
 *   search only.
 * - **outer holdout** — the untouched held-out split; the default (and only
 *   unattended) basis for local promotion.
 * - **Public LB probe** — an optional, limited, expensive submission to the
 *   public leaderboard; capped by an explicit count and never a promotion basis.
 *
 * This is NOT the #11 evaluation noise protocol (`evaluation-noise.ts`): that
 * governs score *noise* (repeats, ladders, A/B agreement, margins); this
 * governs *which data split / leaderboard a score came from and who may read
 * it*. They are complementary and deliberately separate. See
 * docs/validation-ladder.md.
 */

/** The three validation levels. `public_lb` is the optional capped probe. */
export type ValidationLevel = "inner_cv" | "outer_holdout" | "public_lb";

/** Roles that may consume a score. Maps to the spec's separation of duties. */
export type ValidationReaderRole =
  | "candidate_search"
  | "promotion_gate"
  | "mission_director"
  | "evaluator"
  | "auditor"
  | "submission_broker"
  | "operator";

/** Why a level exists in the ladder. */
export type ValidationLevelPurpose = "search" | "promotion" | "public_lb_probe";

/** Adapter/evaluation-contract face: raw, snake/camel-tolerant input. */
export interface ValidationLadderInput {
  /** The unattended promotion basis; must normalize to `outer_holdout`. */
  readonly promotionBasis?: string;
  readonly promotion_basis?: string;
  /** Explicit cap on Public LB probes; default 0 (probe off unless budgeted). */
  readonly publicProbeCap?: number;
  readonly public_probe_cap?: number;
  readonly [key: string]: unknown;
}

/** Adapter face: the ladder is exposed via a snake/camel accessor (or field). */
export type ValidationLadderProvider = {
  readonly validation_ladder?: (() => ValidationLadderInput | undefined) | ValidationLadderInput;
  readonly validationLadder?: (() => ValidationLadderInput | undefined) | ValidationLadderInput;
};

export interface ValidationLevelPolicy {
  readonly level: ValidationLevel;
  readonly purpose: ValidationLevelPurpose;
  readonly readers: readonly ValidationReaderRole[];
}

/** Normalized, frozen contract. */
export interface ValidationLadderContract {
  readonly promotionBasis: ValidationLevel;
  readonly publicProbeCap: number;
  readonly levels: Readonly<Record<ValidationLevel, ValidationLevelPolicy>>;
}

/** The default readers per level (spec #1 story 11: search never sees the holdout). */
const DEFAULT_READERS: Readonly<Record<ValidationLevel, readonly ValidationReaderRole[]>> = {
  inner_cv: ["candidate_search", "evaluator"],
  outer_holdout: ["promotion_gate", "mission_director", "evaluator", "auditor", "operator"],
  public_lb: ["operator", "submission_broker", "mission_director", "auditor"],
};

const LEVEL_PURPOSE: Readonly<Record<ValidationLevel, ValidationLevelPurpose>> = {
  inner_cv: "search",
  outer_holdout: "promotion",
  public_lb: "public_lb_probe",
};

const LEVEL_ALIASES: Readonly<Record<string, ValidationLevel>> = {
  inner_cv: "inner_cv",
  innercv: "inner_cv",
  "inner-cv": "inner_cv",
  cv: "inner_cv",
  cross_validation: "inner_cv",
  outer_holdout: "outer_holdout",
  outerholdout: "outer_holdout",
  "outer-holdout": "outer_holdout",
  holdout: "outer_holdout",
  public_lb: "public_lb",
  publiclb: "public_lb",
  "public-lb": "public_lb",
  public_probe: "public_lb",
  publicprobe: "public_lb",
  "public-probe": "public_lb",
  public_leaderboard: "public_lb",
  leaderboard: "public_lb",
  lb: "public_lb",
};

const READER_ALIASES: Readonly<Record<string, ValidationReaderRole>> = {
  candidate_search: "candidate_search",
  search: "candidate_search",
  search_engine: "candidate_search",
  inner_search: "candidate_search",
  promotion_gate: "promotion_gate",
  promotion: "promotion_gate",
  mission_director: "mission_director",
  director: "mission_director",
  evaluator: "evaluator",
  auditor: "auditor",
  submission_broker: "submission_broker",
  broker: "submission_broker",
  operator: "operator",
  human: "operator",
};

/** Normalizes an adapter-supplied level token; unknown tokens fail closed. */
export function normaliseValidationLevel(value: unknown): ValidationLevel {
  if (typeof value !== "string") throw new TypeError("validation level must be a string");
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const level = LEVEL_ALIASES[key];
  if (!level) throw new RangeError(`unknown validation level: ${value}`);
  return level;
}

function normaliseReader(value: unknown): ValidationReaderRole {
  if (typeof value !== "string") throw new TypeError("validation reader role must be a string");
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const role = READER_ALIASES[key];
  if (!role) throw new RangeError(`unknown validation reader role: ${value}`);
  return role;
}

function nonNegativeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/** True for a normalized ladder contract (carries the canonical `levels` policies). */
export function isValidationLadderContract(value: unknown): value is ValidationLadderContract {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as { levels?: unknown }).levels !== undefined
    && typeof (value as { promotionBasis?: unknown }).promotionBasis === "string";
}

/**
 * Resolves and validates the validation ladder. Two accepted input shapes:
 *  1. a plain declaration object (`{ promotionBasis?, publicProbeCap? }`);
 *  2. a provider/adapter that *exposes* the ladder via a snake/camel accessor —
 *     every Competition Adapter defines `evaluate`, a declaration never does, so
 *     that distinguishes the two. Absent/undefined → the gate is inactive.
 * A non-holdout promotion basis or a bad cap fails closed.
 */
export function resolveValidationLadder(provider: unknown): ValidationLadderContract | undefined {
  let input: unknown = provider;
  const looksLikeProvider = provider !== null && typeof provider === "object" && !Array.isArray(provider)
    && typeof (provider as { evaluate?: unknown }).evaluate === "function";
  if (looksLikeProvider) {
    const face = provider as Partial<ValidationLadderProvider>;
    const accessor = face.validation_ladder ?? face.validationLadder;
    input = typeof accessor === "function" ? (accessor as () => unknown).call(provider) : accessor;
  }
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("validation ladder must be an object");

  const declaration = input as ValidationLadderInput;
  const basisToken = declaration.promotionBasis ?? declaration.promotion_basis ?? "outer_holdout";
  const promotionBasis = normaliseValidationLevel(basisToken);
  // The unattended ceiling is local promotion on the outer holdout; the Public
  // probe may never be configured as the promotion basis.
  if (promotionBasis !== "outer_holdout") {
    throw new RangeError(`validation ladder promotion basis must be outer_holdout, got ${String(basisToken)}`);
  }
  const publicProbeCap = nonNegativeInteger(
    "validation ladder publicProbeCap",
    declaration.publicProbeCap ?? declaration.public_probe_cap ?? 0,
  );

  const levels = Object.fromEntries(
    (["inner_cv", "outer_holdout", "public_lb"] as const).map((level) => {
      const policy: ValidationLevelPolicy = Object.freeze({ level, purpose: LEVEL_PURPOSE[level], readers: Object.freeze([...DEFAULT_READERS[level]]) });
      return [level, policy];
    }),
  ) as Record<ValidationLevel, ValidationLevelPolicy>;

  return deepFreeze({ promotionBasis, publicProbeCap, levels }) as ValidationLadderContract;
}

/**
 * Whether a role may read the score produced at a validation level. Story 11:
 * the leaderboard-optimizing search engine never sees the holdout or Public
 * score; the promotion gate never sees the Public score. Unknown roles → false.
 */
export function canReadScore(level: ValidationLevel, role: ValidationReaderRole | string): boolean {
  let normalized: ValidationReaderRole;
  try {
    normalized = normaliseReader(role);
  } catch {
    return false;
  }
  return DEFAULT_READERS[level].includes(normalized);
}

/** True only when outer-holdout evidence may back a promotion; inner/Public never champion. */
export function levelCanChampion(level: ValidationLevel): boolean {
  return level === "outer_holdout";
}

export interface ProbeAuthorization {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Authorizes one Public LB probe against the explicit cap. `spent` is the
 * number of probes already consumed (projected from the ledger); once the cap
 * is exhausted every further probe is refused.
 */
export function authorizePublicProbe(contract: ValidationLadderContract, spent: number): ProbeAuthorization {
  if (spent >= contract.publicProbeCap) {
    return { allowed: false, reason: `public LB probe cap exhausted: ${contract.publicProbeCap} probe(s) allowed, ${spent} already spent` };
  }
  return { allowed: true };
}

/** Minimal ledger event shape used to count spent probes (structural, no toy-harness import). */
export interface ValidationEventLike {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Counts probes already consumed: evaluator-succeeded events scored at the Public LB level. */
export function publicProbesUsedFromEvents(events: readonly ValidationEventLike[]): number {
  return events.reduce((count, event) => {
    if (event.type !== "EVALUATOR_SUCCEEDED") return count;
    const raw = event.payload?.validationLevel ?? event.payload?.validation_level;
    if (raw === undefined) return count;
    try {
      return normaliseValidationLevel(raw) === "public_lb" ? count + 1 : count;
    } catch {
      return count;
    }
  }, 0);
}
