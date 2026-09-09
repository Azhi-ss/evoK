/**
 * evoK model/auth seam (#109, T1).
 *
 * Resolves the actual Pi SDK `Model` for a Run tier and checks Pi-resolved
 * credentials *before* work is dispatched. Model definitions and auth come
 * exclusively from Pi's SDK-resolved stores (`models.json` / `auth.json` via
 * `ModelRuntime`): evoK never copies or displays credentials and never adds a
 * second provider login path. The same `ModelRuntime` is handed to the actual
 * `AgentSession`, so a reported tier is the model that really executes.
 *
 * Unconfigured orchestra => Pi's default model for every Run. Configured
 * orchestra => flash-first `ModelOrchestra` tier bindings; CLI tiers
 * (`fast`/`deep`/`mid`) are forced-tier resolutions, so an unbound tier fails
 * closed instead of silently falling back to another provider.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  ModelOrchestra,
  createPiModelCatalog,
  OrchestraValidationError,
  type ModelCatalog,
  type ModelConfig,
  type OrchestraConfig,
  type OrchestraResolutionReason,
  type TierId,
} from "./model-orchestra";

export type { ModelCatalog, ModelConfig, OrchestraConfig, OrchestraResolutionReason, TierId };

/** Auth preflight result. `error` is safe to display: it carries no credentials. */
export type ModelAuthPreflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** The resolved model for one Run: the SDK object plus the identity reported to operators. */
export interface ResolvedSessionModel {
  /** Canonical `${provider}/${model}` identity for display/ledger. */
  readonly model: ModelConfig;
  /** The actual SDK Model object passed to `createAgentSession`. */
  readonly modelId: Model<Api>;
  /** The SDK-resolved runtime (same instance reaches the actual session). */
  readonly modelRuntime: ModelRuntime;
  readonly tier: TierId | "default";
  readonly reason: OrchestraResolutionReason;
}

/**
 * Resolves one Run's model and verifies its credentials. Implementations must
 * not perform provider calls — preflight reads stored/resolved credentials so
 * missing/invalid configuration fails before work is dispatched.
 */
export interface SessionModelResolver {
  resolve(tier: string): Promise<ResolvedSessionModel>;
  preflight(model: ModelConfig): Promise<ModelAuthPreflight>;
}

export interface EvokModelResolverOptions {
  /** Reuse an existing SDK ModelRuntime (tests / faux providers). */
  readonly modelRuntime?: ModelRuntime;
  /** Reuse an existing read-only catalog (defaults to the Pi catalog over the runtime). */
  readonly catalog?: ModelCatalog;
  /** Tier bindings; omit/null/empty => Pi default model for every Run. */
  readonly orchestra?: OrchestraConfig | null;
  /** SDK runtime creation options (paths default to Pi's own stores). */
  readonly runtime?: CreateModelRuntimeOptions;
  /** Pi models.json path when not embedded in runtime options. */
  readonly modelsPath?: string;
  /** Settings.json path for Pi's default model; defaults to Pi's own. */
  readonly settingsPath?: string;
}

/** Pi's settings.json next to the SDK-resolved agent dir (models/auth live there too). */
function piSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

const TIER_SET: ReadonlySet<string> = new Set(["fast", "deep", "mid"]);

/** Raised when stored credentials for the resolved model are missing/invalid. */
export class MissingAuthenticationError extends Error {
  readonly kind = "missing-authentication" as const;
  constructor(message: string) {
    super(message);
    this.name = "MissingAuthenticationError";
  }
}

export async function createEvokModelResolver(options: EvokModelResolverOptions = {}): Promise<SessionModelResolver> {
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
    ...options.runtime,
    ...(options.modelsPath !== undefined ? { modelsPath: options.modelsPath } : {}),
    allowModelNetwork: false,
  });
  const catalog = options.catalog ?? await createPiModelCatalog({
    modelRuntime,
    modelsPath: options.modelsPath ?? options.runtime?.modelsPath ?? undefined,
    settingsPath: options.settingsPath ?? piSettingsPath(),
  });
  const registry = new ModelRegistry(modelRuntime);
  const orchestra = new ModelOrchestra(catalog, options.orchestra ?? null);

  function sdkModel(config: ModelConfig): Model<Api> {
    const model = modelRuntime.getModel(config.provider, config.model) ?? registry.find(config.provider, config.model);
    if (!model) {
      // The catalog validated the reference against the same runtime; this is
      // drift, not a guess opportunity: fail closed as configuration error.
      throw new OrchestraValidationError(
        `resolved model "${config.id}" is not available in the Pi SDK model runtime`,
      );
    }
    return model;
  }

  return {
    async resolve(tier: string): Promise<ResolvedSessionModel> {
      const forcedTier = TIER_SET.has(tier) ? (tier as TierId) : undefined;
      const resolution = forcedTier
        ? orchestra.resolve({ forcedTier })
        : orchestra.resolve();
      // An explicit tier request must actually route to a tier binding: with
      // no orchestra config the forced-tier call is silently served the
      // default model upstream. Fail closed instead of a silent downgrade.
      if (forcedTier && resolution.tier === "default") {
        throw new OrchestraValidationError(
          `tier "${forcedTier}" is not bound in the evok orchestra config; refusing to run it on the default model`,
        );
      }
      return {
        model: resolution.model,
        modelId: sdkModel(resolution.model),
        modelRuntime,
        tier: resolution.tier,
        reason: resolution.reason,
      };
    },

    async preflight(model: ModelConfig): Promise<ModelAuthPreflight> {
      const sdk = modelRuntime.getModel(model.provider, model.model);
      if (!sdk) {
        return { ok: false, error: `model "${model.id}" is not available in the Pi model catalog` };
      }
      // Snapshot providers with resolvable stored credentials (runs the same
      // provider auth checks as SDK availability). hasConfiguredAuth reads the
      // post-refresh snapshot; getApiKeyAndHeaders surfaces the explicit error.
      await modelRuntime.getAvailable(model.provider).catch(() => {});
      if (!modelRuntime.hasConfiguredAuth(model.provider)) {
        return {
          ok: false,
          error: `missing or invalid authentication for provider "${model.provider}" (model ${model.id}). Configure credentials with Pi (/login) — evoK does not store or copy keys.`,
        };
      }
      const auth = await registry.getApiKeyAndHeaders(sdk);
      if (!auth.ok) {
        return {
          ok: false,
          error: `missing or invalid authentication for provider "${model.provider}" (model ${model.id}): ${auth.error}. Configure credentials with Pi (/login) — evoK does not store or copy keys.`,
        };
      }
      return { ok: true };
    },
  };
}

export { OrchestraValidationError };
