/**
 * Authorized Mission start + measured baseline (#112, T4) and the autonomous
 * evidence-driven Research Loop (#113, T5; spec #108
 * US12–13/25–35/38–40/44–46; ADR-0001/0004/0005/0006).
 *
 * One validated start action turns a reviewed Mission DRAFT (mission-draft.ts)
 * into a bounded baseline Experiment on the existing Pi execution path:
 *
 *   authorization check → persist accepted Mission + execution intent
 *   → reserve budget → dispatch ONE Run through PiAgentRuntime (fresh
 *   session/workspace, resolved model, coding tools in the approved isolated
 *   workspace) → freeze the workspace into an immutable Candidate snapshot
 *   → independent BaselineEvaluator measures the snapshot (a model-supplied
 *   score can never replace measurement) → persist result/usage/stop reason.
 *
 * #113 adds the missing feedback connection: when a MissionDirector decision
 * port is supplied, the same explicit start then continues WITHOUT a "continue"
 * prompt. The controller builds a trusted read-only projection of the durable
 * state (real observations, Positive/Negative Evidence with refs, objective/
 * policy, remaining budget), the director proposes one bounded next action,
 * and the proposal is applied through THIS module's existing Task/Run/replan/
 * independent-evaluation operations. There is no second state model: the
 * durable MissionRecord is the only authority, and model text is never a Task,
 * a result, or evidence.
 *
 * Controller records, evaluator inputs, credentials, and skill sources stay
 * outside candidate write authority. No External Submission or implicit Human
 * Acceptance lives here. Crash-safety stays simple: a controller lock plus
 * terminal status; an interrupted in-flight execution is reported blocked
 * until the recovery slice (#114) — never silently re-dispatched.
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
import type { EvokResources } from "../evok-resources";
import {
  isMissionId,
  loadMissionDraft,
  missionsDir,
  type DraftPlanTask,
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
} from "../pi-agent-runtime";
export type { RuntimeUsage } from "../pi-agent-runtime";
import {
  buildDirectorInput,
  DirectorDecisionFailedError,
  DirectorProposalRejectedError,
  validateDirectorProposal,
  type DirectorAction,
  type DirectorProposal,
  type MissionDirector,
} from "./mission-director";
import {
  RESUMABLE_STATUSES,
  reconcileInterruptedMission,
  staleControllerLock,
  MissionResumeRejectedError,
  isExplicitResumeRequest,
  type ReconciliationReport,
} from "./mission-resume";

export const MISSION_SCHEMA_VERSION = 1 as const;
const MISSION_FILENAME = "mission.json";
const LOCK_FILENAME = "controller.lock";
const RUNS_DIRNAME = "runs";
const SNAPSHOT_DIRNAME = "snapshot";
const RESULT_FILENAME = "result.json";

/** Only this budget unit is enforceable on this path (priced model usage). */
export const ENFORCEABLE_BUDGET_UNITS = "model-USD" as const;

/** Maximum bounded decision correction attempts at one decision point (AC4). */
export const MAX_DECISION_ATTEMPTS = 3;

/** Default bound on Experiments AFTER the baseline within one start. */
export const DEFAULT_MAX_EXPERIMENTS = 3;

/** Permissions the draft may declare that this path actually grants. */
const SUPPORTED_PERMISSIONS = new Set([
  "read-project",
  "isolated-workspace-write",
  "local-shell-in-workspace",
]);

/** Declared permissions that can never be granted by start (later authority). */
const FORBIDDEN_PERMISSION = /submi|external|network|internet|credential|deploy|publish/i;

const ZERO_USAGE: RuntimeUsage = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
 * The decision model returned only invalid proposals at one decision point
 * (malformed/stale/over-budget/authority-expanding). Bounded correction
 * attempts are exhausted, so the Mission stops truthfully instead of guessing.
 */
export class DirectorBlockedError extends Error {
  readonly kind = "director-blocked" as const;
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "DirectorBlockedError";
    this.reason = reason;
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
  /** One priced usage line per dispatched baseline/experiment Run. */
  readonly runs: readonly UsageLine[];
  /** One priced usage line per decision-model call (#113, US31). */
  readonly decisions?: readonly UsageLine[];
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

/** A later independently-measured Experiment (#113); same shape as baseline. */
export type ExperimentResultRecord = BaselineResultRecord;

/** A Task applied in this Mission: the intake plan or a Director proposal. */
export type MissionTaskRecord = DraftPlanTask & { readonly source?: "intake" | "director" };

/**
 * One attempt carried in the Mission's experiment trail. Holds a measured
 * result OR a dispatch failure, so failed/inconclusive attempts survive as
 * Negative Evidence instead of being silently dropped.
 */
export interface ExperimentTrailEntry {
  readonly runId: string;
  readonly attempt: number;
  readonly action: DirectorAction | "baseline";
  readonly ok: boolean;
  readonly taskObjective: string;
  /** True for failed/inconclusive attempts retained as Negative Evidence. */
  readonly negativeEvidence?: boolean;
  readonly candidateId?: string;
  readonly snapshotDigest?: string;
  readonly evaluator?: { readonly id: string; readonly version: string };
  readonly evaluation?: BaselineMeasurement;
  readonly evidenceRefs: readonly string[];
  readonly error?: string;
  readonly ruleViolations?: readonly string[];
  readonly at: string;
}

/** One priced decision-model call, persisted for explicit-unit accounting. */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly stateVersion: number;
  readonly attempt: number;
  readonly sessionId?: string;
  readonly accepted: boolean;
  readonly action?: DirectorAction;
  readonly rationale?: string;
  readonly rejection?: string;
  readonly tokens: RuntimeUsage["tokens"];
  readonly cost: number;
  readonly at: string;
}

export type MissionStatus =
  | "accepted"
  | "running"
  | "baseline-complete"
  | "evaluator-rule-failure"
  | "evaluator-failed"
  | "budget-exhausted"
  | "run-failed"
  | "interrupted"
  // #113 autonomous continuation terminal/blocker states
  | "director-stopped"
  | "director-blocked"
  | "decision-failed"
  | "iteration-limit";

export type HistoryEventType =
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
  | "BASELINE_COMPLETED"
  // #113 Research Loop
  | "DIRECTOR_CALLED"
  | "PROPOSAL_REJECTED"
  | "PROPOSAL_APPLIED"
  | "DIRECTOR_STOPPED"
  | "ITERATION_LIMIT"
  // #114 recovery
  | "MISSION_RESUMED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_REMEASURED"
  | "RECOVERY_ABANDONED_INTENT";

