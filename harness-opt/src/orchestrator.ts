import { randomBytes } from "node:crypto";
import { Budget } from "./budget";
import { Lineage, Node } from "./lineage";
import { evaluateEvidenceGate, type EvidenceCheck, type TtsStatus } from "./modules/evidence-gate";
import { assertNoHeldOutLeak } from "./modules/proposer";
import { probePlaygroundDryRun, type DryRunStatus } from "./playground-dry-run";
import { backprop, type Selector } from "./modules/selector";

/**
 * Deterministic loop. Port of `design/orchestrator.py` `Orchestrator`.
 * No model call lives here.
 *
 * Held-out is read by the evaluator at two places only: the promotion
 * milestone inside `step`, and `submitGate`. The numbers are not placed on
 * the node, and they are not passed to Gap Finder or Innovator.
 *
 * Keep-better uses a noise leeway. Staged eval runs `dev_small` first and
 * `dev_full` only when the small mean clears `stagedThreshold * parent`.
 * A dev rise whose held-out fell versus the parent is refused (PRD §5.2).
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

/** Scores the evaluator already read. Reviewer does not open `sealed/`. */
export interface MilestoneHeldOut {
  readonly child: number;
  readonly parent: number;
}

export interface ReviewInput {
  readonly child: Node;
  readonly parent: Node;
  readonly heldOut: MilestoneHeldOut | null;
  /** True when dev rose and held-out fell, or when the milestone read failed. */
  readonly devRoseHeldOutFell: boolean;
}

export interface EvidencePack {
  readonly modelId: string;
  readonly changeNote: string;
  readonly traceIndex: readonly string[];
  readonly devScore: number;
  readonly configPath: string;
}

export interface SubmitReceipt {
  readonly ok: boolean;
  readonly submitted: boolean;
  readonly mode: "blocked" | "dry-run";
  readonly detail: string;
}

export interface Roles {
  gapFinder: (parent: Node, lin: Lineage) => Record<string, unknown>;
  innovator: (parent: Node, gaps: Record<string, unknown>, tried: readonly string[]) => Proposal;
  runner: (configPath: string, subset: "dev_small" | "dev_full") => number[];
  reviewer: (input: ReviewInput) => ReviewVerdict;
  /** Called after a dev+held-out accept. Stub may write `evidence_pack/`. */
  reportWriter?: (input: { readonly child: Node; readonly parent: Node }) => EvidencePack;
  /** Called only after the evidence gate is green. Live submit stays off. */
  submitter?: (input: { readonly pack: EvidencePack | null; readonly gateGreen: boolean }) => SubmitReceipt;
}

export interface OrchestratorOptions {
  readonly noiseLeeway?: number;
  readonly stagedThreshold?: number;
  readonly patience?: number;
  readonly ids?: () => string;
  /**
   * Evaluator read for the promotion milestone. Missing or throwing is
   * fail-closed: the child is not promoted. Not visible to Gap Finder.
   */
  readonly heldOutAtMilestone?: (configPath: string) => number;
}

export interface SubmitGateRequest {
  readonly heldoutEval: (configPath: string) => number;
  readonly ttsBaseline: number;
  readonly baseHeldout: number;
  readonly day: string;
  readonly minDelta?: number;
  readonly modelId: string;
  readonly tracePackComplete: boolean;
  readonly changeNotePresent: boolean;
  readonly tokenBudget: number;
  readonly tokensSpent?: number;
  readonly submitCountToday?: number;
  readonly maxSubmitsPerDay?: number;
  /** Omit to derive passed/failed from the numeric TTS comparison. `not-run` always fails. */
  readonly tts?: TtsStatus;
  readonly dryRun?: () => { readonly status: DryRunStatus; readonly detail: string };
  readonly consultEvok?: () => { readonly ok: boolean; readonly refusedGateIds: readonly string[] };
}

export interface SubmitGateResult {
  readonly node: string;
  readonly heldout: number | null;
  readonly submit: boolean;
  readonly checks: readonly EvidenceCheck[];
}

