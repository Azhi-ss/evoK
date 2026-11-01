/**
 * Phase 2 Playground Competition Adapter (#208). Physical home:
 * `src/competition/`.
 *
 * Owns the competition-specific boundary of the Harness Phase 2 challenge:
 * the official pinned Harbor kit facts, the deterministic Wenyon source →
 * organizer grant → downloaded-tree verify → Playground bundle pipeline, and
 * attempt / quota / reconciliation state. It does not decide promotion:
 * nomination and the shared research budget live in
 * `src/mission/phase2-research.ts`.
 *
 * Frozen surfaces are untouched: the generic SubmissionBroker, contest-arm
 * auto-submit and the live S1 path are not used or changed here. Live submit
 * is explicit `{ real: true }` only; dry run, real readiness and a real
 * receipt are three distinct results. Credentials never enter the persisted
 * state or the researcher view.
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { digestValue } from "../execution/security-boundary";

export const PHASE2_STATE_SCHEMA = "evok.phase2/v1" as const;
export const PHASE2_CHALLENGE_ID = "harness-45c4688b" as const;

/** Official pinned Harbor kit facts from the challenge brief. */
export const PHASE2_HARBOR_PIN = {
  version: "0.24.0+lbg.13",
  commit: "c51bee3c4708519f4e993e20fc62c741c3909581",
  tarball: "harbor-lbg-0.24.0-lbg.13-c51bee3c-source.tar.gz",
  tarballSha256: "7011d9892d3992e1d12828c69a6a26a7fa40a6cacd8467b37031644974bae050",
  kitDataset: "harness-phase2-public-kit",
  kitVersion: 3,
} as const;

export const PHASE2_ORGANIZER_SUBJECT = "user:a2bd3223-1df1-40a9-a42a-db1c39c4f191" as const;

/** Exact `model_name` allowlist from the brief; gateway /health may narrow it. */
export const PHASE2_MODEL_ALLOWLIST: readonly string[] = [
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
  "deepseek-v4-pro-0813",
  "glm-5.3-flash",
  "glm-5.3",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "qwen3.8-max",
];

export const PHASE2_SUBMISSION_PLACEHOLDERS = {
  baseUrl: "__BOHRIUM_BASE_URL__",
  apiKey: "__BOHRIUM_API_KEY__",
} as const;

export class Phase2Error extends Error {
  readonly kind = "phase2" as const;
  constructor(message: string) {
    super(message);
    this.name = "Phase2Error";
  }
}

/** Thrown by a platform when a submit response was lost or is ambiguous. */
export class Phase2AmbiguousSubmitError extends Error {
  readonly kind = "phase2-ambiguous-submit" as const;
  constructor(message: string) {
    super(message);
    this.name = "Phase2AmbiguousSubmitError";
  }
}

// ---------------------------------------------------------------------------
// Evidence and revision records (shared state; research workflow writes local
// and cloud evidence, only this adapter writes verified official evidence).
// ---------------------------------------------------------------------------

export type Phase2EvidenceKind =
  | "screening"
  | "withheld-validation"
  | "noisy-repeat"
  | "source-check"
  | "public-smoke"
  | "cloud-self-test"
  | "official";

export type Phase2ScoreChannel = "local" | "cloud-self-test" | "official";

export interface Phase2Evidence {
  readonly kind: Phase2EvidenceKind;
  readonly at: string;
  readonly score?: number;
  readonly passed?: boolean;
  /** Spend in the shared budget units; local and cloud self-tests included. */
  readonly cost?: number;
  readonly ref?: string;
  readonly note?: string;
}

export interface Phase2Revision {
  readonly id: string;
  readonly summary: string;
  readonly change: Readonly<Record<string, unknown>>;
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly evidence: readonly Phase2Evidence[];
}

export type Phase2AttemptState =
  | "prepared"
  | "submitting"
  | "uncertain"
  | "accepted"
  | "evaluating"
  | "scored"
  | "failed"
  | "not-received";

