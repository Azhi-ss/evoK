import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ModelOrchestra,
  OrchestraValidationError,
  ROLE_CLASS_VALUES,
  createPiModelCatalog,
  type BudgetState,
  type ModelCatalog,
  type ModelConfig,
  type OrchestraConfig,
  type OrchestraResolveContext,
  type RoleClass,
  type TierId,
} from "./model-orchestra";

const FLASH: ModelConfig = Object.freeze({ provider: "acme", model: "flash-2", id: "acme/flash-2" });
const PRO: ModelConfig = Object.freeze({ provider: "acme", model: "pro-2", id: "acme/pro-2" });
const MID: ModelConfig = Object.freeze({ provider: "acme", model: "mid-1", id: "acme/mid-1" });

function fakeCatalog(models: readonly ModelConfig[], defaultRef?: string): ModelCatalog {
  const byId = new Map(models.map((m) => [m.id, m]));
  return {
    findModel(ref) {
      return byId.get(ref);
    },
    defaultModel() {
      return defaultRef ? byId.get(defaultRef) : models[0];
    },
  };
}

function orchestra(config: OrchestraConfig | undefined | null, catalog: ModelCatalog = fakeCatalog([FLASH, PRO, MID], FLASH.id)) {
  return new ModelOrchestra(catalog, config);
}

function dualTiers(): ModelOrchestra {
  return orchestra({ fast: FLASH.id, deep: PRO.id });
}

/** Budget with plenty left and deep escalation allowed. */
const BUDGET_OK: BudgetState = Object.freeze({ remainingAttempts: 3, remainingUnits: 10, allowDeep: true });
/** Budget pressure: policy forbids deep escalation. */
const BUDGET_NO_DEEP: BudgetState = Object.freeze({ remainingAttempts: 3, remainingUnits: 10, allowDeep: false });

function resolveDeepGate(gate: string, roleClass: RoleClass = "execution"): OrchestraResolveContext {
  return { pattern: { modelMix: "flash_primary", deepGates: [gate] }, roleClass, gate, budget: BUDGET_OK };
}

describe("ModelOrchestra unconfigured mode", () => {
  test("omitted config resolves the single default model with reason=unconfigured", () => {
    const result = orchestra(undefined).resolve();
    expect(result.reason).toBe("unconfigured");
    expect(result.tier).toBe("default");
    expect(result.model).toEqual(FLASH);
  });

  test("null config behaves like omitted", () => {
    const result = orchestra(null).resolve();
    expect(result.reason).toBe("unconfigured");
    expect(result.model).toEqual(FLASH);
  });

  test("empty config object behaves like omitted", () => {
    const result = orchestra({}).resolve();
    expect(result.reason).toBe("unconfigured");
    expect(result.model).toEqual(FLASH);
  });

  test("unconfigured resolve ignores forced_tier and returns the default (valid context only)", () => {
    const result = orchestra(undefined).resolve({ forcedTier: "deep", roleClass: "orchestration", gate: "success_audit" });
    expect(result.reason).toBe("unconfigured");
    expect(result.model).toEqual(FLASH);
  });

  test("unconfigured resolve still validates the pattern: unknown deep gates fail closed", () => {
    expect(() => orchestra(undefined).resolve({ pattern: { deepGates: ["made_up_gate"] } }))
      .toThrow(OrchestraValidationError);
  });

  test("fails closed when the catalog has no default model", () => {
    const catalog = fakeCatalog([], undefined);
    expect(() => new ModelOrchestra(catalog, undefined).resolve()).toThrow(OrchestraValidationError);
  });
});

describe("ModelOrchestra configured mode (tier binding from #28)", () => {
  test("fast and deep resolve independently to their registered models", () => {
    const instance = dualTiers();
    const fast = instance.resolve({ forcedTier: "fast" });
    const deep = instance.resolve({ forcedTier: "deep" });
    expect(fast).toEqual({ tier: "fast", model: FLASH, reason: "forced" });
    expect(deep).toEqual({ tier: "deep", model: PRO, reason: "forced" });
  });

  test("each resolution returns a fresh ModelConfig (no shared mutable defaults)", () => {
    const instance = dualTiers();
    const first = instance.resolve({ forcedTier: "fast" });
    (first.model as { provider: string }).provider = "mutated";
    expect(instance.resolve({ forcedTier: "fast" }).model).toEqual(FLASH);
    expect(instance.resolve({ forcedTier: "deep" }).model).toEqual(PRO);
  });

  test("fast-only config is valid and defaults flash-first, but a deep request fails closed", () => {
    const instance = orchestra({ fast: FLASH.id });
    expect(instance.resolve().model).toEqual(FLASH);
    expect(() => instance.resolve({ forcedTier: "deep" })).toThrow(OrchestraValidationError);
  });

  test("mid is accepted in schema, validated against the catalog, and reachable only by forced_tier", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id, mid: MID.id });
    expect(instance.resolve({ forcedTier: "mid" })).toEqual({ tier: "mid", model: MID, reason: "forced" });
    expect(() => orchestra({ fast: FLASH.id, deep: PRO.id, mid: "acme/unknown" })).toThrow(OrchestraValidationError);
    // automatic routing never picks mid in v0
    expect(instance.resolve({ pattern: { modelMix: "flash_deep_mix" }, roleClass: "orchestration" }).tier).toBe("deep");
  });

  test("forced unknown tier id fails closed", () => {
    const instance = dualTiers();
    expect(() => instance.resolve({ forcedTier: "pro" as TierId })).toThrow(OrchestraValidationError);
  });

  test("configured resolve with an empty context resolves flash-first (default mix + role defaults)", () => {
    const result = dualTiers().resolve();
    expect(result).toEqual({ tier: "fast", model: FLASH, reason: "role" });
  });
});

