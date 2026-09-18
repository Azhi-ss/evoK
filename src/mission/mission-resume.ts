/**
 * Durable recovery for interrupted Missions (#114, T6; spec #108 US41–45,
 * ADR-0004 "Recovery and model-led research decisions").
 *
 * Recovery reconstructs state ONLY from authoritative durable records
 * (mission.json + per-Run result.json + immutable snapshot bytes) and
 * confirmed Artifacts — never from a conversation or model memory. This module
 * is the one recovery seam:
 *
 *   - reconcileInterruptedMission audits every dispatched Run BEFORE a
 *     resume controller can dispatch again:
 *       measured + valid result.json + digest-matched snapshot → adopted as-is
 *         (no duplicate execution, accounting, evaluation, or promotion);
 *       durable snapshot but no confirmed result → independently RE-MEASURED
 *         by the evaluator port (the model never guesses a completion);
 *       no durable evidence → the unconfirmed intent is abandoned as Negative
 *         Evidence and a permitted retry later gets a FRESH Run identity;
 *       damaged records, digest mismatches, broken budget arithmetic, or an
 *         orphan metered session → explicit ReconciliationBlockedError.
 *   - Resume requires an explicit unambiguous user request
 *     (isExplicitResumeRequest): status browsing, negations, and questions
 *     never resume. Intake is not repeated and budget is never restored.
 *   - A controller lock held by a LIVE pid keeps fencing; a lock left by a
 *     dead process (crash/SIGKILL) is stale and reclaimable by the resumer.
 *
 * The model may later PROPOSE investigation/retry/repair/change-direction from
 * the reconciled projection; it cannot declare a lost Run successful, replay
 * it silently, or widen the objective/permissions/budget.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MissionDraft } from "./mission-draft";
import { isMissionId, missionsDir } from "./mission-draft";
import {
  MISSION_SCHEMA_VERSION,
  atomicWriteJson,
  baselineResultPath,
  type BaselineEvaluator,
  type BaselineMeasurement,
  type BaselineResultRecord,
  type ExperimentTrailEntry,
  type HistoryEventType,
  type MissionRecord,
  type MissionRunRecord,
  type MissionStatus,
  type MissionUsageLedger,
} from "./mission-start";

const LOCK_FILENAME = "controller.lock";
const RUNS_DIRNAME = "runs";
const SNAPSHOT_DIRNAME = "snapshot";
const RESULT_FILENAME = "result.json";

/** Statuses a human may explicitly resume; terminal states are not in this set. */
export const RESUMABLE_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  "interrupted",
  "baseline-complete",
  "director-stopped",
  "director-blocked",
  "decision-failed",
  "iteration-limit",
  "run-failed",
  "evaluator-rule-failure",
  "accepted",
  "running",
]);

export class ReconciliationBlockedError extends Error {
  readonly kind = "reconciliation-blocked" as const;
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "ReconciliationBlockedError";
    this.reason = reason;
  }
}

export class MissionResumeRejectedError extends Error {
  readonly kind = "mission-resume-rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "MissionResumeRejectedError";
  }
}

// ── explicit resume intent ─────────────────────────────────────────────────

const RESUME_VERBS = /\b(?:resume|continue|pick\s?up|go\s?on|carry\s?on)\b/i;
const MISSION_ID_RE = /\bm-[a-f0-9]{12}\b/i;

/**
 * Recognize an explicit, unambiguous request to RESUME an existing Mission.
 * Questions, negations, conditionals, and status chat stay non-resuming. An
 * explicit `/resume` always counts; an id, when present, is extracted.
 */
export function isExplicitResumeRequest(text: string): { resume: boolean; missionId?: string } {
  const t = text.trim();
  const lower = t.toLowerCase();
  const id = t.match(MISSION_ID_RE)?.[0];
  if (/^\/resume(?:\s|$)/.test(lower)) return { resume: true, ...(id ? { missionId: id } : {}) };
  if (lower.includes("?")) return { resume: false, ...(id ? { missionId: id } : {}) };
  if (/\b(?:don'?t|do not|never|shouldn'?t|won'?t|cannot|can'?t|not|maybe|later)\b[^.!?]*\b(?:resume|continue|pick\s?up|go\s?on|carry\s?on)\b/i.test(t)) {
    return { resume: false, ...(id ? { missionId: id } : {}) };
  }
  // "resume m-<id>" names the Mission directly; otherwise require a resume verb
  // together with a Mission reference (mission/it/where we left off).
  if (id && RESUME_VERBS.test(lower)) return { resume: true, missionId: id };
  if (RESUME_VERBS.test(lower) && /\b(?:mission|research|where (?:we|it) (?:left|stopped)|it)\b/i.test(t)) {
    return { resume: true, ...(id ? { missionId: id } : {}) };
  }
  return { resume: false, ...(id ? { missionId: id } : {}) };
}