export interface Phase2Attempt {
  readonly id: string;
  readonly revisionId: string;
  readonly idempotencyKey: string;
  readonly real: boolean;
  readonly state: Phase2AttemptState;
  readonly datasetId?: string;
  readonly sourceVersion?: string;
  readonly treeDigest?: string;
  readonly bundleDigest?: string;
  readonly attemptId?: string;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly official?: { readonly score?: number; readonly cost?: number; readonly status: string; readonly at: string };
  readonly history: readonly { readonly at: string; readonly state: Phase2AttemptState; readonly detail: string }[];
}

export interface Phase2SpendEntry {
  readonly id: string;
  readonly kind: "local" | "cloud-self-test" | "submission";
  readonly amount: number;
  readonly at: string;
  readonly revisionId?: string;
  readonly attemptId?: string;
  readonly note?: string;
}

export interface Phase2QuotaRecord {
  readonly remainingToday: number | null;
  readonly checkedAt: string;
  readonly detail: string;
}

export interface Phase2State {
  readonly schema: typeof PHASE2_STATE_SCHEMA;
  readonly revisions: readonly Phase2Revision[];
  readonly nomineeId: string | null;
  readonly budget: { readonly cap: number; readonly units: string; readonly spent: readonly Phase2SpendEntry[] };
  readonly attempts: readonly Phase2Attempt[];
  readonly quota: Phase2QuotaRecord | null;
}

export function emptyPhase2State(cap: number, units = "cny"): Phase2State {
  if (!Number.isFinite(cap) || cap <= 0) throw new Phase2Error("shared budget cap must be a positive number");
  return { schema: PHASE2_STATE_SCHEMA, revisions: [], nomineeId: null, budget: { cap, units, spent: [] }, attempts: [], quota: null };
}