describe("ModelOrchestra validation (fail closed before mission start)", () => {
  test("unknown tier key in config is rejected", () => {
    expect(() => orchestra({ fast: FLASH.id, deep: PRO.id, pro: "acme/x" } as OrchestraConfig))
      .toThrow(OrchestraValidationError);
  });

  test("tier pointing at a model missing from the catalog is rejected", () => {
    expect(() => orchestra({ fast: FLASH.id, deep: "acme/not-registered" })).toThrow(OrchestraValidationError);
  });

  test("non-string tier value is rejected", () => {
    expect(() => orchestra({ fast: 123 as unknown as string, deep: PRO.id })).toThrow(OrchestraValidationError);
    expect(() => orchestra({ fast: "", deep: PRO.id })).toThrow(OrchestraValidationError);
  });

  test("validation errors name the offending tier", () => {
    try {
      orchestra({ fast: FLASH.id, deep: "acme/ghost" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestraValidationError);
      expect(String((error as Error).message)).toContain("deep");
    }
  });

  test("unknown model_mix is rejected", () => {
    expect(() => dualTiers().resolve({ pattern: { modelMix: "always_deep" as never } }))
      .toThrow(OrchestraValidationError);
  });

  test("unknown deep_gates fail validation with the offending gate named", () => {
    try {
      dualTiers().resolve({ pattern: { deepGates: ["success_audit", "made_up_gate"] }, gate: "success_audit" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestraValidationError);
      expect(String((error as Error).message)).toContain("made_up_gate");
    }
  });

  test("non-string deep gate entries are rejected", () => {
    expect(() => dualTiers().resolve({ pattern: { deepGates: [42 as unknown as string] } }))
      .toThrow(OrchestraValidationError);
  });

  test("unknown role_class is rejected", () => {
    expect(() => dualTiers().resolve({ roleClass: "commander" as RoleClass }))
      .toThrow(OrchestraValidationError);
  });

  test("malformed budget state is rejected", () => {
    const bad = dualTiers();
    expect(() => bad.resolve({ budget: { remainingAttempts: -1, remainingUnits: 0, allowDeep: true } }))
      .toThrow(OrchestraValidationError);
    expect(() => bad.resolve({ budget: { remainingAttempts: 1.5, remainingUnits: 0, allowDeep: true } }))
      .toThrow(OrchestraValidationError);
    expect(() => bad.resolve({ budget: { remainingAttempts: 0, remainingUnits: 0, allowDeep: "yes" as unknown as boolean } }))
      .toThrow(OrchestraValidationError);
  });
});

describe("flash_only mix", () => {
  test("always resolves fast with reason=mix when dual tiers exist, whatever the role class", () => {
    const instance = dualTiers();
    for (const roleClass of ROLE_CLASS_VALUES) {
      const result = instance.resolve({ pattern: { modelMix: "flash_only" }, roleClass });
      expect(result).toEqual({ tier: "fast", model: FLASH, reason: "mix" });
    }
  });

  test("never elevates on deep gates", () => {
    const instance = dualTiers();
    const result = instance.resolve({
      pattern: { modelMix: "flash_only", deepGates: ["success_audit"] },
      roleClass: "orchestration",
      gate: "success_audit",
    });
    expect(result).toEqual({ tier: "fast", model: FLASH, reason: "mix" });
  });

  test("forced fast is accepted", () => {
    const result = dualTiers().resolve({ pattern: { modelMix: "flash_only" }, forcedTier: "fast" });
    expect(result).toEqual({ tier: "fast", model: FLASH, reason: "forced" });
  });

  test("forced non-fast tiers (deep and mid) are rejected: flash_only resolves fast only", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id, mid: MID.id });
    expect(() => instance.resolve({ pattern: { modelMix: "flash_only" }, forcedTier: "deep" }))
      .toThrow(OrchestraValidationError);
    expect(() => instance.resolve({ pattern: { modelMix: "flash_only" }, forcedTier: "mid" }))
      .toThrow(OrchestraValidationError);
  });
});

