import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { declareEvokPlugin, formatEvokPluginStatus, loadEvokPlugin } from "./evok-plugin";

describe("unified evoK Pi plugin", () => {
  test("declares one product plugin with three internal modules", () => {
    expect(declareEvokPlugin()).toEqual({
      pluginId: "evok",
      packageName: "evok",
      experimental: true,
      changelogOfficialHotPlug: false,
      modules: ["platform", "research", "eval"],
    });
  });

  test("loads all internal modules through one entry", async () => {
    const plugin = await loadEvokPlugin({ facets: "session" });
    try {
      expect(Object.keys(plugin.modules)).toEqual(["platform", "research", "eval"]);
      expect(plugin.modules.platform.seat.pluginId).toBe("evok-platform");
      expect(plugin.modules.research.seat.pluginId).toBe("evok-research");
      expect(plugin.modules.eval.seat.pluginId).toBe("evok-eval");
      expect(plugin.tuiCommands).toEqual([]);
      expect(formatEvokPluginStatus(plugin)).toContain("evok plugin loaded");
    } finally {
      await plugin.dispose();
    }
  });

  test("the root package points Pi at one extension entry", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      pi?: { extensions?: string[] };
    };
    expect(packageJson.pi?.extensions).toEqual(["./extensions/evok.ts"]);
  });

  test("the Pi entry registers one command and a shutdown hook", async () => {
    const { default: evokExtension } = await import("../../extensions/evok");
    const commands = new Map<string, unknown>();
    const handlers = new Map<string, unknown>();
    const pi = {
      registerCommand(name: string, definition: unknown) {
        commands.set(name, definition);
      },
      on(event: string, handler: unknown) {
        handlers.set(event, handler);
        return () => {};
      },
    } as unknown as ExtensionAPI;

    await evokExtension(pi);

    expect([...commands.keys()]).toEqual(["evok"]);
    expect(handlers.has("session_shutdown")).toBe(true);

    const shutdown = handlers.get("session_shutdown") as (() => Promise<void>) | undefined;
    await shutdown?.();
  });
});
