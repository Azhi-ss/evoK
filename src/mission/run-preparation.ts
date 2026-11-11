/**
 * Mission-owned Run preparation — the immutable `PreparedRun` (PRD §3, §4
 * Stage 1; #253/#254).
 *
 * A Run is authorized under **frozen conditions**. Those conditions used to be
 * assembled inline by the start path, interleaved with execution, so "this Run
 * was authorized under these conditions" could not be read off a single
 * artifact. This module produces exactly that artifact, once, before anything
 * executes:
 *
 *   authorization + permission checks → Mission lock → budget reservation
 *   → plan-version freeze → the Mission-owned (authorization) snapshot
 *   → Research Memory digest pin → the ledger event proving preparation
 *   completed.
 *
 * Nothing about execution moves here. The order above is the order the start
 * path already ran in, statement for statement, so the durable record, the
 * ledger event sequence, the digests, metering attribution and the dispatch
 * ordering are byte-identical to the review base (#254 trace harness).
 *
 * B1 — two snapshots, not one. `PreparedRun.snapshot` is the **authorization**
 * snapshot the Mission owns: plan version, authorization digest, budget
 * reservation, memory pin, input digests. The **execution-environment**
 * snapshot (runtime, model config, tools, sandbox image, filesystem) is owned
 * by the harness and does not exist yet (PRD §4 Stage 3); its fields are
 * deliberately absent here so no field can quietly become the other's.
 *
 * B3 — metering is three layers. Preparation reserves; it never measures,
 * attributes or settles. Raw measurement is the harness's, attribution and
 * budget settlement stay in the controller.
 *
 * The memory pin states a FACT, never an assumption: a resume pins the digest
 * `reconcileResearchMemory` verified; a fresh start pins `published: false`,
 * because no snapshot existed when its authorization was frozen (the Mission
 * publishes memory only after its baseline). Enforcing that a Run uses exactly
 * the pinned reference is the harness's job (PRD §4 Stage 3); Stage 1 records
 * the pin and dispatches from the frozen plan.
 *
 * Charter (#249/#250/#251): the merged charter code is a schema with no version
 * on the Mission record yet. Charter approval (#251) is what puts a version
 * there; when it lands, that version belongs in `PreparedInputDigests` — the
 * frozen conditions, not a separate field.
 */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { deepFreeze, digestValue } from "../security-boundary";
import { loadMissionDraft, type MissionDraft } from "./mission-draft";
import {
  DEFAULT_MAX_EXPERIMENTS,
  BudgetExhaustedError,
  LOCK_FILENAME,
  MISSION_SCHEMA_VERSION,
  MissionControllerConflictError,
  MissionRecordCorruptionError,
  MissionStartRejectedError,
  assertStartable,
  contractFromDraft,
  loadMissionRecord,
  lockPath,
  makePersistNotifier,
  missionDir,
  prepareCompetitionContext,
  researchMemoryProviderFor,
  withEvent,
  type HistoryEvent,
  type MissionRecord,
  type MissionTaskRecord,
  type PreparedCompetitionContext,
  type StartMissionOptions,
} from "./mission-start";
import { researchMemoryModeOf, type ResearchMemoryEvaluationMode } from "../memory";

/**
 * The budget RESERVATION preparation made (B3: reserve only — attribution and
 * settlement stay in the controller).
 */
export interface PreparedBudgetReservation {
  readonly units: string;
  /** Reserved up front for one Run/decision call; unknown cost is never zero. */
  readonly requested: number;
  readonly total: number;
  readonly remaining: number;
  /** `remaining - reserved` BEFORE this reservation: what was really available. */
  readonly availableBefore: number;
  readonly reservedBefore: number;
  readonly reservedAfter: number;
}

/**
 * The Research Memory digest pin: which arm the Mission runs and which
 * published snapshot existed when authorization was frozen. `published: false`
 * means no snapshot existed — never a digest preparation did not see.
 */
export interface PreparedMemoryPin {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly published: boolean;
  readonly snapshotId?: string;
  readonly digest?: string;
  readonly ledgerRevision?: number;
}

/** Digests of the authorized inputs, so a later Run cannot claim another set. */
export interface PreparedInputDigests {
  readonly objective: string;
  readonly contract: string;
  /** Declared permissions, hard rules, stop conditions, network, tier, unit. */
  readonly policy: string;
}

