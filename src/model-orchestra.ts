import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * ModelOrchestra — deterministic resolution of which tier's ModelConfig a
 * RoleSession uses. It only picks model tiers: it never schedules tasks,
 * spends budget, or changes the mission objective (spec #27, epic #21).
 *
 * Flash-first binding: model_mix (flash_only / flash_primary /
 * flash_deep_mix), role_class defaults, named deep_gates, and forced_tier
 * overrides gated by Policy Guard + budget.
 *
 * Model/provider definitions live exclusively in Pi's model catalog
 * (`~/.pi/agent/models.json`, managed via Pi `/model`/`/login` flows).
 * The orchestra config binds tiers to model ids that already exist there;
 * evoK never duplicates provider API configuration.
 */

export const TIER_IDS = ["fast", "deep", "mid"] as const;
export type TierId = (typeof TIER_IDS)[number];

/** The resolved model a RoleSession runs on. A reference to a registered Pi model, not a copy of its provider config. */
export interface ModelConfig {
  readonly provider: string;
  readonly model: string;
  /** Canonical `${provider}/${model}` reference into the Pi catalog. */
  readonly id: string;
}

/** Read-only view of Pi's model catalog. Fakeable in tests without real model calls. */
export interface ModelCatalog {
  /**
   * Resolve a model reference (`provider/model` or a bare model id) to a registered model.
   * Returns undefined when no model matches; throws when a bare id is ambiguous across providers.
   */
  findModel(ref: string): ModelConfig | undefined;
  /** Pi's current/default model (settings.json defaultModel), or undefined when Pi has none. */
  defaultModel(): ModelConfig | undefined;
}

/**
 * Tier bindings live here (embedded in evoK RunPolicy). `mid` is reserved in
 * the schema; automatic routing never picks it in v0.
 */
export interface OrchestraConfig {
  readonly fast?: string;
  readonly deep?: string;
  readonly mid?: string;
}

/** Pattern-level Flash-first mixes (spec #27 decision 5). */
export const MODEL_MIX_VALUES = ["flash_only", "flash_primary", "flash_deep_mix"] as const;
export type ModelMix = (typeof MODEL_MIX_VALUES)[number];

/** model_mix_default (spec #27 decision 5). */
export const DEFAULT_MODEL_MIX: ModelMix = "flash_primary";

/**
 * Role classes used as soft fallbacks under flash_primary / flash_deep_mix.
 * Workers and Explorers are execution; Mission Director / Team Coordinator are
 * orchestration; Falsifier-style roles are adversarial.
 */
export const ROLE_CLASS_VALUES = ["execution", "orchestration", "adversarial"] as const;
export type RoleClass = (typeof ROLE_CLASS_VALUES)[number];

export const DEFAULT_ROLE_CLASS: RoleClass = "execution";

/**
 * The harness gate catalog: named gates a pattern may declare as deep gates.
 * Only registered gates can open deep routing; unknown gates fail validation
 * (spec #27 decision 6).
 */
export const GATE_CATALOG: Readonly<Record<string, string>> = Object.freeze({
  strategy_synthesis: "pattern stage that proposes the task strategy",
  join_reduce: "fan-in stage that joins or reduces branch outputs",
  success_audit: "checks each part of a success claim against required evidence",
  cross_model_check: "requires fast and deep agreement before promotion",
});

/** Pattern-level model routing declaration (model_mix lives on the pattern, not inside role prose). */
export interface PatternModelPolicy {
  /** Defaults to flash_primary. */
  readonly modelMix?: ModelMix;
  /** Named deep gates; every entry must be registered in GATE_CATALOG. */
  readonly deepGates?: readonly string[];
}

/** Budget state computed by the budget owner; the orchestra only enforces the deep allowance. */
export interface BudgetState {
  readonly remainingAttempts: number;
  readonly remainingUnits: number;
  /** Budget policy verdict: whether a deep escalation is affordable right now. */
  readonly allowDeep: boolean;
}

export interface OrchestraResolveContext {
  readonly pattern?: PatternModelPolicy;
  /** Defaults to execution. */
  readonly roleClass?: RoleClass;
  /** The harness gate currently executing (only registered deep gates elevate). */
  readonly gate?: string;
  readonly budget?: BudgetState;
  /** Operator override; honored only when Policy Guard + budget allow. */
  readonly forcedTier?: TierId;
}

/**
 * Why a tier was chosen. mix = model_mix policy forced it; role = role_class
 * default; gate = named deep gate; forced = accepted forced_tier;
 * budget = budget pressure downgraded an automatic deep selection to fast.
 */
export type OrchestraResolutionReason = "unconfigured" | "mix" | "role" | "gate" | "forced" | "budget";

export interface OrchestraResolution {
  readonly tier: TierId | "default";
  readonly model: ModelConfig;
  readonly reason: OrchestraResolutionReason;
}

export class OrchestraValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestraValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTierId(value: unknown): TierId {
  return normalizeUnion(value, TIER_IDS, "tier id");
}

function normalizeMix(value: unknown): ModelMix {
  return normalizeUnion(value, MODEL_MIX_VALUES, "model_mix", DEFAULT_MODEL_MIX);
}

function normalizeRoleClass(value: unknown): RoleClass {
  return normalizeUnion(value, ROLE_CLASS_VALUES, "role_class", DEFAULT_ROLE_CLASS);
}

function normalizeUnion<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new OrchestraValidationError(`a ${label} is required`);
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new OrchestraValidationError(`unknown ${label} "${String(value)}" (allowed: ${allowed.join(", ")})`);
  }
  return value as T;
}

