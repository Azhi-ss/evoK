/**
 * Research Charter schema, validation and content digest (#250 / C1; spec
 * #249, `docs/research-charter-prd.md` §3–§8).
 *
 * A charter is the pre-Mission study design: what the study must beat, under
 * which frozen protocol, and whether it is worth running at all. This module is
 * the schema authority (`evok.research-charter/v1`); the skills only reference
 * the id, so editing a global skill can never break evoK's parsing.
 *
 * Nothing here runs, dispatches or persists anything. Validation exists to refuse
 * weak or self-serving designs BEFORE a human sees them for approval, and every
 * issue names its field path so the proposing agent can revise instead of guess.
 *
 * The schema is closed. Unknown fields are rejected at every level, which is how
 * §6 is enforced structurally: ambition carries minimum/target/stretch bars only,
 * and no termination, convergence, stop or success field of any shape can enter
 * the charter at all. (The only schema-shaped answer to "should this stop?" stays
 * in the research program, #248 R5.)
 *
 * Authority boundary: a charter is an original human-authorized input, not a
 * projection. `no_go_recommended` is a completed scoping verdict, not an error.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";

export const RESEARCH_CHARTER_SCHEMA = "evok.research-charter/v1";

/** Strict ISO-8601 UTC timestamp; `Date.parse` alone accepts non-ISO text. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The four PRD §4 categories. Counts are guidance, never quotas. */
export const BASELINE_CATEGORIES = ["simple", "strongest_comparable", "method_specific", "internal_ablations"] as const;
export type BaselineCategory = (typeof BASELINE_CATEGORIES)[number];

export type ReproductionStatus = "reproduced" | "reported_only";

/** A literature claim with the reference it came from; an inferred gap is not a gap. */
export interface CharterSource {
  readonly ref: string;
  readonly claim: string;
  readonly title?: string;
  readonly retrievedAt?: string;
}

export interface CharterObjective {
  readonly question: string;
  /** What the question does and does not cover. */
  readonly boundaries: readonly string[];
}

/**
 * Ambition is a rigour requirement, never a success criterion (PRD §6): it sets
 * how strong the baselines must be, and it appears in no termination or
 * convergence field — the closed schema has none.
 */
export interface CharterAmbition {
  readonly minimum: string;
  readonly target: string;
  readonly stretch: string;
  readonly rigourRequirement: string;
}

export interface CharterResearchGap {
  readonly statement: string;
  readonly solved: readonly string[];
  readonly sources: readonly CharterSource[];
}

export interface CharterBaseline {
  readonly baselineId: string;
  readonly paper: string;
  readonly year: number;
  readonly taskDefinition: string;
  readonly conditioning: string;
  readonly dataset: { readonly name: string; readonly split: string };
  readonly metrics: readonly string[];
  readonly codeAvailable: boolean;
  readonly dataAvailable: boolean;
  readonly reproduction: {
    readonly status: ReproductionStatus;
    /** Required for `reported_only`: what exactly could not be reproduced. */
    readonly limitation?: string;
  };
  readonly comparabilityLimits: string;
  readonly selectionRationale: string;
}

export interface BaselineCategorySlot {
  readonly entries: readonly CharterBaseline[];
  /** Required when `entries` is empty: why the category could not be filled. */
  readonly emptyReason?: string;
}

export interface BaselinePortfolio {
  readonly categories: Readonly<Record<BaselineCategory, BaselineCategorySlot>>;
  /**
   * PRD §4 rule 3: never silently downgrade. When any entry is `reported_only`,
   * this names the separate baseline that was actually reproduced, so the
   * strongest known method stays visible beside a runnable comparator.
   */
  readonly reproducedBaselineId?: string;
}