export interface HistoryEvent {
  readonly type: HistoryEventType;
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
  /** #113: experiment/attempt trail and priced decision records. */
  readonly stateVersion?: number;
  readonly tasks?: readonly MissionTaskRecord[];
  /** #114: execution policy captured at acceptance and preserved across recovery. */
  readonly permissions?: readonly string[];
  readonly stopConditions?: readonly string[];
  /** The model tier that served this Mission; a resume must not silently reroute. */
  readonly modelTier?: string;
  readonly decisions?: readonly DecisionRecord[];
  readonly experiments?: readonly ExperimentTrailEntry[];
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
   * Model/control cost reserved BEFORE dispatch for a single Run/decision call
   * (same unit as the budget). Unknown cost is never assumed zero.
   */
  readonly reserveCost?: number;
  /** Isolated workspace parent (default: OS temp dir). */
  readonly workspaceRoot?: string;
  /**
   * Trusted-side model pricing (cost per token). Provider-reported cost is
   * used when the SDK returns a positive total; this pricing is the honest
   * fallback for runtimes that emit token counts without cost (faux/local).
   * Unknown cost is never silently treated as zero.
   */
  readonly priceModelCost?: (model: ModelConfigView) => (tokens: RuntimeUsage["tokens"]) => number | undefined;
  /** Test seam: leave the controller lock in place (simulates a live controller). */
  readonly leaveLock?: boolean;
  /**
   * #113: Mission Director decision port. When supplied, one explicit start
   * runs the measured baseline and then continues autonomously through the
   * evidence-driven Research Loop until a budget/stop/iteration boundary. When
   * absent, behavior stays the T4 single-baseline slice.
   */
  readonly director?: MissionDirector;
  /** Maximum Experiments AFTER the baseline in one authorized start (default 3). */
  readonly maxExperiments?: number;
  /**
   * Observability seam (#114): invoked after EACH durable event persistence
   * with the event and the post-persist record. Read-only — it must not mutate
   * state. It exists so separate-process recovery tests can interrupt at
   * meaningful, deterministic boundaries instead of racing fixed timers; it
   * is not an execution or authorization path.
   */
  readonly onPersistedEvent?: (event: HistoryEvent, record: MissionRecord) => void | Promise<void>;
}

/**
 * #114: explicit, user-sourced authorization to RESUME an existing Mission.
 * Distinct from a start: it names the durable Mission, never repeats intake,
 * and never restores spent budget. `source: "model"` is rejected.
 */
export interface ResumeAuthorization {
  readonly requested: boolean;
  readonly token: string;
  readonly missionSelector: string;
  readonly source?: "user" | "model";
}

