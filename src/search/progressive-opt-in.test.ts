/**
 * ET-PROG-40 / #178 — Progressive #40 opt-in (default still `fixed_uct`).
 *
 * Seams: resolveSearchSelection / readSearchSelectionConfig /
 * SearchSelectionPort.selectParent+schedule / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang / T48MappedCatalog.
 *
 * Product default stays off. Mission or config must opt in explicitly.
 * Env must not silently flip the default. Elite ≠ 晋级 / Promotion /
 * Admission / Broker / kill-test key — inner parent selection only.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "../evidence/budget-gate";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { HypothesisLedger, T48MappedCatalog } from "../evidence/hypothesis-ledger";
import { runKillTestHang } from "../evidence/kill-test-hang";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { EvidenceMemory } from "../mission/research-loop";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  DEFAULT_UCT_EXPLORATION,
  FixedUctSelectionAdapter,
  PROGRESSIVE_MCGS_OPT_IN_ID,
  ProgressiveMcgsOptInAdapter,
  SELECTION_POLICY_40,
  SELECTION_POLICY_40_OPT_IN,
  createDefaultSearchSelectionPort,
  createSearchSelectionPort,
  type SearchParentCandidate,
} from "./search-selection-port";
import {
  ELITE_IS_NOT_JINJI,
  ELITE_ROLE_WHEN_OPTED_IN,
  readSearchSelectionConfig,
  resolveSearchSelection,
} from "./progressive-opt-in";
import { runSuiteLiftCircle } from "./suite-lift-circle";

/**
 * Independent ranking at constant c = √2, parent visits N = 20:
 * A (Q=0.8, n=10) well-visited exploit; B (Q=0.5, n=2) exploration dominates.
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
  "eliteScore",
] as const;

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

describe("product default stays fixed_uct / #40 Progressive OFF", () => {
  test("resolver with no Mission/config stays fixed_uct and does not invent Progressive", () => {
    const resolved = resolveSearchSelection();
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
    expect(resolved.selectionId).toBe("fixed_uct");
    expect(resolved.selectionPolicy40).toBe("off");
    expect(resolved.productDefault).toBe(true);
    expect(resolved.source).toBe("default");
    expect(resolved.anneal).toBe(false);
    expect(resolved.port).toBeInstanceOf(FixedUctSelectionAdapter);
    expect(resolved.port).not.toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(resolved.port.selectParent({ nodes: WORKED }).parentId).toBe("b");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(createSearchSelectionPort().id).toBe("fixed_uct");
  });

  test("empty Mission or config objects do not opt in", () => {
    for (const source of [{}, { progressive: false }, { selectionId: "fixed_uct" }, { mission: {} }, { config: {} }]) {
      const resolved = resolveSearchSelection(source);
      expect(resolved.selectionId).toBe("fixed_uct");
      expect(resolved.selectionPolicy40).toBe("off");
      expect(resolved.productDefault).toBe(true);
      expect(resolved.anneal).toBe(false);
    }
  });
});

describe("env must not silently flip the default", () => {
  test("EVOK_* / SELECTION_POLICY do not weld Progressive or #40 on", () => {
    withEnv({
      EVOK_SEARCH_SELECTION: "progressive_mcgs_optin",
      EVOK_SELECTION_POLICY: "on",
      EVOK_PROGRESSIVE: "1",
      SELECTION_POLICY: "on",
    }, () => {
      const resolved = resolveSearchSelection();
      expect(resolved.selectionId).toBe("fixed_uct");
      expect(resolved.selectionPolicy40).toBe("off");
      expect(resolved.port).toBeInstanceOf(FixedUctSelectionAdapter);
      expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
      expect(createSearchSelectionPort().id).toBe("fixed_uct");
      expect(SELECTION_POLICY_40).toBe("off");
    });
  });
});

describe("Mission or config must explicitly opt in", () => {
  test("Mission progressive: true enables anneal c(t) + Elite soft-switch", () => {
    const resolved = resolveSearchSelection({ progressive: true }, { from: "mission" });
    expect(resolved.selectionId).toBe(PROGRESSIVE_MCGS_OPT_IN_ID);
    expect(resolved.selectionPolicy40).toBe(SELECTION_POLICY_40_OPT_IN);
    expect(resolved.productDefault).toBe(false);
    expect(resolved.source).toBe("mission");
    expect(resolved.anneal).toBe(true);
    expect(resolved.port).toBeInstanceOf(ProgressiveMcgsOptInAdapter);
    expect(resolved.port.describe()).toMatchObject({
      id: "progressive_mcgs_optin",
      productDefault: false,
      selectionPolicy40: "opt-in",
      explorationMode: "c(t) decay",
    });

    expect(resolved.port.selectParent({ nodes: WITH_UNVISITED, t: 0 }).parentId).toBe("fresh");
    const late = resolved.port.schedule?.(8);
    expect(late?.eliteWeight).toBe(1);
    expect(late?.exploration).toBe(DEFAULT_UCT_EXPLORATION / 2);
    expect(resolved.port.selectParent({ nodes: WITH_UNVISITED, t: 8, seed: 7 }).parentId).toBe("a");
    expect(resolveSearchSelection({ progressive: true, t: 8, seed: 7 }).t).toBe(8);
    expect(resolveSearchSelection({ progressive: true, t: 8, seed: 7 }).seed).toBe(7);
  });

  test("config selectionId progressive_mcgs_optin is an explicit opt-in", () => {
    const resolved = resolveSearchSelection(
      { selectionId: "progressive_mcgs_optin", tau: 8, topK: 1, seed: 7 },
      { from: "config" },
    );
    expect(resolved.source).toBe("config");
    expect(resolved.selectionPolicy40).toBe("opt-in");
    expect(resolved.port.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");
  });

  test("nested Mission.searchSelection / config.progressive objects opt in", () => {
    expect(resolveSearchSelection({ mission: { searchSelection: "progressive_mcgs_optin" } }).selectionId)
      .toBe("progressive_mcgs_optin");
    expect(resolveSearchSelection({ config: { progressive: { enabled: true, topK: 1 } } }).anneal)
      .toBe(true);
    expect(resolveSearchSelection({ selectionPolicy40: "opt-in" }).selectionPolicy40).toBe("opt-in");
  });

  test("explicit opt-in still leaves the product default port on fixed_uct", () => {
    const opted = resolveSearchSelection({ progressive: true });
    const def = resolveSearchSelection();
    expect(opted.selectionId).toBe("progressive_mcgs_optin");
    expect(def.selectionId).toBe("fixed_uct");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
  });
});

describe("Elite ≠ 晋级 / Promotion / Broker / kill-test key", () => {
  test("Spec writes Elite ≠ 晋级 and anneal formulas dead", async () => {
    const spec = await readFile(join(process.cwd(), "docs", "progressive-opt-in.md"), "utf8");
    expect(spec).toMatch(/Elite ≠ 晋级/);
    expect(spec).toMatch(/Promotion \/ Admission \/ Broker \/ kill-test/);
    expect(spec).toMatch(/c\(t\) = c0 \/ \(1 \+ t \/ tau\)/);
    expect(spec).toMatch(/w\(t\) = min\(1, t \/ tau\)/);
    expect(spec).toMatch(/product default remains/i);
    expect(spec).toMatch(/Environment variables never flip/i);
    const howTo = await readFile(join(process.cwd(), "docs", "how-to-use.md"), "utf8");
    expect(howTo).toMatch(/Elite ≠ 晋级/);
    expect(howTo).toMatch(/progressive-opt-in\.md/);
  });

  test("Spec pin: Elite is inner-selection only and is not 晋级", () => {
    expect(ELITE_IS_NOT_JINJI).toBe(true);
    expect(ELITE_ROLE_WHEN_OPTED_IN).toBe("inner-selection-only");
    const resolved = resolveSearchSelection({ progressive: true });
    expect(resolved.eliteInnerOnly).toBe(true);
    expect(resolved.eliteIsJinji).toBe(false);
    expect(resolved.eliteIsPromotionKey).toBe(false);
  });

  test("opt-in Elite ranking never emits 晋级 / Promotion / Broker / kill-test keys", () => {
    const resolved = resolveSearchSelection({
      progressive: { enabled: true, topK: 1, tau: 8, seed: 1 },
    });
    const selected = resolved.port.selectParent({
      nodes: WITH_UNVISITED,
      t: 8,
      eliteScore: 0.99,
      mmd: 0.12,
      sideSlot: 0.4,
      nearDup: 0.01,
    } as typeof WORKED extends never ? never : {
      readonly nodes: readonly SearchParentCandidate[];
      readonly t: number;
      readonly eliteScore: number;
      readonly mmd: number;
      readonly sideSlot: number;
      readonly nearDup: number;
    });
    const description = resolved.port.describe();
    expect(selected.parentId).toBe("a");
    expect(selected.adapterId).toBe("progressive_mcgs_optin");
    for (const field of PROMOTION_KEY_FIELDS) {
      expect(selected).not.toHaveProperty(field);
      expect(description).not.toHaveProperty(field);
      expect(resolved).not.toHaveProperty(field);
    }
    expect(selected).not.toHaveProperty("晋级");
    expect(selected).not.toHaveProperty("promotionKey");
    expect(selected).not.toHaveProperty("brokerKey");
    expect(selected).not.toHaveProperty("killTestKey");

    const catalog = T48MappedCatalog.fromMemory(new EvidenceMemory(), [{ artifactId: "art-score" }]);
    expect(() => catalog.map(selected)).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    const ledger = new HypothesisLedger({ catalog });
    expect(() => ledger.createHypothesis({
      statement: "Elite ≠ 晋级 / Promotion / Broker / kill-test key",
      evidenceRefs: [selected],
    })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    const hang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [selected],
      catalog,
      artifacts: [{ artifactId: "art-score" }],
    });
    expect(hang.ok).toBe(false);
    expect(hang.blocksPromotion).toBe(true);
    expect(hang.blocksBroker).toBe(true);
    expect(hang.objections.join(" ")).toMatch(/T48|promotion key|side-slot|MMD|near-dup|diversity|evidence/i);
  });
});

describe("opt-in does not change gate predicates", () => {
  test("missing holdout still refuses Admission; unreserved Budget still refuses; hang inconclusive is not pass", () => {
    resolveSearchSelection({ progressive: true });
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

    const memory = new EvidenceMemory();
    memory.addEvidence({
      id: "ev-holdout",
      kind: "observation",
      summary: "hold-out split is isolated",
      verified: true,
    });
    const catalog = T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
    const hang = runKillTestHang({
      outcome: "inconclusive",
      evidenceRefs: ["ev-holdout"],
      catalog,
      artifacts: [{ artifactId: "art-score" }],
    });
    expect(hang.ok).toBe(false);
    expect(hang.blocksPromotion).toBe(true);
    expect(hang.outcome).toBe("inconclusive");
  });
});

describe("explicit config file opt-in; missing file stays default", () => {
  test("readSearchSelectionConfig ignores env and requires an explicit file", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-prog-40-"));
    try {
      withEnv({ EVOK_SEARCH_SELECTION: "progressive_mcgs_optin" }, () => {
        expect(readSearchSelectionConfig(project)).toBeUndefined();
        expect(resolveSearchSelection(readSearchSelectionConfig(project)).selectionId).toBe("fixed_uct");
      });

      await mkdir(join(project, ".evok"), { recursive: true });
      await writeFile(join(project, ".evok", "search.json"), `${JSON.stringify({
        progressive: true,
        topK: 1,
        tau: 8,
        seed: 7,
      }, null, 2)}\n`);
      const config = readSearchSelectionConfig(project);
      expect(config).toEqual({ progressive: true, topK: 1, tau: 8, seed: 7 });
      const resolved = resolveSearchSelection(config, { from: "config" });
      expect(resolved.selectionId).toBe("progressive_mcgs_optin");
      expect(resolved.selectionPolicy40).toBe("opt-in");
      expect(resolved.port.selectParent({ nodes: WITH_UNVISITED, t: 8 }).parentId).toBe("a");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("suite-lift default stays off; explicit searchSelection opts in", () => {
  test("default circle remains fixed_uct / #40 off", () => {
    const circle = runSuiteLiftCircle({
      baselineFiles: { "src/solve.js": "module.exports = {};" },
    });
    expect(circle.selectionId).toBe("fixed_uct");
    expect(circle.selectionPolicy40).toBe("off");
    expect(circle.selection.adapterId).toBe("fixed_uct");
  });

  test("Mission/config opt-in makes the circle callable on Progressive", () => {
    const circle = runSuiteLiftCircle({
      baselineFiles: { "src/solve.js": "module.exports = {};" },
      searchSelection: { progressive: true, topK: 1, tau: 8, seed: 7, t: 8 },
    });
    expect(circle.selectionId).toBe("progressive_mcgs_optin");
    expect(circle.selectionPolicy40).toBe("opt-in");
    expect(circle.selection.adapterId).toBe("progressive_mcgs_optin");
    expect(circle.selection.exploration).toBe(DEFAULT_UCT_EXPLORATION / 2);
  });
});