/**
 * What the Mission AUTHORIZED (B1). Execution-environment concerns are not
 * here: no runtime, model config, tools, sandbox image or filesystem.
 */
export interface PreparedRunSnapshot {
  /** Digest of the frozen plan (`record.tasks`); a plan change is a new Run. */
  readonly planVersion: string;
  /** Digest of the user authorization taken together with the frozen policy. */
  readonly authorizationDigest: string;
  readonly budget: PreparedBudgetReservation;
  readonly memory: PreparedMemoryPin;
  readonly inputDigests: PreparedInputDigests;
}

/**
 * One Run, authorized and frozen. Immutable: the shell, the authorization
 * snapshot and the draft it was built from are deep-frozen, so no consumer can
 * edit the conditions it was handed. `record` is the durable state preparation
 * produced; the controller advances it by deriving new records (`withEvent`)
 * and never writes through it.
 */
export interface PreparedRun {
  readonly kind: "start" | "resume";
  readonly missionId: string;
  /** Run identity preparation already persisted as the execution intent. */
  readonly runId: string;
  readonly draft: MissionDraft;
  readonly snapshot: PreparedRunSnapshot;
  readonly record: MissionRecord;
  /**
   * The durable ledger event that closed preparation on this path:
   * `BUDGET_RESERVED` for a start, `MISSION_RESUMED` for a resume. Verifying the
   * kind keeps "preparation completed" tied to the ledger, not to a comment.
   */
  readonly ledgerEvent: HistoryEvent;
  readonly competition: PreparedCompetitionContext;
  readonly releaseLock: () => Promise<void>;
}

/** Only these fields are the authorization snapshot; pinned by test. */
function memoryPinOf(record: MissionRecord): PreparedMemoryPin {
  const mode = researchMemoryModeOf(record.researchMemoryMode);
  const summary = record.researchMemory;
  if (summary === undefined) return { mode, published: false };
  return {
    mode,
    published: true,
    snapshotId: summary.snapshotId,
    digest: summary.snapshotDigest,
    ledgerRevision: summary.ledgerRevision,
  };
}

function inputDigestsOf(record: MissionRecord, options: StartMissionOptions): PreparedInputDigests {
  return {
    objective: digestValue(record.objective),
    contract: digestValue(record.contract),
    policy: digestValue({
      permissions: [...(record.permissions ?? [])].sort(),
      stopConditions: [...(record.stopConditions ?? [])],
      researchMemoryMode: researchMemoryModeOf(record.researchMemoryMode),
      tier: record.modelTier ?? "default",
      budgetUnits: record.budget.units,
      network: [...(options.network ?? [])].sort(),
    }),
  };
}

/**
 * Assemble and freeze one `PreparedRun`. Pure: it derives the snapshot from the
 * durable record preparation produced, so the pin can never drift from what was
 * actually persisted.
 */
function buildPreparedRun(args: {
  readonly kind: "start" | "resume";
  readonly draft: MissionDraft;
  readonly runId: string;
  readonly record: MissionRecord;
  readonly options: StartMissionOptions;
  readonly competition: PreparedCompetitionContext;
  readonly releaseLock: () => Promise<void>;
  readonly authorization: { readonly token: string; readonly source: string; readonly selector: string };
  /** The reservation as preparation made it; never re-derived from the record. */
  readonly reservation: {
    readonly requested: number;
    readonly availableBefore: number;
    readonly reservedBefore: number;
  };
  /** The event kind that closes preparation on this path. */
  readonly preparationEvent: HistoryEvent["type"];
}): PreparedRun {
  const { record, options } = args;
  const inputDigests = inputDigestsOf(record, options);
  const planVersion = digestValue({
    procedure: "evok.prepared-run/v1",
    missionId: record.id,
    objective: record.objective,
    contract: record.contract,
    plan: record.tasks ?? [],
  });
  const memory = memoryPinOf(record);
  const snapshot: PreparedRunSnapshot = {
    planVersion,
    // The user authorization is part of the condition, not a log line: the same
    // plan under another token/source is a different authorized Run.
    authorizationDigest: digestValue({
      procedure: "evok.prepared-run/v1",
      missionId: record.id,
      authorization: args.authorization,
      inputDigests,
      planVersion,
      memory,
    }),
    budget: {
      units: record.budget.units,
      requested: args.reservation.requested,
      total: record.budget.total,
      remaining: record.budget.remaining,
      availableBefore: args.reservation.availableBefore,
      reservedBefore: args.reservation.reservedBefore,
      reservedAfter: record.reserved,
    },
    memory,
    inputDigests,
  };
  const ledgerEvent = record.history[record.history.length - 1];
  if (ledgerEvent?.type !== args.preparationEvent) {
    throw new MissionRecordCorruptionError(
      `mission ${record.id} did not close preparation with ${args.preparationEvent} (last event: ${ledgerEvent?.type ?? "none"})`,
    );
  }
  return Object.freeze({
    kind: args.kind,
    missionId: record.id,
    runId: args.runId,
    // Frozen with the snapshot: a caller cannot widen the authorized plan or
    // policy after preparation. The record still advances (new objects only).
    draft: deepFreeze(args.draft),
    snapshot: deepFreeze(snapshot),
    record,
    ledgerEvent,
    competition: args.competition,
    releaseLock: args.releaseLock,
  });
}

