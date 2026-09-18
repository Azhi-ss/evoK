import { TrustViolation, deepFreeze, digestValue } from "../security-boundary";

/**
 * First-class methodology contracts (T44, spec #1 research gaps G4/G5/G6):
 * promotes three Kaggle-methodology objects from "inner search does whatever"
 * to harness/adapter contracts:
 *
 *  1. `feature_pipeline` — component-level feature engineering, independently
 *     searchable / ablated without touching the ensemble or the split.
 *  2. `oof_ensemble` — stacking / blending; promotion requires OOF (or a
 *     contract-declared equivalent leakage-safe protocol).
 *  3. `split_contract` — time / group / kfold split discipline with purge /
 *     embargo declarations. Violating a declared split_contract is a **rule
 *     failure** (`MethodologyViolation`, a TrustViolation), never merely a
 *     worse score.
 *
 * Inner search must NOT silently rewrite split_contract: fan-out over FE or
 * ensemble components re-normalizes and structurally refuses a split change;
 * a candidate that re-declares a random splitter against a time/group contract
 * is audited as a split violation. See docs/methodology-contracts.md.
 */

// ──────────────────────────────────────────────────────────────────────────
// feature_pipeline
// ──────────────────────────────────────────────────────────────────────────

export interface FeatureStep {
  readonly id: string;
  readonly kind: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface FeaturePipelineContract {
  readonly id: string;
  readonly steps: readonly FeatureStep[];
}

// ──────────────────────────────────────────────────────────────────────────
// oof_ensemble
// ──────────────────────────────────────────────────────────────────────────

export type EnsembleMethod = "stack" | "blend";

/**
 * The leakage-safe protocol under which ensemble predictions were produced.
 * `oof` is out-of-fold predictions; any other protocol must be explicitly
 * declared equivalent (nested CV, group/time-aware OOF, …).
 */
export interface OofProtocol {
  readonly protocol: string;
  readonly folds?: number;
  /** True only when a non-`oof` protocol is declared leakage-safe. */
  readonly declared_equivalent?: boolean;
}

export interface OofEnsembleContract {
  readonly id: string;
  readonly members: readonly string[];
  readonly method: EnsembleMethod;
  readonly oof: OofProtocol;
}

// ──────────────────────────────────────────────────────────────────────────
// split_contract
// ──────────────────────────────────────────────────────────────────────────

export type SplitKind = "kfold" | "time" | "group";

export interface SplitContract {
  readonly id: string;
  readonly kind: SplitKind;
  readonly folds: number;
  /** Rows dropped around a train/test boundary (group/time leakage guard). */
  readonly purge: number;
  /** Held-out rows after each test block (group/time leakage guard). */
  readonly embargo: number;
  /** Required for a `group` split: the column whose members never cross folds. */
  readonly group_column?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// normalized bundle + raw declaration
// ──────────────────────────────────────────────────────────────────────────

export interface MethodologyContracts {
  readonly feature_pipeline?: FeaturePipelineContract;
  readonly oof_ensemble?: OofEnsembleContract;
  readonly split_contract?: SplitContract;
}

/** Raw, snake/camel-tolerant input (a candidate/task declaration or adapter face). */
export interface MethodologyDeclaration {
  feature_pipeline?: unknown;
  featurePipeline?: unknown;
  oof_ensemble?: unknown;
  oofEnsemble?: unknown;
  split_contract?: unknown;
  splitContract?: unknown;
  [key: string]: unknown;
}

/** Adapter face: the contracts are exposed via a snake/camel accessor (or field). */
export type MethodologyProvider = {
  readonly methodology?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
  readonly methodology_contracts?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
  readonly methodologyContracts?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
};

// ──────────────────────────────────────────────────────────────────────────
// normalizers
// ──────────────────────────────────────────────────────────────────────────

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RangeError(`${name} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const n = nonNegativeInteger(value, name);
  if (n < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return n;
}

function pick(obj: Readonly<Record<string, unknown>>, snake: string, camel: string): unknown {
  return obj[snake] ?? obj[camel];
}

const SPLIT_ALIASES: Readonly<Record<string, SplitKind>> = {
  kfold: "kfold",
  k_fold: "kfold",
  "k-fold": "kfold",
  cv: "kfold",
  time: "time",
  timeseries: "time",
  time_series: "time",
  "time-series": "time",
  temporal: "time",
  group: "group",
  grouped: "group",
  group_kfold: "group",
  "group-kfold": "group",
};

export function normalizeSplitContract(raw: unknown): SplitContract | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObject(raw, "split_contract");
  const id = nonEmptyString(o.id ?? "split", "split_contract.id");
  const kindToken = String(o.kind ?? "kfold").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const kind = SPLIT_ALIASES[kindToken];
  if (!kind) throw new RangeError(`split_contract: unknown split kind '${String(o.kind)}' (expected kfold | time | group)`);
  const folds = positiveInteger(o.folds ?? o.n_splits ?? o.nSplits ?? 5, "split_contract.folds");
  const purge = nonNegativeInteger(o.purge ?? o.gap ?? 0, "split_contract.purge");
  const embargo = nonNegativeInteger(o.embargo ?? 0, "split_contract.embargo");
  const groupColumn = o.group_column ?? o.groupColumn ?? o.group;
  if (kind === "group" && (typeof groupColumn !== "string" || groupColumn.trim() === "")) {
    throw new RangeError("split_contract.group_column is required for a group split");
  }
  return deepFreeze({
    id,
    kind,
    folds,
    purge,
    embargo,
    ...(typeof groupColumn === "string" && groupColumn.trim() !== "" ? { group_column: groupColumn } : {}),
  }) as SplitContract;
}

export function normalizeFeaturePipeline(raw: unknown): FeaturePipelineContract | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObject(raw, "feature_pipeline");
  const id = nonEmptyString(o.id ?? "feature_pipeline", "feature_pipeline.id");
  const rawSteps = o.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new RangeError("feature_pipeline.steps must be a non-empty array");
  }
  const steps = rawSteps.map((rawStep, index) => {
    const s = asObject(rawStep, `feature_pipeline.steps[${index}]`);
    const stepId = nonEmptyString(s.id ?? `${s.kind ?? "step"}_${index}`, `feature_pipeline.steps[${index}].id`);
    const kind = nonEmptyString(s.kind, `feature_pipeline.steps[${index}].kind`);
    const params = s.params;
    return deepFreeze({
      id: stepId,
      kind,
      ...(params !== undefined ? { params: deepFreeze(asObject(params, `feature_pipeline.steps[${index}].params`)) } : {}),
    }) as FeatureStep;
  });
  return deepFreeze({ id, steps: Object.freeze(steps) }) as FeaturePipelineContract;
}

const METHOD_ALIASES: Readonly<Record<string, EnsembleMethod>> = {
  blend: "blend",
  blending: "blend",
  blend_ensemble: "blend",
  stack: "stack",
  stacking: "stack",
  stacked: "stack",
  stacked_generalization: "stack",
};

export function normalizeOofEnsemble(raw: unknown): OofEnsembleContract | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObject(raw, "oof_ensemble");
  const id = nonEmptyString(o.id ?? "oof_ensemble", "oof_ensemble.id");
  const rawMembers = o.members ?? o.models ?? o.base_models ?? o.baseModels;
  if (!Array.isArray(rawMembers) || rawMembers.length < 2 || rawMembers.some((m) => typeof m !== "string" || m.trim() === "")) {
    throw new RangeError("oof_ensemble.members must be an array of at least two member ids");
  }
  const methodToken = String(o.method ?? o.ensemble_method ?? o.ensembleMethod ?? "blend").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const method = METHOD_ALIASES[methodToken];
  if (!method) throw new RangeError(`oof_ensemble.method must be stack(ing) or blend(ing) (got ${String(o.method)})`);

  const rawOof = o.oof ?? o.oofProtocol ?? o.oof_protocol ?? o.leakage_safe ?? o.leakageSafe;
  if (rawOof === undefined || rawOof === null || typeof rawOof !== "object") {
    throw new RangeError("oof_ensemble promotion requires an OOF protocol (or a declared-equivalent leakage-safe protocol)");
  }
  const oofObj = rawOof as Record<string, unknown>;
  const protocol = nonEmptyString(oofObj.protocol ?? oofObj.type ?? "oof", "oof_ensemble.oof.protocol");
  const folds = oofObj.folds ?? oofObj.n_splits;
  const declaredEquivalent = oofObj.declared_equivalent === true || oofObj.declaredEquivalent === true;
  // OOF is the canonical leakage-safe protocol; anything else must be declared equivalent.
  if (protocol !== "oof" && !declaredEquivalent) {
    throw new RangeError(`oof_ensemble protocol '${protocol}' is not OOF and is not declared_equivalent (leakage risk)`);
  }
  const oof = deepFreeze({
    protocol,
    ...(folds !== undefined ? { folds: positiveInteger(folds, "oof_ensemble.oof.folds") } : {}),
    ...(protocol !== "oof" ? { declared_equivalent: true } : {}),
  }) as OofProtocol;

  return deepFreeze({
    id,
    members: Object.freeze([...new Set(rawMembers.map((m) => String(m)))]),
    method,
    oof,
  }) as OofEnsembleContract;
}

/** True for a normalized methodology bundle (carries at least one normalized object). */
export function isMethodologyContracts(value: unknown): value is MethodologyContracts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.split_contract === "object" || typeof v.feature_pipeline === "object" || typeof v.oof_ensemble === "object";
}

/**
 * Resolves and validates the methodology contracts. Accepts a plain declaration
 * object (candidate/task face) or a provider/adapter exposing them via a
 * snake/camel accessor. Absent → the gate is inactive (undefined). A malformed
 * declaration fails closed.
 */
export function resolveMethodologyContracts(provider: unknown): MethodologyContracts | undefined {
  let input: unknown = provider;
  if (provider !== null && typeof provider === "object" && !Array.isArray(provider)) {
    const face = provider as Partial<MethodologyProvider>;
    const accessor = face.methodology_contracts ?? face.methodologyContracts ?? face.methodology;
    if (accessor !== undefined) {
      input = typeof accessor === "function" ? (accessor as () => unknown).call(provider) : accessor;
    }
  }
  if (input === undefined || input === null) return undefined;
  const decl = asObject(input, "methodology contracts") as MethodologyDeclaration;
  const featurePipeline = normalizeFeaturePipeline(pick(decl, "feature_pipeline", "featurePipeline"));
  const oofEnsemble = normalizeOofEnsemble(pick(decl, "oof_ensemble", "oofEnsemble"));
  const splitContract = normalizeSplitContract(pick(decl, "split_contract", "splitContract"));
  if (!featurePipeline && !oofEnsemble && !splitContract) return undefined;
  return deepFreeze({
    ...(featurePipeline ? { feature_pipeline: featurePipeline } : {}),
    ...(oofEnsemble ? { oof_ensemble: oofEnsemble } : {}),
    ...(splitContract ? { split_contract: splitContract } : {}),
  }) as MethodologyContracts;
}

// ──────────────────────────────────────────────────────────────────────────
// split_contract audit (rule failure, not a worse score)
// ──────────────────────────────────────────────────────────────────────────

export interface MethodologyFinding {
  readonly kind: "split_violation";
  /** The matched split-discipline token; safe to record. */
  readonly token: string;
  readonly detail: string;
}

/**
 * Confirmed random-split signals: shuffling splitters and random CV that leak
 * across a time/group boundary. `Random` alone (e.g. random_state) is not a
 * signal — only an actual shuffling/random splitter is.
 */
const RANDOM_SPLIT_SIGNALS: readonly RegExp[] = [
  /\bKFold\s*\([^)]*\bshuffle\s*=\s*True/i,
  /\bStratifiedKFold\b/i,
  /\bShuffleSplit\b/i,
  /\btrain_test_split\s*\([^)]*\bshuffle\s*=\s*True/i,
  /\btrain_test_split\b(?!\s*\([^)]*\bshuffle\s*=\s*False)/i,
  /\bsplitter\s*=\s*["']random["']/i,
  /\bcv\s*=\s*["']random["']/i,
  /\bGroupShuffleSplit\b/i,
];

/**
 * Scans candidate files for a split that violates the declared split_contract.
 * Only a declared `time` or `group` contract is audited: a `kfold` contract
 * permits ordinary random CV. Static text scan (deterministic for replay).
 *
 * ponytail: deliberately naive token scan — any mention of a shuffling splitter
 * is a finding (comments included; fails closed), and an obfuscated splitter
 * escapes. Upgrade path: AST/dataflow analysis + adapter-provided split probes
 * when a real adapter replaces the toy fixtures.
 */
export function auditMethodology(
  contracts: Readonly<MethodologyContracts> | undefined,
  files: Readonly<Record<string, string>>,
): readonly MethodologyFinding[] {
  const split = contracts?.split_contract;
  // Only time/group discipline forbids random splits; a kfold contract allows them.
  if (!split || (split.kind !== "time" && split.kind !== "group")) return Object.freeze([]);

  const findings: MethodologyFinding[] = [];
  const seen = new Set<string>();
  const note = (token: string, detail: string): void => {
    if (seen.has(token)) return;
    seen.add(token);
    findings.push(Object.freeze({ kind: "split_violation" as const, token, detail }));
  };

  for (const [fileName, rawContent] of Object.entries(files)) {
    const content = typeof rawContent === "string" ? rawContent : String(rawContent ?? "");
    for (const signal of RANDOM_SPLIT_SIGNALS) {
      const match = content.match(signal);
      if (match) {
        note(
          match[0].slice(0, 40),
          `${fileName}: random/shuffling split violates declared ${split.kind} split_contract '${split.id}' (purge=${split.purge}, embargo=${split.embargo}${split.group_column ? `, group=${split.group_column}` : ""})`,
        );
      }
    }
  }
  return Object.freeze(findings);
}

/** Trust violation carrying confirmed methodology findings; the harness quarantines on it. */
export class MethodologyViolation extends TrustViolation {
  readonly findings: readonly MethodologyFinding[];
  constructor(findings: readonly MethodologyFinding[]) {
    super(`methodology contract violation: ${[...new Set(findings.map((f) => f.kind))].join(", ")}`);
    this.name = "MethodologyViolation";
    this.findings = Object.freeze([...findings]);
  }
  /** Stable fingerprint: repeated identical violations are never auto-retried. */
  fingerprint(): string {
    return digestValue(this.findings.map((f) => `${f.kind}:${f.token}`).sort());
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ensemble promotion gate (OOF required)
// ──────────────────────────────────────────────────────────────────────────

export interface EnsemblePromotionEvidence {
  /** Which component the candidate promotes. Only an ensemble candidate is gated. */
  readonly component: "ensemble" | "feature_pipeline" | "model" | string;
  /** Whether the ensemble candidate carries out-of-fold (or declared-equivalent) predictions. */
  readonly oofPredictionsPresent: boolean;
}

export interface EnsemblePromotionDecision {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * An ensemble candidate may be promoted only with OOF predictions (or a
 * contract-declared equivalent leakage-safe protocol). Non-ensemble candidates
 * and missions with no declared oof_ensemble are not gated by this.
 */
export function validateEnsemblePromotion(
  contracts: Readonly<MethodologyContracts> | undefined,
  evidence: Readonly<EnsemblePromotionEvidence>,
): EnsemblePromotionDecision {
  const ensemble = contracts?.oof_ensemble;
  const isEnsemble = evidence.component === "ensemble" || evidence.component === "oof_ensemble";
  if (!ensemble || !isEnsemble) return { ok: true, reasons: Object.freeze([]) };
  const reasons: string[] = [];
  if (!evidence.oofPredictionsPresent) {
    reasons.push(`ensemble '${ensemble.id}' promotion requires OOF predictions (or declared-equivalent leakage-safe protocol); none present`);
  }
  if (ensemble.oof.protocol !== "oof" && ensemble.oof.declared_equivalent !== true) {
    reasons.push(`ensemble '${ensemble.id}' protocol '${ensemble.oof.protocol}' is not a declared leakage-safe equivalent`);
  }
  return Object.freeze({ ok: reasons.length === 0, reasons: Object.freeze(reasons) });
}

// ──────────────────────────────────────────────────────────────────────────
// component-level fan-out (touch only FE or only ensemble; never the split)
// ──────────────────────────────────────────────────────────────────────────────────

export type FanOutComponent = "feature_pipeline" | "oof_ensemble";

export type FeaturePipelineChange =
  | { readonly kind: "add_step"; readonly step: FeatureStep }
  | { readonly kind: "remove_step"; readonly stepId: string };

export type EnsembleChange =
  | { readonly kind: "add_member"; readonly member: string }
  | { readonly kind: "remove_member"; readonly member: string };

export type ComponentChange =
  | { readonly component: "feature_pipeline"; readonly change: FeaturePipelineChange }
  | { readonly component: "oof_ensemble"; readonly change: EnsembleChange };

/**
 * Applies a component-level change in a bounded fan-out. A feature_pipeline
 * change touches only the feature pipeline; an oof_ensemble change touches only
 * the ensemble. The split_contract is structurally out of reach and is carried
 * through byte-identical, and the result is re-normalized so any malformed
 * outcome fails closed. Inner search can never silently rewrite the split.
 */
export function applyComponentFanOut(
  contracts: Readonly<MethodologyContracts>,
  change: Readonly<ComponentChange>,
): MethodologyContracts {
  const component = (change as { component?: unknown }).component;
  if (component === "split_contract" || component === "splitContract") {
    throw new RangeError("component fan-out may not rewrite split_contract (inner search cannot change split discipline)");
  }

  if (component === "feature_pipeline") {
    const delta = change.change as FeaturePipelineChange;
    const current = contracts.feature_pipeline;
    if (!current) throw new RangeError("feature_pipeline change but no feature_pipeline contract is declared");
    let steps = current.steps.map((s) => ({ ...s }));
    if (delta.kind === "add_step") {
      steps = [...steps, delta.step];
    } else if (delta.kind === "remove_step") {
      steps = steps.filter((s) => s.id !== delta.stepId);
    }
    const reNormalized = resolveMethodologyContracts({
      feature_pipeline: { id: current.id, steps },
      ...(contracts.oof_ensemble ? { oof_ensemble: contracts.oof_ensemble } : {}),
      ...(contracts.split_contract ? { split_contract: contracts.split_contract } : {}),
    });
    if (!reNormalized?.feature_pipeline) throw new RangeError("feature_pipeline fan-out produced an invalid pipeline");
    return reNormalized;
  }

  // oof_ensemble
  const delta = change.change as EnsembleChange;
  const current = contracts.oof_ensemble;
  if (!current) throw new RangeError("oof_ensemble change but no oof_ensemble contract is declared");
  let members = [...current.members];
  if (delta.kind === "add_member") {
    if (!members.includes(delta.member)) members = [...members, delta.member];
  } else if (delta.kind === "remove_member") {
    members = members.filter((m) => m !== delta.member);
  }
  const reNormalized = resolveMethodologyContracts({
    ...(contracts.feature_pipeline ? { feature_pipeline: contracts.feature_pipeline } : {}),
    oof_ensemble: { id: current.id, members, method: current.method, oof: current.oof },
    ...(contracts.split_contract ? { split_contract: contracts.split_contract } : {}),
  });
  if (!reNormalized?.oof_ensemble) throw new RangeError("oof_ensemble fan-out produced an invalid ensemble");
  return reNormalized;
}
