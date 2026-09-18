import { describe, expect, test } from "bun:test";
import { HypothesisLedger, T48MappedCatalog } from "../hypothesis-ledger";
import { runKillTestHang } from "../kill-test-hang";
import { EvidenceMemory } from "../research-loop";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  DEFAULT_UCT_EXPLORATION,
  FixedUctSelectionAdapter,
  ProgressiveMcgsOptInAdapter,
  SEARCH_SELECTION_SCHEMA_VERSION,
  SELECTION_POLICY_40,
  StrongSearchAdapter,
  createDefaultSearchSelectionPort,
  createSearchSelectionPort,
  type SearchParentCandidate,
  type SearchSelectionContext,
} from "./search-selection-port";
import type { ToyCompetitionAdapter } from "../toy-harness";

/**
 * Independent ranking at constant c = √2, parent visits N = 20:
 * A (Q=0.8, n=10) well-visited exploit; B (Q=0.5, n=2) exploration dominates;
 * C (Q=0.6, n=8) in between. Constant-exploration UCT therefore selects B.
 */
const WORKED: readonly SearchParentCandidate[] = [
  { nodeId: "a", visits: 10, value: 0.8, parentVisits: 20, lineage: ["root", "a"], failNote: "slow fold" },
  { nodeId: "b", visits: 2, value: 0.5, parentVisits: 20, lineage: ["root", "b"] },
  { nodeId: "c", visits: 8, value: 0.6, parentVisits: 20, lineage: ["root", "c"] },
];

const WITH_UNVISITED: readonly SearchParentCandidate[] = [
  ...WORKED,
  { nodeId: "fresh", visits: 0, value: 0, parentVisits: 20 },
];

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
] as const;

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function smuggledOuterPorts() {
  const calls = { ledger: 0, hang: 0, broker: 0, uct: 0 };
  return {
    calls,
    expandRequested: true,
    ledger: {
      createHypothesis() {
        calls.ledger += 1;
        throw new Error("SearchSelectionPort must not call HypothesisLedger");
      },
    },
    killTestHang() {
      calls.hang += 1;
      throw new Error("SearchSelectionPort must not call Kill-test hang");
    },
    broker() {
      calls.broker += 1;
      throw new Error("SearchSelectionPort must not call Broker");
    },
    uct() {
      calls.uct += 1;
      throw new Error("outer expand_requested must not drive UCT");
    },
  };
}

describe("default SearchSelectionPort is fixed_uct", () => {
  test("factory and FixedUctSelectionAdapter use constant exploration √2 and match select_node UCT", () => {
    const port = createDefaultSearchSelectionPort();
    const explicit = createSearchSelectionPort();
    const adapter = new FixedUctSelectionAdapter();

    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(DEFAULT_UCT_EXPLORATION).toBe(Math.SQRT2);
    expect(SELECTION_POLICY_40).toBe("off");
    expect(port.id).toBe("fixed_uct");
    expect(explicit.id).toBe("fixed_uct");
    expect(adapter.schema_version).toBe(SEARCH_SELECTION_SCHEMA_VERSION);
    expect(port).toBeInstanceOf(FixedUctSelectionAdapter);
    expect(port).not.toBeInstanceOf(ProgressiveMcgsOptInAdapter);

    const selected = port.selectParent({ nodes: WORKED });
    expect(selected.parentId).toBe("b");
    expect(selected.adapterId).toBe("fixed_uct");
    expect(selected.exploration).toBe(Math.SQRT2);
    expect(adapter.selectParent({ nodes: WORKED }).parentId).toBe("b");
    expect(explicit.selectParent({ nodes: WORKED }).parentId).toBe("b");

    const description = port.describe();
    expect(description).toMatchObject({
      id: "fixed_uct",
      kind: "fixed_uct",
      productDefault: true,
      selectionPolicy40: "off",
      exploration: Math.SQRT2,
      explorationMode: "constant",
      role: "parent-selection",
    });
    expect(port.schedule?.(0)).toEqual({ exploration: Math.SQRT2, eliteWeight: 0 });
    expect(port.schedule?.(99)).toEqual({ exploration: Math.SQRT2, eliteWeight: 0 });
  });

  test("unvisited candidates are preferred and low constant exploration is not the product default", () => {
    const def = createDefaultSearchSelectionPort();
    expect(def.selectParent({ nodes: WITH_UNVISITED }).parentId).toBe("fresh");
    expect(new FixedUctSelectionAdapter({ exploration: 0.1 }).selectParent({ nodes: WORKED }).parentId).toBe("a");
    expect(createDefaultSearchSelectionPort().selectParent({ nodes: WORKED }).parentId).toBe("b");
  });
});