function normalizeDeepGates(value: unknown): ReadonlySet<string> {
  const deep = new Set<string>();
  if (value !== undefined && !Array.isArray(value)) {
    throw new OrchestraValidationError("pattern deep_gates must be an array of gate names");
  }
  for (const gate of (value as readonly unknown[] | undefined) ?? []) {
    if (typeof gate !== "string" || gate.trim() === "") {
      throw new OrchestraValidationError("pattern deep_gates must be non-empty strings");
    }
    if (!Object.prototype.hasOwnProperty.call(GATE_CATALOG, gate)) {
      throw new OrchestraValidationError(
        `unknown deep gate "${gate}" is not registered in the harness gate catalog (registered: ${Object.keys(GATE_CATALOG).join(", ")})`,
      );
    }
    deep.add(gate);
  }
  return deep;
}

function normalizePattern(value: unknown): { mix: ModelMix; deepGates: ReadonlySet<string> } {
  if (value === undefined) return { mix: DEFAULT_MODEL_MIX, deepGates: new Set() };
  if (!isRecord(value)) throw new OrchestraValidationError("pattern must be an object");
  return { mix: normalizeMix(value.modelMix), deepGates: normalizeDeepGates(value.deepGates) };
}

function normalizeBudget(value: unknown): BudgetState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new OrchestraValidationError("budget must be an object");
  if (!Number.isInteger(value.remainingAttempts) || (value.remainingAttempts as number) < 0) {
    throw new OrchestraValidationError("budget remainingAttempts must be an integer >= 0");
  }
  if (!Number.isInteger(value.remainingUnits) || (value.remainingUnits as number) < 0) {
    throw new OrchestraValidationError("budget remainingUnits must be an integer >= 0");
  }
  if (typeof value.allowDeep !== "boolean") {
    throw new OrchestraValidationError("budget allowDeep must be a boolean");
  }
  return { remainingAttempts: value.remainingAttempts as number, remainingUnits: value.remainingUnits as number, allowDeep: value.allowDeep };
}

function isConfiguredConfig(config: unknown): config is Record<TierId, unknown> {
  if (config === undefined || config === null) return false;
  if (!isRecord(config)) throw new OrchestraValidationError("orchestra config must be an object");
  const hasTiers = Object.keys(config).length > 0;
  if (hasTiers) {
    for (const key of Object.keys(config)) {
      if (!(TIER_IDS as readonly string[]).includes(key)) {
        throw new OrchestraValidationError(`unknown tier id "${key}" in orchestra config (allowed: ${TIER_IDS.join(", ")})`);
      }
      const ref = config[key];
      if (typeof ref !== "string" || ref.trim() === "") {
        throw new OrchestraValidationError(`tier "${key}" must reference a model id string`);
      }
    }
  }
  return hasTiers;
}

