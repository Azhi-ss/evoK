import { randomBytes } from "node:crypto";
import { Budget } from "./budget";
import { Lineage, Node } from "./lineage";
import { assertNoHeldOutLeak } from "./modules/proposer";
import { backprop, type Selector } from "./modules/selector";

/**
 * Deterministic loop. Port of `design/orchestrator.py` `Orchestrator`.
 * No model call lives here. Held-out is read only inside `submitGate`.
 *
 * Keep-better uses a noise leeway. Staged eval runs `dev_small` first and
 * `dev_full` only when the small mean clears `stagedThreshold * parent`.
 * `PairedLcbKeep` and `SuccessiveHalvingStage` are the swap points; they
 * throw until the selector note's P0 experiments exist.
 */

export const Phase = {
  SELECT: "select",
  GAP: "gap",
  PROPOSE: "propose",
  RUN: "run",
  REVIEW: "review",
  BACKPROP: "backprop",
  GATE: "gate",
  STOP: "stop",
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

export interface Proposal {
  readonly summary: string;
  readonly configPath: string;
  readonly tokens?: number;
}

export interface ReviewVerdict {
  readonly accept: boolean;
  readonly reason: string;
}

export interface Roles {
  gapFinder: (parent: Node, lin: Lineage) => Record<string, unknown>;
  innovator: (parent: Node, gaps: Record<string, unknown>, tried: readonly string[]) => Proposal;
  runner: (configPath: string, subset: "dev_small" | "dev_full") => number[];
  reviewer: (child: Node, parent: Node) => ReviewVerdict;
}

export interface OrchestratorOptions {
  readonly noiseLeeway?: number;
  readonly stagedThreshold?: number;
  readonly patience?: number;
  readonly ids?: () => string;
}

export interface SubmitGateResult {
  readonly node: string;
  readonly heldout: number;
  readonly submit: boolean;
}

export class Orchestrator {
  readonly noiseLeeway: number;
  readonly stagedThreshold: number;
  readonly patience: number;
  sinceImprove = 0;
  phase: Phase = Phase.SELECT;
  private readonly ids: () => string;

  constructor(
    readonly lin: Lineage,
    readonly roles: Roles,
    readonly selector: Selector,
    readonly budget: Budget,
    options: OrchestratorOptions = {},
  ) {
    this.noiseLeeway = options.noiseLeeway ?? 0.01;
    this.stagedThreshold = options.stagedThreshold ?? 0.9;
    this.patience = options.patience ?? 15;
    this.ids = options.ids ?? (() => randomBytes(4).toString("hex"));
  }

  step(): Phase {
    if (!this.budget.canRun()) {
      this.phase = Phase.STOP;
      return this.phase;
    }
    let parent: Node;
    try {
      parent = this.selector.pick(this.lin);
    } catch (error) {
      this.lin.log("error", { node: null, err: repr(error) });
      return Phase.SELECT;
    }
    parent.locked = true;
    this.lin.put(parent);
    this.lin.log("select", { node: parent.id, selector: this.selector.name });
    try {
      const gaps = this.roles.gapFinder(parent, this.lin);
      assertNoHeldOutLeak(gaps, "gap finder output");
      const tried = parent.children.map((id) => this.lin.nodes.get(id)?.patchSummary ?? "");
      const prop = this.roles.innovator(parent, gaps, tried);
      assertNoHeldOutLeak(prop, "innovator output");
      if (tried.includes(prop.summary)) {
        this.lin.log("dup_patch", { node: parent.id });
        return Phase.SELECT;
      }
      const child = new Node({
        id: this.ids(),
        parentId: parent.id,
        configPath: prop.configPath,
        patchSummary: prop.summary,
        tokensUsed: prop.tokens ?? 0,
      });
      parent.children.push(child.id);
      this.lin.put(parent);
      this.lin.put(child);
      this.budget.usedTokens += child.tokensUsed;
      child.status = "running";
      this.lin.put(child);
      const small = assertScores(this.roles.runner(child.configPath, "dev_small"));
      this.budget.usedRuns += 1;
      child.devScores = [...small];
      child.stage = "small";
      const smallMean = mean(small);
      if (parent.devMean !== null && smallMean >= this.stagedThreshold * parent.devMean) {
        const full = assertScores(this.roles.runner(child.configPath, "dev_full"));
        child.devScores = [...small, ...full];
        child.stage = "full";
        this.budget.usedRuns += 1;
      }
      child.status = "evaluated";
      this.lin.put(child);
      const verdict = this.roles.reviewer(child, parent);
      const childMean = child.devMean ?? 0;
      const keep = verdict.accept && childMean >= (parent.devMean ?? 0) - this.noiseLeeway;
      if (!keep) {
        child.status = "rejected";
        this.lin.put(child);
      }
      this.lin.log("review", {
        node: child.id,
        accept: child.status === "evaluated",
        dev: child.devMean,
        reason: verdict.reason,
      });
      backprop(this.lin, child, childMean);
      const best = this.lin.best();
      this.sinceImprove = best.id === child.id ? 0 : this.sinceImprove + 1;
      if (this.sinceImprove >= this.patience) {
        this.lin.log("plateau", { best: best.id });
        this.phase = Phase.STOP;
      }
      return this.phase;
    } catch (error) {
      this.lin.log("error", { node: parent.id, err: repr(error) });
      return Phase.SELECT;
    } finally {
      parent.locked = false;
      this.lin.put(parent);
    }
  }

  run(): Node {
    while (this.step() !== Phase.STOP) {
      // The budget, plateau, and caller-injected roles decide when to stop.
    }
    return this.lin.best();
  }

  /**
   * Held-out + matched-budget TTS baseline + daily quota.
   * This is the only method that receives a held-out callback.
   */
  submitGate(
    heldoutEval: (configPath: string) => number,
    ttsBaseline: number,
    baseHeldout: number,
    day: string,
    minDelta = 0,
  ): SubmitGateResult {
    const best = this.lin.best();
    const heldout = heldoutEval(best.configPath);
    const submit = heldout >= baseHeldout + minDelta && heldout >= ttsBaseline && this.budget.canSubmit(day);
    this.lin.log("gate", { node: best.id, heldout, tts: ttsBaseline, base: baseHeldout, ok: submit });
    return { node: best.id, heldout, submit };
  }
}

export function assertScores(scores: readonly number[]): number[] {
  if (scores.length === 0) throw new Error("runner returned no scores");
  for (const score of scores) {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`runner score ${score} is outside [0, 1]`);
    }
  }
  return [...scores];
}

function mean(scores: readonly number[]): number {
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function repr(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