export interface Phase2Store {
  load(): Phase2State;
  save(state: Phase2State): void;
  exists(): boolean;
  /** Cross-process exclusion for submit/reconcile. A rename alone cannot stop
   * two processes from consuming the same daily quota. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Atomic JSON file store: attempt, quota and budget state survive restarts. */
export function createPhase2JsonStore(path: string): Phase2Store {
  return {
    exists(): boolean {
      return existsSync(path);
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      const lockPath = `${path}.lock`;
      mkdirSync(dirname(path), { recursive: true });
      const acquire = (retried: boolean): boolean => {
        try {
          writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
          return true;
        } catch {
          try {
            const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
            if (typeof holder.pid === "number") process.kill(holder.pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH" && !retried) {
              try { unlinkSync(lockPath); } catch { /* already gone */ }
              return acquire(true);
            }
            return false;
          }
        }
      };
      if (!acquire(false)) {
        throw new Phase2Error(`another phase2 submit/reconcile holds ${lockPath}; wait for it, or remove the lock only after confirming the holder is gone`);
      }
      try {
        return await fn();
      } finally {
        try { unlinkSync(lockPath); } catch { /* already gone */ }
      }
    },
    load(): Phase2State {
      if (!existsSync(path)) throw new Phase2Error(`phase2 state not found at ${path}; run init first`);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Phase2State;
      if (parsed.schema !== PHASE2_STATE_SCHEMA) throw new Phase2Error(`phase2 state schema must be ${PHASE2_STATE_SCHEMA}`);
      return parsed;
    },
    save(state: Phase2State): void {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

// ---------------------------------------------------------------------------
// Platform port. The real implementation shells out to bohr / playground;
// offline runs use the scripted fake. No credentials are part of this port's
// persisted outputs.
// ---------------------------------------------------------------------------

export interface Phase2KitStatus {
  readonly status: "verified" | "missing" | "mismatch";
  readonly detail: string;
  /** Actionable next step when the kit is not verified. */
  readonly action?: string;
}

export interface Phase2QuotaStatus {
  /** null = the platform could not confirm a free slot. */
  readonly remainingToday: number | null;
  readonly detail: string;
}

export interface Phase2SourceRef {
  readonly datasetId: string;
  readonly version: string;
  readonly treeDigest: string;
}

export interface Phase2BundleCheck {
  readonly ok: boolean;
  readonly bundleDigest: string;
  readonly detail: string;
}

export interface Phase2Receipt {
  readonly attemptId: string;
  readonly status: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface Phase2AttemptStatus {
  readonly state: "accepted" | "evaluating" | "scored" | "failed" | "not-received";
  readonly score?: number;
  readonly cost?: number;
  readonly detail: string;
}

export interface Phase2Platform {
  kit(): Promise<Phase2KitStatus>;
  quota(): Promise<Phase2QuotaStatus>;
  /** Digest of the locally nominated source tree, computed independently of
   * any upload echo and bound to THIS revision's own tree. The downloaded
   * tree is verified against this value. */
  localTreeDigest(revision: Phase2Revision): Promise<string>;
  /** Create a private versioned Wenyon source for exactly this revision tree. */
  createSource(input: { readonly revision: Phase2Revision; readonly treeDigest: string }): Promise<Phase2SourceRef>;
  grantOrganizerRead(datasetId: string): Promise<void>;
  /** Re-download the pinned version and compare every file with the local tree. */
  verifyDownloadedTree(input: { readonly datasetId: string; readonly version: string; readonly treeDigest: string }): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Validate the exact Playground bundle locally (`submit --dry-run`). */
  validateBundle(input: { readonly revisionId: string; readonly submissionJson: string; readonly treeDigest: string }): Promise<Phase2BundleCheck>;
  /** Real submit. May throw Phase2AmbiguousSubmitError on timeout. */
  submit(input: { readonly revisionId: string; readonly bundleDigest: string; readonly idempotencyKey: string }): Promise<Phase2Receipt>;
  attemptStatus(attemptId: string): Promise<Phase2AttemptStatus>;
  /** Locate an attempt after a restart when the receipt was never persisted. */
  findAttempt(idempotencyKey: string): Promise<{ readonly attemptId: string } | null>;
}

// ---------------------------------------------------------------------------
// submission.json — deterministic, placeholders only, never real env values.
// ---------------------------------------------------------------------------

export function buildPhase2SubmissionJson(input: {
  readonly datasetId: string;
  readonly modelName: string;
  readonly baseUrlEnv?: string;
  readonly apiKeyEnv?: string;
}): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.datasetId)) throw new Phase2Error("datasetId must be a Wenyon dataset id");
  if (!PHASE2_MODEL_ALLOWLIST.includes(input.modelName)) {
    throw new Phase2Error(`model_name ${input.modelName} is not in the official allowlist`);
  }
  const baseUrlEnv = input.baseUrlEnv ?? "OPENAI_BASE_URL";
  const apiKeyEnv = input.apiKeyEnv ?? "OPENAI_API_KEY";
  for (const name of [baseUrlEnv, apiKeyEnv]) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || ["PATH", "PYTHONPATH", "HOME", "PWD"].includes(name)) {
      throw new Phase2Error(`invalid env var name for submission.json: ${name}`);
    }
  }
  const body = {
    source_url: `https://wenyon.dp.tech/app/console/datasets/${input.datasetId}`,
    model_name: input.modelName,
    envs: {
      [baseUrlEnv]: PHASE2_SUBMISSION_PLACEHOLDERS.baseUrl,
      [apiKeyEnv]: PHASE2_SUBMISSION_PLACEHOLDERS.apiKey,
    },
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(text) > 64 * 1024) throw new Phase2Error("submission.json exceeds 64KiB");
  return text;
}

// ---------------------------------------------------------------------------
// Release readiness and the deterministic submit adapter.
// ---------------------------------------------------------------------------

export interface Phase2Check {
  readonly id: string;
  readonly status: "green" | "waiting" | "red";
  readonly detail: string;
  readonly action?: string;
}

export type Phase2SubmitResult =
  | { readonly kind: "waiting"; readonly checks: readonly Phase2Check[] }
  | { readonly kind: "dry-run"; readonly bundleDigest: string; readonly detail: string }
  | { readonly kind: "receipt"; readonly attemptId: string; readonly receipt: Phase2Receipt; readonly duplicate: boolean }
  | { readonly kind: "uncertain"; readonly attemptRef: string; readonly detail: string };

function findRevision(state: Phase2State, revisionId: string): Phase2Revision {
  const revision = state.revisions.find((entry) => entry.id === revisionId);
  if (!revision) throw new Phase2Error(`unknown revision ${revisionId}`);
  return revision;
}

