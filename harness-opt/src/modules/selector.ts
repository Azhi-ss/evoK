import type { Lineage, Node } from "../lineage";

/**
 * Parent selectors ported from `design/orchestrator.py`.
 *
 * MVP parent picker is `GreedySelector`. `BaselineGate` lives on
 * `Orchestrator.submitGate`. Paired LCB, successive halving, Pareto /
 * MAP-Elites, and novelty stay interfaces that throw: the landing note in
 * `design/2026-10-18-evolution-selector-solutions.md` asks for those as
 * TODOs, and it says not to build a full UCT product, CMA-ME, pure novelty
 * search, PBT, FunSearch-scale islands, or online-leaderboard feedback.
 * `UCTSelector` below is only the formula and progressive-widening cap
 * from the python skeleton.
 *
 * Scores are normalised to [0, 1]. Contest ×100 display stays in scoring.ts.
 */

const SELECTOR_DOC = "harness-opt/design/2026-10-18-evolution-selector-solutions.md";

export interface Selector {
  readonly name: string;
  pick(lin: Lineage): Node;
}

export interface Rng {
  choices<T>(pool: readonly T[], weights: readonly number[]): T;
}

export function mathRng(random: () => number = Math.random): Rng {
  return {
    choices<T>(pool: readonly T[], weights: readonly number[]): T {
      if (pool.length === 0) throw new Error("cannot choose from an empty pool");
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (!(total > 0)) throw new Error("selector weights must be positive");
      let cursor = random() * total;
      for (let i = 0; i < pool.length; i += 1) {
        cursor -= weights[i] ?? 0;
        if (cursor <= 0) return pool[i] as T;
      }
      return pool[pool.length - 1] as T;
    },
  };
}

export const DEFAULT_SELECTOR_ID = "greedy";

export class GreedySelector implements Selector {
  readonly name = "GreedySelector";

  pick(lin: Lineage): Node {
    const pool = lin.evaluated().filter((node) => !node.locked);
    const first = pool[0];
    if (!first) throw new Error("no evaluated unlocked node");
    let best = first;
    for (const node of pool.slice(1)) {
      if ((node.devMean ?? Number.NEGATIVE_INFINITY) > (best.devMean ?? Number.NEGATIVE_INFINITY)) best = node;
    }
    return best;
  }
}

/** AFlow select_round: top-k, p = lam*uniform + (1-lam)*softmax(alpha*100*s). */
export class SoftmaxMixSelector implements Selector {
  readonly name = "SoftmaxMixSelector";

  constructor(
    readonly k = 4,
    readonly alpha = 0.2,
    readonly lam = 0.3,
    private readonly rng: Rng = mathRng(),
  ) {}

  pick(lin: Lineage): Node {
    const pool = [...lin.evaluated().filter((node) => !node.locked)]
      .sort((a, b) => (b.devMean ?? 0) - (a.devMean ?? 0))
      .slice(0, this.k);
    if (pool.length === 0) throw new Error("no evaluated unlocked node");
    const scores = pool.map((node) => (node.devMean ?? 0) * 100);
    return this.rng.choices(pool, softmaxMixWeights(scores, this.alpha, this.lam));
  }
}

export function softmaxMixWeights(scores: readonly number[], alpha: number, lam: number): number[] {
  const max = Math.max(...scores);
  const shifted = scores.map((score) => Math.exp(alpha * (score - max)));
  const z = shifted.reduce((sum, weight) => sum + weight, 0);
  return shifted.map((weight) => lam / scores.length + (1 - lam) * weight / z);
}

/** DGM score_child_prop: sigmoid(10*(s-0.5)) / (1+n_children). */
export class ScoreChildPropSelector implements Selector {
  readonly name = "ScoreChildPropSelector";

  constructor(private readonly rng: Rng = mathRng()) {}

