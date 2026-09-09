import { describe, expect, test } from "bun:test";
import { OrchestraValidationError, createEvokModelResolver, type ModelConfig } from "./evok-model";
import { createPiModelCatalog } from "./model-orchestra";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PRO: ModelConfig = Object.freeze({ provider: "acme", model: "pro-2", id: "acme/pro-2" });

describe("createEvokModelResolver", () => {
  test("unconfigured tier resolves Pi's default model with preflight diagnostics", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2"), catalogModel("pro-2", true)] },
      { defaultModel: "pro-2" },
      { acme: "secret-key" },
    );
    const resolver = await createEvokModelResolver({ modelsPath, settingsPath, runtime: { authPath } });
    const resolved = await resolver.resolve("default");
    expect(resolved.model.id).toBe("acme/pro-2");
    expect(resolved.tier).toBe("default");
    expect(resolved.reason).toBe("unconfigured");
    await expect(resolver.preflight(resolved.model)).resolves.toMatchObject({ ok: true });
  });

  test("an explicit tier with no orchestra bindings fails closed instead of silently using the default", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2"), catalogModel("pro-2", true)] },
      { defaultModel: "flash-2" },
      { acme: "secret-key" },
    );
    const resolver = await createEvokModelResolver({ modelsPath, settingsPath, runtime: { authPath } });
    await expect(resolver.resolve("deep")).rejects.toBeInstanceOf(OrchestraValidationError);
  });

  test("configured tiers resolve distinct bound models including role/tier calls on one shared runtime", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2"), catalogModel("pro-2", true)] },
      { defaultModel: "flash-2" },
      { acme: "secret-key" },
    );
    const resolver = await createEvokModelResolver({
      modelsPath,
      settingsPath,
      runtime: { authPath },
      orchestra: { fast: "acme/flash-2", deep: "acme/pro-2" },
    });
    const fast = await resolver.resolve("fast");
    const deep = await resolver.resolve("deep");
    expect(fast.model.id).toBe("acme/flash-2");
    expect(deep.model.id).toBe("acme/pro-2");
    expect(fast.modelId.provider).toBe("acme");
    expect(fast.modelId.id).toBe("flash-2");
    expect(fast.modelId).not.toBe(deep.modelId);
    expect(fast.modelRuntime).toBe(deep.modelRuntime);
  });

  test("missing default model fails closed with a configuration error before dispatch", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2")] },
      {},
      { acme: "secret-key" },
    );
    const resolver = await createEvokModelResolver({ modelsPath, settingsPath, runtime: { authPath } });
    await expect(resolver.resolve("default")).rejects.toBeInstanceOf(OrchestraValidationError);
  });

  test("an unbound configured tier fails closed instead of silently using another provider", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2"), catalogModel("pro-2", true)] },
      { defaultModel: "flash-2" },
      { acme: "secret-key" },
    );
    const resolver = await createEvokModelResolver({
      modelsPath,
      settingsPath,
      runtime: { authPath },
      orchestra: { fast: "acme/flash-2" },
    });
    await expect(resolver.resolve("deep")).rejects.toBeInstanceOf(OrchestraValidationError);
  });

  test("a tier binding to an unregistered model fails closed at construction time", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2")] },
      { defaultModel: "flash-2" },
      { acme: "secret-key" },
    );
    await expect(createEvokModelResolver({
      modelsPath,
      settingsPath,
      runtime: { authPath },
      orchestra: { fast: "acme/ghost-model" },
    })).rejects.toBeInstanceOf(OrchestraValidationError);
  });

  test("auth preflight reports missing credentials explicitly without exposing secrets", async () => {
    const { modelsPath, settingsPath, authPath } = await fixtureCatalog(
      { acme: [catalogModel("flash-2")] },
      { defaultModel: "flash-2" },
      {},
    );
    const resolver = await createEvokModelResolver({ modelsPath, settingsPath, runtime: { authPath } });
    const resolved = await resolver.resolve("default");
    const result = await resolver.preflight(resolved.model);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("acme");
      expect(result.error).not.toContain("secret-key");
    }
  });

  test("accepts a registered native faux provider runtime (offline SDK execution seam)", async () => {
    const faux = fauxProvider({ provider: "evok-resolver", models: [{ id: "deterministic" }] });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const catalog = await createPiModelCatalog({ modelRuntime });
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog,
      orchestra: { fast: "evok-resolver/deterministic" },
    });
    const resolved = await resolver.resolve("fast");
    expect(resolved.model.id).toBe("evok-resolver/deterministic");
    expect(resolved.modelId.provider).toBe("evok-resolver");
    expect(resolved.modelId.id).toBe("deterministic");
    await expect(resolver.preflight(resolved.model)).resolves.toMatchObject({ ok: true });
  });
});

function catalogModel(id: string, reasoning = false): Record<string, unknown> {
  return {
    id,
    name: id,
    reasoning,
    input: ["text"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

async function fixtureCatalog(
  providers: Record<string, Record<string, unknown>[]>,
  settings: Record<string, unknown>,
  auth: Record<string, string>,
): Promise<{ modelsPath: string; settingsPath: string; authPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "evok-resolver-"));
  const modelsPath = join(dir, "models.json");
  const settingsPath = join(dir, "settings.json");
  const authPath = join(dir, "auth.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: Object.fromEntries(Object.entries(providers).map(([id, models]) => [
      id, {
        name: id,
        baseUrl: `https://${id}.example/v1`,
        ...(auth[id] !== undefined ? { apiKey: auth[id] } : {}),
        api: "openai-completions",
        models,
      },
    ])),
  }));
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(authPath, JSON.stringify(Object.fromEntries(Object.entries(auth).map(([id, key]) => [id, { type: "api_key", key }]))));
  return { modelsPath, settingsPath, authPath };
}
