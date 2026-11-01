/**
 * Phase 2 research workflow integration (#208). Physical home: `src/mission/`.
 *
 * A running EvoK research Mission drives the Phase 2 Playground Competition
 * through this seam: the Researcher proposes immutable, content-addressed
 * Harness revisions and records measured local evidence; the Mission Director
 * nominates the strongest eligible revision and may replace an unsubmitted
 * nominee. Release, submit and reconciliation are delegated to the
 * competition adapter in `src/competition/phase2-playground.ts`.
 *
 * Research keeps going while official evaluation is pending or quota is
 * unavailable. Local, cloud self-test and official scores stay separate
 * channels. The researcher view is a whitelist: no credentials, no private
 * checker material, no raw release/submission state, no global budget.
 */
import { digestValue } from "../execution/security-boundary";
import {
  Phase2PlaygroundAdapter,
  Phase2Error,
  emptyPhase2State,
  isPhase2Eligible,
  phase2AttemptPendingOfficial,
  phase2AttemptSubmitted,
  phase2AttemptUnconfirmed,
  phase2LatestScore,
  phase2Spent,
  strongestPhase2Revision,
  type Phase2Attempt,
  type Phase2Check,
  type Phase2Evidence,
  type Phase2EvidenceKind,
  type Phase2Revision,
  type Phase2State,
  type Phase2Store,
  type Phase2SubmitResult,
} from "../competition/phase2-playground";

export interface Phase2RevisionScore {
  readonly revisionId: string;
  readonly summary: string;
  readonly local: { readonly screening?: number; readonly withheldValidation?: number; readonly noisyRepeat?: number };
  readonly cloudSelfTest?: number;
  readonly official?: number;
  readonly eligible: boolean;
}

export interface Phase2DirectorView {
  readonly nomineeId: string | null;
  readonly revisions: readonly Phase2RevisionScore[];
  readonly budget: { readonly cap: number; readonly units: string; readonly spent: number; readonly remaining: number };
  readonly attempts: readonly { readonly id: string; readonly revisionId: string; readonly state: string; readonly official?: Phase2Attempt["official"] }[];
  readonly quota: Phase2State["quota"];
}

export interface Phase2ResearcherView {
  readonly nomineeId: string | null;
  readonly revisions: readonly Phase2RevisionScore[];
}

export type Phase2NextAction =
  | { readonly action: "propose"; readonly reason: string }
  | { readonly action: "research"; readonly reason: string; readonly releaseReady?: boolean; readonly pendingOfficial?: number }
  | { readonly action: "submit"; readonly revisionId: string; readonly reason: string };

const LOCAL_KINDS: readonly Phase2EvidenceKind[] = ["screening", "withheld-validation", "noisy-repeat", "source-check", "public-smoke"];

const latestScore = phase2LatestScore;

export { isPhase2Eligible };

function scoreRevision(revision: Phase2Revision, includeWithheld: boolean): Phase2RevisionScore {
  return {
    revisionId: revision.id,
    summary: revision.summary,
    local: {
      ...(latestScore(revision, "screening") !== undefined ? { screening: latestScore(revision, "screening") } : {}),
      ...(includeWithheld && latestScore(revision, "withheld-validation") !== undefined ? { withheldValidation: latestScore(revision, "withheld-validation") } : {}),
      ...(includeWithheld && latestScore(revision, "noisy-repeat") !== undefined ? { noisyRepeat: latestScore(revision, "noisy-repeat") } : {}),
    },
    ...(latestScore(revision, "cloud-self-test") !== undefined ? { cloudSelfTest: latestScore(revision, "cloud-self-test") } : {}),
    ...(latestScore(revision, "official") !== undefined ? { official: latestScore(revision, "official") } : {}),
    eligible: isPhase2Eligible(revision),
  };
}

/** Only an unconfirmed receipt pins the nominee. A revision whose attempt is
 * evaluating or scored stays immutable, but a stronger revision can become
 * the NEW nominee on a later day. */
function nomineeHasUnconfirmedAttempt(state: Phase2State, revisionId: string): boolean {
  return state.attempts.some((entry) => entry.revisionId === revisionId && phase2AttemptUnconfirmed(entry));
}

export interface Phase2ResearchOptions {
  readonly store: Phase2Store;
  readonly adapter: Phase2PlaygroundAdapter;
  readonly now?: () => string;
}

export class Phase2Research {
  private readonly store: Phase2Store;
  private readonly adapter: Phase2PlaygroundAdapter;
  private readonly now: () => string;