function hasEvidence(revision: Phase2Revision, kind: Phase2EvidenceKind): Phase2Evidence | undefined {
  return [...revision.evidence].reverse().find((entry) => entry.kind === kind);
}

export function phase2Spent(state: Phase2State): number {
  return state.budget.spent.reduce((total, entry) => total + entry.amount, 0);
}

export function phase2LatestScore(revision: Phase2Revision, kind: Phase2EvidenceKind): number | undefined {
  const hit = [...revision.evidence].reverse().find((entry) => entry.kind === kind && typeof entry.score === "number");
  return hit?.score;
}

/** Competition-defined eligibility: screening, withheld validation and a
 * repeat of the decisive noisy cases, all measured for this revision. */
export function isPhase2Eligible(revision: Phase2Revision): boolean {
  return phase2LatestScore(revision, "screening") !== undefined
    && phase2LatestScore(revision, "withheld-validation") !== undefined
    && phase2LatestScore(revision, "noisy-repeat") !== undefined;
}

/** Compare performance on the common panel, including the decisive rerun.
 * When performance ties, choose the cheaper measured panel. */
export function strongestPhase2Revision(revisions: readonly Phase2Revision[]): Phase2Revision | null {
  const eligible = revisions.filter(isPhase2Eligible);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => {
    const withheld = (phase2LatestScore(b, "withheld-validation") ?? Number.NEGATIVE_INFINITY) - (phase2LatestScore(a, "withheld-validation") ?? Number.NEGATIVE_INFINITY);
    if (withheld !== 0) return withheld;
    const screening = (phase2LatestScore(b, "screening") ?? Number.NEGATIVE_INFINITY) - (phase2LatestScore(a, "screening") ?? Number.NEGATIVE_INFINITY);
    if (screening !== 0) return screening;
    const repeat = phase2LatestScore(b, "noisy-repeat")! - phase2LatestScore(a, "noisy-repeat")!;
    if (repeat !== 0) return repeat;
    const cost = (revision: Phase2Revision) => {
      const panel = ["screening","withheld-validation","noisy-repeat"].map(kind =>
        [...revision.evidence].reverse().find(observation => observation.kind === kind)?.cost);
      return panel.every((n): n is number => typeof n === "number" && Number.isFinite(n))
        ? panel.reduce((total, n) => total + n, 0) : Number.POSITIVE_INFINITY;
    };
    const left = cost(a), right = cost(b);
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** Lifecycle predicates shared by the adapter and the research workflow. */
export function phase2AttemptUnconfirmed(attempt: Phase2Attempt): boolean {
  return attempt.real && ["submitting", "uncertain"].includes(attempt.state);
}

export function phase2AttemptSubmitted(attempt: Phase2Attempt): boolean {
  return attempt.real && ["accepted", "evaluating", "scored"].includes(attempt.state);
}

export function phase2AttemptPendingOfficial(attempt: Phase2Attempt): boolean {
  return attempt.real && ["uncertain", "submitting", "accepted", "evaluating"].includes(attempt.state);
}

/**
 * Parse the real Playground attempt status into summary facts only.
 *
 * Verified schema (public attempt 62146): top-level id/challengeId,
 * execStatus=completed, outcome=failed, yet resultsJson.harbor_reward=0,
 * harness2_eval_status=succeeded, harness2_raw_result.score_complete=true,
 * score_status=complete, cost=0. A graded zero is a score, not a pending or
 * missing value. Only the acknowledged own attempt is ingested, and only
 * summary facts leave this function — never the full tasks array.
 */
export function parsePhase2OfficialStatus(payload: unknown, expected: { readonly attemptId: string; readonly challengeId?: string }): Phase2AttemptStatus {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Phase2Error("playground status is not a JSON object");
  }
  const body = payload as Record<string, unknown>;
  const id = body.id ?? body.attemptId ?? body.attempt_id;
  if (String(id) !== String(expected.attemptId)) {
    throw new Phase2Error(`status id ${String(id)} does not match the acknowledged attempt ${expected.attemptId}; refusing to ingest another attempt`);
  }
  if (expected.challengeId && body.challengeId !== expected.challengeId) {
    throw new Phase2Error(`status challenge ${String(body.challengeId)} != ${expected.challengeId}; refusing to ingest an attempt whose challenge is missing or different`);
  }
  const results = body.resultsJson !== null && typeof body.resultsJson === "object" ? body.resultsJson as Record<string, unknown> : {};
  const rawResult = results.harness2_raw_result ?? body.harness2_raw_result;
  const raw = rawResult !== null && typeof rawResult === "object" ? rawResult as Record<string, unknown> : {};
  const scoreComplete = raw.score_complete === true || raw.score_status === "complete" || body.score_status === "complete";
  const execStatus = typeof body.execStatus === "string" ? body.execStatus : "";
  const outcome = typeof body.outcome === "string" ? body.outcome : "";
  const evaluation = results.harness2_eval_status ?? body.harness2_eval_status;
  const evalStatus = typeof evaluation === "string" ? evaluation : "";
  const detail = `execStatus=${execStatus || "unknown"} outcome=${outcome || "unknown"} eval=${evalStatus || "unknown"} score_status=${scoreComplete ? "complete" : "incomplete"}`;
  if (scoreComplete) {
    const score = results.harbor_reward;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Phase2Error(`score_status is complete but resultsJson.harbor_reward is not a finite number; ${detail}`);
    }
    const cost = raw.cost ?? body.cost;
    return {
      state: "scored",
      score,
      ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
      detail: `official result complete; ${detail}`,
    };
  }
  if (outcome === "failed" || execStatus === "failed" || evalStatus === "failed") {
    return { state: "failed", detail: `official evaluation failed without a complete score; ${detail}` };
  }
  if (execStatus === "running" || execStatus === "evaluating" || execStatus === "completed" || evalStatus === "running") {
    return { state: "evaluating", detail: `official evaluation in progress; ${detail}` };
  }
  return { state: "accepted", detail: `receipt acknowledged, no graded result yet; ${detail}` };
}

