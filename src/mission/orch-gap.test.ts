/**
 * ET-ORCH-GAP / #181 — control-plane glue for #27 / #98 / #99.
 *
 * Seams: runOrchGap / runModelOrchestra / runGoldenPath / resolveSearchSelection.
 * Default path stays `fixed_uct` / Progressive off / StrongSearch off.
 * Golden-path glue is landed and mock-default. Orchestra is a thin impl.
 * No second control plane. DeployArena is out of this ticket.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockLlmCompetitionRuntime } from "../competition/llm-competition-runtime";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { BudgetLedger } from "../evidence/budget-gate";
import { runKillTestHang } from "../evidence/kill-test-hang";
import { T48MappedCatalog } from "../evidence/hypothesis-ledger";
import { EvidenceMemory } from "./research-loop";
import {
  type ModelCatalog,
  type ModelConfig,
} from "../execution/model-orchestra";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  FixedUctSelectionAdapter,
  SELECTION_POLICY_40,
  StrongSearchAdapter,
} from "../search/search-selection-port";
import { runOrchGap } from "./orch-gap";

const FLASH: ModelConfig = Object.freeze({ provider: "acme", model: "flash-2", id: "acme/flash-2" });
const PRO: ModelConfig = Object.freeze({ provider: "acme", model: "pro-2", id: "acme/pro-2" });

function fakeCatalog(defaultRef = FLASH.id): ModelCatalog {
  const byId = new Map([FLASH, PRO].map((model) => [model.id, model]));
  return {
    findModel(ref) {
      return byId.get(ref);
    },
    defaultModel() {
      return byId.get(defaultRef);
    },
  };
}

function withEnv(vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("runOrchGap default path does not flip search or Progressive", () => {
  test("orchestra thin impl + search default + no auto golden-path", async () => {
    const gap = await runOrchGap({ catalog: fakeCatalog() });
    expect(gap.kind).toBe("orch-gap");
    expect(gap.orchestra).toEqual({ tier: "default", model: FLASH, reason: "unconfigured" });
    expect(gap.orchestraKind).toBe("thin-impl");
    expect(gap.goldenPath).toBeUndefined();
    expect(gap.goldenPathLanded).toBe(true);
    expect(gap.search.selectionId).toBe("fixed_uct");
    expect(gap.search.selectionPolicy40).toBe("off");
    expect(gap.search.productDefault).toBe(true);
    expect(gap.search.port).toBeInstanceOf(FixedUctSelectionAdapter);
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });

  test("env does not silent-opt-in StrongSearch or Progressive", async () => {
    await withEnv({
      EVOK_SEARCH_SELECTION: "strong_search",
      EVOK_PROGRESSIVE: "1",
      SELECTION_POLICY: "on",
    }, async () => {
      const gap = await runOrchGap({ catalog: fakeCatalog() });
      expect(gap.search.selectionId).toBe("fixed_uct");
      expect(gap.search.selectionPolicy40).toBe("off");
    });
  });
});

describe("runOrchGap opt-in ports keep the product default off", () => {
  test("configured orchestra + explicit strongSearch + landed golden-path glue", async () => {
    const gap = await runOrchGap({
      catalog: fakeCatalog(),
      orchestra: { fast: FLASH.id, deep: PRO.id },
      goldenPath: { statement: "orch-gap golden-path glue is mock-default" },
      searchSelection: { strongSearch: true, topK: 1, tau: 8, seed: 7, t: 8 },
    });
    expect(gap.orchestra).toEqual({ tier: "fast", model: FLASH, reason: "role" });
    expect(gap.orchestraKind).toBe("thin-impl");
    expect(gap.goldenPath?.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
    expect(gap.goldenPath?.hypothesisId).toBe("h-v1-golden");
    expect(gap.goldenPath?.summary.authoritative).toBe(false);
    expect(gap.search.port).toBeInstanceOf(StrongSearchAdapter);
    expect(gap.search.selectionPolicy40).toBe("opt-in");
    expect(gap.search.productDefault).toBe(false);

    const def = await runOrchGap({ catalog: fakeCatalog() });
    expect(def.search.selectionId).toBe("fixed_uct");
    expect(def.search.selectionPolicy40).toBe("off");
    expect(def.goldenPath).toBeUndefined();
  });
});

describe("orch-gap does not widen gates or start DeployArena", () => {
  test("Admission / Budget / hang predicates stay fail-closed", async () => {
    await runOrchGap({
      catalog: fakeCatalog(),
      searchSelection: { strongSearch: true },
      goldenPath: { statement: "gates stay fail-closed" },
    });
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

    const budget = new BudgetLedger({ total: 1, units: "model-USD" });
    expect(budget.authorize("continue").ok).toBe(false);

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
    expect(hang.outcome).toBe("inconclusive");
  });

  test("handoff / spec state #27 thin impl, #98 landed, #99 opt-in, no DeployArena", async () => {
    const handoff = await readFile(join(process.cwd(), "handoffs", "2026-09-20-et-orch-gap.md"), "utf8");
    expect(handoff).toMatch(/thin impl/i);
    expect(handoff).toMatch(/#98/);
    expect(handoff).toMatch(/landed/i);
    expect(handoff).toMatch(/#99/);
    expect(handoff).toMatch(/opt-in/i);
    expect(handoff).toMatch(/fixed_uct/);
    expect(handoff).not.toMatch(/DeployArena full/i);
    const spec = await readFile(join(process.cwd(), "docs", "orch-gap.md"), "utf8");
    expect(spec).toMatch(/ModelOrchestra/);
    expect(spec).toMatch(/thin impl/i);
    expect(spec).toMatch(/golden-path/);
    expect(spec).toMatch(/strong.search/i);
    expect(spec).toMatch(/fixed_uct/);
    expect(spec).toMatch(/Deploy Arena stays standby/i);
  });
});
