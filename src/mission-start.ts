/**
 * Authorized Mission start + measured baseline (#112, T4; spec #108
 * US12–13/25/30–35/38–40/44–46; ADR-0001/0004/0005/0006).
 *
 * One validated start action turns a reviewed Mission DRAFT (mission-draft.ts)
 * into exactly one bounded baseline Experiment on the existing Pi execution
 * path:
 *
 *   authorization check → persist accepted Mission + execution intent
 *   → reserve budget → dispatch ONE Run through PiAgentRuntime (fresh
 *   session/workspace, resolved model, coding tools in the approved isolated
 *   workspace) → freeze the workspace into an immutable Candidate snapshot
 *   → independent BaselineEvaluator measures the snapshot (a model-supplied
 *   score can never replace measurement) → persist result/usage/stop reason.
 *
 * Controller records, evaluator inputs, credentials, and skill sources stay
 * outside candidate write authority: the Run workspace is disposable temp
 * storage, the project .evok tree is a read root only and is sandbox-protected,
 * and snapshot/result files are written by THIS trusted controller after the
 * Run ends.
 *
 * No autonomous continuation, External Submission, or implicit Human
 * Acceptance lives here (later slices). Crash-safety is deliberately simple:
 * a controller lock plus terminal status; an interrupted in-flight execution
 * is reported as blocked until the recovery slice (#114) — never silently
 * re-dispatched and never adopted on hope.
 */
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EvokResources } from "./evok-resources";
import {
  isMissionId,
  loadMissionDraft,
  missionsDir,
  type MissionDraft,
} from "./mission-draft";
import { draftReadyForReview } from "./mission-intake";
import {
  PiAgentRuntime,
  READ_ONLY_TOOLS,
  type AgentRuntimeResult,
  type ModelConfigView,
  type RuntimeUsage,
  type SessionModelResolver,
} from "./pi-agent-runtime";

export const MISSION_SCHEMA_VERSION = 1 as const;
const MISSION_FILENAME = "mission.json";
const LOCK_FILENAME = "controller.lock";
const RUNS_DIRNAME = "runs";
const SNAPSHOT_DIRNAME = "snapshot";
const RESULT_FILENAME = "result.json";

/** Only this budget unit is enforceable on this path (priced model usage). */
export const ENFORCEABLE_BUDGET_UNITS = "model-USD" as const;

/** Permissions the draft may declare that this baseline path actually grants. */
const SUPPORTED_PERMISSIONS = new Set([
  "read-project",
  "isolated-workspace-write",
  "local-shell-in-workspace",
]);

/** Declared permissions that can never be granted by start (later authority). */
const FORBIDDEN_PERMISSION = /submi|external|network|internet|credential|deploy|publish/i;

export class MissionStartRejectedError extends Error {
  readonly kind = "mission-start-rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "MissionStartRejectedError";
  }
}

export class MissionControllerConflictError extends Error {
  readonly kind = "mission-controller-conflict" as const;
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "MissionControllerConflictError";
    this.reason = reason;
  }
}

export class MissionRecordCorruptionError extends Error {
  readonly kind = "mission-record-corruption" as const;
  constructor(message: string) {
    super(message);
    this.name = "MissionRecordCorruptionError";
  }
}

export class BudgetExhaustedError extends Error {
  readonly kind = "budget-exhausted" as const;
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class EvaluatorFailureError extends Error {
  readonly kind = "evaluator-failure" as const;
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorFailureError";
  }
}

/**
 * Explicit, user-sourced start authorization. Natural-language start requests
 * and `/start` invoke the SAME validated action; the model can only report an
 * authorization to trusted code, never originate one (`source: "model"` is
 * rejected).
 */
export interface StartAuthorization {
  /** The user clearly requested a start (vs. a question/discussion). */
  readonly requested: boolean;
  /** The token the user typed ("/start", "start the mission", …) for the audit trail. */
  readonly token: string;
  /**
   * Which Mission the user sees as displayed: the literal "displayed" means
   * the CLI-selected current draft; an explicit id must match the target.
   */
  readonly missionSelector: string;
  readonly source?: "user" | "model";
}

export interface BaselineEvaluationFact {
  readonly name: string;
  readonly value: string | number | boolean;
  readonly source?: string;
}

/** What an independent measurement returns. It never trusts model text. */
export interface BaselineMeasurement {
  readonly ok: boolean;
  readonly score?: number;
  readonly ruleViolations?: readonly string[];
  readonly facts?: readonly BaselineEvaluationFact[];
}