/**
 * Validates the config against the catalog at construction time so invalid
 * configs fail closed before a mission starts.
 */
export class ModelOrchestra {
  private readonly configured: boolean;
  private readonly bindings: ReadonlyMap<TierId, string>;
  private readonly catalog: ModelCatalog;

  constructor(catalog: ModelCatalog, config?: OrchestraConfig | null) {
    this.catalog = catalog;
    if (!isConfiguredConfig(config)) {
      this.configured = false;
      this.bindings = new Map();
      return;
    }
    const bindings = new Map<TierId, string>();
    for (const tier of TIER_IDS) {
      const ref = config[tier];
      if (ref === undefined) continue;
      if (!this.catalog.findModel(ref)) {
        throw new OrchestraValidationError(`tier "${tier}" references model "${ref}" which is not registered in Pi's model catalog (~/.pi/agent/models.json)`);
      }
      bindings.set(tier, ref);
    }
    this.configured = true;
    this.bindings = bindings;
  }

  /**
   * Unconfigured (orchestra omitted/null/empty): the single default model for
   * every RoleSession, reason=unconfigured, whatever the context.
   *
   * Configured: deterministic Flash-first binding — forced_tier (gated by
   * Policy Guard + budget) > named deep gate > mix/role-class defaults >
   * budget downgrade. Fails closed on invalid inputs, unknown gates, and
   * unbound tiers.
   */
  resolve(ctx: OrchestraResolveContext = {}): OrchestraResolution {
    const pattern = normalizePattern(ctx.pattern);
    const roleClass = normalizeRoleClass(ctx.roleClass);
    const budget = normalizeBudget(ctx.budget);
    if (!this.configured) {
      // Unconfigured ≡ one default model for every session; the context is still
      // validated so a misconfigured pattern (e.g. unknown deep gate) fails
      // closed instead of silently running on the default model.
      const model = this.catalog.defaultModel();
      if (!model) throw new OrchestraValidationError("no default model available in the Pi model catalog and no orchestra config binds a tier");
      return { tier: "default", model: { ...model }, reason: "unconfigured" };
    }

    if (ctx.forcedTier !== undefined) {
      const forced = normalizeTierId(ctx.forcedTier);
      // Policy Guard: mix feasibility — an override cannot bypass the pattern's tier policy.
      if (pattern.mix === "flash_only" && forced !== "fast") {
        throw new OrchestraValidationError(`forced tier "${forced}" is rejected: model_mix "${pattern.mix}" resolves fast only`);
      }
      // Policy Guard + budget: no silent deep spend on an operator override.
      if (forced === "deep" && budget !== undefined && !budget.allowDeep) {
        throw new OrchestraValidationError('forced tier "deep" is rejected: budget does not allow deep escalation');
      }
      return this.boundTier(forced, "forced");
    }

    // flash_only is authoritative: it always resolves fast, whatever the role or gate.
    if (pattern.mix === "flash_only") {
      return this.boundTier("fast", "mix");
    }

    // A named deep gate opens deep routing for any role class.
    if (ctx.gate !== undefined && pattern.deepGates.has(ctx.gate)) {
      return this.boundOrBudget("deep", "gate", budget);
    }

    // Role-class defaults are soft fallbacks under flash_primary / flash_deep_mix.
    const tier: TierId = pattern.mix === "flash_deep_mix" && roleClass === "orchestration" ? "deep" : "fast";
    return this.boundOrBudget(tier, "role", budget);
  }

  private boundTier(tier: TierId, reason: OrchestraResolutionReason): OrchestraResolution {
    const ref = this.bindings.get(tier);
    if (ref === undefined) {
      throw new OrchestraValidationError(`tier "${tier}" is not bound in the orchestra config`);
    }
    const model = this.catalog.findModel(ref);
    if (!model) {
      throw new OrchestraValidationError(`tier "${tier}" references model "${ref}" which is not registered in Pi's model catalog`);
    }
    return { tier, model: { ...model }, reason };
  }