describe("flash_primary mix", () => {
  test("execution and orchestration default to fast with reason=role", () => {
    const instance = dualTiers();
    for (const roleClass of ROLE_CLASS_VALUES) {
      expect(instance.resolve({ pattern: { modelMix: "flash_primary" }, roleClass }))
        .toEqual({ tier: "fast", model: FLASH, reason: "role" });
    }
  });

  test("a configured deep gate (success_audit) resolves deep with reason=gate", () => {
    const result = dualTiers().resolve(resolveDeepGate("success_audit"));
    expect(result).toEqual({ tier: "deep", model: PRO, reason: "gate" });
  });

  test("deep gates elevate regardless of role class", () => {
    const instance = dualTiers();
    for (const roleClass of ROLE_CLASS_VALUES) {
      expect(instance.resolve({ ...resolveDeepGate("success_audit"), roleClass }).tier).toBe("deep");
    }
  });

  test("a gate that is not a pattern deep gate stays on fast defaults", () => {
    const result = dualTiers().resolve({
      pattern: { modelMix: "flash_primary", deepGates: ["success_audit"] },
      roleClass: "orchestration",
      gate: "join_reduce",
    });
    expect(result).toEqual({ tier: "fast", model: FLASH, reason: "role" });
  });

  test("omitted pattern uses the flash_primary default mix", () => {
    expect(dualTiers().resolve({ roleClass: "orchestration" })).toEqual({ tier: "fast", model: FLASH, reason: "role" });
  });
});

describe("flash_deep_mix mix", () => {
  test("workers/explorers (execution) and adversarial roles default fast with reason=role", () => {
    const instance = dualTiers();
    for (const roleClass of ["execution", "adversarial"] as const) {
      expect(instance.resolve({ pattern: { modelMix: "flash_deep_mix" }, roleClass }))
        .toEqual({ tier: "fast", model: FLASH, reason: "role" });
    }
  });

  test("orchestration defaults deep with reason=role as a soft fallback", () => {
    const result = dualTiers().resolve({ pattern: { modelMix: "flash_deep_mix" }, roleClass: "orchestration" });
    expect(result).toEqual({ tier: "deep", model: PRO, reason: "role" });
  });

  test("honors pattern deep gates: strategy_synthesis, join_reduce, success_audit, cross_model_check", () => {
    const instance = dualTiers();
    for (const gate of ["strategy_synthesis", "join_reduce", "success_audit", "cross_model_check"]) {
      const result = instance.resolve({
        pattern: { modelMix: "flash_deep_mix", deepGates: ["strategy_synthesis", "join_reduce", "success_audit", "cross_model_check"] },
        roleClass: "execution",
        gate,
      });
      expect(result).toEqual({ tier: "deep", model: PRO, reason: "gate" });
    }
  });

  test("a deep gate stays authoritative over the orchestration default", () => {
    const result = dualTiers().resolve({
      pattern: { modelMix: "flash_deep_mix", deepGates: ["success_audit"] },
      roleClass: "orchestration",
      gate: "success_audit",
    });
    expect(result).toEqual({ tier: "deep", model: PRO, reason: "gate" });
  });

  test("budget pressure downgrades automatic deep selections to fast with reason=budget", () => {
    const instance = dualTiers();
    const byRole = instance.resolve({ pattern: { modelMix: "flash_deep_mix" }, roleClass: "orchestration", budget: BUDGET_NO_DEEP });
    expect(byRole).toEqual({ tier: "fast", model: FLASH, reason: "budget" });
    const byGate = instance.resolve({ ...resolveDeepGate("success_audit"), pattern: { modelMix: "flash_deep_mix", deepGates: ["success_audit"] }, budget: BUDGET_NO_DEEP });
    expect(byGate).toEqual({ tier: "fast", model: FLASH, reason: "budget" });
  });
});