/**
 * Prepare one AUTHORIZED start: every check and every durable write that must
 * happen before a Run may execute, in the order this path always used.
 *
 * Throws `MissionStartRejectedError` when the start is not authorized (nothing
 * durable is written), `MissionControllerConflictError` when another controller
 * owns the Mission, `BudgetExhaustedError` after persisting a truthful
 * terminal record when the reservation is unaffordable.
 */
export async function prepareAuthorizedStart(options: StartMissionOptions): Promise<PreparedRun> {
  if (!isAbsolute(options.projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  if (options.signal?.aborted) {
    const error = new Error("mission start aborted before dispatch");
    error.name = "AbortError";
    throw error;
  }
  const draft = await loadMissionDraft(options.projectRoot, options.missionId);
  assertStartable(draft, options);
  const competition = prepareCompetitionContext(options.competitionContext, researchMemoryProviderFor(options, draft.id, researchMemoryModeOf(options.researchMemory)));
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
    // M1-T9: the trusted evaluation arm is captured at acceptance like the
    // execution policy, so recovery preserves it.
    researchMemoryMode: researchMemoryModeOf(options.researchMemory),
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
  const reservedBefore = record.reserved;
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

  return buildPreparedRun({
    kind: "start",
    draft,
    runId: baselineRunId,
    record,
    options,
    competition,
    releaseLock,
    reservation: { requested: reserveCost, availableBefore: initialAvailable, reservedBefore },
    preparationEvent: "BUDGET_RESERVED",
    authorization: {
      token: options.authorization.token,
      source: options.authorization.source ?? "user",
      selector: options.authorization.missionSelector,
    },
  });
}

/**
 * Freeze the conditions of an already-authorized RESUME. The resume path (#114)
 * establishes its own authority and reconciles durable state before this point;
 * preparation then pins exactly what recovery proved, so the controller has one
 * input shape and one frozen authorization for both entry points.
 */
export function prepareResumeRun(args: {
  readonly draft: MissionDraft;
  readonly record: MissionRecord;
  readonly options: StartMissionOptions & { readonly authorization: { readonly token: string; readonly missionSelector: string; readonly source?: "user" | "model" } };
  readonly competition: PreparedCompetitionContext;
  readonly releaseLock: () => Promise<void>;
}): PreparedRun {
  return buildPreparedRun({
    kind: "resume",
    draft: args.draft,
    runId: args.record.baselineRunId ?? `${args.draft.id}:baseline:1`,
    record: args.record,
    options: args.options,
    competition: args.competition,
    releaseLock: args.releaseLock,
    reservation: {
      requested: args.options.reserveCost ?? 0,
      availableBefore: args.record.budget.remaining - args.record.reserved,
      reservedBefore: args.record.reserved,
    },
    preparationEvent: "MISSION_RESUMED",
    authorization: {
      token: args.options.authorization.token,
      source: args.options.authorization.source ?? "user",
      selector: args.options.authorization.missionSelector,
    },
  });
}