/**
 * The independent Evaluator port for the declared Competition contract. It
 * measures immutable snapshot bytes; it is NOT the candidate, NOT the model,
 * and NOT a pre-filled score file. Adapters supply the concrete evaluator.
 */
export interface BaselineEvaluator {
  readonly id: string;
  readonly version: string;
  evaluate(
    snapshot: Readonly<Record<string, string>>,
    context: {
      readonly missionId: string;
      readonly runId: string;
      readonly snapshotDigest: string;
      readonly contract: MissionStartContract;
    },
  ): Promise<BaselineMeasurement> | BaselineMeasurement;
}

export interface MissionStartContract {
  readonly objective: string;
  readonly expectedOutputs: readonly string[];
  readonly evaluationMethod: string;
  readonly metric?: string;
  readonly hardRules: readonly string[];
}

export interface UsageLine {
  readonly at: string;
  readonly sessionId: string;
  readonly tokens: RuntimeUsage["tokens"];
  readonly cost: RuntimeUsage["cost"];
}

export interface MissionUsageLedger {
  /** Metered intake discussion carried over from the draft (US31: never zeroed). */
  readonly intake: {
    readonly tokens: MissionDraft["usage"]["tokens"];
    readonly cost: MissionDraft["usage"]["cost"];
  };
  /** One priced usage line per dispatched baseline Run. */
  readonly runs: readonly UsageLine[];
}

export interface MissionRunRecord {
  readonly runId: string;
  readonly intentId: string;
  readonly attempt: number;
  readonly status: "dispatched" | "measured" | "failed" | "interrupted";
  readonly sessionId?: string;
  readonly model?: ModelConfigView;
  readonly workspace: string;
  readonly snapshotRef?: string;
  readonly resultRef?: string;
  readonly error?: string;
  readonly dispatchedAt: string;
  readonly finishedAt?: string;
}

export interface BaselineResultRecord {
  readonly runId: string;
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly evaluator: { readonly id: string; readonly version: string };
  readonly evaluation: BaselineMeasurement;
  readonly evidenceRefs: readonly string[];
  readonly measuredAt: string;
}

export type MissionStatus =
  | "accepted"
  | "running"
  | "baseline-complete"
  | "evaluator-rule-failure"
  | "evaluator-failed"
  | "budget-exhausted"
  | "run-failed"
  | "interrupted";

export interface HistoryEvent {
  readonly type:
    | "MISSION_ACCEPTED"
    | "EXECUTION_INTENT_PERSISTED"
    | "BUDGET_RESERVED"
    | "RUN_DISPATCHED"
    | "RUN_INTERRUPTED"
    | "RUN_FAILED"
    | "SNAPSHOT_COMMITTED"
    | "EVALUATION_MEASURED"
    | "EVALUATOR_FAILED"
    | "BUDGET_EXHAUSTED"
    | "BASELINE_COMPLETED";
  readonly at: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface MissionRecord {
  readonly schemaVersion: typeof MISSION_SCHEMA_VERSION;
  readonly id: string;
  readonly status: MissionStatus;
  readonly objective: string;
  readonly contract: MissionStartContract;
  readonly budget: { readonly total: number; readonly units: string; readonly consumed: number; readonly remaining: number };
  readonly reserved: number;
  readonly usage: MissionUsageLedger;
  readonly runs: Readonly<Record<string, MissionRunRecord>>;
  readonly baselineRunId?: string;
  readonly baseline?: BaselineResultRecord;
  readonly history: readonly HistoryEvent[];
  readonly stopReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartMissionOptions {
  readonly projectRoot: string;
  readonly missionId: string;
  readonly authorization: StartAuthorization;
  readonly resolver: SessionModelResolver;
  readonly resources: EvokResources;
  readonly evaluator: BaselineEvaluator;
  /** Enforceable budget unit; must match the draft's declared unit. */
  readonly budgetUnits?: string;
  readonly tier?: string;
  readonly signal?: AbortSignal;
  /**
   * Model/control cost reserved BEFORE dispatch for the single baseline Run
   * (same unit as the budget). Unknown cost is never assumed zero: callers
   * that cannot bound the Run pass an honest bound; zero reserves nothing and
   * enforcement happens on observed cost.
   */
  readonly reserveCost?: number;
  /** Isolated workspace parent (default: OS temp dir). */
  readonly workspaceRoot?: string;
  /**
   * Trusted-side model pricing (cost per token). Provider-reported cost is
   * used when the SDK returns a positive total; this pricing is the honest
   * fallback for runtimes that emit token counts without cost (faux/local).
   * Unknown cost is never silently treated as zero: when both are absent the
   * caller must supply pricing or the bound cannot be claimed.
   */
  readonly priceModelCost?: (model: ModelConfigView) => (tokens: RuntimeUsage["tokens"]) => number | undefined;
  /** Test seam: leave the controller lock in place (simulates a live controller). */
  readonly leaveLock?: boolean;
}

export interface StartMissionOutcome {
  readonly runId: string;
  readonly status: MissionStatus;
  readonly stopReason: string;
  readonly model: ModelConfigView;
  readonly usage: RuntimeUsage;
  readonly budget: MissionRecord["budget"];
  readonly evaluation: BaselineMeasurement;
  readonly record: MissionRecord;
}

function missionDir(projectRoot: string, missionId: string): string {
  return join(missionsDir(projectRoot), missionId);
}

export function missionRecordPath(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), MISSION_FILENAME);
}