export interface ResumeMissionOptions extends Omit<StartMissionOptions, "authorization"> {
  readonly authorization: ResumeAuthorization;
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
  /** #113: every dispatched Run beyond the baseline (empty for T4 path). */
  readonly experiments: readonly ExperimentTrailEntry[];
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

/** Crash-safe JSON write; the single durable-write primitive for recovery too. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2));
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
    throw new MissionRecordCorruptionError(`mission.json for ${expectedId} has damaged history`);
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

/**
 * Build a persist wrapper that also fires the #114 observability seam once per
 * newly appended history event (identity-tracked), AFTER the durable write.
 * Shadowing the module-level `persist` with this wrapper needs no call-site
 * changes in the start/controller scopes.
 */
function makePersistNotifier(options: StartMissionOptions): (projectRoot: string, record: MissionRecord) => Promise<void> {
  let lastNotified: HistoryEvent | undefined;
  return async (projectRoot, record) => {
    await persist(projectRoot, record);
    const event = record.history[record.history.length - 1];
    if (event && event !== lastNotified) {
      lastNotified = event;
      await options.onPersistedEvent?.(event, record);
    }
  };
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

/** Outcome of one candidate dispatch (shared by baseline and each Experiment). */
type AttemptOutcome =
  | { readonly kind: "run-failed"; readonly runId: string; readonly attempt: number; readonly error: string }
  | {
      readonly kind: "measured";
      readonly runId: string;
      readonly attempt: number;
      readonly measurement: BaselineMeasurement;
      readonly budgetCrossed: boolean;
      readonly evidenceRefs: readonly string[];
      readonly candidateId: string;
      readonly snapshotDigest: string;
      readonly evaluator: { readonly id: string; readonly version: string };
    };

/**
 * Start one authorized Mission and run its measured baseline; when a
 * MissionDirector is supplied, continue autonomously through the evidence
 * driven Research Loop (#113). Throws MissionStartRejectedError for validation
 * failures (nothing dispatched), MissionControllerConflictError for
 * concurrent/uncertain ownership, BudgetExhaustedError / EvaluatorFailureError
 * / DirectorBlockedError / DirectorDecisionFailedError for truthful terminal
 * stops, and AbortError on user interruption.
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
  const maxExperiments = options.maxExperiments ?? DEFAULT_MAX_EXPERIMENTS;
  if (!Number.isInteger(maxExperiments) || maxExperiments < 0) {
    throw new MissionStartRejectedError("maxExperiments must be a non-negative integer");
  }
  // #114 observability seam (shadows the module writer; no call-site churn).
  const persist = makePersistNotifier(options);

  // Ownership fencing BEFORE any accepted record can be reused.
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
    throw new MissionStartRejectedError(
      `mission ${draft.id} was already started (status ${previous.status}); start is not idempotent — resume through the recovery path; the existing record was not overwritten`,
    );
  }

  const now = () => new Date().toISOString();
  const baselineRunId = `${draft.id}:baseline:1`;
  const baselineIntentId = `${baselineRunId}:intent`;

  // Acquire the controller lock BEFORE any accepted record is persisted.
  const lock = lockPath(options.projectRoot, draft.id);
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, runId: baselineRunId, since: now() }, null, 2), { flag: "wx" });
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

  let record: MissionRecord = {
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
    // #113: the single authoritative state; the director only reads a
    // projection of it and proposes bounded changes validated by this module.
    stateVersion: 0,
    tasks: draft.plan.tasks.map((task) => ({ ...task, source: "intake" as const })) as MissionTaskRecord[],
    // #114: the accepted execution policy is authoritative; a resume enforces
    // these values rather than re-reading the mutable draft.
    permissions: draft.constraints.permissions ?? [],
    stopConditions: draft.stopConditions,
    modelTier: options.tier ?? "default",
    decisions: [],
    experiments: [],
    createdAt: now(),
    updatedAt: now(),
  };

  record = withEvent(record, { type: "MISSION_ACCEPTED", at: now(), detail: { authorizationToken: options.authorization.token, source: options.authorization.source ?? "user" } });
  record = withEvent(record, { type: "EXECUTION_INTENT_PERSISTED", at: now(), detail: { runId: baselineRunId, intentId: baselineIntentId, attempt: 1 } }, {
    runs: { ...record.runs, [baselineRunId]: { runId: baselineRunId, intentId: baselineIntentId, attempt: 1, status: "dispatched", workspace: "", dispatchedAt: now() } },
  });

  // Reserve/check the declared baseline bound before further dispatch.
  const initialAvailable = record.budget.remaining - record.reserved;
  if (initialAvailable < reserveCost) {
    record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { available: initialAvailable, requested: reserveCost } }, {
      status: "budget-exhausted",
      stopReason: `budget exhausted before dispatch: ${initialAvailable} ${record.budget.units} available, ${reserveCost} reserved`,
    });
    await persist(options.projectRoot, record);
    await releaseLock();
    throw new BudgetExhaustedError(record.stopReason!);
  }
  record = withEvent(record, { type: "BUDGET_RESERVED", at: now(), detail: { reserveCost } }, {
    reserved: record.reserved + reserveCost,
  });
  await persist(options.projectRoot, record);

  const baselineTask = draft.plan.tasks[0]!;
  const baselineInstructions = [
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

  return runMissionController({
    options, draft, record, reserveCost, releaseLock,
    mode: { kind: "start", baselineRunId, baselineTask, baselineInstructions },
  });
}


/**
 * Shared autonomous-loop controller for BOTH a fresh start (#112/#113) and
 * a recovered resume (#114). It owns the single abort owner, the bounded
 * candidate dispatcher, decision metering, the validated Director loop, and
 * all persistence/locking after the caller has established authority and
 * the initial durable `record`. A resume supplies the reconciled record and
 * enters the SAME decision/Experiment loop without a baseline dispatch or
 * any intake; consumed budget and confirmed results are already on record.
 */
export interface ControllerInit {
  readonly options: StartMissionOptions;
  readonly draft: MissionDraft;
  readonly record: MissionRecord;
  readonly reserveCost: number;
  readonly releaseLock: () => Promise<void>;
  readonly mode:
    | { readonly kind: "start"; readonly baselineRunId: string; readonly baselineTask: DraftPlanTask; readonly baselineInstructions: string }
    | { readonly kind: "resume" };
}

export async function runMissionController(init: ControllerInit): Promise<StartMissionOutcome> {
  const { options, draft, reserveCost, releaseLock } = init;
  let record: MissionRecord = init.record;
  // #114 observability seam (shadows the module writer; no call-site churn).
  const persist = makePersistNotifier(options);
  // Mode-derived baseline context: a fresh start names its baseline Run; a
  // resume enters with the reconciled record and no baseline to dispatch.
  const now = () => new Date().toISOString();
  const maxExperiments = options.maxExperiments ?? DEFAULT_MAX_EXPERIMENTS;
  const startMode = init.mode.kind === "start" ? init.mode : undefined;
  const baselineRunId = startMode?.baselineRunId ?? record.baselineRunId ?? `${draft.id}:baseline:1`;
  const allowBash = (record.permissions ?? draft.constraints.permissions ?? []).includes("local-shell-in-workspace");
  const roleTools = [...READ_ONLY_TOOLS, "write", "edit", ...(allowBash ? ["bash"] : [])];

  // A single abort owner: an external user signal aborts every dispatch in
  // this start (baseline + loop + decisions).
  const runController = new AbortController();
  const onExternalAbort = () => runController.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) runController.abort();
  const aborted = () => options.signal?.aborted || runController.signal.aborted;
  const abortError = (label: string) => {
    const error = new Error(`${label} interrupted by the user; no unconfirmed result was adopted`);
    error.name = "AbortError";
    return error;
  };

  let lastResult: AgentRuntimeResult | undefined;
  let lastMeasurement: BaselineMeasurement | undefined;
  let lastRunId = baselineRunId;

  /**
   * Dispatch ONE bounded candidate Run through the existing Pi execution path:
   * fresh runtime/session/workspace/attempt (ADR-0001) → freeze immutable
   * snapshot → independent measurement → meter cost. Shared by the baseline
   * and every Director-proposed Experiment, so proposals run through the
   * existing Task/Run/evaluation ops rather than a second state model.
   *
   * Run failures and non-ok measurements are RETURNED (the loop retains them
   * as Negative Evidence); budget/unknown-cost/evaluator/abort conditions are
   * terminal and persist + release the lock before throwing.
   */
  const dispatchCandidateAttempt = async (args: {
    current: MissionRecord;
    runId: string;
    attempt: number;
    branchId: string;
    roleName: string;
    instructions: string;
    objective: string;
    expectedOutputs: readonly string[];
    reserve: number;
    kind: "baseline" | "experiment";
  }): Promise<{ record: MissionRecord; outcome: AttemptOutcome; result?: AgentRuntimeResult }> => {
    let r = args.current;
    if (aborted()) {
      r = withEvent(r, { type: "RUN_INTERRUPTED", at: now(), detail: { runId: args.runId } }, {
        status: "interrupted",
        stopReason: `user interruption before the ${args.kind} Run; result unconfirmed until recovery`,
        runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "interrupted", finishedAt: now() } },
      });
      await persist(options.projectRoot, r);
      await releaseLock();
      throw abortError(args.kind);
    }

