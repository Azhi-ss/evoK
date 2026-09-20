/**
 * ET-ORCH-GAP / #99 — StrongSearch opt-in port (default still `fixed_uct`).
 *
 * Seams: resolveSearchSelection / createSearchSelectionPort /
 * optInStrongSearchPort / mountStrongSearchOptIn / SeaHost.defaultSelection /
 * runSuiteLiftCircle.
 *
 * StrongSearch is an explicit alias of the existing Progressive adapter.
 * Product default stays `fixed_uct`. Progressive stays opt-in / off.
 * Env never flips the default. Elite ≠ 晋级.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  DEFAULT_UCT_EXPLORATION,
  FixedUctSelectionAdapter,
  ProgressiveMcgsOptInAdapter,
  SELECTION_POLICY_40,
  STRONG_SEARCH_OPT_IN_ID,
  StrongSearchAdapter,
  createDefaultSearchSelectionPort,
  createSearchSelectionPort,
  type SearchParentCandidate,
} from "./search-selection-port";
import { readSearchSelectionConfig, resolveSearchSelection } from "./progressive-opt-in";
import {
  mountStrongSearchOptIn,
  optInStrongSearchPort,
} from "./strong-search-opt-in";
import { createSeaHost } from "./sea-plugin";
import { runSuiteLiftCircle } from "./suite-lift-circle";

const WORKED: readonly SearchParentCandidate[] = [
  { nodeId: "a", visits: 10, value: 0.8, parentVisits: 20 },
  { nodeId: "b", visits: 2, value: 0.5, parentVisits: 20 },
  { nodeId: "c", visits: 8, value: 0.6, parentVisits: 20 },
];

const WITH_UNVISITED: readonly SearchParentCandidate[] = [
  ...WORKED,
  { nodeId: "fresh", visits: 0, value: 0, parentVisits: 20 },
];

function withEnv(vars: Record<string, string>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("strong-search port stays opt-in; default path unchanged", () => {
  test("unnamed factory and resolver stay fixed_uct / Progressive off", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
    expect(STRONG_SEARCH_OPT_IN_ID).toBe("strong_search");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(createSearchSelectionPort().id).toBe("fixed_uct");
    expect(createSearchSelectionPort().selectParent({ nodes: WORKED }).parentId).toBe("b");

    const resolved = resolveSearchSelection();
    expect(resolved.selectionId).toBe("fixed_uct");
    expect(resolved.selectionPolicy40).toBe("off");
    expect(resolved.productDefault).toBe(true);
    expect(resolved.anneal).toBe(false);
    expect(resolved.port).toBeInstanceOf(FixedUctSelectionAdapter);
    expect(resolved.port).not.toBeInstanceOf(StrongSearchAdapter);
  });

  test("empty / false strongSearch fields do not opt in", () => {
    for (const source of [
      {},
      { strongSearch: false },
      { selectionId: "fixed_uct" },
      { searchSelection: "fixed_uct" },
      { mission: {} },
      { config: { strongSearch: false } },
    ]) {
      const resolved = resolveSearchSelection(source);
      expect(resolved.selectionId).toBe("fixed_uct");
      expect(resolved.selectionPolicy40).toBe("off");
      expect(resolved.productDefault).toBe(true);
    }
  });

  test("env never mounts StrongSearch or Progressive", () => {
    withEnv({
      EVOK_SEARCH_SELECTION: "strong_search",
      EVOK_STRONG_SEARCH: "1",
      EVOK_PROGRESSIVE: "1",
      SELECTION_POLICY: "on",
    }, () => {
      const resolved = resolveSearchSelection();
      expect(resolved.selectionId).toBe("fixed_uct");
      expect(resolved.selectionPolicy40).toBe("off");
      expect(createSearchSelectionPort().id).toBe("fixed_uct");
      expect(createSeaHost().defaultSelection().id).toBe("fixed_uct");
    });
  });
});

describe("explicit StrongSearch opt-in is callable and is not the product default", () => {
  test("Mission strongSearch: true uses StrongSearchAdapter without flipping the default port", () => {
    const opted = resolveSearchSelection({ strongSearch: true, topK: 1, tau: 8, seed: 7, t: 8 }, { from: "mission" });
    expect(opted.productDefault).toBe(false);
    expect(opted.source).toBe("mission");
    expect(opted.anneal).toBe(true);
    expect(opted.selectionPolicy40).toBe("opt-in");
    expect(opted.port).toBeInstanceOf(StrongSearchAdapter);
    expect(opted.port).toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(opted.port.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");

    const def = resolveSearchSelection();
    expect(def.selectionId).toBe("fixed_uct");
    expect(def.selectionPolicy40).toBe("off");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
  });

  test("selectionId / searchSelection strong_search and createSearchSelectionPort alias opt in", () => {
    expect(resolveSearchSelection({ selectionId: "strong_search" }).port).toBeInstanceOf(StrongSearchAdapter);
    expect(resolveSearchSelection({ searchSelection: "strong_search" }).anneal).toBe(true);
    expect(resolveSearchSelection({ mission: { searchSelection: { strongSearch: true, topK: 1 } } }).productDefault)
      .toBe(false);

    const aliased = createSearchSelectionPort("strong_search", { topK: 1, tau: 8, seed: 7 });
    expect(aliased).toBeInstanceOf(StrongSearchAdapter);
    expect(aliased.id).toBe("progressive_mcgs_optin");
    expect(aliased.describe().productDefault).toBe(false);
    expect(aliased.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");
  });

  test("optInStrongSearchPort / SEA mount leave host defaultSelection on fixed_uct", () => {
    const port = optInStrongSearchPort({ topK: 1, tau: 8, seed: 7 });
    expect(port).toBeInstanceOf(StrongSearchAdapter);
    expect(port.describe().productDefault).toBe(false);
    expect(port.schedule?.(8)?.exploration).toBe(DEFAULT_UCT_EXPLORATION / 2);

    const { host, port: mounted } = mountStrongSearchOptIn();
    expect(host.mounted()?.kind).toBe("strong_search");
    expect(mounted).toBeInstanceOf(StrongSearchAdapter);
    expect(host.defaultSelection().id).toBe("fixed_uct");
    expect(host.defaultSelection().selectParent({ nodes: WORKED }).parentId).toBe("b");
  });
});

describe("project search.json strongSearch is explicit file opt-in", () => {
  test("missing file stays default; { strongSearch: true } opts in", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-strong-search-"));
    try {
      withEnv({ EVOK_SEARCH_SELECTION: "strong_search" }, () => {
        expect(readSearchSelectionConfig(project)).toBeUndefined();
        expect(resolveSearchSelection(readSearchSelectionConfig(project)).selectionId).toBe("fixed_uct");
      });
      await mkdir(join(project, ".evok"), { recursive: true });
      await writeFile(join(project, ".evok", "search.json"), `${JSON.stringify({
        strongSearch: true,
        topK: 1,
        tau: 8,
        seed: 7,
      }, null, 2)}\n`);
      const config = readSearchSelectionConfig(project);
      expect(config).toEqual({ strongSearch: true, topK: 1, tau: 8, seed: 7 });
      const resolved = resolveSearchSelection(config, { from: "config" });
      expect(resolved.port).toBeInstanceOf(StrongSearchAdapter);
      expect(resolved.selectionPolicy40).toBe("opt-in");
      expect(resolved.port.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("suite-lift default stays fixed_uct; strongSearch is explicit", () => {
  test("default circle is unchanged; strongSearch opt-in is callable", () => {
    const baselineFiles = { "src/solve.js": "module.exports = {};" };
    const def = runSuiteLiftCircle({ baselineFiles });
    expect(def.selectionId).toBe("fixed_uct");
    expect(def.selectionPolicy40).toBe("off");

    const opted = runSuiteLiftCircle({
      baselineFiles,
      searchSelection: { strongSearch: true, topK: 1, tau: 8, seed: 7, t: 8 },
    });
    expect(opted.selectionId).toBe("progressive_mcgs_optin");
    expect(opted.selectionPolicy40).toBe("opt-in");
    expect(opted.selection.adapterId).toBe("progressive_mcgs_optin");
  });
});