export interface CharterEvaluationProtocol {
  /** New protocol version on every later change (PRD §5); prior results are never re-scored. */
  readonly protocolVersion: string;
  readonly dataset: { readonly name: string; readonly split: string };
  readonly trainTestIsolation: string;
  readonly metrics: readonly { readonly name: string; readonly direction: "higher_is_better" | "lower_is_better" }[];
  readonly generationBudget: { readonly candidates: number; readonly units: string };
  readonly seedStrategy: { readonly seeds: readonly number[] };
  readonly statisticalComparison: { readonly test: string; readonly alpha: number };
  readonly independentValidation: {
    /** Mandatory literal: independence is not negotiable after the results. */
    readonly required: true;
    /** At least one `independent` evaluator; the method's own reward model may never be the sole judge. */
    readonly evaluators: readonly {
      readonly id: string;
      readonly kind: "independent" | "method_own_reward_model";
    }[];
  };
  readonly reproducibilityArtifacts: readonly string[];
}

export interface CharterConstraints {
  readonly compute: string;
  readonly data: string;
  readonly permissions: readonly string[];
  readonly externalAccess: readonly string[];
}

/**
 * PRD §7: `no_go_recommended` is a successful scoping outcome, not an error, and
 * it carries evidence. Nothing is authorized by either verdict here.
 */
export interface CharterVerdict {
  readonly recommendation: "go" | "no_go_recommended";
  readonly rationale: string;
  readonly evidence: readonly CharterSource[];
}

export interface ResearchCharterInput {
  readonly schema: typeof RESEARCH_CHARTER_SCHEMA;
  readonly charterId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly objective: CharterObjective;
  readonly ambition: CharterAmbition;
  readonly researchGap: CharterResearchGap;
  readonly baselinePortfolio: BaselinePortfolio;
  readonly evaluation: CharterEvaluationProtocol;
  readonly constraints: CharterConstraints;
  readonly verdict: CharterVerdict;
}

export interface ResearchCharter extends ResearchCharterInput {
  /** sha256 over the canonical charter content, excluding this field. */
  readonly digest: string;
}

/** One revision-ready validation issue: a field path, a stable code, a directive message. */
export interface CharterIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type CharterValidation =
  | { readonly ok: true; readonly charter: ResearchCharter }
  | { readonly ok: false; readonly issues: readonly CharterIssue[] };