    const available = r.budget.remaining - r.reserved;
    if (available + 1e-12 < args.reserve) {
      r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { runId: args.runId, available, requested: args.reserve } }, {
        status: "budget-exhausted",
        stopReason: `budget exhausted before ${args.kind} dispatch: ${available} ${r.budget.units} available, ${args.reserve} reserved; no further dispatch`,
      });
      await persist(options.projectRoot, r);
      await releaseLock();
      throw new BudgetExhaustedError(r.stopReason!);
    }
    r = { ...r, reserved: r.reserved + args.reserve };
    const intentId = `${args.runId}:intent`;
    r = withEvent(r, { type: "EXECUTION_INTENT_PERSISTED", at: now(), detail: { runId: args.runId, intentId, attempt: args.attempt } }, {
      runs: { ...r.runs, [args.runId]: { runId: args.runId, intentId, attempt: args.attempt, status: "dispatched", workspace: "", dispatchedAt: now() } },
    });
    await persist(options.projectRoot, r);

    const workspaceParent = join(
      options.workspaceRoot ?? tmpdir(),
      `evok-${args.kind}-${draft.id.replace(/[^a-z0-9._-]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const disposeWorkspace = () => rm(workspaceParent, { recursive: true, force: true }).catch(() => {});

    // A fresh runtime per attempt: no reused session, workspace, or attempt id.
    const runtime = new PiAgentRuntime({
      workspaceRoot: workspaceParent,
      modelResolver: options.resolver,
      resources: options.resources,
      sandbox: { allowBash },
    });

    let result: AgentRuntimeResult;
    try {
      result = await runtime.execute(
        {
          task: {
            objective: args.objective,
            constraints: { missionId: draft.id, runId: args.runId, hardRules: record.contract.hardRules },
            expectedOutputs: args.expectedOutputs,
          },
          role: {
            name: args.roleName,
            instructions: args.instructions,
            tools: roleTools,
            allowCodingTools: true,
            ...(allowBash ? { allowTestExecution: true } : {}),
          },
          workspace: {
            path: join(workspaceParent, args.kind),
            isolated: true,
            approved: true,
            readRoots: [options.projectRoot, ...options.resources.readRoots],
            sandbox: {
              allowBash,
              network: "none",
              allowedTools: roleTools,
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
          identity: { branchId: args.branchId, runId: args.runId, attempt: args.attempt, workspaceId: workspaceParent, fencingToken: args.attempt },
        },
        runController.signal,
      );
    } catch (error) {
      await disposeWorkspace();
      if ((error as Error).name === "AbortError" || aborted()) {
        r = withEvent(r, { type: "RUN_INTERRUPTED", at: now(), detail: { runId: args.runId } }, {
          status: "interrupted",
          stopReason: `user interruption during the ${args.kind} Run; result unconfirmed until recovery`,
          runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "interrupted", finishedAt: now() } },
        });
        await persist(options.projectRoot, r);
        await releaseLock();
        throw abortError(args.kind);
      }
      const message = error instanceof Error ? error.message : String(error);
      r = withEvent(r, { type: "RUN_FAILED", at: now(), detail: { runId: args.runId, error: message } }, {
        reserved: Math.max(0, r.reserved - args.reserve),
        runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "failed", error: message, finishedAt: now() } },
      });
      return { record: r, outcome: { kind: "run-failed", runId: args.runId, attempt: args.attempt, error: message } };
    }

    const modelCost = result.model && options.priceModelCost ? options.priceModelCost(result.model) : undefined;
    let runCost = result.usage.cost.total;
    if (!Number.isFinite(runCost) || runCost === 0) {
      const priced = modelCost ? modelCost(result.usage.tokens) : undefined;
      if (result.usage.tokens.total > 0 && (priced === undefined || !Number.isFinite(priced))) {
        r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { runId: args.runId, reason: "observed model usage without meterable cost" } }, {
          status: "budget-exhausted",
          stopReason: "model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
          runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], sessionId: result.sessionId, model: result.model, workspace: result.workspace, status: "failed", finishedAt: now() } },
        });
        await persist(options.projectRoot, r);
        await releaseLock();
        await disposeWorkspace();
        throw new BudgetExhaustedError(r.stopReason!);
      }
      if (priced !== undefined && Number.isFinite(priced)) runCost = priced;
    }
    const consumed = r.budget.consumed + runCost;
    const runLine: UsageLine = { at: now(), sessionId: result.sessionId, tokens: { ...result.usage.tokens }, cost: { ...result.usage.cost, total: runCost } };
    r = {
      ...r,
      reserved: Math.max(0, r.reserved - args.reserve),
      budget: { ...r.budget, consumed, remaining: r.budget.total - consumed },
      usage: { ...r.usage, runs: [...r.usage.runs, runLine] },
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "dispatched", sessionId: result.sessionId, model: result.model, workspace: result.workspace } },
    };
    r = withEvent(r, { type: "RUN_DISPATCHED", at: now(), detail: { runId: args.runId, sessionId: result.sessionId, model: result.model?.id, cost: runCost } });

    const snapshot = await commitSnapshot(options.projectRoot, draft.id, args.runId, result.workspace);
    await disposeWorkspace();
    r = withEvent(r, { type: "SNAPSHOT_COMMITTED", at: now(), detail: { runId: args.runId, snapshotDigest: snapshot.digest, files: Object.keys(snapshot.files).length } }, {
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], snapshotRef: snapshot.ref } },
    });

    let measurement: BaselineMeasurement;
    try {
      measurement = await options.evaluator.evaluate(snapshot.files, {
        missionId: draft.id, runId: args.runId, snapshotDigest: snapshot.digest, contract: r.contract,
      });
    } catch (error) {
      r = withEvent(r, { type: "EVALUATOR_FAILED", at: now(), detail: { runId: args.runId, error: (error as Error).message, snapshotDigest: snapshot.digest } }, {
        status: "evaluator-failed",
        stopReason: `independent evaluator failed: ${(error as Error).message}`,
        ...(args.kind === "baseline" ? { baselineRunId: args.runId } : {}),
        runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "failed", snapshotRef: snapshot.ref, finishedAt: now() } },
      });
      await persist(options.projectRoot, r);
      await releaseLock();
      throw new EvaluatorFailureError((error as Error).message);
    }

    const evidenceRefs = [snapshot.ref, join(RUNS_DIRNAME, args.runId, RESULT_FILENAME)];
    const resultRecord: BaselineResultRecord = {
      runId: args.runId,
      candidateId: `candidate:${snapshot.digest.slice(0, 16)}`,
      snapshotDigest: snapshot.digest,
      evaluator: { id: options.evaluator.id, version: options.evaluator.version },
      evaluation: measurement,
      evidenceRefs,
      measuredAt: now(),
    };
    await atomicWrite(baselineResultPath(options.projectRoot, draft.id, args.runId), JSON.stringify(resultRecord, null, 2));
    r = withEvent(r, { type: "EVALUATION_MEASURED", at: now(), detail: { runId: args.runId, ok: measurement.ok, score: measurement.score } }, {
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "measured", resultRef: join(RUNS_DIRNAME, args.runId, RESULT_FILENAME), finishedAt: now() } },
    });

    const budgetCrossed = consumed > r.budget.total + 1e-12;
    if (budgetCrossed) {
      r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { consumed, total: r.budget.total, runId: args.runId } }, {
        status: "budget-exhausted",
        stopReason: `declared budget ${r.budget.total} ${r.budget.units} exceeded by observed cost ${consumed}; no further dispatch`,
      });
    }
    lastResult = result;
    lastMeasurement = measurement;
    lastRunId = args.runId;
    return {
      record: r,
      result,
      outcome: {
        kind: "measured", runId: args.runId, attempt: args.attempt, measurement, budgetCrossed,
        evidenceRefs, candidateId: resultRecord.candidateId, snapshotDigest: resultRecord.snapshotDigest, evaluator: resultRecord.evaluator,
      },
    };
  };

  /** Meter one decision-model call with the same honest cost rules as Runs. */
  const meterDecision = async (args: {
    current: MissionRecord;
    decisionId: string;
    stateVersion: number;
    attempt: number;
    usage: RuntimeUsage;
    sessionId?: string;
    model?: ModelConfigView;
  }): Promise<{ record: MissionRecord; cost: number; unknownCost: boolean }> => {
    let cost = args.usage.cost.total;
    let unknownCost = false;
    if (!Number.isFinite(cost) || cost === 0) {
      const pricer = options.priceModelCost;
      const priced = pricer && args.model ? pricer(args.model)(args.usage.tokens) : undefined;
      if (args.usage.tokens.total > 0 && (priced === undefined || !Number.isFinite(priced))) {
        // Token-positive usage with no meterable price is UNKNOWN cost, never a
        // verified zero: record the call and stop rather than dispatch again.
        unknownCost = true;
        cost = 0;
      } else if (priced !== undefined && Number.isFinite(priced)) {
        cost = priced;
      }
    }
    const consumed = args.current.budget.consumed + cost;
    const line: UsageLine = {
      at: now(), sessionId: args.sessionId ?? args.decisionId,
      tokens: { ...args.usage.tokens }, cost: { ...args.usage.cost, total: cost },
    };
    const r: MissionRecord = {
      ...args.current,
      budget: { ...args.current.budget, consumed, remaining: args.current.budget.total - consumed },
      usage: { ...args.current.usage, decisions: [...(args.current.usage.decisions ?? []), line] },
    };
    return { record: r, cost, unknownCost };
  };

  const appendDecision = async (
    r: MissionRecord,
    args: { decisionId: string; stateVersion: number; attempt: number; sessionId?: string },
    cost: number,
    accepted: boolean,
    rejection: string | undefined,
    proposal?: DirectorProposal,
    usage?: RuntimeUsage,
  ): Promise<MissionRecord> => {
    const decision: DecisionRecord = {
      decisionId: args.decisionId,
      stateVersion: args.stateVersion,
      attempt: args.attempt,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      accepted,
      ...(proposal?.action ? { action: proposal.action } : {}),
      ...(proposal?.rationale ? { rationale: proposal.rationale } : {}),
      ...(rejection ? { rejection } : {}),
      tokens: { ...(usage?.tokens ?? ZERO_USAGE.tokens) },
      cost,
      at: now(),
    };
    const event: HistoryEvent = accepted
      ? { type: "DIRECTOR_CALLED", at: now(), detail: { decisionId: args.decisionId, action: proposal?.action, cost } }
      : { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId: args.decisionId, attempt: args.attempt, reason: rejection } };
    return withEvent(r, event, { decisions: [...(r.decisions ?? []), decision] });
  };

  // start mode carries the entry-built baseline context; resume never
  // dispatches a baseline, so these are the start mode's values or empty.
  const baselineTask = startMode?.baselineTask ?? draft.plan.tasks[0]!;
  const baselineInstructions = startMode?.baselineInstructions ?? "";

  const buildOutcome = (r: MissionRecord): StartMissionOutcome => ({
    runId: lastRunId,
    status: r.status,
    stopReason: r.stopReason ?? r.status,
    model: lastResult?.model ?? r.runs[r.baselineRunId!]?.model ?? { provider: "unknown", model: "unknown", id: "unknown" },
    usage: lastResult?.usage ?? ZERO_USAGE,
    budget: r.budget,
    evaluation: lastMeasurement ?? r.baseline?.evaluation ?? { ok: false },
    record: r,
    experiments: r.experiments ?? [],
  });

  try {
    // ── Baseline (fresh start only; a resume reuses reconciled evidence) ──
    let dispatched: Awaited<ReturnType<typeof dispatchCandidateAttempt>> | undefined;
    if (startMode) {
      dispatched = await dispatchCandidateAttempt({
        current: record,
        runId: baselineRunId,
        attempt: 1,
        branchId: "baseline",
        roleName: "evok-baseline-candidate",
        instructions: baselineInstructions,
        objective: baselineTask.objective,
        expectedOutputs: draft.outputs,
        reserve: reserveCost,
        kind: "baseline",
      });
      record = dispatched.record;

      // Record the baseline measurement (or its failure in loop mode) as the
      // first authoritative observation and advance the state version.
      if (dispatched.outcome.kind === "measured") {
        const o = dispatched.outcome;
        const baseline: BaselineResultRecord = {
          runId: baselineRunId,
          candidateId: o.candidateId,
          snapshotDigest: o.snapshotDigest,
          evaluator: o.evaluator,
          evaluation: o.measurement,
          evidenceRefs: o.evidenceRefs,
          measuredAt: now(),
        };
        record = {
          ...record,
          baselineRunId,
          baseline,
          stateVersion: (record.stateVersion ?? 0) + 1,
        };
        if (o.measurement.ok) {
          record = withEvent(record, { type: "BASELINE_COMPLETED", at: now(), detail: { runId: baselineRunId, score: o.measurement.score } });
        }
      }

      // A failed baseline DISPATCH (no measurement at all) is still Negative
      // Evidence the director can act on; record the run failure and advance
      // the state so the next decision sees it. A measured rule failure is
      // already in record.baseline and projected by buildDirectorInput.
      if (dispatched.outcome.kind === "run-failed" && options.director) {
        const entry: ExperimentTrailEntry = {
          runId: baselineRunId, attempt: 1, action: "baseline", ok: false,
          negativeEvidence: true, taskObjective: baselineTask.objective, evidenceRefs: [],
          error: dispatched.outcome.error, at: now(),
        };
        record = { ...record, experiments: [...(record.experiments ?? []), entry], stateVersion: (record.stateVersion ?? 0) + 1 };
      }

      // ── T4 path: one baseline, then a truthful terminal status ──────────
      if (!options.director) {
        if (dispatched.outcome.kind === "run-failed") {
          // T4: a baseline dispatch failure is terminal (RUN_FAILED is already
          // recorded in the run ledger by the dispatcher).
          record = { ...record, status: "run-failed", stopReason: `baseline Run failed before measurement: ${dispatched.outcome.error}` };
          await persist(options.projectRoot, record);
          await releaseLock();
          throw new Error(dispatched.outcome.error);
        }
        const m = dispatched.outcome.measurement;
        if (!record.stopReason) {
          const ok = m.ok;
          record = { ...record, status: ok ? "baseline-complete" : "evaluator-rule-failure", stopReason: ok ? "baseline-complete" : "evaluator-rule-failure" };
        }
        await persist(options.projectRoot, record);
        await releaseLock();
        return buildOutcome(record);
      }
    } else if (!options.director) {
      // Resuming without a decision boundary would have nothing new to do.
      throw new MissionStartRejectedError("resuming a Mission without a Mission Director is not supported; the baseline path is not resumable work");
    }

    // ── #113 autonomous Research Loop ─────────────────────────────────────
    // Candidate Run attempts are numbered 1 (baseline), 2, 3, … across the
    // WHOLE Mission. A resume keeps climbing from the reconciled trail so a
    // retried/abandoned attempt id is never reused or silently replayed.
    let nextAttemptNumber = Object.values(record.runs).reduce((m, r) => Math.max(m, r.attempt), 1) + 1;
    let experimentCount = 0; // Experiments dispatched in THIS controller run

    const experimentInstructions = (proposal: DirectorProposal, projected: { observations: ReturnType<typeof buildDirectorInput>["observations"] }): string => {
      const evidence = projected.observations.map((obs) => {
        const measured = obs.ok ? `measured score ${obs.score ?? "n/a"}` : `NOT ok${obs.ruleViolations?.length ? ` (${obs.ruleViolations.join("; ")})` : ""}${obs.error ? ` (${obs.error})` : ""}`;
        return `- ${obs.runId} [${obs.action}] ${measured}; refs: ${obs.evidenceRefs.join(", ") || "(none; dispatch failed)"}`;
      }).join("\n");
      const outputs = proposal.task?.expectedOutputs?.length ? proposal.task!.expectedOutputs : draft.outputs;
      return [
        "You are executing the NEXT Experiment of one authorized evoK Mission, chosen by the Mission Director from measured evidence. Work only inside your isolated run workspace; it is the current working directory. This is a FRESH Run: prior sessions are not available, only the evidence summary below.",
        `Mission objective: ${draft.objective}`,
        `Director action: ${proposal.action}. Rationale: ${proposal.rationale}`,
        `Task: ${proposal.task!.objective}`,
        `Required output artifacts: ${outputs.join(", ")}`,
        `Measured evidence so far (independent evaluator; durable refs live under this mission's runs dir):\n${evidence}`,
        draft.evaluation.metric ? `The independent evaluator measures "${draft.evaluation.method}" with metric ${draft.evaluation.metric}.` : `The independent evaluator measures "${draft.evaluation.method}".`,
        "Produce the real artifact files. Do NOT write a score file, do NOT self-report a score, do NOT claim success: an independent evaluator measures the immutable snapshot after you finish. Failed attempts are evidence, not results to hide.",
        `Hard rules: ${[...record.contract.hardRules, "no network", "no external submission"].join("; ")}`,
        "Read-only project inspection is allowed; writes are confined to this workspace.",
      ].join("\n");
    };

    // Reserve/check around one decision call, then release after metering.
    const decisionReserve = reserveCost;
    const reserveDecisionSlot = (r: MissionRecord): MissionRecord => {
      const available = r.budget.remaining - r.reserved;
      if (available + 1e-12 < decisionReserve) {
        const stopped = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { available, requested: decisionReserve, stage: "before-director-decision" } }, {
          status: "budget-exhausted",
          stopReason: `budget exhausted before the next decision: ${available} ${r.budget.units} available; no further dispatch even if the model would continue`,
        });
        return stopped;
      }
      return { ...r, reserved: r.reserved + decisionReserve };
    };

    while (true) {
      // After a candidate Run or priced decision crosses the budget the loop
      // ends with a truthful persisted terminal status (no throw needed).
      if (record.status === "budget-exhausted") break;
      if (experimentCount >= maxExperiments) {
        record = withEvent(record, { type: "ITERATION_LIMIT", at: now(), detail: { maxExperiments } }, {
          status: "iteration-limit",
          stopReason: `reached the authorized bound of ${maxExperiments} Experiment(s) after the baseline; stopped explicitly rather than waiting for another prompt`,
        });
        break;
      }
      if (aborted()) {
        record = withEvent(record, { type: "RUN_INTERRUPTED", at: now() }, {
          status: "interrupted",
          stopReason: "user interruption during the Research Loop; result unconfirmed until recovery",
        });
        await persist(options.projectRoot, record);
        await releaseLock();
        throw abortError("Research Loop");
      }

      const directorInput = buildDirectorInput(record, {
        permissions: record.permissions ?? draft.constraints.permissions ?? [],
        hardRules: record.contract.hardRules,
        stopConditions: record.stopConditions ?? draft.stopConditions,
      });

      // Bounded decision with correction attempts. EVERY call is a fresh,
      // priced Run; correction consumes the same authorized resources.
      let proposal: DirectorProposal | undefined;
      let blockedReason: string | undefined;
      for (let decisionAttempt = 1; decisionAttempt <= MAX_DECISION_ATTEMPTS; decisionAttempt++) {
        const stateVersion = record.stateVersion ?? 0;
        const decisionId = `${draft.id}:director:${stateVersion}:${decisionAttempt}`;
        const reserved = reserveDecisionSlot(record);
        if (reserved.status === "budget-exhausted") {
          record = reserved;
          break;
        }
        record = reserved;
        let call;
        try {
          call = await options.director.decide(directorInput, runController.signal, decisionAttempt);
        } catch (error) {
          if ((error as Error).name === "AbortError" || aborted()) {
            record = withEvent(record, { type: "RUN_INTERRUPTED", at: now(), detail: { decisionId } }, {
              status: "interrupted",
              stopReason: "user interruption during a director decision; result unconfirmed until recovery",
            });
            await persist(options.projectRoot, record);
            await releaseLock();
            throw abortError("director decision");
          }
          if (error instanceof DirectorDecisionFailedError) {
            record = { ...record, reserved: Math.max(0, record.reserved - decisionReserve) };
            record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId, reason: error.message } }, {
              status: "decision-failed",
              stopReason: `decision-model run failed: ${error.message}`,
            });
            await persist(options.projectRoot, record);
            await releaseLock();
            throw error;
          }
          // A rejection surfaced by the adapter (non-JSON / invalid JSON) is
          // still a REAL priced model call: meter its carried usage so the
          // correction attempt counts against the budget (AC6), then retry.
          if (error instanceof DirectorProposalRejectedError && error.usage) {
            const metered = await meterDecision({
              current: { ...record, reserved: Math.max(0, record.reserved - decisionReserve) },
              decisionId, stateVersion, attempt: decisionAttempt,
              usage: error.usage, sessionId: error.sessionId, model: error.model,
            });
            record = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: error.sessionId }, metered.cost, false, error.message, undefined, error.usage);
            if (metered.unknownCost) {
              record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
                status: "budget-exhausted",
                stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
              });
              await persist(options.projectRoot, record);
              await releaseLock();
              throw new BudgetExhaustedError(record.stopReason!);
            }
            blockedReason = error.message;
            await persist(options.projectRoot, record);
            continue;
          }
          // A rejection without any carried usage (no model call happened).
          const reason = error instanceof DirectorProposalRejectedError ? error.message : String((error as Error).message ?? error);
          record = { ...record, reserved: Math.max(0, record.reserved - decisionReserve) };
          record = await appendDecision(record, { decisionId, stateVersion, attempt: decisionAttempt }, 0, false, reason, undefined, ZERO_USAGE);
          blockedReason = reason;
          await persist(options.projectRoot, record);
          continue;
        }

        // Validate AGAIN in the controller (never trust the adapter).
        let accepted: DirectorProposal;
        try {
          accepted = validateDirectorProposal(call.proposal, directorInput);
        } catch (error) {
          const reason = (error as Error).message;
          const metered = await meterDecision({
            current: { ...record, reserved: Math.max(0, record.reserved - decisionReserve) },
            decisionId, stateVersion, attempt: decisionAttempt,
            usage: call.usage, sessionId: call.sessionId, model: call.model,
          });
          record = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: call.sessionId }, metered.cost, false, reason, undefined, call.usage);
          if (metered.unknownCost) {
            record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
              status: "budget-exhausted",
              stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
            });
            await persist(options.projectRoot, record);
            await releaseLock();
            throw new BudgetExhaustedError(record.stopReason!);
          }
          blockedReason = reason;
          await persist(options.projectRoot, record);
          continue;
        }

        const metered = await meterDecision({
          current: { ...record, reserved: Math.max(0, record.reserved - decisionReserve) },
          decisionId, stateVersion, attempt: decisionAttempt,
          usage: call.usage, sessionId: call.sessionId, model: call.model,
        });
        record = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: call.sessionId }, metered.cost, true, undefined, accepted, call.usage);
        if (metered.unknownCost) {
          record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
            status: "budget-exhausted",
            stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
          });
          await persist(options.projectRoot, record);
          await releaseLock();
          throw new BudgetExhaustedError(record.stopReason!);
        }
        // A priced decision may itself cross the budget: metered cost leaves
        // consumed/remaining honest; enforce a hard stop here.
        if (record.budget.consumed > record.budget.total + 1e-12) {
          record = withEvent(record, { type: "BUDGET_EXHAUSTED", at: now(), detail: { consumed: record.budget.consumed, total: record.budget.total } }, {
            status: "budget-exhausted",
            stopReason: `declared budget ${record.budget.total} ${record.budget.units} exceeded after a decision call; no further dispatch`,
          });
        }
        proposal = accepted;
        await persist(options.projectRoot, record);
        break;
      }

      if (record.status === "budget-exhausted") {
        // Pre-decision budget stop: persist and surface a truthful error, never
        // silently wait for another prompt.
        await persist(options.projectRoot, record);
        await releaseLock();
        throw new BudgetExhaustedError(record.stopReason ?? "budget exhausted before the next decision; no further dispatch");
      }
      if (!proposal) {
        const reason = blockedReason ?? "the decision model returned no usable proposal";
        record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { exhausted: MAX_DECISION_ATTEMPTS, reason } }, {
          status: "director-blocked",
          stopReason: `decision model produced only invalid proposals after ${MAX_DECISION_ATTEMPTS} bounded attempts (${reason}); stopping for an explicit decision instead of guessing`,
        });
        await persist(options.projectRoot, record);
        await releaseLock();
        throw new DirectorBlockedError(record.stopReason!, reason);
      }

      if (proposal.action === "stop") {
        record = withEvent(record, { type: "DIRECTOR_STOPPED", at: now(), detail: { stateVersion: record.stateVersion, stopReason: proposal.stopReason, rationale: proposal.rationale } }, {
          status: "director-stopped",
          stopReason: proposal.stopReason || `model-proposed stop: ${proposal.rationale}`,
        });
        break;
      }

      // Apply the bounded proposal THROUGH the existing operations: generate a
      // Task Contract entry, then dispatch a fresh Run and independently measure.
      experimentCount += 1;
      const expAttempt = nextAttemptNumber++; // baseline is attempt 1; resume climbs past every prior attempt
      const expRunId = `${draft.id}:exp:${expAttempt}`;
      const task: NonNullable<MissionRecord["tasks"]>[number] = {
        taskId: `task-exp-${expAttempt}`,
        objective: proposal.task!.objective,
        ...(proposal.task!.expectedOutputs ? { expectedOutputs: proposal.task!.expectedOutputs } : {}),
        ...(proposal.task!.constraints ? { constraints: proposal.task!.constraints } : {}),
        ...(proposal.basedOn ? { dependencies: proposal.basedOn } : {}),
        source: "director",
      };
      record = withEvent(record, {
        type: "PROPOSAL_APPLIED",
        at: now(),
        detail: { runId: expRunId, action: proposal.action, stateVersion: record.stateVersion, taskId: task.taskId, basedOn: proposal.basedOn ?? [] },
      }, { tasks: [...(record.tasks ?? []), task] });

      const outputs = proposal.task!.expectedOutputs?.length ? proposal.task!.expectedOutputs! : draft.outputs;
      const expDispatched = await dispatchCandidateAttempt({
        current: record,
        runId: expRunId,
        attempt: expAttempt,
        branchId: `exp-${expAttempt}`,
        roleName: `evok-experiment-${proposal.action}`,
        instructions: experimentInstructions(proposal, directorInput),
        objective: proposal.task!.objective,
        expectedOutputs: outputs,
        reserve: proposal.expectedCost ?? reserveCost,
        kind: "experiment",
      });
      record = expDispatched.record;
      const at = now();
      const entry: ExperimentTrailEntry = expDispatched.outcome.kind === "measured"
        ? {
            runId: expRunId, attempt: expAttempt, action: proposal.action, ok: expDispatched.outcome.measurement.ok,
            // A rule-failed measurement is Negative Evidence, not a drop.
            ...(expDispatched.outcome.measurement.ok ? {} : { negativeEvidence: true }),
            taskObjective: proposal.task!.objective,
            candidateId: expDispatched.outcome.candidateId, snapshotDigest: expDispatched.outcome.snapshotDigest,
            evaluator: expDispatched.outcome.evaluator, evaluation: expDispatched.outcome.measurement,
            evidenceRefs: expDispatched.outcome.evidenceRefs,
            ...(expDispatched.outcome.measurement.ruleViolations?.length ? { ruleViolations: [...expDispatched.outcome.measurement.ruleViolations] } : {}),
            at,
          }
        : {
            runId: expRunId, attempt: expAttempt, action: proposal.action, ok: false, negativeEvidence: true,
            taskObjective: proposal.task!.objective, evidenceRefs: [],
            error: expDispatched.outcome.error, at,
          };
      // New observation => authoritative state advances; the next decision
      // must echo this new stateVersion (stale proposals are rejected).
      record = { ...record, experiments: [...(record.experiments ?? []), entry], stateVersion: (record.stateVersion ?? 0) + 1 };
      await persist(options.projectRoot, record);
      if (record.status === "budget-exhausted") break;
    }

    await persist(options.projectRoot, record);
    await releaseLock();
    return buildOutcome(record);
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}


