/**
 * ET-CHORD-SPLIT-EVAL / #192 — evok-eval Chord plugin pilot.
 *
 * Seams: declareEvokEvalPlugin / loadEvokEvalPlugin.
 * Domain pins: Admission / Budget / hang / T48 / Broker stay fail-closed.
 * Auto-submit stays fail-closed. Elite ≠ Promotion.
 * Local experimental path. Pi 0.86 changelog did not advertise Chord hot-plug.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateContestAutoSubmitGates } from "../evidence/contest-auto-submit";
import { killTestHangHasLedgerPlan } from "../evidence/kill-test-hang";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { SUITE_METRIC_ID } from "../competition/suite-metric";
import { ELITE_IS_NOT_JINJI } from "../search/progressive-opt-in";
import {
  declareEvokEvalPlugin,
  loadEvokEvalPlugin,
} from "./evok-eval-plugin";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("evok-eval is independently declarable", () => {
  test("declares the eval / promotion / Broker seat as an experimental Chord plugin", () => {
    const declaration = declareEvokEvalPlugin();

    expect(declaration.packageDir.endsWith(`${join("plugins", "evok-eval")}`)).toBe(true);
    expect(declaration).toMatchObject({
      pluginId: "evok-eval",
      packageName: "evok-eval",
      seat: "eval-promotion-broker",
      experimental: true,
      changelogOfficialHotPlug: false,
      failClosed: true,
      admissionNoWiden: true,
      budgetNoWiden: true,
      hangNoWiden: true,
      t48NoWiden: true,
      brokerNoWiden: true,
      autoSubmitFailClosed: true,
      eliteIsPromotion: false,
      facets: {
        session: "src/session.ts",
        tui: "src/tui.ts",
      },
      surfaces: [
        { id: "eval", pack: "src/competition", role: "scoring-suite-metric" },
        { id: "promotion", pack: "src/evidence", role: "evidence-admission-gates" },
        { id: "broker", pack: "src/evidence", role: "submission-broker" },
      ],
    });
    expect(existsSync(join(declaration.packageDir, "package.json"))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.session))).toBe(true);
    expect(existsSync(join(declaration.packageDir, declaration.facets.tui))).toBe(true);
    const repoRoot = join(HERE, "../..");
    expect(existsSync(join(repoRoot, "src/competition"))).toBe(true);
    expect(existsSync(join(repoRoot, "src/evidence"))).toBe(true);
  });

  test("package.json is a conventional Chord plugin and does not mention other domain plugins", async () => {
    const declaration = declareEvokEvalPlugin();
    const raw = await readFile(join(declaration.packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      name: string;
      peerDependencies?: Record<string, string>;
      chord?: { facets?: Record<string, string | false> };
    };

    expect(pkg.name).toBe("evok-eval");
    expect(pkg.peerDependencies?.["@earendil-works/chord"]).toMatch(/0\.86/);
    expect(pkg.chord?.facets).toEqual({
      session: "./src/session.ts",
      tui: "./src/tui.ts",
    });
    expect(raw).not.toMatch(/evok-platform|evok-research/);
  });
});

describe("evok-eval is independently loadable on the local pilot path", () => {
  test("session facet loads alone and describes the eval seat without widening gates", async () => {
    const loaded = await loadEvokEvalPlugin({ facets: "session" });
    try {
      expect(loaded.seat).toEqual({
        pluginId: "evok-eval",
        seat: "eval-promotion-broker",
        experimental: true,
        changelogOfficialHotPlug: false,
        failClosed: true,
        admissionNoWiden: true,
        budgetNoWiden: true,
        hangNoWiden: true,
        t48NoWiden: true,
        brokerNoWiden: true,
        autoSubmitFailClosed: true,
        eliteIsPromotion: false,
        surfaces: [
          { id: "eval", pack: "src/competition", role: "scoring-suite-metric" },
          { id: "promotion", pack: "src/evidence", role: "evidence-admission-gates" },
          { id: "broker", pack: "src/evidence", role: "submission-broker" },
        ],
      });
      expect(loaded.tuiCommands).toEqual([]);
      expect(SUITE_METRIC_ID).toBe("suite-metric");
      expect(ELITE_IS_NOT_JINJI).toBe(true);
      expect(killTestHangHasLedgerPlan({})).toBe(false);
      const autoSubmit = evaluateContestAutoSubmitGates({});
      expect(autoSubmit.ok).toBe(false);
      expect(autoSubmit.outcome).toBe("refused");
      expect(autoSubmit.reason).toBe("gates-not-green");
      const admission = evaluateMethodAdmission({
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
      });
      expect(admission.admitted).toBe(false);
    } finally {
      await loaded.dispose();
    }
  });

  test("session and TUI facets load together and the TUI seat registers a smoke command", async () => {
    const loaded = await loadEvokEvalPlugin();
    try {
      expect(loaded.seat.pluginId).toBe("evok-eval");
      expect(loaded.seat.changelogOfficialHotPlug).toBe(false);
      expect(loaded.seat.failClosed).toBe(true);
      expect(loaded.seat.autoSubmitFailClosed).toBe(true);
      expect(loaded.seat.eliteIsPromotion).toBe(false);
      expect(loaded.tuiCommands).toEqual([
        {
          name: "evok-eval",
          description:
            "Describe the evok-eval eval / promotion / Broker seat (pilot; fail-closed; not changelog-official Chord hot-plug).",
        },
      ]);
    } finally {
      await loaded.dispose();
    }
  });
});

describe("evok-eval docs stay honest about Chord hot-plug and fail-closed gates", () => {
  test("spec and handoff call the path experimental, deny changelog-official hot-plug, and keep gates fail-closed", async () => {
    const spec = await readFile(join(HERE, "../../docs/evok-eval-chord.md"), "utf8");
    const handoff = await readFile(join(HERE, "../../handoffs/2026-09-22-et-chord-split-eval.md"), "utf8");
    const howto = await readFile(join(HERE, "../../docs/how-to-use.md"), "utf8");

    for (const text of [spec, handoff]) {
      expect(text).toMatch(/evok-eval/);
      expect(text).toMatch(/experimental|试点/i);
      expect(text).toMatch(/changelog/i);
      expect(text.toLowerCase()).toMatch(/not[\s*]+(advertise|changelog-official)|未宣传|不是.*官方/);
      expect(text.toLowerCase()).not.toMatch(/officially supported chord hot-?plug/);
      expect(text).toMatch(/fail-closed|failClosed|失败关闭/i);
      expect(text).toMatch(/Admission/);
      expect(text).toMatch(/Broker/);
      expect(text).toMatch(/Elite/);
    }
    expect(howto).toMatch(/evok-eval-chord\.md/);
    expect(howto).toMatch(/not changelog-official/i);
    expect(howto).toMatch(/fail-closed/i);
  });
});
