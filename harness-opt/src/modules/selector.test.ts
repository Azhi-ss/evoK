import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lineage, Node } from "../lineage";
import {
  DEFAULT_SELECTOR_ID,
  GreedySelector,
  MapElitesArchive,
  NoveltyFilter,
  PairedLcbKeep,
  ParetoArchive,
  ScoreChildPropSelector,
  SoftmaxMixSelector,
  SuccessiveHalvingStage,
  UCTSelector,
  getSelector,
  scoreChildPropWeight,
  softmaxMixWeights,
  type Rng,
} from "./selector";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-sel-"));
}

function evaluated(lin: Lineage, id: string, score: number, extra: Partial<ConstructorParameters<typeof Node>[0]> = {}): Node {
  const node = new Node({
    id,
    parentId: extra.parentId ?? null,
    configPath: `candidates/${id}/config.json`,
    status: "evaluated",
    devScores: [score],
    stage: "full",
    ...extra,
  });
  lin.put(node);
  return node;
}

describe("selectors", () => {
  test("the MVP default is greedy", () => {
    expect(DEFAULT_SELECTOR_ID).toBe("greedy");
    expect(getSelector().name).toBe("GreedySelector");
  });

  test("greedy skips a locked higher node and keeps the earlier tie", () => {
    const lin = new Lineage(dir());
    evaluated(lin, "low", 0.4);
    const high = evaluated(lin, "high", 0.9);
    high.locked = true;
    lin.put(high);
    expect(new GreedySelector().pick(lin).id).toBe("low");
    high.locked = false;
    lin.put(high);
    const twin = evaluated(lin, "twin", 0.9);
    expect(new GreedySelector().pick(lin).id).toBe("high");
    expect(twin.devMean).toBe(0.9);
  });

  test("softmax mix matches the AFlow weight formula", () => {
    const weights = softmaxMixWeights([90, 10], 0.2, 0.3);
    expect(weights[0]).toBeCloseTo(0.15 + 0.7, 6);
    expect(weights[1]).toBeCloseTo(0.15, 4);
    const seen: number[] = [];
    const rng: Rng = {
      choices<T>(pool: readonly T[], drawn: readonly number[]): T {
        seen.push(...drawn);
        return pool[1] as T;
      },
    };
    const lin = new Lineage(dir());
    evaluated(lin, "best", 0.9);
    evaluated(lin, "other", 0.1);
    expect(new SoftmaxMixSelector(4, 0.2, 0.3, rng).pick(lin).id).toBe("other");
    expect(seen[0]).toBeCloseTo(weights[0] as number, 6);
    expect(seen[1]).toBeCloseTo(weights[1] as number, 6);
  });

  test("score-child-prop keeps the DGM expression and refuses to select with it", () => {
    const heavy = scoreChildPropWeight(0.8, 0);
    const light = scoreChildPropWeight(0.8, 2);
    expect(heavy).toBeCloseTo(1 / (1 + Math.exp(-3)), 6);
    expect(light).toBeCloseTo(heavy / 3, 6);
    const lin = new Lineage(dir());
    evaluated(lin, "fresh", 0.8);
    expect(() => new ScoreChildPropSelector().pick(lin)).toThrow(/archive median/);
    expect(() => getSelector("score-child-prop")).toThrow(/1\/sigma/);
  });

  test("UCT cap, unvisited infinity, and descent when the cap is full", () => {
    const selector = new UCTSelector();
    const leaf = new Node({ id: "v1", parentId: "root", configPath: "c", visits: 1 });
    expect(selector.cap(leaf)).toBe(2);
    leaf.visits = 16;
    expect(selector.cap(leaf)).toBe(6);
    const unvisited = new Node({ id: "new", parentId: "root", configPath: "c", visits: 0 });
    const parent = new Node({ id: "root", parentId: null, configPath: "c", visits: 1 });
    expect(selector.uct(unvisited, parent)).toBe(Number.POSITIVE_INFINITY);

    const lin = new Lineage(dir());
    const root = evaluated(lin, "root", 0.5, { visits: 1, children: ["low", "high"] });
    evaluated(lin, "low", 0.2, { parentId: "root", visits: 1, valueSum: 0.2 });
    evaluated(lin, "high", 0.9, { parentId: "root", visits: 1, valueSum: 0.9 });
    expect(selector.pick(lin).id).toBe("high");
    expect(root.children).toEqual(["low", "high"]);
  });

  test("P0 and P2 mechanisms stay throwing interfaces", () => {
    expect(() => new PairedLcbKeep().decide()).toThrow(/TODO/);
    expect(() => new SuccessiveHalvingStage().next()).toThrow(/TODO/);
    expect(() => new ParetoArchive().consider()).toThrow(/TODO/);
    expect(() => new MapElitesArchive().consider()).toThrow(/TODO/);
    expect(() => new NoveltyFilter().allow()).toThrow(/TODO/);
    for (const id of ["paired-lcb", "successive-halving", "map-elites", "novelty", "score-child-prop"]) {
      expect(() => getSelector(id)).toThrow(/TODO/);
    }
  });
});