  private boundOrBudget(tier: TierId, reason: OrchestraResolutionReason, budget: BudgetState | undefined): OrchestraResolution {
    if (tier === "deep" && budget !== undefined && !budget.allowDeep) {
      return this.boundTier("fast", "budget");
    }
    return this.boundTier(tier, reason);
  }

  /**
   * Promotion-gate dual-tier bindings for a cross-model agreement check
   * (promotion_cross_model=both, spec #27 decision 7): the ModelConfigs a
   * harness requests for the two tiered evaluation attempts. Supplies
   * configs only — it never evaluates, agrees, or decides promotion.
   *
   * Returns undefined when the orchestra is unconfigured (no dual path
   * without tier bindings); throws OrchestraValidationError when a required
   * tier is unbound, so misconfig fails closed.
   */
  crossModelConfigs(): { fast: ModelConfig; deep: ModelConfig } | undefined {
    if (!this.configured) return undefined;
    const fast = this.boundTier("fast", "mix").model;
    const deep = this.boundTier("deep", "mix").model;
    if (fast.id === deep.id) {
      throw new OrchestraValidationError("cross-model tiers must bind different models: fast and deep resolve to the same model");
    }
    return { fast, deep };
  }
}

export interface PiModelCatalogOptions {
  /** Pi models.json path; defaults to Pi's own (~/.pi/agent/models.json). */
  readonly modelsPath?: string;
  /** Pi settings.json path used for defaultModel/defaultProvider; defaults to Pi's own (~/.pi/agent/settings.json). */
  readonly settingsPath?: string;
}

/** Reads Pi's settings.json for the default model (no provider config duplication). */
async function readDefaultModel(settingsPath: string | undefined): Promise<{ model: string; provider?: string } | undefined> {
  const path = settingsPath ?? joinPiAgentDir("settings.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.defaultModel !== "string" || parsed.defaultModel.trim() === "") return undefined;
    return { model: parsed.defaultModel, provider: typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined };
  } catch {
    return undefined; // missing/malformed settings: no default model, unconfigured resolve fails closed
  }
}

function joinPiAgentDir(name: string): string {
  const agentDir = process.env.PI_AGENT_DIR;
  if (agentDir) return join(agentDir, name);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".pi", "agent", name);
}

/** Build the ModelCatalog over Pi's model registry (models.json). */
export async function createPiModelCatalog(options: PiModelCatalogOptions = {}): Promise<ModelCatalog> {
  const runtime = await ModelRuntime.create({ modelsPath: options.modelsPath, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const models = registry.getAll();

  const byRef = new Map<string, ModelConfig>();
  const byBareId = new Map<string, ModelConfig[]>();
  for (const model of models) {
    const config: ModelConfig = { provider: model.provider, model: model.id, id: `${model.provider}/${model.id}` };
    byRef.set(config.id, config);
    const bare = byBareId.get(model.id) ?? [];
    bare.push(config);
    byBareId.set(model.id, bare);
  }

  const findModel = (ref: string): ModelConfig | undefined => {
    const direct = byRef.get(ref);
    if (direct) return { ...direct };
    const bare = byBareId.get(ref);
    if (!bare || bare.length === 0) return undefined;
    if (bare.length > 1) {
      throw new OrchestraValidationError(`model id "${ref}" is ambiguous across providers (${bare.map((m) => m.id).join(", ")}); use "provider/model"`);
    }
    return { ...bare[0] };
  };

  // The default model is Pi's current/default model (settings.json defaultModel).
  // If Pi has none, unconfigured resolve fails closed instead of guessing a model.
  let defaultConfig: ModelConfig | undefined;
  const settingsDefault = await readDefaultModel(options.settingsPath);
  if (settingsDefault) {
    const ref = settingsDefault.provider ? `${settingsDefault.provider}/${settingsDefault.model}` : settingsDefault.model;
    try {
      defaultConfig = findModel(ref);
    } catch {
      // ambiguous bare default id: leave unset, resolve will fail closed
    }
  }

  return {
    findModel,
    defaultModel: () => (defaultConfig ? { ...defaultConfig } : undefined),
  };
}