export interface Phase2AdapterOptions {
  readonly store: Phase2Store;
  readonly platform: Phase2Platform;
  readonly now?: () => string;
}

export class Phase2PlaygroundAdapter {
  private readonly store: Phase2Store;
  private readonly platform: Phase2Platform;
  private readonly now: () => string;

  constructor(options: Phase2AdapterOptions) {
    this.store = options.store;
    this.platform = options.platform;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Release checks tied to the candidate. Missing resources wait, never pass. */
  async checkRelease(revisionId: string): Promise<readonly Phase2Check[]> {
    const state = this.store.load();
    const revision = findRevision(state, revisionId);
    const checks: Phase2Check[] = [];
    const kit = await this.platform.kit();
    checks.push({
      id: "harbor-kit",
      status: kit.status === "verified" ? "green" : "waiting",
      detail: `Harbor ${PHASE2_HARBOR_PIN.version} kit ${kit.status}: ${kit.detail}`,
      ...(kit.status === "verified" ? {} : { action: kit.action ?? `bohr wenyon dataset download ${PHASE2_HARBOR_PIN.kitDataset} --version ${PHASE2_HARBOR_PIN.kitVersion} and verify the tarball sha256` }),
    });
    const source = hasEvidence(revision, "source-check");
    checks.push({
      id: "source-check",
      status: source?.passed === true ? "green" : "waiting",
      detail: source?.passed === true ? `offline source validation passed (${source.ref ?? "recorded"})` : "no passing offline/source validation tied to this revision",
      ...(source?.passed === true ? {} : { action: "run kit tools/check_source.py on the revision tree and record the result" }),
    });
    const smoke = hasEvidence(revision, "public-smoke");
    checks.push({
      id: "public-smoke",
      status: smoke?.passed === true ? "green" : "waiting",
      detail: smoke?.passed === true ? `public smoke passed (${smoke.ref ?? "recorded"})` : "no passing public smoke evidence tied to this revision",
      ...(smoke?.passed === true ? {} : { action: "run the public smoke task through the pinned Harbor kit and record the result" }),
    });
    const cloud = hasEvidence(revision, "cloud-self-test");
    checks.push({
      id: "real-validation",
      status: cloud && typeof cloud.score === "number" ? "green" : "waiting",
      detail: cloud && typeof cloud.score === "number" ? `real public-task validation score ${cloud.score} (cloud self-test, not official)` : "no real validation evidence on public dev tasks for this revision",
      ...(cloud && typeof cloud.score === "number" ? {} : { action: "run the public dev tasks with own credentials within the shared cap and record the cloud self-test score" }),
    });
    return checks;
  }

  private transition(attempt: Phase2Attempt, to: Phase2AttemptState, detail: string): Phase2Attempt {
    return { ...attempt, state: to, history: [...attempt.history, { at: this.now(), state: to, detail }] };
  }

  /** Drop a submission reservation when no real submission happened. */
  private releaseReservation(attemptId: string, note: string): void {
    const state = this.store.load();
    this.store.save({
      ...state,
      budget: {
        ...state.budget,
        spent: state.budget.spent.map((entry) => entry.attemptId === attemptId ? { ...entry, amount: 0, note } : entry),
      },
    });
  }

  private saveAttempt(attempt: Phase2Attempt): void {
    const state = this.store.load();
    const rest = state.attempts.filter((entry) => entry.id !== attempt.id);
    this.store.save({ ...state, attempts: [...rest, attempt] });
  }

  /**
   * Deterministic submit pipeline. `real: false` (default) stops after the
   * exact-bundle dry run. `real: true` additionally needs fresh platform
   * quota and budget headroom, and returns a receipt, never a guess.
   */
  async submit(input: {
    readonly revisionId: string;
    readonly modelName: string;
    readonly real?: boolean;
    readonly estimatedCost?: number;
  }): Promise<Phase2SubmitResult> {
    return this.store.withLock(() => this.submitLocked(input));
  }

  private async submitLocked(input: {
    readonly revisionId: string;
    readonly modelName: string;
    readonly real?: boolean;
    readonly estimatedCost?: number;
  }): Promise<Phase2SubmitResult> {
    const real = input.real === true;
    if (real && input.estimatedCost === undefined) {
      throw new Phase2Error("--estimated-cost is required for a real submit; an unknown cost never defaults to 0 against the shared cap");
    }
    const estimatedCost = input.estimatedCost ?? 0;
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) throw new Phase2Error("estimatedCost must be a non-negative number");
    const releaseChecks = await this.checkRelease(input.revisionId);
    const blocked = releaseChecks.filter((check) => check.status !== "green");
    if (blocked.length > 0) return { kind: "waiting", checks: blocked };

    const state = this.store.load();
    if (real) {
      // Cross-revision exclusion: an unconfirmed receipt on ANY revision
      // blocks a new real submit until the original attempt is reconciled.
      const unconfirmed = state.attempts.find(phase2AttemptUnconfirmed);
      if (unconfirmed) {
        return { kind: "uncertain", attemptRef: unconfirmed.id, detail: `attempt ${unconfirmed.id} on ${unconfirmed.revisionId} has no confirmed receipt; reconcile the original attempt instead of submitting another revision` };
      }
    }
    const existing = state.attempts.find((entry) => entry.revisionId === input.revisionId && entry.real);
    if (real && existing) {
      if (phase2AttemptSubmitted(existing)) {
        return {
          kind: "receipt",
          attemptId: existing.attemptId ?? existing.id,
          receipt: (existing.receipt as Phase2Receipt | undefined) ?? { attemptId: existing.attemptId ?? existing.id, status: existing.state },
          duplicate: true,
        };
      }
    }

    if (real) {
      // Quota and budget gate before any external side effect. One formal
      // submission per day: never guess the reset timezone and never assume
      // an unchecked account has a free slot.
      const quota = await this.refreshQuota();
      const current = this.store.load();
      if (quota.remainingToday === null || quota.remainingToday < 1) {
        return {
          kind: "waiting",
          checks: [{
            id: "quota",
            status: "waiting",
            detail: quota.remainingToday === null
              ? `platform could not confirm a free daily slot: ${quota.detail}`
              : `daily submission quota exhausted: ${quota.detail}`,
            action: "keep researching; re-check platform quota/attempt status before any real submit",
          }],
        };
      }
      if (phase2Spent(current) + estimatedCost > current.budget.cap) {
        return { kind: "waiting", checks: [{ id: "budget", status: "red", detail: `submission estimate ${estimatedCost} exceeds the shared cap (${phase2Spent(current)} + ${estimatedCost} > ${current.budget.cap})`, action: "keep researching within the cap or raise the cap explicitly" }] };
      }
    }

    // The locally nominated tree digest is computed independently; the
    // downloaded tree is verified against it, never against an upload echo.
    const revision = findRevision(state, input.revisionId);
    const treeDigest = await this.platform.localTreeDigest(revision);
    const source = await this.platform.createSource({ revision, treeDigest });
    await this.platform.grantOrganizerRead(source.datasetId);
    const verified = await this.platform.verifyDownloadedTree({ datasetId: source.datasetId, version: source.version, treeDigest });
    if (!verified.ok) {
      throw new Phase2Error(`downloaded tree mismatch for ${source.datasetId} v${source.version}: ${verified.detail}; do not submit a wrong reference`);
    }
    const finalSubmissionJson = buildPhase2SubmissionJson({ datasetId: source.datasetId, modelName: input.modelName });
    const bundle = await this.platform.validateBundle({ revisionId: input.revisionId, submissionJson: finalSubmissionJson, treeDigest });
    if (!bundle.ok) return { kind: "waiting", checks: [{ id: "bundle", status: "red", detail: `playground bundle validation failed: ${bundle.detail}`, action: "fix the bundle and re-run submit --dry-run" }] };
    if (!real) {
      return { kind: "dry-run", bundleDigest: bundle.bundleDigest, detail: "exact Playground bundle validated locally; no real submission was made" };
    }

    const idempotencyKey = digestValue({ revisionId: input.revisionId, datasetId: source.datasetId, version: source.version, bundle: bundle.bundleDigest });
    let attempt: Phase2Attempt = {
      id: `attempt-${idempotencyKey.slice(0, 16)}`,
      revisionId: input.revisionId,
      idempotencyKey,
      real: true,
      state: "prepared",
      datasetId: source.datasetId,
      sourceVersion: source.version,
      treeDigest,
      bundleDigest: bundle.bundleDigest,
      history: [...(existing?.history ?? []), { at: this.now(), state: "prepared", detail: "source granted, downloaded tree verified, bundle validated" }],
    };
    this.saveAttempt(attempt);
    attempt = this.transition(attempt, "submitting", "platform submit called");
    this.saveAttempt(attempt);
    const withSpend = this.store.load();
    this.store.save({
      ...withSpend,
      budget: {
        ...withSpend.budget,
        spent: [...withSpend.budget.spent, { id: `spend-${attempt.id}`, kind: "submission", amount: estimatedCost, at: this.now(), revisionId: input.revisionId, attemptId: attempt.id, note: "reserved at submit; settled to the official cost at reconciliation" }],
      },
    });

    let receipt: Phase2Receipt;
    try {
      receipt = await this.platform.submit({ revisionId: input.revisionId, bundleDigest: bundle.bundleDigest, idempotencyKey });
    } catch (error) {
      if (error instanceof Phase2AmbiguousSubmitError) {
        const uncertain = this.transition(attempt, "uncertain", `ambiguous submit response: ${error.message}; query the original attempt, do not resubmit`);
        this.saveAttempt(uncertain);
        return { kind: "uncertain", attemptRef: attempt.id, detail: error.message };
      }
      const failed = this.transition(attempt, "failed", `submit failed before any receipt: ${(error as Error).message}`);
      this.saveAttempt(failed);
      this.releaseReservation(attempt.id, "submit failed before any receipt; reservation released");
      throw error;
    }
    const accepted = this.transition({ ...attempt, attemptId: receipt.attemptId, receipt: receipt.raw ?? { attemptId: receipt.attemptId, status: receipt.status } }, "accepted", `platform receipt ${receipt.attemptId}: ${receipt.status}; accepted is not a final score`);
    this.saveAttempt(accepted);
    return { kind: "receipt", attemptId: receipt.attemptId, receipt, duplicate: false };
  }

