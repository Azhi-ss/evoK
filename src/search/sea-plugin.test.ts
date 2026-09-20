/**
 * ET-M1-SEA / #146 — removable SEA plugin contract.
 *
 * Seams: createSeaHost mount / unmount / defaultSelection / optInSelection.
 * Default parent selection stays `fixed_uct` and does not depend on a plugin.
 * Progressive / MCTS / StrongSearch stay explicit opt-in. `#40` stays off.
 */
import { describe, expect, test } from "bun:test";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { BudgetLedger } from "../evidence/budget-gate";
import { HypothesisLedger, T48MappedCatalog } from "../hypothesis-ledger";
import { runKillTestHang } from "../kill-test-hang";
import { EvidenceMemory } from "../research-loop";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  DEFAULT_UCT_EXPLORATION,
  FixedUctSelectionAdapter,
  ProgressiveMcgsOptInAdapter,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
  type SearchParentCandidate,
  type SearchSelectionContext,
} from "./search-selection-port";
import type { ToyCompetitionAdapter } from "../toy-harness";
import {
  SeaPluginNotMountedError,
  SeaPluginSelectionNotOpenedError,
  createMctsSeaPlugin,
  createProgressiveSeaPlugin,
  createSeaHost,
  createStrongSearchSeaPlugin,
} from "./sea-plugin";

/**
 * Independent ranking at constant c = √2, parent visits N = 20:
 * A (Q=0.8, n=10) well-visited exploit; B (Q=0.5, n=2) exploration dominates.
 */
const WORKED: readonly SearchParentCandidate[] = [
  { nodeId: "a", visits: 10, value: 0.8, parentVisits: 20, lineage: ["root", "a"] },
  { nodeId: "b", visits: 2, value: 0.5, parentVisits: 20, lineage: ["root", "b"] },
  { nodeId: "c", visits: 8, value: 0.6, parentVisits: 20, lineage: ["root", "c"] },
];

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

function smuggledOuterPorts() {
  const calls = { ledger: 0, hang: 0, broker: 0 };
  return {
    calls,
    ledger: {
      createHypothesis() {
        calls.ledger += 1;
        throw new Error("SEA plugin must not call HypothesisLedger");
      },
    },
    killTestHang() {
      calls.hang += 1;
      throw new Error("SEA plugin must not call Kill-test hang");
    },
    broker() {
      calls.broker += 1;
      throw new Error("SEA plugin must not call Broker");
    },
  };
}

