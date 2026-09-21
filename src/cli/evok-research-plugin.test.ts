/**
 * ET-CHORD-SPLIT-RESEARCH / #191 — evok-research Chord plugin pilot.
 *
 * Seams: declareEvokResearchPlugin / loadEvokResearchPlugin.
 * Domain pins: search pack default stays `fixed_uct`; `#40` Progressive stays off.
 * Local experimental path. Pi 0.86 changelog did not advertise Chord hot-plug.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
} from "../search/search-selection-port";
import { ELITE_IS_NOT_JINJI } from "../search/progressive-opt-in";
import {
  declareEvokResearchPlugin,
  loadEvokResearchPlugin,
} from "./evok-research-plugin";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("evok-research is independently declarable", () => {
  test("declares the 选点 / Harness / SelectionPolicy seat as an experimental Chord plugin", () => {
    const declaration = declareEvokResearchPlugin();

    expect(declaration.packageDir.endsWith(`${join("plugins", "evok-research")}`)).toBe(true);
    expect(declaration).toMatchObject({
      pluginId: "evok-research",
      packageName: "evok-research",
      seat: "selection-harness-selection-policy",
      experimental: true,
      changelogOfficialHotPlug: false,
      defaultSelectionId: "fixed_uct",
      selectionPolicy40: "off",
      progressiveDefault: "off",
      eliteIsPromotion: false,
      facets: {
        session: "src/session.ts",
        tui: "src/tui.ts",
      },
      surfaces: [
        { id: "selection", pack: "src/search", role: "parent-selection" },
        { id: "harness", pack: "src/search", role: "search-host" },
        { id: "selection-policy", pack: "src/search", role: "policy-default" },
      ],
    });
    expect(existsSync(join(declaration.packageDir, "package.json"))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.session))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.tui))).toBe(true);
    const repoRoot = join(HERE, "../..");
    expect(existsSync(join(repoRoot, "src/search"))).toBe(true);
  });

  test("package.json is a conventional Chord plugin and does not mention other domain plugins", async () => {
    const declaration = declareEvokResearchPlugin();
    const raw = await readFile(join(declaration.packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      name: string;
      peerDependencies?: Record<string, string>;
      chord?: { facets?: Record<string, string | false> };
    };

    expect(pkg.name).toBe("evok-research");
    expect(pkg.peerDependencies?.["@earendil-works/chord"]).toMatch(/0\.86/);
    expect(pkg.chord?.facets).toEqual({
      session: "./src/session.ts",
      tui: "./src/tui.ts",
    });
    expect(raw).not.toMatch(/evok-platform|evok-eval/);
  });
});

describe("evok-research is independently loadable on the local pilot path", () => {
  test("session facet loads alone and describes the research seat without flipping defaults", async () => {
    const loaded = await loadEvokResearchPlugin({ facets: "session" });
    try {
      expect(loaded.seat).toEqual({
        pluginId: "evok-research",
        seat: "selection-harness-selection-policy",
        experimental: true,
        changelogOfficialHotPlug: false,
        defaultSelectionId: "fixed_uct",
        selectionPolicy40: "off",
        progressiveDefault: "off",
        eliteIsPromotion: false,
        surfaces: [
          { id: "selection", pack: "src/search", role: "parent-selection" },
          { id: "harness", pack: "src/search", role: "search-host" },
          { id: "selection-policy", pack: "src/search", role: "policy-default" },
        ],
      });
      expect(loaded.tuiCommands).toEqual([]);
      expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
      expect(SELECTION_POLICY_40).toBe("off");
      expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
      expect(ELITE_IS_NOT_JINJI).toBe(true);
    } finally {
      await loaded.dispose();
    }
  });

  test("session and TUI facets load together and the TUI seat registers a smoke command", async () => {
    const loaded = await loadEvokResearchPlugin();
    try {
      expect(loaded.seat.pluginId).toBe("evok-research");
      expect(loaded.seat.changelogOfficialHotPlug).toBe(false);
      expect(loaded.seat.defaultSelectionId).toBe("fixed_uct");
      expect(loaded.seat.progressiveDefault).toBe("off");
      expect(loaded.seat.eliteIsPromotion).toBe(false);
      expect(loaded.tuiCommands).toEqual([
        {
          name: "evok-research",
          description:
            "Describe the evok-research 选点 / Harness / SelectionPolicy seat (pilot; default fixed_uct; Progressive opt-in only; not changelog-official Chord hot-plug).",
        },
      ]);
    } finally {
      await loaded.dispose();
    }
  });
});

describe("evok-research docs stay honest about Chord hot-plug and defaults", () => {
  test("spec and handoff call the path experimental, deny changelog-official hot-plug, and keep Progressive opt-in", async () => {
    const spec = await readFile(join(HERE, "../../docs/evok-research-chord.md"), "utf8");
    const handoff = await readFile(join(HERE, "../../handoffs/2026-09-21-et-chord-split-research.md"), "utf8");
    const howto = await readFile(join(HERE, "../../docs/how-to-use.md"), "utf8");

    for (const text of [spec, handoff]) {
      expect(text).toMatch(/evok-research/);
      expect(text).toMatch(/experimental|试点/i);
      expect(text).toMatch(/changelog/i);
      expect(text.toLowerCase()).toMatch(/not[\s*]+(advertise|changelog-official)|未宣传|不是.*官方/);
      expect(text.toLowerCase()).not.toMatch(/officially supported chord hot-?plug/);
      expect(text).toMatch(/fixed_uct/);
      expect(text).toMatch(/opt-in|显式/i);
      expect(text).toMatch(/Elite/);
    }
    expect(howto).toMatch(/evok-research-chord\.md/);
    expect(howto).toMatch(/not changelog-official/i);
    expect(howto).toMatch(/fixed_uct/);
  });
});