function lockPath(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), LOCK_FILENAME);
}

function runDir(projectRoot: string, missionId: string, runId: string): string {
  return join(missionDir(projectRoot, missionId), RUNS_DIRNAME, runId);
}

export function baselineResultPath(projectRoot: string, missionId: string, runId: string): string {
  return join(runDir(projectRoot, missionId, runId), RESULT_FILENAME);
}

function snapshotPath(projectRoot: string, missionId: string, runId: string): string {
  return join(runDir(projectRoot, missionId, runId), SNAPSHOT_DIRNAME);
}

/** Crash-safe write: temp file + fsync + atomic rename, fsync the directory. */
async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    // ponytail: fsync file + directory; rename is atomic but not durable past a
    // power loss without the fsync pair. Cheap relative to one model Run.
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  const dir = await open(join(file, ".."), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digestFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files[name]);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Validation shared by disk loads: untrustworthy bytes are never a new Mission. */
function validateRecord(value: unknown, expectedId: string): MissionRecord {
  if (!isRecord(value)) throw new MissionRecordCorruptionError(`mission.json for ${expectedId} must be a JSON object`);
  if (value.schemaVersion !== MISSION_SCHEMA_VERSION) {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}`);
  }
  if (value.id !== expectedId) {
    throw new MissionRecordCorruptionError(`mission.json id ${JSON.stringify(value.id)} does not match directory ${expectedId}`);
  }
  if (typeof value.status !== "string" || typeof value.objective !== "string" || value.objective.trim() === "") {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} is missing status/objective`);
  }
  if (!isRecord(value.budget) || typeof value.budget.total !== "number" || typeof value.budget.consumed !== "number") {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has a damaged budget ledger`);
  }
  if (!Array.isArray(value.history)) {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has a damaged history`);
  }
  if (!isRecord(value.usage) || !isRecord(value.usage.intake) || !Array.isArray(value.usage.runs)) {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has damaged usage records`);
  }
  if (!isRecord(value.runs)) {
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has damaged run records`);
  }
  return value as unknown as MissionRecord;
}