describe("SEA default path does not depend on a plugin", () => {
  test("unmounted host selects with fixed_uct and matches the product default", () => {
    const host = createSeaHost();
    const port = host.defaultSelection();
    const selected = port.selectParent({ nodes: WORKED });

    expect(host.mounted()).toBeUndefined();
    expect(host.describe()).toMatchObject({
      defaultSelectionId: "fixed_uct",
      selectionPolicy40: "off",
      pluginMounted: false,
    });
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
    expect(port).toBeInstanceOf(FixedUctSelectionAdapter);
    expect(port).not.toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(port.id).toBe("fixed_uct");
    expect(selected.parentId).toBe("b");
    expect(selected.adapterId).toBe("fixed_uct");
    expect(selected.exploration).toBe(DEFAULT_UCT_EXPLORATION);
    expect(createDefaultSearchSelectionPort().selectParent({ nodes: WORKED }).parentId).toBe("b");
  });

  test("mount then unmount leaves the default path identical to never-mounted", () => {
    const neverMounted = createSeaHost().defaultSelection().selectParent({ nodes: WORKED });
    const host = createSeaHost();
    const plugin = createMctsSeaPlugin();

    const mounted = host.mount(plugin);
    expect(mounted.pluginId).toBe("mcts");
    expect(mounted.kind).toBe("mcts");
    expect(host.mounted()?.pluginId).toBe("mcts");
    expect(host.defaultSelection().id).toBe("fixed_uct");
    expect(host.defaultSelection().selectParent({ nodes: WORKED }).parentId).toBe("b");
    expect(host.defaultSelection()).not.toBeInstanceOf(ProgressiveMcgsOptInAdapter);

    host.unmount();
    const afterUnmount = host.defaultSelection().selectParent({ nodes: WORKED });
    expect(host.mounted()).toBeUndefined();
    expect(host.describe().pluginMounted).toBe(false);
    expect(afterUnmount).toEqual(neverMounted);
    expect(afterUnmount.parentId).toBe("b");
    expect(afterUnmount.adapterId).toBe("fixed_uct");
  });

  test("env and #40 do not silently mount Progressive or MCTS", () => {
    const previous = {
      EVOK_SEARCH_SELECTION: process.env.EVOK_SEARCH_SELECTION,
      EVOK_SEA_PLUGIN: process.env.EVOK_SEA_PLUGIN,
      EVOK_SELECTION_POLICY: process.env.EVOK_SELECTION_POLICY,
      SELECTION_POLICY: process.env.SELECTION_POLICY,
    };
    process.env.EVOK_SEARCH_SELECTION = "progressive_mcgs_optin";
    process.env.EVOK_SEA_PLUGIN = "mcts";
    process.env.EVOK_SELECTION_POLICY = "on";
    process.env.SELECTION_POLICY = "on";
    try {
      const host = createSeaHost();
      expect(host.mounted()).toBeUndefined();
      expect(host.defaultSelection().id).toBe("fixed_uct");
      expect(host.describe().selectionPolicy40).toBe("off");
      expect(SELECTION_POLICY_40).toBe("off");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("SEA Progressive / MCTS / StrongSearch stay explicit opt-in", () => {
  test("opt-in without a mounted plugin is refused", () => {
    const host = createSeaHost();
    expect(() => host.optInSelection()).toThrow(SeaPluginNotMountedError);
    expect(() => host.optInSelection()).toThrow(/not mounted|unmount|plugin/i);
    expect(host.defaultSelection().id).toBe("fixed_uct");
  });

  test("MCTS mount is expressible but does not open selection math or become the default", () => {
    const host = createSeaHost();
    host.mount(createMctsSeaPlugin());
    expect(host.mounted()?.kind).toBe("mcts");
    expect(host.defaultSelection().id).toBe("fixed_uct");
    expect(() => host.optInSelection()).toThrow(SeaPluginSelectionNotOpenedError);
    expect(() => host.optInSelection()).toThrow(/not opened|skeleton|selection math/i);
    host.unmount();
    expect(host.mounted()).toBeUndefined();
    expect(() => host.optInSelection()).toThrow(SeaPluginNotMountedError);
  });

  test("explicit Progressive plugin opt-in uses c(t) decay and is not the product default", () => {
    const host = createSeaHost();
    host.mount(createProgressiveSeaPlugin());
    const optIn = host.optInSelection({ topK: 1, tau: 8, seed: 7 });
    expect(optIn).toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(optIn.id).toBe("progressive_mcgs_optin");
    expect(optIn.describe().productDefault).toBe(false);
    expect(optIn.describe().selectionPolicy40).toBe("opt-in");
    expect(host.defaultSelection().id).toBe("fixed_uct");
    expect(host.defaultSelection().selectParent({ nodes: WORKED }).parentId).toBe("b");

    const withFresh: readonly SearchParentCandidate[] = [
      ...WORKED,
      { nodeId: "fresh", visits: 0, value: 0, parentVisits: 20 },
    ];
    expect(optIn.selectParent({ nodes: withFresh, t: 0 }).parentId).toBe("fresh");
    expect(optIn.selectParent({ nodes: withFresh, t: 8 }).parentId).toBe("a");
  });

  test("StrongSearch plugin is the same explicit opt-in alias, not a second default", () => {
    const host = createSeaHost();
    host.mount(createStrongSearchSeaPlugin());
    expect(host.mounted()?.kind).toBe("strong_search");
    const optIn = host.optInSelection({ topK: 1, tau: 8, seed: 7 });
    expect(optIn).toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(host.defaultSelection().id).toBe("fixed_uct");
  });

  test("a second mount is refused until unmount", () => {
    const host = createSeaHost();
    host.mount(createMctsSeaPlugin());
    expect(() => host.mount(createProgressiveSeaPlugin())).toThrow(/unmount/i);
    expect(host.mounted()?.kind).toBe("mcts");
    host.unmount();
    host.mount(createProgressiveSeaPlugin());
    expect(host.mounted()?.kind).toBe("progressive_mcgs_optin");
  });
});

describe("SEA plugin is not a gate, ToyHarness, or promotion key", () => {
  test("Elite / MMD / near-dup / side-slot fields are rejected on mount and describe", () => {
    const host = createSeaHost();
    expect(() => host.mount({
      id: "mcts",
      kind: "mcts",
      eliteScore: 0.99,
    } as ReturnType<typeof createMctsSeaPlugin> & { readonly eliteScore: number })).toThrow(
      /Elite|MMD|near-dup|side-slot|promotion/i,
    );
    host.mount(createMctsSeaPlugin());
    const description = host.describe();
    for (const field of PROMOTION_KEY_FIELDS) {
      expect(description).not.toHaveProperty(field);
    }
    expect(description).not.toHaveProperty("eliteScore");
  });

  test("does not call HypothesisLedger, Kill-test hang, or Broker", () => {
    const ports = smuggledOuterPorts();
    const host = createSeaHost();
    host.mount({
      ...createMctsSeaPlugin(),
      ...ports,
    } as ReturnType<typeof createMctsSeaPlugin> & typeof ports);
    const selected = host.defaultSelection().selectParent({
      nodes: WORKED,
      ...ports,
    } as SearchSelectionContext & typeof ports);
    expect(selected.parentId).toBe("b");
    expect(ports.calls).toEqual({ ledger: 0, hang: 0, broker: 0 });
    expect(typeof runKillTestHang).toBe("function");

    const catalog = T48MappedCatalog.fromMemory(new EvidenceMemory(), [{ artifactId: "art-score" }]);
    expect(() => catalog.map(host.describe())).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    const ledger = new HypothesisLedger({ catalog });
    expect(() => ledger.createHypothesis({
      statement: "SEA describe must not promote",
      evidenceRefs: [host.describe()],
    })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
  });

  test("is not a ToyCompetitionAdapter and does not evaluate", () => {
    const host = createSeaHost();
    expect("evaluate" in host).toBe(false);
    expect(typeof (host as unknown as ToyCompetitionAdapter).evaluate).toBe("undefined");
    expect(host.describe().role).toBe("search-plugin-host");
  });

  test("does not change EXP Admission or Budget Gate predicates", () => {
    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [
          { kind: "official_samples", present: true, outcome: "pass" },
          { kind: "adversarial_labeled", present: true, outcome: "pass" },
        ],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
    });
    expect(admission.admitted).toBe(false);
    expect(admission.outcome).toBe("fail");
    expect(admission.objections.join(" ")).toMatch(/protected holdout/i);

    const ledger = new BudgetLedger({ total: 1, units: "model-USD" });
    const unauthorized = ledger.authorize("continue");
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.reason).toBe("unreserved");
  });
});