describe("forced_tier (Policy Guard + budget gated)", () => {
  test("accepted when Policy Guard and budget allow", () => {
    const instance = dualTiers();
    expect(instance.resolve({ pattern: { modelMix: "flash_primary" }, forcedTier: "deep", budget: BUDGET_OK }))
      .toEqual({ tier: "deep", model: PRO, reason: "forced" });
    // no budget state means no budget constraint on the forced tier
    expect(instance.resolve({ pattern: { modelMix: "flash_primary" }, forcedTier: "deep" }).tier).toBe("deep");
  });

  test("overrides automatic resolution when accepted", () => {
    const instance = dualTiers();
    const fast = instance.resolve({ pattern: { modelMix: "flash_deep_mix" }, roleClass: "orchestration", forcedTier: "fast" });
    expect(fast).toEqual({ tier: "fast", model: FLASH, reason: "forced" });
    const deep = instance.resolve({ pattern: { modelMix: "flash_primary" }, roleClass: "execution", forcedTier: "deep", budget: BUDGET_OK });
    expect(deep).toEqual({ tier: "deep", model: PRO, reason: "forced" });
  });

  test("forced deep under budget pressure is rejected — no silent deep", () => {
    expect(() => dualTiers().resolve({ pattern: { modelMix: "flash_primary" }, forcedTier: "deep", budget: BUDGET_NO_DEEP }))
      .toThrow(OrchestraValidationError);
  });

  test("forced deep when deep is unbound is rejected", () => {
    expect(() => orchestra({ fast: FLASH.id }).resolve({ forcedTier: "deep" }))
      .toThrow(OrchestraValidationError);
  });
});

describe("createPiModelCatalog (Pi SDK models.json)", () => {
  const model = (id: string, reasoning = false): Record<string, unknown> => ({
    id,
    name: id,
    reasoning,
    input: ["text"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  });

  async function writeCatalog(dir: string, providers: Record<string, Record<string, unknown>[]>, settings: Record<string, unknown>): Promise<{ modelsPath: string; settingsPath: string }> {
    const modelsPath = join(dir, "models.json");
    const settingsPath = join(dir, "settings.json");
    await writeFile(modelsPath, JSON.stringify({
      providers: Object.fromEntries(Object.entries(providers).map(([id, models]) => [
        id, { name: id, baseUrl: `https://${id}.example/v1`, apiKey: "test-key", api: "openai-completions", models },
      ])),
    }));
    await writeFile(settingsPath, JSON.stringify(settings));
    return { modelsPath, settingsPath };
  }

  async function tempCatalog(providers: Record<string, Record<string, unknown>[]>, settings: Record<string, unknown>): Promise<{ modelsPath: string; settingsPath: string }> {
    return writeCatalog(await mkdtemp(join(tmpdir(), "evok-orchestra-")), providers, settings);
  }

  test("loads models from a models.json file and honors settings defaultModel", async () => {
    const { modelsPath, settingsPath } = await tempCatalog({ acme: [model("flash-2"), model("pro-2", true)] }, { defaultModel: "pro-2" });

    const catalog = await createPiModelCatalog({ modelsPath, settingsPath });
    expect(catalog.findModel("acme/flash-2")).toEqual(FLASH);
    expect(catalog.findModel("acme/pro-2")).toEqual(PRO);
    expect(catalog.findModel("acme/ghost")).toBeUndefined();
    expect(catalog.defaultModel()).toEqual(PRO);

    const instance = new ModelOrchestra(catalog, { fast: "acme/flash-2", deep: "acme/pro-2" });
    expect(instance.resolve({ forcedTier: "fast" }).model).toEqual(FLASH);
    expect(instance.resolve({ forcedTier: "deep" }).model).toEqual(PRO);
  });

  test("fails closed when settings has no defaultModel (no guessing a builtin)", async () => {
    const { modelsPath, settingsPath } = await tempCatalog({ acme: [model("flash-2")] }, {});

    const catalog = await createPiModelCatalog({ modelsPath, settingsPath });
    expect(catalog.defaultModel()).toBeUndefined();
    expect(() => new ModelOrchestra(catalog, undefined).resolve()).toThrow(OrchestraValidationError);
  });

  test("ambiguous bare model id fails closed instead of guessing a provider", async () => {
    const { modelsPath, settingsPath } = await tempCatalog(
      { acme: [model("shared-id")], zenith: [model("shared-id")] },
      { defaultModel: "shared-id" },
    );

    const catalog = await createPiModelCatalog({ modelsPath, settingsPath });
    expect(() => catalog.findModel("shared-id")).toThrow(OrchestraValidationError);
    expect(catalog.defaultModel()).toBeUndefined();
    expect(() => new ModelOrchestra(catalog, undefined).resolve()).toThrow(OrchestraValidationError);
  });

  test("honors settings defaultProvider+defaultModel as a provider/model ref", async () => {
    const { modelsPath, settingsPath } = await tempCatalog({ acme: [model("flash-2")] }, { defaultProvider: "acme", defaultModel: "flash-2" });

    const catalog = await createPiModelCatalog({ modelsPath, settingsPath });
    expect(catalog.defaultModel()).toEqual(FLASH);
  });
});
