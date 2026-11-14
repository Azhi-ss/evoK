/**
 * The layout simplification removed migration shims and the pilot Chord seat
 * packages. Living docs must not send a reader to those paths, and the single
 * plugin entry must still expose the same seat locks.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvokPlugin } from "../../src/cli/evok-plugin";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

const LIVING_DOCS = [
  "CONTEXT.md",
  "docs/how-to-use.md",
  "docs/chord-plugins.md",
  "docs/evok-platform-chord.md",
  "docs/evok-research-chord.md",
  "docs/evok-eval-chord.md",
  "docs/multi-agent-architecture.md",
  "docs/arch-as-is.md",
  "docs/file-blueprint.md",
  "docs/ledger-event-types.md",
  "docs/methodology-contracts.md",
  "docs/validation-ladder.md",
  "docs/data-honesty.md",
  "docs/agents/memory-map.md",
  "docs/code-structure-prd.md",
  "docs/memory-subsystem-prd.md",
  "docs/long-term-memory-prd.md",
  "docs/agents/harness-map.md",
  "README.md",
  "src/cli/README.md",
  "src/competition/README.md",
  "src/evidence/README.md",
  "src/execution/README.md",
  "src/mission/README.md",
  "src/search/README.md",
  "src/search/fixtures/OWNERSHIP.md",
  "src/memory/README.md",
  "harness-opt/design/2026-10-18-pi-subagents-setup.md",
] as const;

const RETIRED_PATHS = [
  "src/file-blueprint.ts",
  "src/evok-cli.ts",
  "src/second-toy-adapter.ts",
  "src/baseline-track.ts",
  "src/branch-recovery.ts",
  "src/llm-propose-outer-min.ts",
  "src/mission-director.ts",
  "src/mission-draft.ts",
  "src/mission-intake.ts",
  "src/mission-resume.ts",
  "src/mission-start.ts",
  "src/outer-e2e-min-path.ts",
  "src/outer-min-path.ts",
  "src/research-loop.ts",
  "src/v1-golden-path.ts",
  "src/hypothesis-ledger.ts",
  "src/kill-test-hang.ts",
  "src/ledger-kinds.ts",
  "src/methodology-acceptance.ts",
  "src/methodology-contracts.ts",
  "src/methodology.ts",
  "src/submission-broker.ts",
  "src/validation-ladder.ts",
  "src/verification-gates.ts",
  "src/dag-scheduler.ts",
  "src/model-orchestra.ts",
  "src/pi-agent-runtime.ts",
  "src/security-boundary.ts",
  "src/team-execution.ts",
  "src/outer-search-space-fixtures.ts",
  "src/search-selection-port.ts",
  "src/search-space-profile.ts",
  "src/toy-harness.ts",
  "src/llm-comp-arm-before-promotion.ts",
  "src/llm-competition-runtime.ts",
  "src/evidence/research-memory.ts",
  "src/execution/memory-slice.ts",
  "src/execution/research-memory-provider.ts",
  "src/cli/evok-platform-plugin.ts",
  "src/cli/evok-platform-plugin.test.ts",
  "src/cli/evok-research-plugin.ts",
  "src/cli/evok-research-plugin.test.ts",
  "src/cli/evok-eval-plugin.ts",
  "src/cli/evok-eval-plugin.test.ts",
  "plugins/evok-platform/package.json",
  "plugins/evok-research/package.json",
  "plugins/evok-eval/package.json",
] as const;

const STALE_CLAIMS = [
  "migration-period re-export",
  "for one more release",
  "Compatibility shims persist",
  "createFacetHost",
  "createStaticFacetLoader",
  "declareEvokPlatformPlugin",
  "declareEvokResearchPlugin",
  "declareEvokEvalPlugin",
  "loadEvokPlatformPlugin",
  "loadEvokResearchPlugin",
  "loadEvokEvalPlugin",
  "evok-platform-plugin",
  "evok-research-plugin",
  "evok-eval-plugin",
  "plugins/evok-platform",
  "plugins/evok-research",
  "plugins/evok-eval",
  "src/cli/*-plugin.ts",
  "Chord multi-plugin",
] as const;

describe("layout simplification stays honest", () => {
  test("the single plugin entry still loads the three seat locks without a seat package on disk", async () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      pi?: { extensions?: string[] };
    };
    expect(packageJson.dependencies?.["@earendil-works/chord"]).toBeUndefined();
    expect(packageJson.pi?.extensions).toEqual(["./extensions/evok.ts"]);
    expect(existsSync(join(ROOT, "plugins/evok-platform"))).toBe(false);
    expect(existsSync(join(ROOT, "plugins/evok-research"))).toBe(false);
    expect(existsSync(join(ROOT, "plugins/evok-eval"))).toBe(false);

    const plugin = await loadEvokPlugin({
      repoRoot: join(ROOT, "missing-seat-packages"),
      facets: "session",
    });
    try {
      expect(plugin.declaration).toEqual({
        pluginId: "evok",
        packageName: "evok",
        experimental: true,
        changelogOfficialHotPlug: false,
        modules: ["platform", "research", "eval"],
      });
      expect(plugin.modules.platform.seat).toMatchObject({
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
      expect(plugin.modules.research.seat).toMatchObject({
        pluginId: "evok-research",
        defaultSelectionId: "fixed_uct",
        selectionPolicy40: "off",
        progressiveDefault: "off",
        eliteIsPromotion: false,
      });
      expect(plugin.modules.eval.seat).toMatchObject({
        pluginId: "evok-eval",
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
    } finally {
      await plugin.dispose();
    }

    const withTui = await loadEvokPlugin({ facets: "session+tui" });
    try {
      expect(withTui.tuiCommands.map((command) => command.name)).toEqual([
        "evok-platform",
        "evok-research",
        "evok-eval",
      ]);
    } finally {
      await withTui.dispose();
    }
  });

  test("living docs do not cite retired shim or Chord seat paths as present", () => {
    const violations: string[] = [];
    for (const rel of LIVING_DOCS) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const claim of STALE_CLAIMS) {
        if (text.includes(claim)) violations.push(`${rel}: ${claim}`);
      }
      for (const retired of RETIRED_PATHS) {
        if (text.includes(retired)) violations.push(`${rel}: ${retired}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("ADR-0013 and ADR-0016 record that the forwarding shims are gone and the file store remains", () => {
    const closeout = readFileSync(join(ROOT, "docs/adr/0013-six-pack-physical-closeout.md"), "utf8");
    const memory = readFileSync(join(ROOT, "docs/adr/0016-memory-physical-pack.md"), "utf8");
    const ownership = readFileSync(join(ROOT, "docs/adr/0007-six-pack-ownership.md"), "utf8");
    expect(closeout).toContain("Later note (2026-11-14 layout simplification)");
    expect(closeout).toContain("are deleted");
    expect(memory).toContain("Later note (2026-11-14 layout simplification)");
    expect(memory).toContain("file-store rollback remains");
    expect(ownership).toContain("Later note (2026-11-14 layout simplification)");
    for (const rel of [
      "docs/adr/0008-evidence-physical-pack.md",
      "docs/adr/0009-search-physical-pack.md",
      "docs/adr/0010-mission-cli-physical-pack.md",
      "docs/adr/0011-execution-physical-pack.md",
      "docs/adr/0012-competition-physical-pack.md",
    ]) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text).toContain("Later note (2026-11-14 layout simplification)");
      expect(text).toContain("those flat re-exports are deleted");
    }
  });
});