  constructor(options: Phase2ResearchOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Researcher proposes a versioned Harness change (runtime, prompts, Skills). */
  proposeRevision(input: { readonly summary: string; readonly change: Readonly<Record<string, unknown>> }): Phase2Revision {
    if (input.summary.trim() === "") throw new Phase2Error("revision summary is required");
    const state = this.store.load();
    const contentDigest = digestValue(input.change);
    const existing = state.revisions.find((entry) => entry.contentDigest === contentDigest);
    if (existing) return existing;
    const revision: Phase2Revision = {
      id: `rev-${contentDigest.slice(0, 16)}`,
      summary: input.summary,
      change: input.change,
      contentDigest,
      createdAt: this.now(),
      evidence: [],
    };
    this.store.save({ ...state, revisions: [...state.revisions, revision] });
    return revision;
  }

  getRevision(revisionId: string): Phase2Revision {
    const revision = this.store.load().revisions.find((entry) => entry.id === revisionId);
    if (!revision) throw new Phase2Error(`unknown revision ${revisionId}`);
    return revision;
  }

  /** Record measured local or cloud self-test evidence; spends the shared budget.
   * `externalBooking: true` marks cost already charged by the S1 meter (the
   * workspace evaluator); no second Phase2SpendEntry is written. */
  recordEvidence(revisionId: string, evidence: Omit<Phase2Evidence, "at"> & { readonly at?: string; readonly externalBooking?: boolean }): void {
    if (evidence.kind === "official") throw new Phase2Error("official evidence is written only by adapter reconciliation");
    if (evidence.score !== undefined && !Number.isFinite(evidence.score)) throw new Phase2Error("evidence score must be finite");
    if (evidence.kind === "cloud-self-test" && evidence.cost === undefined) {
      throw new Phase2Error("cloud self-test evidence requires an explicit cost; an unknown cloud cost is not free (use externalBooking for S1-billed runs)");
    }
    const cost = evidence.cost ?? 0;
    if (!Number.isFinite(cost) || cost < 0) throw new Phase2Error("evidence cost must be a non-negative number");
    const state = this.store.load();
    const revision = state.revisions.find((entry) => entry.id === revisionId);
    if (!revision) throw new Phase2Error(`unknown revision ${revisionId}`);
    if (evidence.externalBooking !== true && phase2Spent(state) + cost > state.budget.cap) {
      throw new Phase2Error(`shared research budget exhausted: ${phase2Spent(state)} + ${cost} > ${state.budget.cap} ${state.budget.units}`);
    }
    const record: Phase2Evidence = { ...evidence, at: evidence.at ?? this.now(), cost };
    const kind: "local" | "cloud-self-test" = LOCAL_KINDS.includes(evidence.kind) ? "local" : "cloud-self-test";
    this.store.save({
      ...state,
      revisions: state.revisions.map((entry) => entry.id === revisionId ? { ...entry, evidence: [...entry.evidence, record] } : entry),
      budget: evidence.externalBooking === true ? state.budget : {
        ...state.budget,
        spent: [...state.budget.spent, {
          id: `spend-${digestValue({ revisionId, record }).slice(0, 16)}`,
          kind,
          amount: cost,
          at: record.at,
          revisionId,
          note: evidence.kind,
        }],
      },
    });
  }

  /**
   * Director nominates the strongest eligible immutable revision (withheld
   * validation, then screening, then id for determinism). An unsubmitted
   * nominee is replaced; a submitted one is not.
   */
  nominate(): { readonly nomineeId: string | null; readonly replaced: boolean; readonly reason?: string } {
    const state = this.store.load();
    const strongest = strongestPhase2Revision(state.revisions);
    if (!strongest) return { nomineeId: state.nomineeId, replaced: false, reason: "no revision has screening + withheld validation + a noisy-case repeat yet" };
    if (state.nomineeId === strongest.id) return { nomineeId: strongest.id, replaced: false };
    if (state.nomineeId && nomineeHasUnconfirmedAttempt(state, state.nomineeId)) {
      return { nomineeId: state.nomineeId, replaced: false, reason: `nominee ${state.nomineeId} has an unconfirmed attempt; reconcile it before replacing the nominee` };
    }
    this.store.save({ ...state, nomineeId: strongest.id });
    return { nomineeId: strongest.id, replaced: state.nomineeId !== null };
  }

  async release(revisionId?: string): Promise<{ readonly ready: boolean; readonly checks: readonly Phase2Check[] }> {
    const state = this.store.load();
    const target = revisionId ?? state.nomineeId;
    if (!target) return { ready: false, checks: [{ id: "nominee", status: "waiting", detail: "no nominated revision", action: "record local evidence and nominate the strongest eligible revision" }] };
    const checks = [...await this.adapter.checkRelease(target)];
    if (state.nomineeId !== target) checks.push({ id: "nominee", status: "red", detail: `${target} is not the current nominee`, action: "nominate before release" });
    return { ready: checks.every((check) => check.status === "green"), checks };
  }

  async submit(input: { readonly modelName: string; readonly real?: boolean; readonly estimatedCost?: number; readonly revisionId?: string }): Promise<Phase2SubmitResult> {
    const state = this.store.load();
    const revisionId = input.revisionId ?? state.nomineeId;
    if (!revisionId) return { kind: "waiting", checks: [{ id: "nominee", status: "waiting", detail: "no nominated revision", action: "nominate first" }] };
    if (state.nomineeId !== revisionId) return { kind: "waiting", checks: [{ id: "nominee", status: "red", detail: `${revisionId} is not the current nominee`, action: "nominate the strongest eligible revision before submitting" }] };
    return this.adapter.submit({ revisionId, modelName: input.modelName, real: input.real, estimatedCost: input.estimatedCost });
  }

  async reconcile(): Promise<readonly Phase2Attempt[]> {
    return this.adapter.reconcile();
  }

  bindAttempt(attemptRef: string, platformAttemptId: string): void {
    this.adapter.bindAttempt(attemptRef, platformAttemptId);
  }

  /** Research continues while official evaluation is pending or quota is out. */
  async nextAction(): Promise<Phase2NextAction> {
    const state = this.store.load();
    if (state.revisions.length === 0) return { action: "propose", reason: "no Harness revision proposed yet" };
    const pendingOfficial = state.attempts.filter(phase2AttemptPendingOfficial).length;
    if (!state.nomineeId) {
      return { action: "research", reason: "gather screening, withheld validation and a noisy-case repeat, then nominate", pendingOfficial };
    }
    const release = await this.release(state.nomineeId);
    if (!release.ready) {
      const waiting = release.checks.filter((check) => check.status !== "green").map((check) => `${check.id}: ${check.action ?? check.detail}`).join("; ");
      return { action: "research", reason: `release not ready (${waiting}); keep researching`, releaseReady: false, pendingOfficial };
    }
    const nomineeAttempt = state.attempts.find((entry) => entry.real && entry.revisionId === state.nomineeId);
    if (nomineeAttempt && phase2AttemptSubmitted(nomineeAttempt)) {
      return { action: "research", reason: `official evaluation ${nomineeAttempt.state} for ${nomineeAttempt.id}; keep researching the next revision`, releaseReady: true, pendingOfficial };
    }
    if (nomineeAttempt && phase2AttemptUnconfirmed(nomineeAttempt)) {
      return { action: "research", reason: `submit ${nomineeAttempt.id} is unconfirmed; reconcile the original attempt and keep researching`, releaseReady: true, pendingOfficial };
    }
    // A cached exhausted quota belongs to the day it was checked. Refresh it
    // on later ticks instead of blocking research/submit forever.
    if (state.quota === null || state.quota.remainingToday === null || state.quota.remainingToday < 1) {
      const fresh = await this.adapter.refreshQuota();
      if (fresh.remainingToday === null || fresh.remainingToday < 1) {
        return { action: "research", reason: fresh.remainingToday === null ? "platform has not confirmed a free daily slot; keep researching" : "daily submission quota exhausted; keep researching until the platform confirms a free slot", releaseReady: true, pendingOfficial };
      }
    }
    return { action: "submit", revisionId: state.nomineeId, reason: "nominee release checks are green; dry-run first, real submit needs fresh platform quota and budget headroom" };
  }

  /**
   * One normal research tick: ingest official results, run the wired
   * researcher/evaluator hook when more research is needed, re-nominate and
   * recompute the next action. The hook is the production candidate
   * generation/scoring seam (workspace runner or a Pi Mission plug), never a
   * text-only "keep researching".
   */
  async tick(runner?: (research: Phase2Research) => Promise<unknown>): Promise<{
    readonly action: Phase2NextAction;
    readonly nomination: { readonly nomineeId: string | null; readonly replaced: boolean; readonly reason?: string };
    readonly research?: unknown;
  }> {
    await this.reconcile();
    let action = await this.nextAction();
    let research: unknown;
    if (runner && (action.action === "research" || action.action === "propose")) {
      research = await runner(this);
    }
    const nomination = this.nominate();
    action = await this.nextAction();
    return { action, nomination, ...(research === undefined ? {} : { research }) };
  }

  directorView(): Phase2DirectorView {
    const state = this.store.load();
    return {
      nomineeId: state.nomineeId,
      revisions: state.revisions.map((entry) => scoreRevision(entry, true)),
      budget: { cap: state.budget.cap, units: state.budget.units, spent: phase2Spent(state), remaining: state.budget.cap - phase2Spent(state) },
      attempts: state.attempts.map((entry) => ({ id: entry.id, revisionId: entry.revisionId, state: entry.state, ...(entry.official ? { official: entry.official } : {}) })),
      quota: state.quota,
    };
  }

  /** Whitelist view for short-lived Researcher agents. No release internals,
   * no global budget and no withheld/noisy-repeat scores. */
  researcherView(): Phase2ResearcherView {
    const state = this.store.load();
    return { nomineeId: state.nomineeId, revisions: state.revisions.map((entry) => scoreRevision(entry, false)) };
  }
}

/** Initialize a persistent Phase 2 research state. Idempotent: an existing
 * valid state is returned unchanged, never reset. */
export function initPhase2Research(store: Phase2Store, input: { readonly cap: number; readonly units?: string }): Phase2State {
  if (store.exists()) return store.load();
  const state = emptyPhase2State(input.cap, input.units ?? "cny");
  store.save(state);
  return state;
}