  /**
   * Reconcile uncertain and pending attempts with the platform. Verified
   * official score/cost/status is written back for its own revision only.
   */
  /** Fresh platform quota, persisted. Ticks call this so a cached exhausted
   * day never blocks a later day. */
  async refreshQuota(): Promise<Phase2QuotaStatus> {
    const quota = await this.platform.quota();
    if (quota.remainingToday !== null && (!Number.isSafeInteger(quota.remainingToday) || quota.remainingToday < 0)) {
      throw new Phase2Error(`platform returned a malformed daily quota (${String(quota.remainingToday)}); treating it as unconfirmed instead of submitting`);
    }
    const state = this.store.load();
    this.store.save({ ...state, quota: { remainingToday: quota.remainingToday, checkedAt: this.now(), detail: quota.detail } });
    return quota;
  }

  /** Bind a platform attempt id to an unconfirmed local attempt (operator
   * confirmed it is the same own attempt) so reconcile can proceed. */
  bindAttempt(attemptRef: string, platformAttemptId: string): void {
    const state = this.store.load();
    const attempt = state.attempts.find((entry) => entry.id === attemptRef);
    if (!attempt) throw new Phase2Error(`unknown local attempt ${attemptRef}`);
    this.saveAttempt({ ...attempt, attemptId: platformAttemptId, history: [...attempt.history, { at: this.now(), state: attempt.state, detail: `operator bound platform attempt ${platformAttemptId}` }] });
  }