  pick(lin: Lineage): Node {
    const pool = lin.evaluated().filter((node) => !node.locked);
    if (pool.length === 0) throw new Error("no evaluated unlocked node");
    const weights = pool.map((node) => scoreChildPropWeight(node.devMean ?? 0, node.children.length));
    return this.rng.choices(pool, weights);
  }
}

export function scoreChildPropWeight(devMean: number, childCount: number): number {
  return (1 / (1 + Math.exp(-10 * (devMean - 0.5)))) / (1 + childCount);
}

/**
 * Tree descent with UCB1. Expand when the widening cap is not full.
 * cap(n) = min(maxChildren, ceil(k * max(1, visits)^alpha)).
 */
export class UCTSelector implements Selector {
  readonly name = "UCTSelector";

  constructor(
    readonly c = Math.SQRT2,
    readonly pwK = 2,
    readonly pwAlpha = 0.5,
    readonly maxChildren = 6,
  ) {}

  cap(node: Node): number {
    return Math.min(this.maxChildren, Math.ceil(this.pwK * Math.max(1, node.visits) ** this.pwAlpha));
  }

  uct(child: Node, parent: Node): number {
    if (child.visits === 0) return Number.POSITIVE_INFINITY;
    return child.valueSum / child.visits + this.c * Math.sqrt(Math.log(Math.max(1, parent.visits)) / child.visits);
  }

  pick(lin: Lineage): Node {
    let node = lin.rootNode();
    while (true) {
      const kids = node.children
        .map((id) => lin.nodes.get(id))
        .filter((child): child is Node => child !== undefined && child.status === "evaluated" && !child.locked);
      if (node.children.length < this.cap(node) || kids.length === 0) return node;
      let next = kids[0] as Node;
      let best = this.uct(next, node);
      for (const child of kids.slice(1)) {
        const score = this.uct(child, node);
        if (score > best) {
          best = score;
          next = child;
        }
      }
      node = next;
    }
  }
}

export function backprop(lin: Lineage, node: Node, reward: number): void {
  let current: Node | undefined = node;
  while (current) {
    current.visits += 1;
    current.valueSum += reward;
    lin.put(current);
    current = current.parentId ? lin.nodes.get(current.parentId) : undefined;
  }
}

const TODO_IDS = ["paired-lcb", "successive-halving", "map-elites", "novelty"] as const;

export function getSelector(id: string = DEFAULT_SELECTOR_ID, rng?: Rng): Selector {
  if ((TODO_IDS as readonly string[]).includes(id)) {
    throw new Error(`TODO(${SELECTOR_DOC}): ${id} is an interface only in this round`);
  }
  switch (id) {
    case "greedy":
      return new GreedySelector();
    case "softmax-mix":
      return new SoftmaxMixSelector(4, 0.2, 0.3, rng);
    case "score-child-prop":
      return new ScoreChildPropSelector(rng);
    case "uct":
      return new UCTSelector();
    default:
      throw new Error(`unknown selector: ${id}`);
  }
}

/** P0 keep rule. Throws so an unfinished criterion cannot promote. */
export class PairedLcbKeep {
  decide(): never {
    throw new Error(`TODO(${SELECTOR_DOC} P0): paired evaluation + LCB keep is not implemented`);
  }
}

/** P0 racer. Throws so staging cannot silently skip the small subset. */
export class SuccessiveHalvingStage {
  next(): never {
    throw new Error(`TODO(${SELECTOR_DOC} P0): successive halving is not implemented`);
  }
}

/** P1 archive. The linear archive is the lineage itself. */
export class ParetoArchive {
  consider(): never {
    throw new Error(`TODO(${SELECTOR_DOC} P1): per-task Pareto archive is not implemented`);
  }
}

/** P2 archive. */
export class MapElitesArchive {
  consider(): never {
    throw new Error(`TODO(${SELECTOR_DOC} P2): MAP-Elites is not implemented`);
  }
}

/** P1 filter. */
export class NoveltyFilter {
  allow(): never {
    throw new Error(`TODO(${SELECTOR_DOC} P1): novelty rejection is not implemented`);
  }
}