/** Thrown by `assertResearchCharter`; carries every issue, not just the first. */
export class ResearchCharterValidationError extends Error {
  readonly issues: readonly CharterIssue[];
  constructor(issues: readonly CharterIssue[]) {
    super(`research charter rejected (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ResearchCharterValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Issues {
  readonly list: CharterIssue[] = [];
  add(path: string, code: string, message: string): void {
    this.list.push({ path, code, message: `${path} ${message}` });
  }
}

/** Root-relative field path; the charter itself has no path prefix. */
function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Closed-object check: reports a non-object and every key the schema does not define. */
function object(value: unknown, path: string, allowed: readonly string[], issues: Issues): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.add(path === "" ? "charter" : path, "invalid_type", `must be a JSON object, got ${describe(value)}`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add(joinPath(path, key), "unknown_field", `is not part of ${RESEARCH_CHARTER_SCHEMA}; remove it (the schema is closed and has no termination, convergence or stop field)`);
    }
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value === "string" ? JSON.stringify(value) : `${typeof value} ${JSON.stringify(value)}`;
}

function optionalText(record: Record<string, unknown>, key: string, path: string, issues: Issues, hint: string): void {
  if (record[key] === undefined) return;
  text(record, key, path, issues, hint);
}

function text(record: Record<string, unknown>, key: string, path: string, issues: Issues, hint: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    issues.add(path, "required", `is required: ${hint}`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(path, "invalid_type", `must be a non-empty string, got ${describe(value)}${hint === "" ? "" : ` — ${hint}`}`);
    return undefined;
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string, path: string, issues: Issues, hint: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    issues.add(path, "required", `is required: ${hint}`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.add(path, "invalid_type", `must be an integer, got ${describe(value)} — ${hint}`);
    return undefined;
  }
  return value;
}

function boolean(record: Record<string, unknown>, key: string, path: string, issues: Issues, hint: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    issues.add(path, "required", `is required: ${hint}`);
    return undefined;
  }
  if (typeof value !== "boolean") {
    issues.add(path, "invalid_type", `must be true or false, got ${describe(value)} — ${hint}`);
    return undefined;
  }
  return value;
}

const SOURCE_KEYS = ["ref", "claim", "title", "retrievedAt"] as const;

function sources(value: unknown, path: string, issues: Issues, hint: string): readonly CharterSource[] | undefined {
  const entries = arrayValue(value, path, issues, hint);
  if (!entries) return undefined;
  if (entries.length === 0) {
    issues.add(path, "empty_list", `must not be empty: ${hint}`);
    return undefined;
  }
  return entries.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = object(entry, entryPath, SOURCE_KEYS, issues) ?? {};
    text(record, "ref", `${entryPath}.ref`, issues, "the reference (DOI, arXiv id, URL) this claim comes from");
    text(record, "claim", `${entryPath}.claim`, issues, "the specific claim the source makes");
    optionalText(record, "title", `${entryPath}.title`, issues, "the source title");
    optionalText(record, "retrievedAt", `${entryPath}.retrievedAt`, issues, "when the source was read");
    return record as unknown as CharterSource;
  });
}

function arrayValue(value: unknown, path: string, issues: Issues, hint: string): readonly unknown[] | undefined {
  if (value === undefined) {
    issues.add(path, "required", `is required: ${hint}`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.add(path, "invalid_type", `must be an array, got ${describe(value)} — ${hint}`);
    return undefined;
  }
  return value;
}

function metricList(value: unknown, path: string, issues: Issues, hint: string): void {
  const entries = arrayValue(value, path, issues, hint);
  if (!entries) return;
  if (entries.length === 0) {
    issues.add(path, "empty_list", `must not be empty: ${hint}`);
    return;
  }
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = object(entry, entryPath, ["name", "direction"], issues) ?? {};
    text(record, "name", `${entryPath}.name`, issues, "the metric name as the protocol defines it");
    const direction = record.direction;
    if (direction !== "higher_is_better" && direction !== "lower_is_better") {
      issues.add(`${entryPath}.direction`, direction === undefined ? "required" : "invalid_value", `must be "higher_is_better" or "lower_is_better", got ${describe(direction)}`);
    }
  });
}

function dataset(value: unknown, path: string, issues: Issues): void {
  const record = object(value, path, ["name", "split"], issues) ?? {};
  text(record, "name", `${path}.name`, issues, "the dataset the protocol evaluates on");
  text(record, "split", `${path}.split`, issues, "the exact split, including how test rows are kept out of train");
}

const BASELINE_KEYS = [
  "baselineId", "paper", "year", "taskDefinition", "conditioning", "dataset", "metrics",
  "codeAvailable", "dataAvailable", "reproduction", "comparabilityLimits", "selectionRationale",
] as const;

function baselineList(value: unknown, path: string, issues: Issues): readonly Record<string, unknown>[] | undefined {
  const entries = arrayValue(value, path, issues, "baseline entries for this category");
  if (!entries) return undefined;
  return entries.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = object(entry, entryPath, BASELINE_KEYS, issues) ?? {};
    text(record, "baselineId", `${entryPath}.baselineId`, issues, "a stable id used by portfolio.reproducedBaselineId");
    text(record, "paper", `${entryPath}.paper`, issues, "paper title of the baseline");
    const year = integer(record, "year", `${entryPath}.year`, issues, "publication year of the baseline paper");
    if (year !== undefined && (year < 1900 || year > new Date().getUTCFullYear() + 1)) {
      issues.add(`${entryPath}.year`, "invalid_value", `must be a plausible publication year, got ${year}`);
    }
    text(record, "taskDefinition", `${entryPath}.taskDefinition`, issues, "the task this baseline solves; comparability beats recency");
    text(record, "conditioning", `${entryPath}.conditioning`, issues, "the conditioning the baseline uses; an unconditional method is not comparable to a conditional task");
    dataset(record.dataset, `${entryPath}.dataset`, issues);
    stringItems(record.metrics, `${entryPath}.metrics`, issues, "the metrics this baseline reports", { nonEmpty: true });
    boolean(record, "codeAvailable", `${entryPath}.codeAvailable`, issues, "whether baseline code is available");
    boolean(record, "dataAvailable", `${entryPath}.dataAvailable`, issues, "whether the baseline's data or split is available");
    reproduction(record.reproduction, `${entryPath}.reproduction`, issues);
    text(record, "comparabilityLimits", `${entryPath}.comparabilityLimits`, issues, "what makes a direct comparison unsafe (split, budget, conditioning)");
    text(record, "selectionRationale", `${entryPath}.selectionRationale`, issues, "why this baseline and not another");
    return record;
  });
}

function reproduction(value: unknown, path: string, issues: Issues): void {
  const record = object(value, path, ["status", "limitation"], issues) ?? {};
  const status = record.status;
  if (status !== "reproduced" && status !== "reported_only") {
    issues.add(`${path}.status`, status === undefined ? "required" : "invalid_value", `must be "reproduced" or "reported_only", got ${describe(status)}`);
  }
  const limitation = record.limitation;
  if (status === "reported_only") {
    if (limitation === undefined) {
      issues.add(`${path}.limitation`, "required", `is required when status is "reported_only": document what could not be reproduced (missing code, data, compute, incompatible protocol) rather than dropping the method`);
    } else if (typeof limitation !== "string" || limitation.trim() === "") {
      issues.add(`${path}.limitation`, "invalid_type", `must be a non-empty string when status is "reported_only", got ${describe(limitation)}`);
    }
  } else if (limitation !== undefined && typeof limitation !== "string") {
    issues.add(`${path}.limitation`, "invalid_type", `must be a string when present, got ${describe(limitation)}`);
  }
}

function portfolio(value: unknown, path: string, issues: Issues): void {
  const record = object(value, path, ["categories", "reproducedBaselineId"], issues);
  if (!record) return;

  const categoriesValue = record.categories;
  const categoriesPath = `${path}.categories`;
  let categories: Record<string, unknown> | undefined;
  if (categoriesValue === undefined) {
    issues.add(categoriesPath, "required", `is required: all four categories (${BASELINE_CATEGORIES.join(", ")}); an empty category needs an explicit reason, never silent omission`);
  } else {
    categories = object(categoriesValue, categoriesPath, BASELINE_CATEGORIES, issues);
  }

  const entries: { readonly baselineId: string; readonly status: ReproductionStatus; readonly category: BaselineCategory }[] = [];
  for (const category of BASELINE_CATEGORIES) {
    const slotPath = `${categoriesPath}.${category}`;
    if (!categories) break;
    if (categories[category] === undefined) {
      issues.add(slotPath, "required", `is required: an empty category needs an explicit reason in ${slotPath} instead of being omitted`);
      continue;
    }
    const slot = object(categories[category], slotPath, ["entries", "emptyReason"], issues) ?? {};
    const categoryEntries = baselineList(slot.entries, `${slotPath}.entries`, issues) ?? [];
    if (categoryEntries.length === 0) {
      const reason = slot.emptyReason;
      if (reason === undefined) {
        issues.add(`${slotPath}.emptyReason`, "required", `is required because entries is empty: say why this category cannot be filled instead of silently omitting it`);
      } else if (typeof reason !== "string" || reason.trim() === "") {
        issues.add(`${slotPath}.emptyReason`, "invalid_type", `must be a non-empty reason when entries is empty, got ${describe(reason)}`);
      }
    }
    for (const entry of categoryEntries) {
      const baselineId = entry.baselineId;
      const status = isRecord(entry.reproduction) ? entry.reproduction.status : undefined;
      if (typeof baselineId === "string" && (status === "reproduced" || status === "reported_only")) {
        entries.push({ baselineId, status, category });
      }
    }
  }

  if (entries.length === 0 && categories) {
    issues.add(categoriesPath, "empty_portfolio", `has no baseline entry at all: a study must beat something — name the comparator set, or recommend no_go_recommended with evidence`);
  }

  const duplicated = entries.map((entry) => entry.baselineId).filter((id, index, all) => all.indexOf(id) !== index);
  for (const id of new Set(duplicated)) {
    issues.add(`${categoriesPath}`, "duplicate_baseline_id", `has the baselineId ${JSON.stringify(id)} twice; ids must be unique across all categories because portfolio.reproducedBaselineId refers to them`);
  }

  const reproducedBaselineId = record.reproducedBaselineId;
  if (reproducedBaselineId !== undefined && typeof reproducedBaselineId !== "string") {
    issues.add(`${path}.reproducedBaselineId`, "invalid_type", `must be a baselineId string, got ${describe(reproducedBaselineId)}`);
  }
  const reportedOnly = entries.filter((entry) => entry.status === "reported_only");
  if (reportedOnly.length > 0) {
    if (reproducedBaselineId === undefined) {
      issues.add(`${path}.reproducedBaselineId`, "required", `is required because ${reportedOnly.map((entry) => JSON.stringify(entry.baselineId)).join(", ")} is reported_only: keep the strongest unreproducible method as reported_only with its limitation AND name a separate reproduced baseline — dropping it without that pair is a silent downgrade`);
    } else if (typeof reproducedBaselineId === "string") {
      const match = entries.find((entry) => entry.baselineId === reproducedBaselineId);
      if (!match) {
        issues.add(`${path}.reproducedBaselineId`, "invalid_value", `refers to ${JSON.stringify(reproducedBaselineId)}, which is not a baselineId in the portfolio; name an existing entry`);
      } else if (match.status !== "reproduced") {
        issues.add(`${path}.reproducedBaselineId`, "invalid_value", `refers to ${JSON.stringify(reproducedBaselineId)}, whose status is ${JSON.stringify(match.status)}; the separate baseline must be an actually reproduced entry`);
      } else if (match.category !== "strongest_comparable") {
        issues.add(`${path}.reproducedBaselineId`, "invalid_value", `refers to ${JSON.stringify(reproducedBaselineId)}, which sits in ${JSON.stringify(match.category)}; the separate reproduced baseline must be the strongest reproduced comparable method in "strongest_comparable" — substituting an easy baseline for the reported_only strongest method is the silent downgrade this rule exists to reject`);
      }
    }
  }
}

function evaluation(value: unknown, path: string, issues: Issues): void {
  const record = object(value, path, [
    "protocolVersion", "dataset", "trainTestIsolation", "metrics", "generationBudget",
    "seedStrategy", "statisticalComparison", "independentValidation", "reproducibilityArtifacts",
  ], issues);
  if (!record) return;

  text(record, "protocolVersion", `${path}.protocolVersion`, issues, "the frozen protocol version, e.g. p1; a later change is a new version with a recorded reason");
  dataset(record.dataset, `${path}.dataset`, issues);
  text(record, "trainTestIsolation", `${path}.trainTestIsolation`, issues, "how train and test are kept isolated");
  metricList(record.metrics, `${path}.metrics`, issues, "the metric set; no single-metric judgement");

  const budgetPath = `${path}.generationBudget`;
  const budget = object(record.generationBudget, budgetPath, ["candidates", "units"], issues) ?? {};
  const candidates = integer(budget, "candidates", `${budgetPath}.candidates`, issues, "how many candidates one evaluation may generate");
  if (candidates !== undefined && candidates <= 0) {
    issues.add(`${budgetPath}.candidates`, "invalid_value", `must be a positive number, got ${candidates}`);
  }
  text(budget, "units", `${budgetPath}.units`, issues, 'the budget unit, e.g. "molecules" or "tokens"');

  const seedsPath = `${path}.seedStrategy`;
  const seeds = object(record.seedStrategy, seedsPath, ["seeds"], issues) ?? {};
  const seedValues = arrayValue(seeds.seeds, `${seedsPath}.seeds`, issues, "the fixed seed list the protocol runs");
  if (seedValues) {
    if (seedValues.length === 0) issues.add(`${seedsPath}.seeds`, "empty_list", `must not be empty: the protocol needs a declared seed strategy`);
    seedValues.forEach((seed, index) => {
      if (typeof seed !== "number" || !Number.isInteger(seed)) {
        issues.add(`${seedsPath}.seeds[${index}]`, "invalid_type", `must be an integer seed, got ${describe(seed)}`);
      }
    });
  }

  const statsPath = `${path}.statisticalComparison`;
  const stats = object(record.statisticalComparison, statsPath, ["test", "alpha"], issues) ?? {};
  text(stats, "test", `${statsPath}.test`, issues, "the statistical comparison the protocol commits to");
  const alpha = stats.alpha;
  if (alpha === undefined) {
    issues.add(`${statsPath}.alpha`, "required", "is required: the significance level the comparison uses");
  } else if (typeof alpha !== "number" || !(alpha > 0 && alpha < 1)) {
    issues.add(`${statsPath}.alpha`, "invalid_value", `must be a number between 0 and 1 (exclusive), got ${describe(alpha)}`);
  }

  const independencePath = `${path}.independentValidation`;
  const independence = object(record.independentValidation, independencePath, ["required", "evaluators"], issues) ?? {};
  if (independence.required !== true) {
    issues.add(`${independencePath}.required`, independence.required === undefined ? "required" : "invalid_value", `must be the literal true: independent evaluation is mandatory in the charter, not added after the results look good`);
  }
  const evaluatorsPath = `${independencePath}.evaluators`;
  const evaluators = arrayValue(independence.evaluators, evaluatorsPath, issues, "the evaluators that judge the results");
  if (evaluators) {
    let independent = 0;
    evaluators.forEach((entry, index) => {
      const entryPath = `${evaluatorsPath}[${index}]`;
      const evaluator = object(entry, entryPath, ["id", "kind"], issues) ?? {};
      text(evaluator, "id", `${entryPath}.id`, issues, "the evaluator id (a separate evaluator, not the method's own reward model)");
      const kind = evaluator.kind;
      if (kind === "independent") independent += 1;
      else if (kind !== "method_own_reward_model") {
        issues.add(`${entryPath}.kind`, kind === undefined ? "required" : "invalid_value", `must be "independent" or "method_own_reward_model", got ${describe(kind)}`);
      }
    });
    if (evaluators.length === 0) {
      issues.add(evaluatorsPath, "independent_evaluation_required", `is empty: independent evaluation is mandatory, so name at least one "independent" evaluator; an empty list leaves the method's own reward model as the only possible judge`);
    } else if (independent === 0) {
      issues.add(evaluatorsPath, "independent_evaluation_required", `has no "independent" evaluator: a protocol judged solely by the method's own reward model is rejected — add an independent evaluator (docking oracle, held-out scorer, human review)`);
    }
  }

