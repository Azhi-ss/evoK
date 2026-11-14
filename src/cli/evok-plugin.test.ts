import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUITE_METRIC_ID } from "../competition/suite-metric";
import { evaluateContestAutoSubmitGates } from "../evidence/contest-auto-submit";
import { killTestHangHasLedgerPlan } from "../evidence/kill-test-hang";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { ELITE_IS_NOT_JINJI } from "../search/progressive-opt-in";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
} from "../search/search-selection-port";
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

  test("loads all internal modules through one entry and preserves domain locks", async () => {
    const plugin = await loadEvokPlugin({ facets: "session" });
    try {
      expect(Object.keys(plugin.modules)).toEqual(["platform", "research", "eval"]);
      expect(plugin.modules.platform.seat).toMatchObject({
        pluginId: "evok-platform",
        seat: "mission-orchestration-tui-cli",
        experimental: true,
        changelogOfficialHotPlug: false,
      });
      expect(plugin.modules.research.seat).toMatchObject({
        pluginId: "evok-research",
        seat: "selection-harness-selection-policy",
        defaultSelectionId: "fixed_uct",
        selectionPolicy40: "off",
        progressiveDefault: "off",
        eliteIsPromotion: false,
      });
      expect(plugin.modules.eval.seat).toMatchObject({
        pluginId: "evok-eval",
        seat: "eval-promotion-broker",
        failClosed: true,
        admissionNoWiden: true,
        budgetNoWiden: true,
        hangNoWiden: true,
        t48NoWiden: true,
        brokerNoWiden: true,
        autoSubmitFailClosed: true,
        eliteIsPromotion: false,
      });
      expect(plugin.tuiCommands).toEqual([]);
      expect(formatEvokPluginStatus(plugin)).toContain("evok plugin loaded");

      expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
      expect(SELECTION_POLICY_40).toBe("off");
      expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
      expect(ELITE_IS_NOT_JINJI).toBe(true);
      expect(SUITE_METRIC_ID).toBe("suite-metric");
      expect(killTestHangHasLedgerPlan({})).toBe(false);
      expect(evaluateContestAutoSubmitGates({})).toMatchObject({
        ok: false,
        outcome: "refused",
        reason: "gates-not-green",
      });
      expect(
        evaluateMethodAdmission({
          validity: {
            ok: true,
            outcome: "pass",
            effective: true,
            optimal: false,
            hang: false,
            blocksAdmission: false,
            slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
            objections: [],
          },
          slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
          elite: true,
        }).admitted,
      ).toBe(false);
    } finally {
      await plugin.dispose();
    }

    const withTui = await loadEvokPlugin({ facets: "session+tui" });
    try {
      expect(withTui.tuiCommands.map((cmd) => cmd.name)).toEqual([
        "evok-platform",
        "evok-research",
        "evok-eval",
      ]);
    } finally {
      await withTui.dispose();
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
