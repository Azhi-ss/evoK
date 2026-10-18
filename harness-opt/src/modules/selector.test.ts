import { describe, expect, test } from "bun:test";
import type { Scorecard, SearchGenes } from "../types";
import {
  DEFAULT_SELECTOR_ID,
  DEFAULT_SELECTOR_SEARCH,
  DEFAULT_STAGED_THRESHOLDS,
  getParentSampler,
  getPromotionCriterion,
  GREEDY_ID,
  PAIRED_CI_HALVING_ID,
  STAGED_THRESHOLD_ID,
} from "./selector";

const genes: SearchGenes = { samples: 1, selfChecks: 0, retries: 0 };

function card(devScore: number, tokens: number, attributionComplete = true): Scorecard {
  return { devScore, tokens, attributionComplete };
}

function decide(id: string, parent: Scorecard | null, candidate: Scorecard) {
  return getPromotionCriterion(id).decide({
    parent,
    candidate,
    thresholds: DEFAULT_STAGED_THRESHOLDS,
    genes,
    search: DEFAULT_SELECTOR_SEARCH,
  });
}

describe("promotion criteria", () => {
  test("default criterion is staged keep-better, not greedy", () => {
    expect(DEFAULT_SELECTOR_ID).toBe(STAGED_THRESHOLD_ID);
    expect(getPromotionCriterion().id).toBe(STAGED_THRESHOLD_ID);
  });

  test("a small dev bump clears greedy and misses the staged threshold", () => {
    const parent = card(50, 10);
    const candidate = card(50.5, 10);
    expect(decide(GREEDY_ID, parent, candidate).accept).toBe(true);
    expect(decide(STAGED_THRESHOLD_ID, parent, candidate).accept).toBe(false);
  });

  test("staged threshold also refuses a token regression", () => {
    const decision = decide(STAGED_THRESHOLD_ID, card(40, 10), card(80, 30));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain("token");
  });

  test("paired CI + halving is reserved and cannot promote", () => {
    const decision = decide(PAIRED_CI_HALVING_ID, card(10, 10), card(90, 10));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain("TODO(evolution-selector §④)");
    expect(decision.genes).toEqual(genes);
  });

  test("AFlow, DGM, and UCT samplers stay unimplemented", () => {
    for (const id of ["aflow-sample", "dgm-sample", "uct"] as const) {
      expect(() => getParentSampler(id).sample(["parent"], DEFAULT_SELECTOR_SEARCH)).toThrow(/TODO/);
    }
  });

  test("sampleCount stays a searchable config while greedy still returns one parent", () => {
    const config = { ...DEFAULT_SELECTOR_SEARCH, sampleCount: 4 };
    expect(getParentSampler("greedy").sample(["best", "other"], config)).toEqual(["best"]);
    expect(config.sampleCount).toBe(4);
  });
});