  stringItems(record.reproducibilityArtifacts, `${path}.reproducibilityArtifacts`, issues, "the artifacts a later reader needs to reproduce the run", { nonEmpty: true });
}

function stringItems(value: unknown, path: string, issues: Issues, hint: string, options: { readonly nonEmpty?: boolean } = {}): void {
  const entries = arrayValue(value, path, issues, hint);
  if (!entries) return;
  if (options.nonEmpty && entries.length === 0) {
    issues.add(path, "empty_list", `must not be empty: ${hint}`);
    return;
  }
  entries.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.add(`${path}[${index}]`, "invalid_type", `must be a non-empty string, got ${describe(entry)}`);
    }
  });
}

/**
 * Validate and normalize a charter proposal. Returns every issue with its field
 * path instead of throwing, so a proposing agent can revise in one pass; the ok
 * branch is deep-frozen and carries the content digest.
 */
export function validateResearchCharter(input: unknown): CharterValidation {
  const issues = new Issues();
  const record = object(input, "", [
    "schema", "charterId", "version", "createdAt", "objective", "ambition", "researchGap",
    "baselinePortfolio", "evaluation", "constraints", "verdict",
  ], issues);

  if (!record) return { ok: false, issues: issues.list };
  if (record.schema !== RESEARCH_CHARTER_SCHEMA) {
    issues.add("schema", record.schema === undefined ? "required" : "invalid_value", `must be "${RESEARCH_CHARTER_SCHEMA}", got ${describe(record.schema)}; a breaking change needs a new schema version and a migration note`);
  }

  text(record, "charterId", "charterId", issues, "a stable id for this charter");
  const version = integer(record, "version", "version", issues, "the charter version; an approved charter changes only through a new version");
  if (version !== undefined && version < 1) {
    issues.add("version", "invalid_value", `must be at least 1, got ${version}`);
  }
  const createdAt = text(record, "createdAt", "createdAt", issues, "an ISO-8601 timestamp");
  if (createdAt !== undefined && !ISO_TIMESTAMP.test(createdAt)) {
    issues.add("createdAt", "invalid_value", `must be an ISO-8601 UTC timestamp such as 2026-11-11T00:00:00.000Z, got ${JSON.stringify(createdAt)}`);
  }

  const objective = object(record.objective, "objective", ["question", "boundaries"], issues);
  if (objective) {
    text(objective, "question", "objective.question", issues, "the scientific question this study answers");
    stringItems(objective.boundaries, "objective.boundaries", issues, "what the question does and does not cover", { nonEmpty: true });
  }

  const ambition = object(record.ambition, "ambition", ["minimum", "target", "stretch", "rigourRequirement"], issues);
  if (ambition) {
    text(ambition, "minimum", "ambition.minimum", issues, "the minimum bar a result must clear to be reported");
    text(ambition, "target", "ambition.target", issues, "the target bar");
    text(ambition, "stretch", "ambition.stretch", issues, "the stretch bar");
    text(ambition, "rigourRequirement", "ambition.rigourRequirement", issues, "how ambition raises baseline strength and control strictness; ambition sets rigour, never success");
  }

  const gap = object(record.researchGap, "researchGap", ["statement", "solved", "sources"], issues);
  if (gap) {
    text(gap, "statement", "researchGap.statement", issues, "the open question, stated from literature rather than inferred");
    stringItems(gap.solved, "researchGap.solved", issues, "what the literature already solves", { nonEmpty: true });
    sources(gap.sources, "researchGap.sources", issues, "the sources the gap claim rests on");
  }

  portfolio(record.baselinePortfolio, "baselinePortfolio", issues);
  evaluation(record.evaluation, "evaluation", issues);

  const constraints = object(record.constraints, "constraints", ["compute", "data", "permissions", "externalAccess"], issues);
  if (constraints) {
    text(constraints, "compute", "constraints.compute", issues, "the compute envelope the study may use");
    text(constraints, "data", "constraints.data", issues, "which data may be used");
    stringItems(constraints.permissions, "constraints.permissions", issues, "the permissions the study relies on; declare an empty list rather than omitting it");
    stringItems(constraints.externalAccess, "constraints.externalAccess", issues, "the external access the study needs; declare an empty list rather than omitting it");
  }

  const verdict = object(record.verdict, "verdict", ["recommendation", "rationale", "evidence"], issues);
  if (verdict) {
    const recommendation = verdict.recommendation;
    if (recommendation !== "go" && recommendation !== "no_go_recommended") {
      issues.add("verdict.recommendation", recommendation === undefined ? "required" : "invalid_value", `must be "go" or "no_go_recommended", got ${describe(recommendation)}; no_go_recommended is a valid completed scoping verdict, not an error`);
    }
    text(verdict, "rationale", "verdict.rationale", issues, "why this recommendation follows from the evidence");
    sources(verdict.evidence, "verdict.evidence", issues, "the evidence behind the recommendation; no_go_recommended is only supported with evidence");
  }

  if (issues.list.length > 0) return { ok: false, issues: issues.list };

  const charter = { ...(structuredClone(record) as unknown as ResearchCharterInput) };
  return { ok: true, charter: deepFreeze({ ...charter, digest: charterDigest(charter) }) };
}

/** sha256 of the canonical charter content, excluding the digest field itself. */
export function charterDigest(charter: ResearchCharterInput | ResearchCharter): string {
  const { digest: _digest, ...content } = charter as ResearchCharter;
  return digestValue(content);
}

/** Strict entry point: returns the frozen charter or throws every issue at once. */
export function assertResearchCharter(input: unknown): ResearchCharter {
  const result = validateResearchCharter(input);
  if (!result.ok) throw new ResearchCharterValidationError(result.issues);
  return result.charter;
}