export class Orchestrator {
  readonly noiseLeeway: number;
  readonly stagedThreshold: number;
  readonly patience: number;
  sinceImprove = 0;
  phase: Phase = Phase.SELECT;
  private readonly ids: () => string;
  private readonly heldOutAtMilestone: ((configPath: string) => number) | undefined;
  lastPack: EvidencePack | null = null;

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
    this.heldOutAtMilestone = options.heldOutAtMilestone;
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
      const childMean = child.devMean ?? 0;
      const milestone = readMilestone(this.heldOutAtMilestone, child.configPath, parent.configPath);
      const devRose = parent.devMean !== null && childMean > parent.devMean;
      const heldOutFell = milestone !== null && milestone.child < milestone.parent;
      const devRoseHeldOutFell = milestone === null || (devRose && heldOutFell);
      const verdict = this.roles.reviewer({ child, parent, heldOut: milestone, devRoseHeldOutFell });
      const keep = verdict.accept
        && childMean >= (parent.devMean ?? 0) - this.noiseLeeway
        && !devRoseHeldOutFell;
      const reason = devRoseHeldOutFell
        ? milestone === null
          ? "held-out milestone was not read; promotion refused"
          : "dev rose and held-out fell relative to the parent; promotion refused"
        : verdict.reason;
      if (!keep) {
        child.status = "rejected";
        this.lin.put(child);
      } else {
        const pack = this.roles.reportWriter?.({ child, parent }) ?? null;
        this.lastPack = pack;
      }
      this.lin.log("review", {
        node: child.id,
        accept: child.status === "evaluated",
        dev: child.devMean,
        heldOutRegression: devRoseHeldOutFell,
        reason,
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
   * PRD §9, all required, any miss fails closed:
   * evaluateEvidenceGate (pinned model, trace pack, change note, budget, quota,
   * held-out floor, TTS status, dry-run) AND the held-out floor AND the
   * matched-budget TTS comparison AND a successful dry-run.
   * Submitter runs only when that conjunction is true, and it still does not
   * live-post.
   */
  submitGate(request: SubmitGateRequest): SubmitGateResult {
    const best = this.lin.best();
    const minDelta = request.minDelta ?? 0;
    let heldout: number | null = null;
    try {
      const score = request.heldoutEval(best.configPath);
      heldout = Number.isFinite(score) ? score : null;
    } catch {
      heldout = null;
    }
    const dry = (request.dryRun ?? probePlaygroundDryRun)();
    const compared = heldout !== null && Number.isFinite(request.ttsBaseline);
    const ttsStatus: TtsStatus = request.tts ?? (compared
      ? (heldout as number) >= request.ttsBaseline ? "passed" : "failed"
      : "not-run");
    const submitCountToday = request.submitCountToday ?? this.budget.submits[request.day] ?? 0;
    const maxSubmitsPerDay = request.maxSubmitsPerDay ?? this.budget.maxOnlineSubmitsPerDay;
    const tokensSpent = request.tokensSpent ?? this.budget.usedTokens;
    const evidence = evaluateEvidenceGate({
      modelId: request.modelId,
      heldOutScore: heldout,
      heldOutFloor: request.baseHeldout + minDelta,
      tracePackComplete: request.tracePackComplete,
      changeNotePresent: request.changeNotePresent,
      tts: ttsStatus,
      submitCountToday,
      maxSubmitsPerDay,
      tokensSpent,
      tokenBudget: request.tokenBudget,
      dryRun: dry.status,
      ...(request.consultEvok ? { consultEvok: request.consultEvok } : {}),
    });
    const heldOutGate = heldout !== null && heldout >= request.baseHeldout + minDelta;
    const ttsGate = ttsStatus === "passed" && heldout !== null && heldout >= request.ttsBaseline;
    const dryGate = dry.status === "passed";
    const budgetGate = tokensSpent <= request.tokenBudget && this.budget.canSubmit(request.day);
    const submit = evidence.ok && heldOutGate && ttsGate && dryGate && budgetGate;
    if (submit) {
      const receipt = (this.roles.submitter ?? defaultSubmitter)({ pack: this.lastPack, gateGreen: true });
      if (receipt.submitted) {
        throw new Error("live playground submit is off");
      }
    }
    this.lin.log("gate", {
      node: best.id,
      heldout,
      tts: request.ttsBaseline,
      base: request.baseHeldout,
      ok: submit,
      failed: evidence.checks.filter((item) => !item.ok).map((item) => item.id),
    });
    return { node: best.id, heldout, submit, checks: evidence.checks };
  }
}

function readMilestone(
  read: ((configPath: string) => number) | undefined,
  childPath: string,
  parentPath: string,
): MilestoneHeldOut | null {
  if (!read) return null;
  try {
    const child = read(childPath);
    const parent = read(parentPath);
    if (!Number.isFinite(child) || !Number.isFinite(parent)) return null;
    return { child, parent };
  } catch {
    return null;
  }
}

function defaultSubmitter(_input: { readonly pack: EvidencePack | null; readonly gateGreen: boolean }): SubmitReceipt {
  return {
    ok: true,
    submitted: false,
    mode: "dry-run",
    detail: "evidence gate is green; live playground submit is off",
  };
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
