import { randomBytes } from "node:crypto";
import { Budget } from "./budget";
import { Lineage, Node, type RoleLineage } from "./lineage";
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
 * the node. Gap Finder receives `Lineage.roleView()`, which has already
 * dropped held-out keys. Gate scores go to `gate.jsonl`, not `lineage.jsonl`.
 *
 * The 0.01 keep margin and the 0.9 staged ratio are placeholders, not
 * statistical criteria. See the comments on those two comparisons.
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

/**
 * unread: the milestone was not read.
 * fell: it was read and the child is below the parent.
 * held: it was read and the child did not fall.
 */
export type HeldOutMilestoneState = "unread" | "fell" | "held";

export function heldOutMilestoneState(milestone: MilestoneHeldOut | null): HeldOutMilestoneState {
  if (milestone === null) return "unread";
  return milestone.child < milestone.parent ? "fell" : "held";
}

export interface ReviewInput {
  readonly child: Node;
  readonly parent: Node;
  readonly heldOut: MilestoneHeldOut | null;
  readonly heldOutState: HeldOutMilestoneState;
  /** True only when dev rose and the milestone was read and fell. Unread is not a drop. */
  readonly devRoseHeldOutFell: boolean;
}

/** Stored reviewer verdict when the milestone state itself decides the call. */
export function forcedReviewVerdict(input: Pick<ReviewInput, "heldOutState" | "devRoseHeldOutFell">): ReviewVerdict | null {
  if (input.heldOutState === "unread") {
    return { accept: false, reason: "milestone-unread：里程碑没读到" };
  }
  if (input.devRoseHeldOutFell) {
    return { accept: false, reason: "held-out 相对父节点下跌" };
  }
  return null;
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

type Awaitable<T> = T | Promise<T>;

export interface Roles {
  gapFinder: (parent: Node, lin: RoleLineage) => Awaitable<Record<string, unknown>>;
  innovator: (parent: Node, gaps: Record<string, unknown>, tried: readonly string[]) => Awaitable<Proposal>;
  runner: (configPath: string, subset: "dev_small" | "dev_full") => Awaitable<number[]>;
  reviewer: (input: ReviewInput) => Awaitable<ReviewVerdict>;
  /** Called after a dev+held-out accept. Stub may write `evidence_pack/`. */
  reportWriter?: (input: { readonly child: Node; readonly parent: Node }) => Awaitable<EvidencePack>;
  /** Called only after the evidence gate is green. Live submit stays off. */
  submitter?: (input: { readonly pack: EvidencePack | null; readonly gateGreen: boolean }) => Awaitable<SubmitReceipt>;
}

export interface OrchestratorOptions {
  /**
   * Placeholder keep margin. Not a paired difference and not an LCB.
   * `0.01` is a nominal constant.
   */
  readonly noiseLeeway?: number;
  /**
   * Placeholder pre-filter ratio. The small-subset mean and the parent's
   * full-set mean are not on the same scale. `0.9` is an arbitrary constant.
   */
  readonly stagedThreshold?: number;
  readonly patience?: number;
  readonly ids?: () => string;
  /**
   * Consecutive select / duplicate-patch / infra failures with no new
   * reviewed node. `run` stops instead of spinning until the wall clock.
   */
  readonly maxConsecutiveStalls?: number;
  /**
   * Evaluator read for the promotion milestone. Missing or throwing is
   * fail-closed: the child is not promoted. Not visible to Gap Finder.
   */
  readonly heldOutAtMilestone?: (configPath: string) => number;
  /** Per-stage report hook. The session writes one JSON file per call. */
  readonly onStage?: (stage: string, output: unknown, explanation: string) => void;
}

export interface SubmitGateRequest {
  readonly heldoutEval: (configPath: string) => number;
  readonly ttsBaseline: number;
  readonly baseHeldout: number;
  readonly day: string;
  /**
   * Positive held-out margin over the baseline, derived from measured sigma.
   * Omit it, or pass a non-positive value, and the gate refuses. There is
   * no default of 0.
   */
  readonly minDelta?: number;
  readonly modelId: string;
  readonly tracePackComplete: boolean;
  readonly changeNotePresent: boolean;
  readonly tokenBudget: number;
  readonly tokensSpent?: number;
  readonly submitCountToday?: number;
  readonly maxSubmitsPerDay?: number;
  /**
   * Explicit status. When omitted, `ttsEval` is read inside the gate.
   * A throw, an unreadable file, or a missing file fails the tts check and
   * the gate still finishes. `not-run` and `failed` both fail closed.
   */
  readonly tts?: TtsStatus;
  /** Deferred TTS read. Same fail-closed timing as `heldoutEval`. */
  readonly ttsEval?: () => Exclude<TtsStatus, "not-run"> | undefined;
  readonly dryRun?: () => { readonly status: DryRunStatus; readonly detail: string };
  readonly consultEvok?: () => { readonly ok: boolean; readonly refusedGateIds: readonly string[] };
  readonly missingInputs?: readonly string[];
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
  private readonly onStage: ((stage: string, output: unknown, explanation: string) => void) | undefined;
  readonly maxConsecutiveStalls: number;
  consecutiveStalls = 0;
  lastPack: EvidencePack | null = null;

  constructor(
    readonly lin: Lineage,
    readonly roles: Roles,
    readonly selector: Selector,
    readonly budget: Budget,
    options: OrchestratorOptions = {},
  ) {
    // Nominal placeholders. See the comparisons in `step`. Not sigma, not an LCB.
    this.noiseLeeway = options.noiseLeeway ?? 0.01;
    this.stagedThreshold = options.stagedThreshold ?? 0.9;
    this.patience = options.patience ?? 15;
    this.ids = options.ids ?? (() => randomBytes(4).toString("hex"));
    this.heldOutAtMilestone = options.heldOutAtMilestone;
    this.onStage = options.onStage;
    this.maxConsecutiveStalls = options.maxConsecutiveStalls ?? 3;
  }

  async step(): Promise<Phase> {
    if (!this.budget.canRun()) {
      this.phase = Phase.STOP;
      return this.phase;
    }
    let parent: Node;
    try {
      parent = this.selector.pick(this.lin);
    } catch (error) {
      return this.noteStall("error", { node: null, err: repr(error) });
    }
    parent.locked = true;
    this.lin.put(parent);
    this.lin.log("select", { node: parent.id, selector: this.selector.name });
    this.onStage?.("select", { node: parent.id, selector: this.selector.name }, `selected parent ${parent.id} with ${this.selector.name}`);
    let child: Node | undefined;
    try {
      const view = this.lin.roleView();
      assertNoHeldOutLeak({ parent: parent.toJSON(), events: view.events() }, "gap finder input");
      const gaps = await this.roles.gapFinder(parent, view);
      assertNoHeldOutLeak(gaps, "gap finder output");
      this.onStage?.("gap", gaps, "gap finder output was parsed by the orchestrator");
      const tried = parent.children.map((id) => this.lin.nodes.get(id)?.patchSummary ?? "");
      assertNoHeldOutLeak({ parent: parent.toJSON(), gaps, tried }, "innovator input");
      const prop = await this.roles.innovator(parent, gaps, tried);
      assertNoHeldOutLeak(prop, "innovator output");
      this.onStage?.("propose", prop, "innovator patch was parsed by the orchestrator");
      if (tried.includes(prop.summary)) {
        return this.noteStall("dup_patch", { node: parent.id });
      }
      const childId = this.ids();
      if (this.lin.nodes.has(childId) || childId === parent.id) {
        throw new Error(`lineage id ${childId} already exists`);
      }
      child = new Node({
        id: childId,
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
      const small = assertScores(await this.roles.runner(child.configPath, "dev_small"));
      this.budget.usedRuns += 1;
      child.devSmallScores = [...small];
      child.devScores = [...small];
      child.stage = "small";
      const smallMean = mean(small);
      // Placeholder pre-filter, not a statistical criterion. `smallMean` is the
      // small subset and `parent.devMean` is whatever subset the parent kept
      // (often the full set). Those scales do not match. `stagedThreshold`
      // (default 0.9) is an arbitrary constant, only a cheap screen.
      if (parent.devMean !== null && smallMean >= this.stagedThreshold * parent.devMean) {
        const full = assertScores(await this.roles.runner(child.configPath, "dev_full"));
        // dev_small and dev_full are not disjoint here. The empty-run fixture
        // repeats one candidate score; dev_full is a longer copy of that
        // measurement, not a remainder. Concatenating the lists would count
        // the small scores again and pull devMean toward the small subset.
        // The mean uses dev_full alone once it has run. `bin/eval.ts` does not
        // invent that repeat from fixtureScore.
        child.devFullScores = [...full];
        child.devScores = [...full];
        child.stage = "full";
        this.budget.usedRuns += 1;
      }
      child.status = "evaluated";
      this.lin.put(child);
      this.onStage?.("run", { id: child.id, devScores: child.devScores, stage: child.stage }, "runner returned one subset; dev_full replaces dev_small in the mean");
      const childMean = child.devMean ?? 0;
      const milestone = readMilestone(this.heldOutAtMilestone, child.configPath, parent.configPath);
      const devRose = parent.devMean !== null && childMean > parent.devMean;
      const heldOutState = heldOutMilestoneState(milestone);
      const devRoseHeldOutFell = devRose && heldOutState === "fell";
      const verdict = await this.roles.reviewer({
        child,
        parent,
        heldOut: milestone,
        heldOutState,
        devRoseHeldOutFell,
      });
      // Placeholder keep rule, not a statistical criterion. This is an unpaired
      // comparison, not a paired difference and not an LCB. `noiseLeeway`
      // (default 0.01) is a nominal constant; it is not an estimate of noise.
      // Unread is a separate refusal from a read drop: both block promotion.
      const keep = verdict.accept
        && childMean >= (parent.devMean ?? 0) - this.noiseLeeway
        && heldOutState !== "unread"
        && !devRoseHeldOutFell;
      const reason = heldOutState === "unread"
        ? "milestone-unread"
        : devRoseHeldOutFell
          ? "regressed"
          : verdict.reason;
      if (!keep) {
        child.status = "rejected";
        this.lin.put(child);
      } else {
        const pack = this.roles.reportWriter ? await this.roles.reportWriter({ child, parent }) : null;
        this.lastPack = pack;
      }
      this.consecutiveStalls = 0;
      this.onStage?.("review", { accept: child.status === "evaluated", reason, regressed: devRoseHeldOutFell, milestone: heldOutState }, reason);
      this.lin.log("review", {
        node: child.id,
        accept: child.status === "evaluated",
        dev: child.devMean,
        regressed: devRoseHeldOutFell,
        milestone: heldOutState,
        reason,
      });
      backprop(this.lin, child, childMean);
      this.onStage?.("backprop", { node: child.id, reward: childMean }, "value was added up the parent chain");
      const best = this.lin.best();
      this.sinceImprove = best.id === child.id ? 0 : this.sinceImprove + 1;
      if (this.sinceImprove >= this.patience) {
        this.lin.log("plateau", { best: best.id });
        this.phase = Phase.STOP;
      }
      return this.phase;
    } catch (error) {
      if (child?.status === "running") {
        child.status = "failed";
        this.lin.put(child);
      }
      return this.noteStall("error", { node: child?.id ?? parent.id, err: repr(error) });
    } finally {
      parent.locked = false;
      this.lin.put(parent);
    }
  }

  async run(): Promise<Node> {
    while (await this.step() !== Phase.STOP) {
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
  async submitGate(request: SubmitGateRequest): Promise<SubmitGateResult> {
    const best = this.lin.best();
    const minDelta = positiveMinDelta(request.minDelta);
    let heldout: number | null = null;
    let readError: string | undefined;
    try {
      const score = request.heldoutEval(best.configPath);
      if (!Number.isFinite(score)) readError = "held-out score is not a finite number";
      else heldout = score;
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    const dry = (request.dryRun ?? probePlaygroundDryRun)();
    // Held-out versus ttsBaseline is not a matched-budget comparison.
    const ttsRead = readTtsStatus(request);
    const submitCountToday = request.submitCountToday ?? this.budget.submits[request.day] ?? 0;
    const maxSubmitsPerDay = request.maxSubmitsPerDay ?? this.budget.maxOnlineSubmitsPerDay;
    const tokensSpent = request.tokensSpent ?? this.budget.usedTokens;
    const evidence = evaluateEvidenceGate({
      modelId: request.modelId,
      heldOutScore: heldout,
      heldOutFloor: minDelta === null ? Number.NaN : request.baseHeldout + minDelta,
      ...(minDelta === null || readError ? { heldOutRefusal: [minDelta === null ? MIN_DELTA_REFUSAL : "", readError ?? ""].filter(Boolean).join("; ") } : {}),
      tracePackComplete: request.tracePackComplete,
      changeNotePresent: request.changeNotePresent,
      tts: ttsRead.status,
      ...(ttsRead.refusal ? { ttsRefusal: ttsRead.refusal } : {}),
      submitCountToday,
      maxSubmitsPerDay,
      tokensSpent,
      tokenBudget: request.tokenBudget,
      dryRun: dry.status,
      dryRunDetail: dry.detail,
      ...(request.consultEvok ? { consultEvok: request.consultEvok } : {}),
      ...(request.missingInputs && request.missingInputs.length > 0 ? { missingInputs: request.missingInputs } : {}),
    });
    const heldOutGate = minDelta !== null && heldout !== null && heldout >= request.baseHeldout + minDelta;
    const ttsGate = ttsRead.status === "passed" && ttsRead.refusal === undefined;
    const dryGate = dry.status === "passed";
    const budgetGate = tokensSpent <= request.tokenBudget && this.budget.canSubmit(request.day);
    const submit = evidence.ok && heldOutGate && ttsGate && dryGate && budgetGate;
    if (submit) {
      const receipt = await (this.roles.submitter ?? defaultSubmitter)({ pack: this.lastPack, gateGreen: true });
      if (receipt.submitted) {
        throw new Error("live playground submit is off");
      }
    }
    const failed = evidence.checks.filter((item) => !item.ok).map((item) => item.id);
    this.lin.gateLog({
      node: best.id,
      heldout,
      tts: request.ttsBaseline,
      base: request.baseHeldout,
      ok: submit,
      failed,
      ...(readError ? { readError } : {}),
    });
    this.lin.log("gate", { node: best.id, ok: submit });
    this.onStage?.("gate", { node: best.id, ok: submit, failed }, submit ? "submit gate is green; live submit stays off" : `submit gate failed: ${failed.join(", ")}`);
    return { node: best.id, heldout, submit, checks: evidence.checks };
  }

  /** No new reviewed node. Stops the loop after N consecutive stalls. */
  private noteStall(kind: string, fields: Record<string, unknown>): Phase {
    this.consecutiveStalls += 1;
    this.lin.log(kind, { ...fields, stall: this.consecutiveStalls });
    if (this.consecutiveStalls >= this.maxConsecutiveStalls) {
      this.phase = Phase.STOP;
      this.lin.log("stall", { stalls: this.consecutiveStalls });
      return Phase.STOP;
    }
    return Phase.SELECT;
  }
}

function readTtsStatus(request: SubmitGateRequest): { readonly status: TtsStatus; readonly refusal?: string } {
  if (request.tts !== undefined) return { status: request.tts };
  if (!request.ttsEval) return { status: "not-run" };
  try {
    return { status: request.ttsEval() ?? "not-run" };
  } catch (error) {
    return {
      status: "failed",
      refusal: error instanceof Error ? error.message : String(error),
    };
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

/** A measured-sigma margin. Missing, non-finite, and non-positive values stay shut. */
export function positiveMinDelta(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

const MIN_DELTA_REFUSAL = "minDelta must be a positive threshold derived from measured sigma; unknown sigma fails closed";

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
