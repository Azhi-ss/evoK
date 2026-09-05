import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * ModelOrchestra — deterministic resolution of which tier's ModelConfig a
 * RoleSession uses. It only picks model tiers: it never schedules tasks,
 * spends budget, or changes the mission objective (spec #27, epic #21).
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
 * the schema; v0 has no behavior that routes to it.
 */
export interface OrchestraConfig {
  readonly fast?: string;
  readonly deep?: string;
  readonly mid?: string;
}

export type OrchestraResolutionReason = "unconfigured" | "configured";

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
   * every RoleSession, reason=unconfigured. Configured: resolve the requested
   * tier, reason=configured. Fails closed on unknown or unbound tiers.
   */
  resolve(tier?: TierId): OrchestraResolution {
    if (!this.configured) {
      const model = this.catalog.defaultModel();
      if (!model) throw new OrchestraValidationError("no default model available in the Pi model catalog and no orchestra config binds a tier");
      return { tier: "default", model: { ...model }, reason: "unconfigured" };
    }
    if (tier === undefined) {
      throw new OrchestraValidationError("a tier is required when the orchestra is configured");
    }
    if (!(TIER_IDS as readonly string[]).includes(tier)) {
      throw new OrchestraValidationError(`unknown tier id "${String(tier)}"`);
    }
    const ref = this.bindings.get(tier);
    if (ref === undefined) {
      throw new OrchestraValidationError(`tier "${tier}" is not bound in the orchestra config`);
    }
    const model = this.catalog.findModel(ref);
    if (!model) {
      throw new OrchestraValidationError(`tier "${tier}" references model "${ref}" which is not registered in Pi's model catalog`);
    }
    return { tier, model: { ...model }, reason: "configured" };
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