/** Build the minimal "display + reopen" projection over a durable record. */
export function summarizeMission(record: MissionRecord): {
  readonly id: string;
  readonly status: MissionStatus;
  readonly stopReason?: string;
  readonly budget: MissionRecord["budget"];
  readonly model?: string;
  readonly evaluation?: BaselineMeasurement;
  readonly evidenceRefs: readonly string[];
  readonly experiments: number;
  readonly decisions: number;
  readonly negativeEvidence: number;
} {
  const experiments = record.experiments ?? [];
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
    experiments: experiments.length,
    decisions: record.decisions?.length ?? 0,
    negativeEvidence: experiments.filter((entry) => !entry.ok).length,
  };
}

// ── #114 explicit resume into the SAME autonomous controller ────────────────

export {
  ReconciliationBlockedError,
  MissionResumeRejectedError,
  isExplicitResumeRequest,
  listUnfinishedMissions,
  staleControllerLock,
  RESUMABLE_STATUSES,
} from "./mission-resume";
export type { ReconciliationReport, UnfinishedMissionsView, UnfinishedMissionView } from "./mission-resume";

/**
 * Resume an interrupted/stopped Mission from durable records (#114). The flow
 * is authority → fencing → reconcile → persist → continue through the SAME
 * shared controller as a start:
 *
 *   explicit user resume (model cannot authorize) → reject stale/double claims
 *   → reclaim only a STALE lock (a live controller stays fenced)
 *   → reconcile every dispatched Run from durable evidence (adopt confirmed,
 *     independently re-measure snapshot-only, abandon unconfirmed intents)
 *   → persist the reconciled record, then enter the decision/Experiment loop
 *     with remaining budget. Intake is never repeated and budget is never
 *     restored.
 */