export async function loadMissionRecord(projectRoot: string, missionId: string): Promise<MissionRecord> {
  if (!isMissionId(missionId)) throw new MissionRecordCorruptionError(`malformed mission id: ${missionId}`);
  let raw: string;
  try {
    raw = await readFile(missionRecordPath(projectRoot, missionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissionStartRejectedError(`mission ${missionId} has no accepted start record (only a draft or nothing)`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MissionRecordCorruptionError(`mission.json for ${missionId} is not valid JSON: ${(error as Error).message}`);
  }
  return validateRecord(parsed, missionId);
}

/**
 * Recognize an explicit natural-language start request. Ambiguity stays a
 * conversation: questions ("when can we start…?"), negations ("do not start")
 * and conditional wishes never authorize a paid dispatch — only a positive
 * imperative that names this Mission/baseline/experiment/run (or `/start`).
 */
export function isExplicitStartRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^\/start(?:\s|$)/.test(t)) return true;
  if (t.includes("?")) return false;
  if (/\b(?:don'?t|do not|never|shouldn'?t|won'?t|cannot|can'?t|not)\b[^.!?]*\bstart\b/.test(t)) return false;
  return /(?:^|\s)(?:please\s+)?start\b[^?]*\b(?:mission|baseline|experiment|run)\b/.test(t)
    || /\b(?:begin|launch|dispatch|kick\s?off)\b[^?]*\b(?:mission|baseline|experiment|run)\b/.test(t);
}

function assertStartable(draft: MissionDraft, options: StartMissionOptions): void {
  const auth = options.authorization;
  if (!auth.requested || !isExplicitStartRequest(auth.token)) {
    throw new MissionStartRejectedError("start intent is ambiguous or absent; discussing a Mission does not dispatch work");
  }
  if (auth.source === "model") {
    throw new MissionStartRejectedError("start authorization must come from the user; a model-authored approval cannot dispatch a Mission");
  }
  const selected = auth.missionSelector;
  if (selected !== "displayed" && selected !== draft.id) {
    throw new MissionStartRejectedError(`start targets mission ${selected} but the displayed mission is ${draft.id}; refusing to guess which work was authorized`);
  }
  if (!draftReadyForReview(draft)) {
    const missing: string[] = [];
    if (draft.objective.trim() === "") missing.push("objective");
    if (draft.successCriteria.length === 0) missing.push("success criteria");
    if (draft.data.description.trim() === "") missing.push("data description");
    if (draft.evaluation.method.trim() === "") missing.push("evaluation method");
    if (draft.budget.total <= 0) missing.push("a positive enforceable budget");
    if (draft.outputs.length === 0) missing.push("declared outputs");
    if (draft.stopConditions.length === 0) missing.push("stop conditions");
    if (draft.plan.tasks.length === 0) missing.push("the initial baseline task");
    if (draft.unresolvedPrerequisites.length > 0) {
      throw new MissionStartRejectedError(`execution prerequisites remain unresolved: ${draft.unresolvedPrerequisites.join("; ")}`);
    }
    throw new MissionStartRejectedError(`mission ${draft.id} is not ready to start (missing: ${missing.join(", ") || "review requirements"})`);
  }
  const units = options.budgetUnits ?? ENFORCEABLE_BUDGET_UNITS;
  if (draft.budget.units !== units) {
    throw new MissionStartRejectedError(
      `declared budget unit "${draft.budget.units}" is not enforceable on this path (only "${units}" is metered from real provider usage); refusing to claim a cap`,
    );
  }
  const permissions = draft.constraints.permissions ?? [];
  for (const permission of permissions) {
    if (FORBIDDEN_PERMISSION.test(permission)) {
      throw new MissionStartRejectedError(`declared permission "${permission}" cannot be granted at start (external/irreversible authority is never implicit)`);
    }
    if (!SUPPORTED_PERMISSIONS.has(permission)) {
      throw new MissionStartRejectedError(`declared permission "${permission}" is not supported by the baseline path; remove it or start through a path that grants it`);
    }
  }
}

function contractFromDraft(draft: MissionDraft): MissionStartContract {
  return {
    objective: draft.objective,
    expectedOutputs: draft.outputs,
    evaluationMethod: draft.evaluation.method,
    ...(draft.evaluation.metric ? { metric: draft.evaluation.metric } : {}),
    hardRules: draft.constraints.hardRules ?? [],
  };
}

async function persist(projectRoot: string, record: MissionRecord): Promise<void> {
  await atomicWrite(missionRecordPath(projectRoot, record.id), JSON.stringify(record, null, 2));
}

function withEvent(record: MissionRecord, event: HistoryEvent, patch: Partial<MissionRecord> = {}): MissionRecord {
  return {
    ...record,
    ...patch,
    history: [...record.history, event],
    updatedAt: event.at,
  };
}

/**
 * Recursively copy regular text files from a workspace into a plain
 * path→content map. Directory traversal stays lexical: the workspace is the
 * controller's freshly created temp dir, and every path is relative to it.
 */
async function collectFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        files[rel] = await readFile(full, "utf8");
      }
      // sockets/symlinks/etc. are not candidate artifacts and are skipped.
    }
  }
  await walk(root, "");
  return files;
}

/** Copy immutable snapshot bytes into controller-owned storage. */
async function commitSnapshot(
  projectRoot: string,
  missionId: string,
  runId: string,
  workspace: string,
): Promise<{ files: Record<string, string>; digest: string; ref: string }> {
  const target = snapshotPath(projectRoot, missionId, runId);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, ".."), { recursive: true });
  // cp, not rename: the Run workspace is disposable and removed by the runtime.
  await cp(workspace, target, { recursive: true, errorOnExist: false, force: true });
  const files = await collectFiles(target);
  const digest = digestFiles(files);
  return { files, digest, ref: join(RUNS_DIRNAME, runId, SNAPSHOT_DIRNAME) };
}