describe("progressive_mcgs_optin is constructed only when selected", () => {
  test("is not the product default and env / #40 do not weld it on", () => {
    const previous = {
      EVOK_SEARCH_SELECTION: process.env.EVOK_SEARCH_SELECTION,
      EVOK_SELECTION_POLICY: process.env.EVOK_SELECTION_POLICY,
      SELECTION_POLICY: process.env.SELECTION_POLICY,
    };
    process.env.EVOK_SEARCH_SELECTION = "progressive_mcgs_optin";
    process.env.EVOK_SELECTION_POLICY = "progressive_mcgs_optin";
    process.env.SELECTION_POLICY = "on";
    try {
      const def = createDefaultSearchSelectionPort();
      const unnamed = createSearchSelectionPort();
      expect(def.id).toBe("fixed_uct");
      expect(unnamed.id).toBe("fixed_uct");
      expect(def).not.toBeInstanceOf(ProgressiveMcgsOptInAdapter);
      expect(SELECTION_POLICY_40).toBe("off");
      expect(def.describe().selectionPolicy40).toBe("off");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("explicit Progressive / StrongSearchAdapter uses c(t) decay and Elite soft-switch", () => {
    const optIn = createSearchSelectionPort("progressive_mcgs_optin", { topK: 1, tau: 8, seed: 7 });
    const strong = new StrongSearchAdapter({ topK: 1, tau: 8, seed: 7 });
    expect(optIn).toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(optIn).toBeInstanceOf(StrongSearchAdapter);
    expect(optIn.id).toBe("progressive_mcgs_optin");
    expect(optIn.describe()).toMatchObject({
      id: "progressive_mcgs_optin",
      kind: "progressive_mcgs_optin",
      productDefault: false,
      selectionPolicy40: "off",
      explorationMode: "c(t) decay",
      role: "parent-selection",
      topK: 1,
    });

    expect(optIn.selectParent({ nodes: WITH_UNVISITED, t: 0 }).parentId).toBe("fresh");
    expect(optIn.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");
    expect(strong.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");

    const early = optIn.schedule?.(0);
    const late = optIn.schedule?.(8);
    expect(early?.exploration).toBe(Math.SQRT2);
    expect(early?.eliteWeight).toBe(0);
    expect(late?.eliteWeight).toBe(1);
    expect(late?.exploration).toBeLessThan(Math.SQRT2);
  });

  test("opt-in path is reproducible with a fixed seed", () => {
    const left = new ProgressiveMcgsOptInAdapter({ topK: 2, tau: 8, seed: 42 });
    const right = new ProgressiveMcgsOptInAdapter({ topK: 2, tau: 8, seed: 42 });
    const other = new ProgressiveMcgsOptInAdapter({ topK: 2, tau: 8, seed: 99 });
    const ctx = { nodes: WORKED, t: 8 };
    const first = left.selectParent(ctx);
    const second = right.selectParent(ctx);
    expect(first.parentId).toBe(second.parentId);
    expect(first).toEqual(second);
    expect(["a", "c"]).toContain(first.parentId);
    expect(first.parentId).not.toBe("b");
    const ctxSeed = left.selectParent({ ...ctx, seed: 42 });
    expect(ctxSeed.parentId).toBe(first.parentId);
    expect(other.selectParent(ctx).parentId).toMatch(/^[ac]$/);
  });
});

describe("Elite / diagnostic scores are not promotion keys", () => {
  test("Elite path does not emit promotion / Broker / Kill-test keys", () => {
    const port = new ProgressiveMcgsOptInAdapter({ topK: 1, tau: 8, seed: 1 });
    const selected = port.selectParent({
      nodes: WITH_UNVISITED,
      t: 8,
      eliteScore: 0.99,
      mmd: 0.12,
      sideSlot: 0.4,
      nearDup: 0.01,
    } as SearchSelectionContext & {
      readonly eliteScore: number;
      readonly mmd: number;
      readonly sideSlot: number;
      readonly nearDup: number;
    });
    const description = port.describe();

    expect(selected.parentId).toBe("a");
    expect(selected.lineage).toEqual(["root", "a"]);
    expect(selected.failNote).toBe("slow fold");
    for (const field of PROMOTION_KEY_FIELDS) {
      expect(selected).not.toHaveProperty(field);
      expect(description).not.toHaveProperty(field);
    }
    expect(selected).not.toHaveProperty("eliteScore");
    expect(selected).not.toHaveProperty("embedding");
    expect(selected).not.toHaveProperty("faiss");
    expect(selected).not.toHaveProperty("vector");

    const catalog = catalogWithMappedIds();
    expect(() => catalog.map(selected)).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    expect(() => catalog.map(description)).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    const ledger = new HypothesisLedger({ catalog });
    expect(() => ledger.createHypothesis({
      statement: "elite must not promote",
      evidenceRefs: [selected],
    })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
  });
});

describe("SearchSelectionPort isolation", () => {
  test("does not call HypothesisLedger, Kill-test hang, or Broker and ignores expand_requested", () => {
    const ports = smuggledOuterPorts();
    const fixed = createDefaultSearchSelectionPort();
    const progressive = new ProgressiveMcgsOptInAdapter({ topK: 1, tau: 8 });
    const ctx = {
      nodes: WORKED,
      ...ports,
    } as SearchSelectionContext & typeof ports;

    expect(fixed.selectParent(ctx).parentId).toBe("b");
    expect(fixed.selectParent({ nodes: WORKED }).parentId).toBe("b");
    expect(progressive.selectParent({ ...ctx, t: 0 }).parentId).toBe("b");
    expect(ports.calls).toEqual({ ledger: 0, hang: 0, broker: 0, uct: 0 });
    expect(typeof runKillTestHang).toBe("function");
  });

  test("is not a ToyCompetitionAdapter eval port", () => {
    const selection = createDefaultSearchSelectionPort();
    expect("evaluate" in selection).toBe(false);
    expect(typeof (selection as unknown as ToyCompetitionAdapter).evaluate).toBe("undefined");
    expect(selection.describe().role).toBe("parent-selection");
  });

  test("keeps failure memory to parent lineage plus an optional short fail_note", () => {
    const selected = createDefaultSearchSelectionPort().selectParent({
      nodes: WORKED,
      embedding: [0.1, 0.2],
      faiss: { index: "transplant" },
    } as SearchSelectionContext & { readonly embedding: readonly number[]; readonly faiss: { readonly index: string } });
    expect(selected.parentId).toBe("b");
    expect(selected.lineage).toEqual(["root", "b"]);
    expect(selected.failNote).toBeUndefined();
    expect(selected).not.toHaveProperty("embedding");
    expect(selected).not.toHaveProperty("faiss");
    expect(() => createDefaultSearchSelectionPort().selectParent({
      nodes: [{ nodeId: "a", visits: 1, value: 0.2, failNote: "x".repeat(281) }],
    })).toThrow(/fail_note|failNote|short/i);
  });
});