// ── controller lock ─────────────────────────────────────────────────────────

function lockPath(projectRoot: string, missionId: string): string {
  return join(missionsDir(projectRoot), missionId, LOCK_FILENAME);
}

/**
 * True when the controller lock is stale (no file, or held by a dead pid) and
 * a resume controller may reclaim the Mission. False means a LIVE process
 * holds it: concurrent-controller fencing stands and resume must refuse.
 */
export async function staleControllerLock(projectRoot: string, missionId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath(projectRoot, missionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let pid: unknown;
  try {
    pid = JSON.parse(raw)?.pid;
  } catch {
    // Unparseable lock: treat as an active, unverifiable fence, never silently
    // steal a Mission that another controller might own.
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  // kill(pid, 0) is a liveness probe; EPERM means the process exists.
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// ── durable-artifact helpers ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotDir(projectRoot: string, missionId: string, runId: string): string {
  return join(missionsDir(projectRoot), missionId, RUNS_DIRNAME, runId, SNAPSHOT_DIRNAME);
}

function collectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files[rel] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(root)) walk(root, "");
  return files;
}

function digestFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name); hash.update("\0"); hash.update(files[name]!); hash.update("\0");
  }
  return hash.digest("hex");
}

async function readResultJson(projectRoot: string, missionId: string, runId: string): Promise<BaselineResultRecord | undefined> {
  try {
    const raw = await readFile(baselineResultPath(projectRoot, missionId, runId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.snapshotDigest !== "string" || !isRecord(parsed.evaluation)) return undefined;
    return parsed as unknown as BaselineResultRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function fail(reason: string): never {
  throw new ReconciliationBlockedError(`recovery blocked for damaged Mission state: ${reason}`, reason);
}

// ── structural + accounting integrity (fail visibly on corruption) ──────────

function assertIntact(record: MissionRecord): void {
  if (record.schemaVersion !== MISSION_SCHEMA_VERSION) fail(`unsupported schemaVersion ${record.schemaVersion}`);
  if (!Number.isFinite(record.budget.total) || !Number.isFinite(record.budget.consumed) || !Number.isFinite(record.budget.remaining)) {
    fail("budget ledger contains non-finite values");
  }
  if (Math.abs(record.budget.remaining - (record.budget.total - record.budget.consumed)) > 1e-9) {
    fail("budget remaining disagrees with total - consumed");
  }
  if (record.budget.consumed < -1e-12 || record.budget.consumed > record.budget.total + 1e-9) {
    fail("budget consumed is outside the declared envelope");
  }
  if (!Array.isArray(record.usage.runs) || !isRecord(record.usage.intake)) fail("usage ledger is damaged");
  const meteredSessions = new Set(record.usage.runs.map((line) => line.sessionId));
  for (const run of Object.values(record.runs)) {
    // Only a run that ALREADY carries a confirmed resultRef must have its
    // metered ledger line. A snapshot-only killed run has no result yet (its
    // outcome is reconciled separately) and is not "measured" on this check.
    if (run.resultRef) {
      if (!run.sessionId || !meteredSessions.has(run.sessionId)) {
        fail(`confirmed run ${run.runId} has no matching metered usage line (damaged accounting)`);
      }
    }
  }
  if (record.baseline && record.baselineRunId) {
    const baselineRun = record.runs[record.baselineRunId];
    if (!baselineRun) fail("baseline points at a missing run record");
  }
}

// ── reconciliation ──────────────────────────────────────────────────────────

export interface AbandonedIntent {
  readonly runId: string;
  readonly attempt: number;
  readonly reason: string;
}

export interface ReconciliationReport {
  readonly record: MissionRecord;
  /** Confirmed runs adopted with no duplicate work. */
  readonly adoptedRunIds: readonly string[];
  /** Durable snapshots independently re-measured during recovery. */
  readonly remeasuredRunIds: readonly string[];
  /** Unconfirmed pre-interrupt intents, retained as Negative Evidence. */
  readonly abandonedIntents: readonly AbandonedIntent[];
}

export interface ReconcileOptions {
  readonly projectRoot: string;
  readonly draft: MissionDraft;
  readonly record: MissionRecord;
  readonly evaluator: BaselineEvaluator;
  readonly now?: () => string;
}

function trailEntryFor(result: BaselineResultRecord, run: MissionRunRecord, record: MissionRecord): ExperimentTrailEntry {
  // Recover the real Director action/objective from durable history rather
  // than guessing a label; fall back to the baseline identity only.
  const applied = [...record.history].reverse().find((h) =>
    h.type === "PROPOSAL_APPLIED" && isRecord(h.detail) && h.detail.runId === run.runId);
  const appliedAction = applied && isRecord(applied.detail) && typeof applied.detail.action === "string"
    ? applied.detail.action as ExperimentTrailEntry["action"] : undefined;
  const action = run.runId.includes(":baseline:") ? "baseline" as const : (appliedAction ?? "repair" as const);
  const taskId = applied && isRecord(applied.detail) && typeof applied.detail.taskId === "string" ? applied.detail.taskId : undefined;
  const taskObjective = record.tasks?.find((t) => t.taskId === taskId)?.objective ?? "";
  return {
    runId: result.runId,
    attempt: run.attempt,
    action,
    ok: result.evaluation.ok,
    ...(result.evaluation.ok ? {} : { negativeEvidence: true }),
    taskObjective,
    candidateId: result.candidateId,
    snapshotDigest: result.snapshotDigest,
    evaluator: result.evaluator,
    evaluation: result.evaluation,
    evidenceRefs: result.evidenceRefs,
    ...(result.evaluation.ruleViolations?.length ? { ruleViolations: [...result.evaluation.ruleViolations] } : {}),
    at: result.measuredAt,
  };
}

/**
 * Audit and reconstruct one interrupted/stopped Mission purely from durable
 * evidence. Mutates no record on disk itself; the caller persists the returned
 * record. The evaluator port runs ONLY against durable snapshots that lack a
 * confirmed result; confirmed results are never evaluated twice.
 */
export async function reconcileInterruptedMission(options: ReconcileOptions): Promise<ReconciliationReport> {
  if (!isAbsolute(options.projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  const { projectRoot, draft, record } = options;
  assertIntact(record);

  const adoptedRunIds: string[] = [];
  const remeasuredRunIds: string[] = [];
  const abandonedIntents: AbandonedIntent[] = [];
  let experiments = [...(record.experiments ?? [])];
  let baseline = record.baseline;
  let baselineRunId = record.baselineRunId;
  let runs = { ...record.runs };
  let reserved = record.reserved;
  let stateVersion = record.stateVersion ?? 0;
  const events: Array<{ type: HistoryEventType; detail?: Record<string, unknown> }> = [];

  const runsOrdered = Object.values(runs).sort((a, b) => a.attempt - b.attempt || a.runId.localeCompare(b.runId));
  for (const runOriginal of runsOrdered) {
    const run = runOriginal;
    const result = await readResultJson(projectRoot, draft.id, run.runId);
    const snapDir = snapshotDir(projectRoot, draft.id, run.runId);
    let snapshotFiles: Record<string, string> | undefined;
    let snapshotDigest: string | undefined;
    if (existsSync(snapDir)) {
      snapshotFiles = collectFiles(snapDir);
      snapshotDigest = digestFiles(snapshotFiles);
    }

    const isBaselineRun = run.runId === baselineRunId || run.runId.includes(":baseline:");
    const claimed: BaselineResultRecord | undefined = result ?? (isBaselineRun ? baseline : undefined);

    if (claimed) {
      // Adopt only if the immutable evidence chain is intact.
      if (!snapshotDigest) fail(`confirmed run ${run.runId} is missing its snapshot artifacts`);
      if (claimed.snapshotDigest !== snapshotDigest) {
        fail(`snapshot digest for ${run.runId} no longer matches its confirmed result (evidence tampering or damage)`);
      }
      if (claimed.evaluator.id !== options.evaluator.id) {
        // A different evaluator identity is an evaluation-contract change, not
        // something recovery silently re-labels.
        fail(`run ${run.runId} was measured by ${claimed.evaluator.id} but recovery loaded ${options.evaluator.id}`);
      }
      adoptedRunIds.push(run.runId);
      runs[run.runId] = { ...run, status: "measured", resultRef: run.resultRef ?? `runs/${run.runId}/${RESULT_FILENAME}`, snapshotRef: run.snapshotRef ?? `runs/${run.runId}/${SNAPSHOT_DIRNAME}` };
      if (isBaselineRun) {
        baselineRunId = run.runId;
        baseline = claimed;
      } else if (!experiments.some((e) => e.runId === run.runId)) {
        experiments.push(trailEntryFor(claimed, { ...run, status: "measured" }, record));
        stateVersion += 1;
        events.push({ type: "RECOVERY_REMEASURED", detail: { runId: run.runId, adopted: true } });
      }
      continue;
    }

    // No confirmed result. A durable snapshot is independently re-measured —
    // the model never asserts completion and the old session is never replayed.
    if (snapshotDigest && snapshotFiles) {
      const measurement: BaselineMeasurement = await options.evaluator.evaluate(snapshotFiles, {
        missionId: draft.id, runId: run.runId, snapshotDigest, contract: record.contract,
      });
      const refs = [`runs/${run.runId}/${SNAPSHOT_DIRNAME}`, `runs/${run.runId}/${RESULT_FILENAME}`];
      const rebuilt: BaselineResultRecord = {
        runId: run.runId,
        candidateId: `candidate:${snapshotDigest.slice(0, 16)}`,
        snapshotDigest,
        evaluator: { id: options.evaluator.id, version: options.evaluator.version },
        evaluation: measurement,
        evidenceRefs: refs,
        measuredAt: new Date().toISOString(),
      };
      const runDir = join(missionsDir(projectRoot), draft.id, RUNS_DIRNAME, run.runId);
      await mkdir(runDir, { recursive: true });
      await atomicWriteJson(join(runDir, RESULT_FILENAME), rebuilt);
      runs[run.runId] = { ...run, status: "measured", resultRef: `runs/${run.runId}/${RESULT_FILENAME}`, snapshotRef: `runs/${run.runId}/${SNAPSHOT_DIRNAME}` };
      remeasuredRunIds.push(run.runId);
      stateVersion += 1;
      if (isBaselineRun && !baseline) {
        baselineRunId = run.runId;
        baseline = rebuilt;
      } else {
        experiments.push(trailEntryFor(rebuilt, { ...run, status: "measured" }, record));
      }
      events.push({ type: "RECOVERY_REMEASURED", detail: { runId: run.runId, adopted: false, score: measurement.score } });
      continue;
    }

    // Dispatched before the interruption but with NO durable result or
    // snapshot: the outcome is unknowable. Abandon the intent (never adopt a
    // guessed completion, never silently replay); its reservation stays
    // conservatively held so the unknown spend cannot be dispatched twice.
    abandonedIntents.push({ runId: run.runId, attempt: run.attempt, reason: "dispatched before interruption with no durable result or snapshot" });
    runs[run.runId] = { ...run, status: "interrupted", finishedAt: run.finishedAt ?? new Date().toISOString() };
    // The unconfirmed intent is ALWAYS surfaced as Negative Evidence — even a
    // lost baseline — so the Director sees the attempt it must investigate.
    if (!experiments.some((e) => e.runId === run.runId)) {
      const applied = [...record.history].reverse().find((h) =>
        h.type === "PROPOSAL_APPLIED" && isRecord(h.detail) && h.detail.runId === run.runId);
      const action = isBaselineRun ? "baseline" as const
        : applied && isRecord(applied.detail) && typeof applied.detail.action === "string"
          ? applied.detail.action as ExperimentTrailEntry["action"] : "repair" as const;
      experiments.push({
        runId: run.runId, attempt: run.attempt,
        action,
        ok: false, negativeEvidence: true,
        taskObjective: isBaselineRun ? (record.tasks?.[0]?.objective ?? run.intentId) : run.intentId,
        evidenceRefs: [], error: "unconfirmed pre-interrupt intent abandoned during recovery; retry requires a fresh Run",
        at: new Date().toISOString(),
      });
      stateVersion += 1;
    }
    events.push({ type: "RECOVERY_ABANDONED_INTENT", detail: { runId: run.runId, attempt: run.attempt } });
  }

  const history = [...record.history];
  const now = options.now ?? (() => new Date().toISOString());
  for (const event of events) history.push({ type: event.type, at: now(), ...(event.detail ? { detail: event.detail } : {}) });
  history.push({ type: "RECOVERY_COMPLETED", at: now(), detail: { adopted: adoptedRunIds.length, remeasured: remeasuredRunIds.length, abandoned: abandonedIntents.length } });

  const recovered: MissionRecord = {
    ...record,
    status: "running",
    ...(stopReasonCleared(record.status) ? { stopReason: undefined } : {}),
    runs,
    reserved,
    experiments,
    stateVersion,
    ...(baseline ? { baseline } : {}),
    ...(baselineRunId ? { baselineRunId } : {}),
    history,
    updatedAt: now(),
  };
  assertIntact(recovered);
  return { record: recovered, adoptedRunIds, remeasuredRunIds, abandonedIntents };
}

/** Resumable stop states clear their stopReason on recovery; others never had one. */
function stopReasonCleared(status: MissionStatus): boolean {
  return status === "interrupted" || status === "director-stopped" || status === "director-blocked"
    || status === "decision-failed" || status === "iteration-limit" || status === "run-failed"
    || status === "baseline-complete" || status === "evaluator-rule-failure" || status === "accepted" || status === "running";
}

// ── reopen listing ──────────────────────────────────────────────────────────

export interface UnfinishedMissionView {
  readonly id: string;
  readonly status: MissionStatus;
  readonly stopReason?: string;
  readonly experiments: number;
  readonly negativeEvidence: number;
  readonly hasBaseline: boolean;
  readonly totalBudget: number;
  readonly consumedBudget: number;
  readonly remainingBudget: number;
  readonly units: string;
  readonly resumable: boolean;
  readonly updatedAt: string;
}

export interface UnfinishedMissionsView {
  readonly missions: readonly UnfinishedMissionView[];
  /** Mission drafts with no accepted start (intake resumes the conversation, not a Run). */
  readonly drafts: readonly { readonly id: string; readonly updatedAt: string }[];
}

/**
 * Reopen a project: list every accepted Mission with progress, stop/blocker
 * information, and remaining budget, plus unstarted drafts. Corrupt records
 * are surfaced, never hidden as absent Missions.
 */
export async function listUnfinishedMissions(projectRoot: string): Promise<UnfinishedMissionsView> {
  if (!isAbsolute(projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  const root = missionsDir(projectRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missions: [], drafts: [] };
    throw error;
  }
  const missions: UnfinishedMissionView[] = [];
  const drafts: { id: string; updatedAt: string }[] = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const id = entry.name;
    if (!isMissionId(id)) continue;
    const dir = join(root, id);
    const missionFile = join(dir, "mission.json");
    const draftFile = join(dir, "draft.json");
    const [missionStat, draftStat] = await Promise.all([stat(missionFile).catch(() => undefined), stat(draftFile).catch(() => undefined)]);
    if (missionStat) {
      const raw = await readFile(missionFile, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ReconciliationBlockedError(`mission.json for ${id} is not valid JSON`, `damaged mission record: ${id}`);
      }
      const r = parsed as MissionRecord;
      // A parseable but structurally damaged record is surfaced, never hidden
      // as an absent Mission or rendered with NaN figures.
      if (!isRecord(r) || r.id !== id || typeof r.status !== "string" || !isRecord(r.budget)
        || typeof r.budget.total !== "number" || typeof r.budget.consumed !== "number" || typeof r.budget.remaining !== "number"
        || Math.abs(r.budget.remaining - (r.budget.total - r.budget.consumed)) > 1e-9) {
        throw new ReconciliationBlockedError(`mission.json for ${id} has a damaged status or budget ledger`, `damaged mission record: ${id}`);
      }
      const experiments = Array.isArray(r.experiments) ? r.experiments : [];
      missions.push({
        id,
        status: r.status,
        ...(r.stopReason ? { stopReason: r.stopReason } : {}),
        experiments: experiments.length,
        negativeEvidence: experiments.filter((e) => !e.ok).length,
        hasBaseline: Boolean(r.baseline),
        totalBudget: r.budget.total,
        consumedBudget: r.budget.consumed,
        remainingBudget: r.budget.remaining,
        units: r.budget.units,
        resumable: RESUMABLE_STATUSES.has(r.status),
        updatedAt: r.updatedAt,
      });
    } else if (draftStat) {
      drafts.push({ id, updatedAt: new Date(draftStat.mtimeMs).toISOString() });
    }
  }
  missions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { missions, drafts };
}
