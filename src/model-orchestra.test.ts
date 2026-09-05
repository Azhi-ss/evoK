import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ModelOrchestra,
  OrchestraValidationError,
  createPiModelCatalog,
  type ModelCatalog,
  type ModelConfig,
  type OrchestraConfig,
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

  test("unconfigured resolve ignores a requested tier and returns the default", () => {
    const result = orchestra(undefined).resolve("deep");
    expect(result.reason).toBe("unconfigured");
    expect(result.model).toEqual(FLASH);
  });

  test("fails closed when the catalog has no default model", () => {
    const catalog = fakeCatalog([], undefined);
    expect(() => new ModelOrchestra(catalog, undefined).resolve()).toThrow(OrchestraValidationError);
  });
});

describe("ModelOrchestra configured mode", () => {
  test("fast and deep resolve independently to their registered models", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id });
    const fast = instance.resolve("fast");
    const deep = instance.resolve("deep");
    expect(fast).toEqual({ tier: "fast", model: FLASH, reason: "configured" });
    expect(deep).toEqual({ tier: "deep", model: PRO, reason: "configured" });
  });

  test("each resolution returns a fresh ModelConfig (no shared mutable defaults)", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id });
    const first = instance.resolve("fast");
    (first.model as { provider: string }).provider = "mutated";
    expect(instance.resolve("fast").model).toEqual(FLASH);
    expect(instance.resolve("deep").model).toEqual(PRO);
  });

  test("fast-only config is valid, but resolving an unbound tier fails closed", () => {
    const instance = orchestra({ fast: FLASH.id });
    expect(instance.resolve("fast").model).toEqual(FLASH);
    expect(() => instance.resolve("deep")).toThrow(OrchestraValidationError);
  });

  test("mid is accepted in schema and validated against the catalog", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id, mid: MID.id });
    expect(instance.resolve("mid")).toEqual({ tier: "mid", model: MID, reason: "configured" });
    expect(() => orchestra({ fast: FLASH.id, deep: PRO.id, mid: "acme/unknown" })).toThrow(OrchestraValidationError);
  });

  test("resolve with an unknown tier id fails closed", () => {
    const instance = orchestra({ fast: FLASH.id, deep: PRO.id });
    expect(() => instance.resolve("pro" as TierId)).toThrow(OrchestraValidationError);
  });

  test("configured resolve without a tier fails closed (tier selection is not this ticket's job)", () => {
    expect(() => orchestra({ fast: FLASH.id, deep: PRO.id }).resolve()).toThrow(OrchestraValidationError);
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
    expect(instance.resolve("fast").model).toEqual(FLASH);
    expect(instance.resolve("deep").model).toEqual(PRO);
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