export async function resumeAuthorizedMission(options: ResumeMissionOptions): Promise<StartMissionOutcome & { readonly reconciliation: ReconciliationReport }> {
  if (!isAbsolute(options.projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  const auth = options.authorization;
  if (!auth.requested) {
    throw new MissionResumeRejectedError("resume intent is absent; status browsing never dispatches work");
  }
  if (auth.source === "model") {
    throw new MissionResumeRejectedError("resume authorization must come from the user; a model cannot resume a Mission");
  }
  if (!isExplicitResumeRequest(auth.token).resume) {
    throw new MissionResumeRejectedError("resume intent is ambiguous; a question, negation, or status chat does not resume a Mission");
  }

  const draft = await loadMissionDraft(options.projectRoot, options.missionId);
  // Re-open the authoritative record; corrupted bytes fail visibly here.
  const previous = await loadMissionRecord(options.projectRoot, options.missionId);
  const selector = auth.missionSelector;
  if (selector !== "displayed" && selector !== draft.id) {
    throw new MissionResumeRejectedError(`resume targets mission ${selector} but the displayed mission is ${draft.id}; refusing to guess`);
  }
  if (!RESUMABLE_STATUSES.has(previous.status)) {
    throw new MissionResumeRejectedError(
      `mission ${draft.id} is ${previous.status} and is not resumable; an exhausted/failed Mission needs an explicit new decision, not a silent restart`,
    );
  }
  if (previous.objective !== draft.objective) {
    throw new MissionRecordCorruptionError(`mission ${draft.id}: the draft objective no longer matches the accepted Mission objective`);
  }

  // Fence concurrent controllers BEFORE validating the mutable draft against
  // the accepted policy: a live owner keeps authority regardless of the draft.
  const lock = lockPath(options.projectRoot, draft.id);
  const stale = await staleControllerLock(options.projectRoot, draft.id).catch((error: unknown) => {
    throw new MissionControllerConflictError(
      `mission ${draft.id} controller lock could not be verified: ${(error as Error).message}`,
      "unverifiable-controller-lock",
    );
  });
  if (!stale) {
    throw new MissionControllerConflictError(
      `mission ${draft.id} still has a live controller (${LOCK_FILENAME}); a second controller cannot resume it`,
      "active-controller-lock",
    );
  }

  // Preserve the accepted execution policy (AC5): a re-saved draft cannot
  // widen permissions or silently reroute the model tier on recovery. Records
  // accepted before the policy was persisted (T4/T5) are not retroactively
  // restricted by a missing field; only a record that captures permissions is
  // enforced. A draft dropping permissions only reduces authority (safe).
  if (previous.permissions) {
    for (const permission of draft.constraints.permissions ?? []) {
      if (!previous.permissions.includes(permission)) {
        throw new MissionResumeRejectedError(
          `the draft grants permission "${permission}" that the accepted Mission did not have; widening authority on resume is rejected`,
        );
      }
    }
  }
  if (previous.contract?.hardRules) {
    const acceptedHardRules = new Set(previous.contract.hardRules);
    for (const rule of draft.constraints.hardRules ?? []) {
      if (!acceptedHardRules.has(rule)) {
        throw new MissionResumeRejectedError(
          `the draft adds hard rule "${rule}" not present on the accepted Mission; changing the evaluation contract on resume is rejected`,
        );
      }
    }
  }
  const requestedTier = options.tier ?? "default";
  if (previous.modelTier && requestedTier !== previous.modelTier) {
    throw new MissionResumeRejectedError(
      `the accepted Mission was served by tier "${previous.modelTier}" but resume requests "${requestedTier}"; silent model rerouting is rejected (resume with the accepted tier)`,
    );
  }

  // A stale lock (dead process) is reclaimed atomically.
  await rm(lock, { force: true }).catch(() => {});
  const now = () => new Date().toISOString();
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, resumedFrom: previous.status, since: now() }, null, 2), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MissionControllerConflictError(
        `mission ${draft.id} acquired a live controller while recovery was starting; refusing to race it`,
        "active-controller-lock",
      );
    }
    throw error;
  }
  const releaseLock = async () => {
    if (!options.leaveLock) await rm(lock, { force: true }).catch(() => {});
  };

  if (!options.director) {
    await releaseLock();
    throw new MissionResumeRejectedError("resuming requires a Mission Director: the single-baseline path has no autonomous continuation to resume");
  }

  // Reconstruct authoritative state from durable records/confirmed artifacts.
  // Reconciliation can fail visibly (damaged state): release the controller
  // lock on every such failure rather than leaving this process's fence on disk.
  const persistRecovered = makePersistNotifier(options);
  let reconciliation: ReconciliationReport;
  try {
    reconciliation = await reconcileInterruptedMission({
      projectRoot: options.projectRoot,
      draft,
      record: previous,
      evaluator: options.evaluator,
    });
  } catch (error) {
    await releaseLock();
    throw error;
  }
  let record = reconciliation.record;
  record = withEvent(record, {
    type: "MISSION_RESUMED",
    at: now(),
    detail: {
      authorizationToken: auth.token,
      adopted: reconciliation.adoptedRunIds.length,
      remeasured: reconciliation.remeasuredRunIds.length,
      abandoned: reconciliation.abandonedIntents.map((a) => a.runId),
      remainingBudget: record.budget.remaining,
    },
  });
  await persistRecovered(options.projectRoot, record);

  const outcome = await runMissionController({
    options,
    draft,
    record,
    reserveCost: options.reserveCost ?? 0,
    releaseLock,
    mode: { kind: "resume" },
  });
  return { ...outcome, reconciliation };
}