/**
 * Start one authorized Mission and run its measured baseline. Throws
 * MissionStartRejectedError for validation failures (nothing dispatched),
 * MissionControllerConflictError for concurrent/uncertain ownership,
 * BudgetExhaustedError / EvaluatorFailureError for truthful terminal stops,
 * and AbortError on user interruption.
 */
export async function startAuthorizedMission(options: StartMissionOptions): Promise<StartMissionOutcome> {
  if (!isAbsolute(options.projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  if (options.signal?.aborted) {
    const error = new Error("mission start aborted before dispatch");
    error.name = "AbortError";
    throw error;
  }
  const draft = await loadMissionDraft(options.projectRoot, options.missionId);
  assertStartable(draft, options);

  const dir = missionDir(options.projectRoot, draft.id);
  await mkdir(dir, { recursive: true });

  const reserveCost = options.reserveCost ?? 0;
  if (!Number.isFinite(reserveCost) || reserveCost < 0) {
    throw new MissionStartRejectedError("reserveCost must be a finite non-negative number; unknown cost is not zero");
  }

  // Ownership fencing BEFORE any accepted record can be reused: a live lock or
  // an interrupted in-flight Run blocks a second controller.
  let previous: MissionRecord | undefined;
  try {
    previous = await loadMissionRecord(options.projectRoot, draft.id);
  } catch (error) {
    if (error instanceof MissionRecordCorruptionError) throw error;
    if (!(error instanceof MissionStartRejectedError)) throw error;
  }
  let lockExists = false;
  try {
    await stat(lockPath(options.projectRoot, draft.id));
    lockExists = true;
  } catch {
    lockExists = false;
  }
  if (lockExists) {
    throw new MissionControllerConflictError(
      `mission ${draft.id} already has an active controller (${LOCK_FILENAME}); a second controller cannot dispatch it`,
      "active-controller-lock",
    );
  }
  if (previous) {
    if (previous.status === "interrupted" || Object.values(previous.runs).some((run) => run.status === "interrupted")) {
      throw new MissionControllerConflictError(
        `mission ${draft.id} has an interrupted, unconfirmed execution; it stays blocked until the recovery slice reconciles it`,
        "uncertain interrupted execution awaits recovery",
      );
    }
    // Any other accepted record (running, complete, failed, budget-stopped,
    // rule-failed) is authoritative history: a second start must never reuse
    // the run id or overwrite its snapshot/result. Retries are new Runs and
    // belong to the recovery/continuation slices (#113/#114).
    throw new MissionStartRejectedError(
      `mission ${draft.id} was already started (status ${previous.status}); start is not idempotent — resume through the recovery path; the existing record was not overwritten`,
    );
  }

  const now = () => new Date().toISOString();
  const runId = `${draft.id}:baseline:1`;
  const intentId = `${runId}:intent`;
  const attempt = 1;

  // Acquire the controller lock BEFORE any accepted record is persisted, so
  // two concurrent starts cannot both pass the ownership check above (the
  // disk stat check plus this O_EXCL create are the fence; recovery (#114)
  // owns stale-lock interpretation).
  const lock = lockPath(options.projectRoot, draft.id);
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, runId, since: now() }, null, 2), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MissionControllerConflictError(
        `mission ${draft.id} already has an active controller (${LOCK_FILENAME}); a second controller cannot dispatch it`,
        "active-controller-lock",
      );
    }
    throw error;
  }
  const releaseLock = async () => {
    if (!options.leaveLock) await rm(lock, { force: true }).catch(() => {});
  };

  let record: MissionRecord = previous ?? {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: draft.id,
    status: "accepted",
    objective: draft.objective,
    contract: contractFromDraft(draft),
    budget: { total: draft.budget.total, units: draft.budget.units, consumed: draft.usage.cost.total, remaining: draft.budget.total - draft.usage.cost.total },
    reserved: 0,
    usage: { intake: { tokens: { ...draft.usage.tokens }, cost: { ...draft.usage.cost } }, runs: [] },
    runs: {},
    history: [],
    stopReason: undefined,
    createdAt: now(),
    updatedAt: now(),
  };

  // Persist the accepted Mission + execution intent BEFORE dispatch (AC2).
  record = withEvent(record, { type: "MISSION_ACCEPTED", at: now(), detail: { authorizationToken: options.authorization.token, source: options.authorization.source ?? "user" } });
  record = withEvent(record, { type: "EXECUTION_INTENT_PERSISTED", at: now(), detail: { runId, intentId, attempt } }, {
    runs: { ...record.runs, [runId]: { runId, intentId, attempt, status: "dispatched", workspace: "", dispatchedAt: now() } },
  });

  // Reserve/check the declared bound before further dispatch. The reservation
  // is explicit, priced in the budget unit, and never silently assumed zero.
  const available = record.budget.remaining - record.reserved;
  if (available < reserveCost) {
    record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { available, requested: reserveCost } }, {
      status: "budget-exhausted",
      stopReason: `budget exhausted before dispatch: ${available} ${record.budget.units} available, ${reserveCost} reserved`,
    });
    await persist(options.projectRoot, record);
    await releaseLock();
    throw new BudgetExhaustedError(record.stopReason!);
  }
  record = withEvent(record, { type: "BUDGET_RESERVED", at: now(), detail: { reserveCost } }, {
    reserved: record.reserved + reserveCost,
  });
  await persist(options.projectRoot, record);

  const workspaceParent = join(
    options.workspaceRoot ?? tmpdir(),
    `evok-baseline-${draft.id.replace(/[^a-z0-9._-]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // ADR-0001: the Run workspace is disposable; its durable copy is the
  // immutable snapshot committed below. Best-effort cleanup on every exit.
  const disposeWorkspace = () => rm(workspaceParent, { recursive: true, force: true }).catch(() => {});

  const baselineTask = draft.plan.tasks[0]!;
  const allowBash = (draft.constraints.permissions ?? []).includes("local-shell-in-workspace");
  const roleTools = [...READ_ONLY_TOOLS, "write", "edit", ...(allowBash ? ["bash"] : [])];
  const instructions = [
    "You are executing the BASELINE Task of one authorized evoK Mission. Work only inside your isolated run workspace; it is the current working directory.",
    `Mission objective: ${draft.objective}`,
    `Baseline task (${baselineTask.taskId}): ${baselineTask.objective}`,
    `Required output artifacts: ${draft.outputs.join(", ")}`,
    baselineTask.expectedOutputs?.length ? `Expected outputs: ${baselineTask.expectedOutputs.join("; ")}` : "",
    draft.evaluation.metric ? `The independent evaluator measures "${draft.evaluation.method}" with metric ${draft.evaluation.metric}.` : `The independent evaluator measures "${draft.evaluation.method}".`,
    "Produce the real artifact files in the workspace. Do NOT write a score file, do NOT self-report a score, and do NOT claim verification: an independent evaluator measures the immutable snapshot after you finish. Text claims are never evidence.",
    `Hard rules: ${[...(draft.constraints.hardRules ?? []), "no network", "no external submission"].join("; ")}`,
    "Read-only project inspection is allowed; writes are confined to this workspace. Stop when the baseline artifact is materialized.",
  ].filter((line) => line !== "").join("\n");

  const runtime = new PiAgentRuntime({
    workspaceRoot: workspaceParent,
    modelResolver: options.resolver,
    resources: options.resources,
    // bash only when the draft explicitly grants local-shell-in-workspace;
    // the per-Run policy below carries the real tool/network restrictions.
    sandbox: { allowBash },
  });

  let result: AgentRuntimeResult;
  // A single abort owner: an external user signal and the deterministic
  // mid-Run interruption seam both abort this controller.
  const runController = new AbortController();
  const onExternalAbort = () => runController.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) runController.abort();
  try {
    result = await runtime.execute(
      {
        task: {
          objective: baselineTask.objective,
          constraints: { missionId: draft.id, runId, hardRules: draft.constraints.hardRules ?? [] },
          expectedOutputs: draft.outputs,
        },
        role: {
          name: "evok-baseline-candidate",
          instructions,
          tools: roleTools,
          allowCodingTools: true,
          // Real local execution inside the isolated workspace only when the
          // draft explicitly grants it; the network stays "none" regardless.
          ...(allowBash ? { allowTestExecution: true } : {}),
        },
        workspace: {
          path: join(workspaceParent, "baseline"),
          isolated: true,
          approved: true,
          // Project facts and approved skill sources are READ-ONLY. The
          // mission dir sits under the project root, so it is readable but
          // sandbox-protected; every write is rooted at the run workspace.
          readRoots: [options.projectRoot, ...options.resources.readRoots],
          // bash is a coding tool: the per-run policy must also allow it.
          sandbox: {
            allowBash,
            network: "none",
            allowedTools: roleTools,
            // Controller records, evoK config/skills, the shared project skill
            // namespace, and Pi's own model/credential stores stay outside
            // candidate authority even though the project is a read root
            // (US40, ADR-0005/0006).
            protectedPaths: [
              join(options.projectRoot, ".evok"),
              join(options.projectRoot, ".agents"),
              getAgentDir(),
            ],
            ...(options.resources.userRoot
              ? { credentialPaths: [options.resources.userRoot, getAgentDir()] }
              : { credentialPaths: [getAgentDir()] }),
          },
        },
        tier: options.tier ?? "default",
        intentId,
        identity: { branchId: "baseline", runId, attempt, workspaceId: workspaceParent, fencingToken: attempt },
      },
      runController.signal,
    );
  } catch (error) {
    const at = now();
    if ((error as Error).name === "AbortError" || options.signal?.aborted || runController.signal.aborted) {
      record = withEvent(record, { type: "RUN_INTERRUPTED", at, detail: { runId } }, {
        status: "interrupted",
        stopReason: "user interruption during the baseline Run; result unconfirmed until recovery",
        runs: { ...record.runs, [runId]: { ...record.runs[runId], status: "interrupted", finishedAt: at } },
      });
      await persist(options.projectRoot, record);
      await releaseLock();
      await disposeWorkspace();
      const abortError = new Error("baseline Run interrupted by the user; no result was adopted");
      abortError.name = "AbortError";
      throw abortError;
    }
    const message = error instanceof Error ? error.message : String(error);
    record = withEvent(record, { type: "RUN_FAILED", at, detail: { runId, error: message } }, {
      status: "run-failed",
      stopReason: `baseline Run failed before measurement: ${message}`,
      reserved: 0,
      runs: { ...record.runs, [runId]: { ...record.runs[runId], status: "failed", error: message, finishedAt: at } },
    });
    await persist(options.projectRoot, record);
    await releaseLock();
    await disposeWorkspace();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
  // Provider-reported cost wins when positive; otherwise the trusted-side
  // pricing fallback turns REAL token usage into the budget unit. Both zero
  // with no pricing callback means cost is unknown — it is never treated as a
  // verified zero against the bound.
  const modelCost = result.model && options.priceModelCost ? options.priceModelCost(result.model) : undefined;
  let runCost = result.usage.cost.total;
  if (!Number.isFinite(runCost) || runCost === 0) {
    // Provider cost is absent/zero. Token-positive usage without a trusted
    // meterable price is UNKNOWN cost, never a verified zero: the bound
    // cannot be enforced honestly, so the Mission stops without further dispatch.
    const priced = modelCost ? modelCost(result.usage.tokens) : undefined;
    if (result.usage.tokens.total > 0 && (priced === undefined || !Number.isFinite(priced))) {
      const at = now();
      record = withEvent(record, { type: "BUDGET_EXHAUSTED", at, detail: { runId, reason: "observed model usage without meterable cost" } }, {
        status: "budget-exhausted",
        stopReason: "model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
        runs: { ...record.runs, [runId]: { ...record.runs[runId], sessionId: result.sessionId, model: result.model, workspace: result.workspace, status: "failed", finishedAt: at } },
      });
      await persist(options.projectRoot, record);
      await releaseLock();
      await disposeWorkspace();
      throw new BudgetExhaustedError(record.stopReason!);
    }
    if (priced !== undefined && Number.isFinite(priced)) runCost = priced;
  }
  const consumed = record.budget.consumed + runCost;
  const runLine: UsageLine = {
    at: now(),
    sessionId: result.sessionId,
    tokens: { ...result.usage.tokens },
    cost: { ...result.usage.cost, total: runCost },
  };
  record = {
    ...record,
    reserved: Math.max(0, record.reserved - reserveCost),
    budget: { ...record.budget, consumed, remaining: record.budget.total - consumed },
    usage: { ...record.usage, runs: [...record.usage.runs, runLine] },
    runs: {
      ...record.runs,
      [runId]: {
        ...record.runs[runId],
        status: "dispatched",
        sessionId: result.sessionId,
        model: result.model,
        workspace: result.workspace,
      },
    },
  };
  record = withEvent(record, { type: "RUN_DISPATCHED", at: now(), detail: { runId, sessionId: result.sessionId, model: result.model?.id, cost: runCost } });

  // Freeze the immutable Candidate snapshot from the (about-to-be-deleted)
  // workspace BEFORE evaluating: the evaluator measures frozen bytes, never
  // the live workspace or model text.
  const snapshot = await commitSnapshot(options.projectRoot, draft.id, runId, result.workspace);
  record = withEvent(record, {
    type: "SNAPSHOT_COMMITTED",
    at: now(),
    detail: { runId, snapshotDigest: snapshot.digest, files: Object.keys(snapshot.files).length },
  }, {
    runs: { ...record.runs, [runId]: { ...record.runs[runId], snapshotRef: snapshot.ref } },
  });

  // Independent measurement. A model-supplied score never reaches here: the
  // evaluator only sees snapshot files + the declared contract.
  let measurement: BaselineMeasurement;
  try {
    measurement = await options.evaluator.evaluate(snapshot.files, {
      missionId: draft.id,
      runId,
      snapshotDigest: snapshot.digest,
      contract: record.contract,
    });
  } catch (error) {
    const at = now();
    record = withEvent(record, { type: "EVALUATOR_FAILED", at, detail: { runId, error: (error as Error).message, snapshotDigest: snapshot.digest } }, {
      status: "evaluator-failed",
      stopReason: `independent evaluator failed: ${(error as Error).message}`,
      baselineRunId: runId,
      runs: { ...record.runs, [runId]: { ...record.runs[runId], status: "failed", snapshotRef: snapshot.ref, finishedAt: at } },
    });
    await persist(options.projectRoot, record);
    await releaseLock();
    await disposeWorkspace();
    throw new EvaluatorFailureError((error as Error).message);
  }

  const evidenceRefs = [
    snapshot.ref,
    join(RUNS_DIRNAME, runId, RESULT_FILENAME),
  ];
  const baseline: BaselineResultRecord = {
    runId,
    candidateId: `candidate:${snapshot.digest.slice(0, 16)}`,
    snapshotDigest: snapshot.digest,
    evaluator: { id: options.evaluator.id, version: options.evaluator.version },
    evaluation: measurement,
    evidenceRefs,
    measuredAt: now(),
  };
  await atomicWrite(baselineResultPath(options.projectRoot, draft.id, runId), JSON.stringify(baseline, null, 2));

  const budgetCrossed = consumed > record.budget.total + 1e-12;
  let status: MissionStatus;
  let stopReason: string;
  let event: HistoryEvent;
  if (budgetCrossed) {
    status = "budget-exhausted";
    stopReason = `declared budget ${record.budget.total} ${record.budget.units} exceeded by observed cost ${consumed}; no further dispatch`;
    event = { type: "BUDGET_EXHAUSTED", at: now(), detail: { consumed, total: record.budget.total } };
  } else if (measurement.ok) {
    status = "baseline-complete";
    stopReason = "baseline-complete";
    event = { type: "BASELINE_COMPLETED", at: now(), detail: { runId, score: measurement.score } };
  } else {
    status = "evaluator-rule-failure";
    // Machine-readable stop reason; rule detail is retained in history/baseline.
    stopReason = "evaluator-rule-failure";
    event = { type: "EVALUATION_MEASURED", at: now(), detail: { runId, ok: false, violations: measurement.ruleViolations ?? [] } };
  }
  if (measurement.ok || budgetCrossed) {
    record = withEvent(record, { type: "EVALUATION_MEASURED", at: now(), detail: { runId, ok: measurement.ok, score: measurement.score } });
  }
  record = withEvent(record, event, {
    status,
    stopReason,
    baselineRunId: runId,
    baseline,
    runs: { ...record.runs, [runId]: { ...record.runs[runId], status: "measured", resultRef: join(RUNS_DIRNAME, runId, RESULT_FILENAME), finishedAt: now() } },
  });
  await persist(options.projectRoot, record);
  await releaseLock();
  await disposeWorkspace();

  return {
    runId,
    status,
    stopReason,
    model: result.model!,
    usage: result.usage,
    budget: record.budget,
    evaluation: measurement,
    record,
  };
}

/** Build the minimal "display + reopen" projection over a durable record. */export function summarizeMission(record: MissionRecord): {
  readonly id: string;
  readonly status: MissionStatus;
  readonly stopReason?: string;
  readonly budget: MissionRecord["budget"];
  readonly model?: string;
  readonly evaluation?: BaselineMeasurement;
  readonly evidenceRefs: readonly string[];
} {
  return {
    id: record.id,
    status: record.status,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    budget: record.budget,
    ...(record.baseline ? {
      model: record.runs[record.baselineRunId!]?.model?.id,
      evaluation: record.baseline.evaluation,
      evidenceRefs: record.baseline.evidenceRefs,
    } : { evidenceRefs: [] }),
  };
}