  async reconcile(): Promise<readonly Phase2Attempt[]> {
    return this.store.withLock(() => this.reconcileLocked());
  }

  private async reconcileLocked(): Promise<readonly Phase2Attempt[]> {
    const state = this.store.load();
    const pending = state.attempts.filter(phase2AttemptPendingOfficial);
    for (const attempt of pending) {
      let platformAttemptId = attempt.attemptId;
      if (!platformAttemptId) {
        const found = await this.platform.findAttempt(attempt.idempotencyKey);
        if (!found) {
          // Crash after "submitting" with no platform record: still ambiguous
          // unless the platform positively says nothing was received.
          if (attempt.state === "uncertain") continue;
          this.saveAttempt(this.transition(attempt, "uncertain", "no attempt id persisted and platform lookup found nothing; confirm the original attempt before any retry"));
          continue;
        }
        platformAttemptId = found.attemptId;
      }
      const status = await this.platform.attemptStatus(platformAttemptId);
      let next: Phase2Attempt = { ...attempt, attemptId: platformAttemptId };
      if (status.state === "not-received") {
        next = this.transition(next, "not-received", status.detail);
        this.releaseReservation(attempt.id, "platform confirms nothing was received; reservation released");
      } else if (status.state === "scored" || status.state === "failed") {
        next = this.transition({
          ...next,
          official: { ...(typeof status.score === "number" ? { score: status.score } : {}), ...(typeof status.cost === "number" ? { cost: status.cost } : {}), status: status.detail, at: this.now() },
        }, status.state, status.detail);
      } else {
        next = this.transition(next, status.state, status.detail);
      }
      this.saveAttempt(next);
      if (status.state === "scored") {
        const fresh = this.store.load();
        const revision = findRevision(fresh, attempt.revisionId);
        const officialEvidence: Phase2Evidence = {
          kind: "official",
          at: this.now(),
          ...(typeof status.score === "number" ? { score: status.score } : {}),
          ref: `attempt:${platformAttemptId}`,
          note: `verified platform status: ${status.detail}`,
        };
        const spent = fresh.budget.spent.map((entry) => entry.attemptId === attempt.id && typeof status.cost === "number" ? { ...entry, amount: status.cost, note: "settled to the official cost" } : entry);
        this.store.save({
          ...fresh,
          revisions: fresh.revisions.map((entry) => entry.id === revision.id ? { ...entry, evidence: [...entry.evidence, officialEvidence] } : entry),
          budget: { ...fresh.budget, spent },
        });
      }
    }
    return this.store.load().attempts;
  }
}
