/**
 * ET-CHORD-SPLIT-PLATFORM / #190 — evok-platform Chord plugin pilot.
 *
 * Seams: declareEvokPlatformPlugin / loadEvokPlatformPlugin.
 * Local experimental path. Pi 0.86 changelog did not advertise Chord hot-plug.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declareEvokPlatformPlugin,
  loadEvokPlatformPlugin,
} from "./evok-platform-plugin";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("evok-platform is independently declarable", () => {
  test("declares the Mission / orchestration / TUI·CLI seat as an experimental Chord plugin", () => {
    const declaration = declareEvokPlatformPlugin();

    expect(declaration.packageDir.endsWith(`${join("plugins", "evok-platform")}`)).toBe(true);
    expect(declaration).toMatchObject({
      pluginId: "evok-platform",
      packageName: "evok-platform",
      seat: "mission-orchestration-tui-cli",
      experimental: true,
      changelogOfficialHotPlug: false,
      facets: {
        session: "src/session.ts",
        tui: "src/tui.ts",
      },
      surfaces: [
        { id: "mission", pack: "src/mission", role: "control-plane" },
        { id: "orchestration", pack: "src/mission", role: "thin-glue" },
        { id: "tui-cli", pack: "src/cli", role: "entry-mirror" },
      ],
    });
    expect(existsSync(join(declaration.packageDir, "package.json"))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.session))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.tui))).toBe(true);
  });

  test("package.json is a conventional Chord plugin and does not mention other domain plugins", async () => {
    const declaration = declareEvokPlatformPlugin();
    const raw = await readFile(join(declaration.packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      name: string;
      peerDependencies?: Record<string, string>;
      chord?: { facets?: Record<string, string | false> };
    };

    expect(pkg.name).toBe("evok-platform");
    expect(pkg.peerDependencies?.["@earendil-works/chord"]).toMatch(/0\.86/);
    expect(pkg.chord?.facets).toEqual({
      session: "./src/session.ts",
      tui: "./src/tui.ts",
    });
    expect(raw).not.toMatch(/evok-research|evok-eval/);
  });
});

describe("evok-platform is independently loadable on the local pilot path", () => {
  test("session facet loads alone and describes the platform seat", async () => {
    const loaded = await loadEvokPlatformPlugin({ facets: "session" });
    try {
      expect(loaded.seat).toEqual({
        pluginId: "evok-platform",
        seat: "mission-orchestration-tui-cli",
        experimental: true,
        changelogOfficialHotPlug: false,
        surfaces: [
          { id: "mission", pack: "src/mission", role: "control-plane" },
          { id: "orchestration", pack: "src/mission", role: "thin-glue" },
          { id: "tui-cli", pack: "src/cli", role: "entry-mirror" },
        ],
      });
      expect(loaded.tuiCommands).toEqual([]);
    } finally {
      await loaded.dispose();
    }
  });

  test("session and TUI facets load together and the TUI seat registers a smoke command", async () => {
    const loaded = await loadEvokPlatformPlugin();
    try {
      expect(loaded.seat.pluginId).toBe("evok-platform");
      expect(loaded.seat.changelogOfficialHotPlug).toBe(false);
      expect(loaded.tuiCommands).toEqual([
        {
          name: "evok-platform",
          description: "Describe the evok-platform Mission / orchestration / TUI·CLI seat (pilot; not changelog-official Chord hot-plug).",
        },
      ]);
    } finally {
      await loaded.dispose();
    }
  });
});

describe("evok-platform docs stay honest about Chord hot-plug", () => {
  test("spec and handoff call the path experimental and deny changelog-official hot-plug", async () => {
    const spec = await readFile(join(HERE, "../../docs/evok-platform-chord.md"), "utf8");
    const handoff = await readFile(join(HERE, "../../handoffs/2026-09-21-et-chord-split-platform.md"), "utf8");
    const howto = await readFile(join(HERE, "../../docs/how-to-use.md"), "utf8");

    for (const text of [spec, handoff]) {
      expect(text).toMatch(/evok-platform/);
      expect(text).toMatch(/experimental|试点/i);
      expect(text).toMatch(/changelog/i);
      expect(text).not.toMatch(/changelog-official Chord hot-plug/i);
      expect(text.toLowerCase()).not.toMatch(/officially supported chord hot-?plug/);
    }
    expect(howto).toMatch(/evok-platform-chord\.md/);
    expect(howto).toMatch(/not changelog-official/i);
  });
});
