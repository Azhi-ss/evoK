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
import { cp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { collectArtifactCollection } from "../harness";
import type { EvokResources } from "../evok-resources";
import {
  isMissionId,
  loadMissionDraft,
  missionsDir,
  type DraftPlanTask,
  type MissionDraft,
} from "./mission-draft";
import { draftReadyForReview, listDraftStartGaps } from "./mission-intake";
import {
  PiAgentRuntime,
  READ_ONLY_TOOLS,
  type AgentRuntimeResult,
  type ModelConfigView,
  type RuntimeUsage,
  type SessionModelResolver,
} from "../execution/pi-agent-runtime";
export type { RuntimeUsage } from "../execution/pi-agent-runtime";
import {
  assertOffRetainsMissionState,
  buildDirectorInput,
  missionRetainedState,
  recordRetainedState,
  type DecisionDelta,
  type DirectorAction,
  type DirectorProposal,
  type MissionDirector,
} from "./mission-director";
import { projectDecisionAccountability, type CounterfactualStatus, type RejectedDirectionApplicability, type ResearchDiversity } from "./decision-accountability";

import type { InsightLedger } from "./insight-inbox";
import {
  RESUMABLE_STATUSES,
  reconcileInterruptedMission,
  reconcileResearchMemory,
  staleControllerLock,
  MissionResumeRejectedError,
  isExplicitResumeRequest,
  type ReconciliationReport,
} from "./mission-resume";
import { prepareAuthorizedStart, prepareResumeRun, type PreparedRun } from "./run-preparation";
import {
  dispatchCandidateAttempt,
  type AttemptOutcome,
  type DispatchAttemptArgs,
} from "./run-dispatch";
import {
  finalizeBaselineRun,
  finalizeExperimentRun,
  missionOutcomeOf,
  type FinalizationPorts,
} from "./run-finalization";
import {
  applyDirectorProposal,
  createDirectorPhases,
  experimentInstructions,
} from "./director-phases";
import { loopStep, nextRunAttempt, stopStep } from "./recovery";
import { ContextBroker, type MemoryProvider } from "../execution/context-broker";
import { checkHostCapabilities } from "../execution/host-capabilities";
import type { HostInventory } from "../execution/host-inventory";
import type { ResourceRequest } from "../execution/resource-lease";
import {
  defaultResearchMemoryProvider,
  researchMemoryStoreFor,
} from "../memory";
import {
  assertMemorySafeText,
  projectResearchMemorySnapshot,
  researchMemoryModeOf,
  shamResearchMemorySnapshot,
  summarizeResearchMemorySnapshot,
  type ResearchMemoryEvaluationMode,
  type ResearchMemorySource,
  type ResearchMemorySummary,
  type ResearchRunFinding,
} from "../memory";
import { classifyRunOutcome, type RunOutcomeClassification } from "../evidence/run-outcome";
import {
  validateSynthesisProposal,
  type SynthesisProposal,
  type SynthesisProposalContext,
  type SynthesisRejectionReason,
} from "../evidence/synthesis-proposal";
import { digestValue, type SandboxPolicy } from "../execution/security-boundary";
import type { CompetitionContract } from "../competition/competition-contract";
import type { RuleVisibilityPolicy } from "../competition/rule-visibility";

export const MISSION_SCHEMA_VERSION = 1 as const;
const MISSION_FILENAME = "mission.json";
export const LOCK_FILENAME = "controller.lock";
/** Serializes Synthesis Proposal read-modify-write (never a data-losing race). */
const SUBMISSION_LOCK_FILENAME = "synthesis.lock";
const RUNS_DIRNAME = "runs";
const SNAPSHOT_DIRNAME = "snapshot";
const RESULT_FILENAME = "result.json";

/** Only this budget unit is enforceable on this path (priced model usage). */
export const ENFORCEABLE_BUDGET_UNITS = "model-USD" as const;

/** Default bound on Experiments AFTER the baseline within one start. */
export const DEFAULT_MAX_EXPERIMENTS = 3;

/** Permissions the draft may declare that this path actually grants. */
export const START_SUPPORTED_PERMISSIONS = new Set([
  "read-project",
  "isolated-workspace-write",
  "local-shell-in-workspace",
]);

/** Declared permissions that can never be granted by start (later authority). */
export const START_FORBIDDEN_PERMISSION = /submi|external|network|internet|credential|deploy|publish/i;

/** The honest zero: no Run/decision has measured usage yet. */
export const ZERO_USAGE: RuntimeUsage = {
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
  /** M1-T1: the Research Memory snapshot/slice this Run actually consumed. */
  readonly researchMemory?: {
    readonly snapshotId: string;
    readonly snapshotDigest: string;
    readonly sliceDigest: string;
    /** The published snapshot's durable ledger revision (absent on legacy records). */
    readonly ledgerRevision?: number;
  };
  readonly error?: string;
  /**
   * Recovery confirmed this Run from its durable artifacts, but the crash landed
   * before the controller settled its cost, so no metered usage line exists
   * (#257, PRD §6 "after artifact write"). Its budget reservation stays held:
   * an unknown spend is never re-dispatchable and is never booked as free.
   */
  readonly metering?: "unsettled";
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
 * result OR a dispatch failure, so failed/inconclusive attempts survive as a
 * Run Outcome instead of being silently dropped.
 */
export interface ExperimentTrailEntry {
  readonly runId: string;
  readonly attempt: number;
  readonly action: DirectorAction | "baseline";
  readonly ok: boolean;
  readonly taskId?: string;
  readonly taskObjective: string;
  /** True only for measured scientific Negative Evidence (never a Run failure). */
  readonly negativeEvidence?: boolean;
  readonly candidateId?: string;
  readonly snapshotDigest?: string;
  readonly evaluator?: { readonly id: string; readonly version: string };
  readonly evaluation?: BaselineMeasurement;
  readonly evidenceRefs: readonly string[];
  readonly error?: string;
  readonly ruleViolations?: readonly string[];
  /** Declared Task configuration under which the attempt ran, when bounded. */
  readonly configuration?: string;
  readonly at: string;
}

/** The durable shape a trail entry re-read from disk may have. */
type TrailOutcomeFields = Pick<ExperimentTrailEntry, "ok" | "evaluation" | "ruleViolations" | "error" | "configuration">;

/**
 * Reads ONE trail entry as a scientific/operational outcome (#213). Every
 * producer and reader goes through here, so an OOM/timeout/invalid measurement
 * can never be re-labelled as a refutation by a drifting copy.
 */
export function classifyTrailEntry(entry: TrailOutcomeFields): RunOutcomeClassification {
  const ruleViolations = entry.ruleViolations ?? entry.evaluation?.ruleViolations;
  return classifyRunOutcome({
    ok: entry.ok === true,
    ...(typeof entry.evaluation?.score === "number" ? { score: entry.evaluation.score } : {}),
    ...(ruleViolations !== undefined ? { ruleViolations } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.configuration !== undefined ? { configuration: entry.configuration } : {}),
  });
}

/**
 * The declared Task configuration as one bounded, memory-safe label. A value
 * that could not enter agent memory is dropped rather than failing a Run.
 */
export function configurationLabel(constraints: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const entries = Object.entries(constraints ?? {}).filter(([, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  if (entries.length === 0) return undefined;
  const label = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join("; ");
  try {
    assertMemorySafeText("task configuration", label);
  } catch {
    return undefined;
  }
  return label;
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
  /** M1-T2: which decision stage this priced call belonged to. */
  readonly phase?: DecisionPhase;
  /** M1-T2: the logical two-stage decision these calls belong to. */
  readonly decisionGroupId?: string;
  /** M1-T2: the validated proposal (frozen for the blind stage). */
  readonly proposal?: DirectorProposal;
  /** M1-T2: the actual model that served this stage (trusted-side pricing). */
  readonly model?: ModelConfigView;
  /** M1-T2: the pinned Memory view the revision stage actually received. */
  readonly memory?: DecisionMemoryUse;
  /** #240: the pinned human Insight the revision stage actually received. */
  readonly insight?: DecisionInsightUse;
  /** M1-T2: controller-derived delta between the two stages. */
  readonly delta?: DecisionDelta;
  /** M1-T2: the revision's own reason, kept next to the blind rationale. */
  readonly revisionReason?: string;
  /** M1-T2: considered actions the revision did not select. */
  readonly rejectedAlternatives?: readonly RejectedAlternative[];
}

/** The two stages of one Director decision (M1-T2). */
export type DecisionPhase = "blind" | "revision";

/** Durable audit fields one decision stage contributes to its priced call. */
export type DecisionAuditFields = Pick<DecisionRecord, "phase" | "decisionGroupId" | "model" | "memory" | "insight" | "delta" | "revisionReason" | "rejectedAlternatives">;

/**
 * What one Revision was SHOWN from the Mission Insight Inbox (#240): the pinned
 * ids and versions, plus the omission count, so the durable record can be
 * audited against the log the operator later reads. It carries no Insight text
 * and nothing epistemic: Insight is advisor context, never Evidence.
 */
export interface DecisionInsightUse {
  readonly sidecarDigest: string;
  readonly items: readonly { readonly insightId: string; readonly version: number }[];
  /** Pinned Insight the Revision did not answer at all: a gap, never a stop. */
  readonly undispositioned?: readonly string[];
  readonly omittedCount: number;
  readonly truncated: boolean;
}

/** What the Memory-informed stage was shown, and which cards it used. */
export interface DecisionMemoryUse {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly packetDigest: string;
  readonly cardRefs: readonly string[];
  readonly usedCardRefs: readonly string[];
}

/** One bounded action the revision did not choose, with its reason. */
export interface RejectedAlternative {
  readonly action: DirectorAction;
  readonly objective?: string;
  /** Set only when a real (frozen or declared) proposal is being audited. */
  readonly proposal?: DirectorProposal;
  readonly reason: string;
  /** M1-T6: the Memory cards that informed the revision which rejected it. */
  readonly influencingMemoryRefs?: readonly string[];
  /** M1-T6: the applicability those cards declared, as the revision saw it. */
  readonly applicability?: RejectedDirectionApplicability;
  /**
   * M1-T6: an unexecuted direction has an UNOBSERVED outcome. It is never a
   * failure, Negative Evidence, or Decision Regret; observed regret is recorded
   * later only when a comparable Experiment actually measured the direction.
   */
  readonly counterfactualStatus?: CounterfactualStatus;
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
  // M1-T3 stored Synthesis Proposals (accepted unverified / refused)
  | "SYNTHESIS_PROPOSAL_RECORDED"
  | "SYNTHESIS_PROPOSAL_REJECTED"
  // M1-T6 advisory anti-collapse review (never a gate, never a quota)
  | "DIRECTION_CONCENTRATION_REVIEW"
  // #114 recovery
  | "MISSION_RESUMED"
  | "RECOVERY_COMPLETED"
  | "RECOVERY_REMEASURED"
  | "RECOVERY_ABANDONED_INTENT"
  // M1-T7: a damaged or missing derived Memory snapshot was rebuilt
  | "RECOVERY_MEMORY_REBUILT"
  // M-d (#245): one served Research Memory card was read on demand (or refused)
  | "MEMORY_READ";

export interface HistoryEvent {
  readonly type: HistoryEventType;
  readonly at: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * One stored submission decision. An accepted Proposal is durable but stays
 * epistemically unverified; a rejection keeps only a reason code and a content
 * address, never the refused payload.
 */
export type SynthesisProposalRecord =
  | {
    readonly outcome: "accepted_for_storage";
    readonly at: string;
    readonly epistemicStatus: "unverified";
    readonly proposal: SynthesisProposal;
  }
  | {
    readonly outcome: "rejected";
    readonly at: string;
    readonly reason: SynthesisRejectionReason;
    readonly explanation: string;
    readonly payloadDigest: string;
  };

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
  /** M1-T1: read-only facts about the active derived Research Memory snapshot. */
  readonly researchMemory?: ResearchMemorySummary;
  /**
   * M1-T9: the trusted evaluation arm this Mission ran under. Durable, so a
   * resume can never silently switch arms; a legacy record without it ran the
   * product default (Real Memory).
   */
  readonly researchMemoryMode?: ResearchMemoryEvaluationMode;
  /** M1-T3: stored Synthesis Proposals; integrity is never scientific status. */
  readonly synthesisProposals?: readonly SynthesisProposalRecord[];
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
  /**
   * Per-competition contract + rule-visibility policy. When supplied, every
   * Candidate Run receives a broker-assembled, role-scoped context bound to
   * that Run and agent; the generic task constraints stay non-sensitive and
   * carry no rules. If the contract declares resources, `inventory` is
   * required and the broker grants a Run-bound lease before dispatch. When
   * absent, the Run keeps the legacy prompt and no role context.
   */
  readonly competitionContext?: MissionCompetitionContext;
  /**
   * Trusted Mission-level Research Memory configuration (M1-T1/M1-T9). Only the
   * controller/CLI supplies it; a Run or agent cannot set it. `false` (Memory
   * Off) writes no projection and injects none, `"sham"` selects the
   * Schema-only control arm, `true`/`"real"` the product default. It never
   * displaces an explicitly supplied custom `MemoryProvider`.
   */
  readonly researchMemory?: boolean | ResearchMemoryEvaluationMode;
  /**
   * Test/broker seam: builds the runtime for one attempt (fresh workspace
   * root). Defaults to a PiAgentRuntime wired to `resolver`/`resources`.
   */
  readonly runtimeFactory?: (workspaceRoot: string, sandbox: SandboxPolicy) => PiAgentRuntime;
  /** Enforceable budget unit; must match the draft's declared unit. */
  readonly budgetUnits?: string;
  readonly tier?: string;
  /** Trusted operator-granted outbound host allowlist for candidate ssh/scp. */
  readonly network?: readonly string[];
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
  /**
   * #240: the Mission ledger that holds this Mission's human Insight drafts.
   * The controller reads pending Insight from it unconditionally at every
   * Revision and appends the dispositions it recorded back to it. When absent,
   * the Revision still receives an explicit EMPTY sidecar: loading is part of
   * the Revision step, so absence is a stated fact and never a skipped stage.
   * No CLI or evaluation surface supplies it yet, so a Mission started today
   * pins the empty sidecar; wiring an operator surface is a separate ticket.
   */
  readonly insightLedger?: InsightLedger;
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
 * One competition as this Mission runs it: its own contract + policy. The
 * broker validates the binding, so a Mission can never broadcast another
 * competition's rules.
 */
export interface MissionCompetitionContext {
  readonly contract: CompetitionContract;
  readonly policy: RuleVisibilityPolicy;
  /** Optional durable-memory source for the per-Run MemorySlice. */
  readonly memory?: MemoryProvider;
  /** Dynamic host snapshot used to check and grant this competition's resources. */
  readonly inventory?: HostInventory;
  /** Optional per-run override; contract resource requirements remain the floor. */
  readonly resourceRequest?: ResourceRequest;
}

function resourceRequestForCompetition(context: MissionCompetitionContext): ResourceRequest | undefined {
  const requirements = context.contract.resources;
  const requested = context.resourceRequest;
  if (!requirements && !requested) return undefined;
  if (!requirements) return requested;
  const gpus = requirements.gpu
    ? requested?.gpus === undefined
      ? requirements.gpu.count
      : typeof requested.gpus === "number"
        ? Math.max(requirements.gpu.count, requested.gpus)
        : requested.gpus.length < requirements.gpu.count
          ? (() => { throw new MissionStartRejectedError("resourceRequest.gpus cannot be below the competition GPU requirement"); })()
          : requested.gpus
    : requested?.gpus;
  return {
    cpus: Math.max(requirements.cpus, requested?.cpus ?? 0),
    memoryBytes: Math.max(requirements.memoryBytes, requested?.memoryBytes ?? 0),
    ...(gpus !== undefined ? { gpus } : {}),
    ...(requested?.timeLimitMs !== undefined
      ? { timeLimitMs: requested.timeLimitMs }
      : requirements && context.contract.limits.timeLimitMs !== undefined
        ? { timeLimitMs: context.contract.limits.timeLimitMs }
        : {}),
  };
}

export interface PreparedCompetitionContext {
  readonly broker?: ContextBroker;
  readonly resourceRequest?: ResourceRequest;
}

export function prepareCompetitionContext(context: MissionCompetitionContext | undefined, memory?: MemoryProvider): PreparedCompetitionContext {
  if (context === undefined) return {};
  const resourceRequest = resourceRequestForCompetition(context);
  if (resourceRequest !== undefined && context.inventory === undefined) {
    throw new MissionStartRejectedError("competition resource requests need a HostInventory before the Mission can start");
  }
  if (context.contract.resources !== undefined) {
    try {
      checkHostCapabilities(context.inventory!, context.contract.resources);
    } catch (error) {
      throw new MissionStartRejectedError(`host does not satisfy competition resources: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    resourceRequest,
    broker: new ContextBroker({
      contract: context.contract,
      policy: context.policy,
      ...(context.inventory ? { inventory: context.inventory } : {}),
      ...(memory ? { memory } : {}),
      source: "mission-controller",
    }),
  };
}

/**
 * The default durable Research Memory provider for a Run that already uses the
 * role-context/ContextBroker path. A legacy no-role-context Run keeps no broker
 * and therefore no injection; an explicit custom provider is never displaced.
 */
export function researchMemoryProviderFor(options: StartMissionOptions, missionId: string, mode: ResearchMemoryEvaluationMode): MemoryProvider | undefined {
  if (options.competitionContext === undefined) return undefined;
  if (options.competitionContext.memory) return options.competitionContext.memory;
  if (mode === "off") return undefined;
  // M-c (#244): the default store is SQLite, migrated from this Mission's files
  // on first use; the file reader stays the rollback path.
  return defaultResearchMemoryProvider(researchMemoryDir(options.projectRoot, missionId));
}

/** Project-local derived-artifact namespace (under the git-ignored Mission dir). */
export function researchMemoryDir(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), "memory");
}

/**
 * Publishes the derived projection for an already-persisted durable record and
 * persists its status summary. Shared by the Run loop and Proposal submission so
 * both produce the same deterministic snapshot; a projection failure surfaces
 * without ever rewriting authoritative history.
 */
async function projectAndPublishResearchMemory(
  projectRoot: string,
  record: MissionRecord,
  mode: ResearchMemoryEvaluationMode,
): Promise<MissionRecord> {
  const projected = projectResearchMemorySnapshot(missionResearchSource(record));
  // M1-T9: the Sham arm publishes the SAME structural projection with control
  // slots only, so no research content reaches a comparison arm by accident.
  const snapshot = mode === "sham" ? shamResearchMemorySnapshot(projected) : projected;
  await researchMemoryStoreFor(researchMemoryDir(projectRoot, record.id)).publish(snapshot);
  const next: MissionRecord = { ...record, researchMemory: summarizeResearchMemorySnapshot(snapshot) };
  await persist(projectRoot, next);
  return next;
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

/**
 * M1-T9: a Mission's evaluation arm is captured at acceptance. A resume, or any
 * later trusted write, may restate it but never switch it: mixing two arms in
 * one Mission record would make every arm comparison unreadable.
 */
export function assertResearchMemoryArmUnchanged(accepted: unknown, requested: unknown): void {
  if (requested === undefined) return;
  const acceptedMode = researchMemoryModeOf(accepted);
  const requestedMode = researchMemoryModeOf(requested);
  if (requestedMode !== acceptedMode) {
    throw new MissionResumeRejectedError(
      `the accepted Mission ran the "${acceptedMode}" Research Memory arm; this operation requests "${requestedMode}"; changing the evaluation arm of an accepted Mission is rejected`,
    );
  }
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

export function missionDir(projectRoot: string, missionId: string): string {
  return join(missionsDir(projectRoot), missionId);
}

export function missionRecordPath(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), MISSION_FILENAME);
}

export function lockPath(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), LOCK_FILENAME);
}

function submissionLockPath(projectRoot: string, missionId: string): string {
  return join(missionDir(projectRoot, missionId), SUBMISSION_LOCK_FILENAME);
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

/** Trusted, static explanations for a refused Proposal (never the payload). */
const SYNTHESIS_REJECTION_EXPLANATIONS: Readonly<Record<SynthesisRejectionReason, string>> = {
  schema: "the submission is not a well-formed evok.synthesis-proposal/v1 payload",
  identity: "the submission does not match this Mission, its Tasks/Runs, or its bound agent",
  "sensitive-content": "the submission carries sensitive content and can never enter agent memory",
  refs: "a cited ref is untyped or does not resolve to an authoritative Mission object",
  visibility: "a Proposal cannot be more visible than its source Mission",
  applicability: "applicability must be claim-specific dimension:value entries, and a Pitfall needs conditions",
  idempotency: "that operation or proposal id was already used for a different payload",
};

export interface SubmitSynthesisProposalOptions {
  readonly projectRoot: string;
  readonly missionId: string;
  /** Untrusted agent/Director submission; the controller validates it. */
  readonly proposal: unknown;
  /** Trusted Mission-level switch, same as start: stores but projects nothing when false. */
  readonly researchMemory?: boolean | ResearchMemoryEvaluationMode;
}

export interface SynthesisProposalSubmission {
  readonly outcome: "accepted_for_storage" | "rejected";
  readonly reason?: SynthesisRejectionReason;
  readonly explanation: string;
  /** Present only for an accepted Proposal: storage never verifies it. */
  readonly epistemicStatus?: "unverified";
  /** Content address of the submission, kept even when the payload is refused. */
  readonly payloadDigest: string;
  readonly record: MissionRecord;
}

function acceptedProposalsOf(entries: readonly SynthesisProposalRecord[]): SynthesisProposal[] {
  return entries.flatMap((entry) => (entry.outcome === "accepted_for_storage" ? [entry.proposal] : []));
}

/** The trusted Mission facts a Proposal is validated against. */
function synthesisContextFor(record: MissionRecord): SynthesisProposalContext {
  const runIds = Object.keys(record.runs);
  return {
    missionId: record.id,
    taskIds: (record.tasks ?? []).map((task) => task.taskId),
    runIds,
    negativeEvidenceRunIds: (record.experiments ?? [])
      .filter((entry) => entry.negativeEvidence === true && runIds.includes(entry.runId))
      .map((entry) => entry.runId),
    evidenceRefs: [...new Set([
      ...(record.baseline?.evidenceRefs ?? []),
      ...(record.experiments ?? []).flatMap((entry) => entry.evidenceRefs),
    ])],
    accepted: acceptedProposalsOf(record.synthesisProposals ?? []),
  };
}

function payloadDigestOf(value: unknown): string {
  try {
    return digestValue(value);
  } catch {
    // A non-JSON submission is still auditable by address, never by content.
    return digestValue(JSON.stringify(value) ?? "unserializable");
  }
}

/**
 * Stores ONE Synthesis Proposal submitted by an authorized Agent or Director.
 *
 * Deterministic and offline: no model is called and nothing is dispatched. A
 * structurally valid Proposal becomes `accepted_for_storage` while staying
 * epistemically unverified and is projected as a reading card into the next
 * snapshot. A refused submission keeps an auditable reason code and content
 * address only. A live controller owns the record, so submission is refused
 * while its lock exists rather than racing a lost write.
 */
export async function submitSynthesisProposal(options: SubmitSynthesisProposalOptions): Promise<SynthesisProposalSubmission> {
  if (!isAbsolute(options.projectRoot)) throw new TypeError("projectRoot must be an absolute path");
  if (!isMissionId(options.missionId)) throw new MissionStartRejectedError(`malformed mission id: ${options.missionId}`);
  // Same fence as resume: reclaim only a STALE controller lock, and fail closed
  // when the lock state itself cannot be verified.
  let lockIsStale: boolean;
  try {
    lockIsStale = await staleControllerLock(options.projectRoot, options.missionId);
  } catch {
    throw new MissionControllerConflictError(
      `mission ${options.missionId} has an unverifiable controller lock; refusing to write a Proposal over it`,
      "unverifiable-controller-lock",
    );
  }
  if (!lockIsStale) {
    throw new MissionControllerConflictError(
      `mission ${options.missionId} has an active controller; a Synthesis Proposal cannot be written into a live controller's record`,
      "active-controller-lock",
    );
  }

  // One writer at a time: a second submission is refused rather than overwriting
  // the first one's just-persisted Proposal.
  const submissionLock = submissionLockPath(options.projectRoot, options.missionId);
  try {
    await writeFile(submissionLock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }, null, 2), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MissionControllerConflictError(
        `mission ${options.missionId} already has a Synthesis Proposal submission in progress`,
        "active-submission-lock",
      );
    }
    throw error;
  }
  try {
    // Read INSIDE the lock: a stale read would let the second writer drop the
    // first one's just-persisted Proposal.
    const record = await loadMissionRecord(options.projectRoot, options.missionId);
    return await storeSynthesisProposal(options, record);
  } finally {
    await rm(submissionLock, { force: true }).catch(() => {});
  }
}

/** Read-modify-write of one validated submission, under the submission lock. */
async function storeSynthesisProposal(
  options: SubmitSynthesisProposalOptions,
  record: MissionRecord,
): Promise<SynthesisProposalSubmission> {
  const at = new Date().toISOString();
  const payloadDigest = payloadDigestOf(options.proposal);
  const stored = record.synthesisProposals ?? [];
  const validation = validateSynthesisProposal(options.proposal, synthesisContextFor(record));

  if (validation.outcome === "rejected") {
    const entry: SynthesisProposalRecord = {
      outcome: "rejected",
      at,
      reason: validation.reason,
      explanation: SYNTHESIS_REJECTION_EXPLANATIONS[validation.reason],
      payloadDigest,
    };
    const next = withEvent(record,
      { type: "SYNTHESIS_PROPOSAL_REJECTED", at, detail: { reason: validation.reason, payloadDigest } },
      { synthesisProposals: [...stored, entry] });
    await persist(options.projectRoot, next);
    return { outcome: "rejected", reason: validation.reason, explanation: entry.explanation, payloadDigest, record: next };
  }

  const proposal = validation.proposal;
  const alreadyStored = stored.some((entry) =>
    entry.outcome === "accepted_for_storage" && entry.proposal.digest === proposal.digest);
  if (alreadyStored) {
    // Idempotent replay: the durable record and its snapshot stay untouched.
    return {
      outcome: "accepted_for_storage",
      epistemicStatus: "unverified",
      explanation: "the identical Proposal is already stored",
      payloadDigest,
      record,
    };
  }

  const entry: SynthesisProposalRecord = { outcome: "accepted_for_storage", at, epistemicStatus: "unverified", proposal };
  let next = withEvent(record,
    {
      type: "SYNTHESIS_PROPOSAL_RECORDED",
      at,
      detail: {
        proposalId: proposal.proposalId,
        operationId: proposal.operationId,
        kind: proposal.kind,
        digest: proposal.digest,
        epistemicStatus: "unverified",
      },
    },
    { synthesisProposals: [...stored, entry], stateVersion: (record.stateVersion ?? 0) + 1 });
  // M1-T9: the DURABLE arm wins, so a submission cannot publish Real Memory into
  // a Sham arm (or the reverse). Fence BEFORE the write, so a refused request
  // leaves no stored payload behind.
  const recordedMode = record.researchMemoryMode === undefined ? undefined : researchMemoryModeOf(record.researchMemoryMode);
  if (recordedMode !== undefined && options.researchMemory !== undefined && researchMemoryModeOf(options.researchMemory) !== recordedMode) {
    throw new MissionStartRejectedError(
      `mission ${record.id} runs the "${recordedMode}" Research Memory arm; a submission cannot switch it to "${researchMemoryModeOf(options.researchMemory)}"`,
    );
  }
  const mode = recordedMode ?? researchMemoryModeOf(options.researchMemory);
  // Authoritative write FIRST: a refused projection can never lose the Proposal.
  await persist(options.projectRoot, next);
  if (mode !== "off") {
    next = await projectAndPublishResearchMemory(options.projectRoot, next, mode);
  }
  return {
    outcome: "accepted_for_storage",
    epistemicStatus: "unverified",
    explanation: "stored as an unverified research-state card; storage is not scientific approval",
    payloadDigest,
    record: next,
  };
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

export function assertStartable(draft: MissionDraft, options: StartMissionOptions): void {
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
    const { missing, unresolved } = listDraftStartGaps(draft);
    if (unresolved.length > 0) {
      throw new MissionStartRejectedError(`execution prerequisites remain unresolved: ${unresolved.join("; ")}`);
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
    if (START_FORBIDDEN_PERMISSION.test(permission)) {
      throw new MissionStartRejectedError(`declared permission "${permission}" cannot be granted at start (external/irreversible authority is never implicit)`);
    }
    if (!START_SUPPORTED_PERMISSIONS.has(permission)) {
      throw new MissionStartRejectedError(`declared permission "${permission}" is not supported by the baseline path; remove it or start through a path that grants it`);
    }
  }
}

export function contractFromDraft(draft: MissionDraft): MissionStartContract {
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
export function makePersistNotifier(options: StartMissionOptions): (projectRoot: string, record: MissionRecord) => Promise<void> {
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

export function withEvent(record: MissionRecord, event: HistoryEvent, patch: Partial<MissionRecord> = {}): MissionRecord {
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
/** Copy immutable snapshot bytes into controller-owned storage. */
export async function commitSnapshot(
  projectRoot: string,
  missionId: string,
  runId: string,
  /** The execution that ran in the workspace: the receipt's producer (B2). */
  executionId: string,
  workspace: string,
): Promise<{ files: Record<string, string>; digest: string; ref: string }> {
  const target = snapshotPath(projectRoot, missionId, runId);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, ".."), { recursive: true });
  // cp, not rename: the Run workspace is disposable and removed by the runtime.
  await cp(workspace, target, { recursive: true, errorOnExist: false, force: true });
  // B2: the harness collects, validates and content-addresses the workspace and
  // issues its receipt; copying it here and deciding it belongs to this Run is
  // the Mission's adoption.
  const artifact = await collectArtifactCollection(target, executionId);
  return { files: artifact.files, digest: artifact.receipt.digest, ref: join(RUNS_DIRNAME, runId, SNAPSHOT_DIRNAME) };
}

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
  // Stage 1 (#254): authorization + permission checks, the Mission lock, the
  // budget reservation, the plan-version freeze and the Mission-owned
  // authorization snapshot happen in ONE place (run-preparation.ts) before any
  // execution. Everything after this point is the unchanged dispatch path.
  const prepared = await prepareAuthorizedStart(options);
  const { draft } = prepared;
  // The dispatch input is the FROZEN plan preparation authorized, not the
  // mutable draft: re-saving the draft after preparation changes nothing.
  const baselineTask = prepared.record.tasks![0]!;
  const baselineInstructions = [
    "You are executing the BASELINE Task of one authorized evoK Mission. Work only inside your isolated run workspace; it is the current working directory.",
    `Mission objective: ${draft.objective}`,
    `Baseline task (${baselineTask.taskId}): ${baselineTask.objective}`,
    `Required output artifacts: ${draft.outputs.join(", ")}`,
    baselineTask.expectedOutputs?.length ? `Expected outputs: ${baselineTask.expectedOutputs.join("; ")}` : "",
    draft.evaluation.metric ? `The independent evaluator measures "${draft.evaluation.method}" with metric ${draft.evaluation.metric}.` : `The independent evaluator measures "${draft.evaluation.method}".`,
    "Produce the real artifact files in the workspace. Do NOT write a score file, do NOT self-report a score, and do NOT claim verification: an independent evaluator measures the immutable snapshot after you finish. Text claims are never evidence.",
    options.competitionContext
      ? "Your competition rules for this role are in the ROLE CONTEXT block. No external submission is authorized."
      : `Hard rules: ${[...(draft.constraints.hardRules ?? []), "no external submission"].join("; ")}`,
    candidateNetworkInstruction(options.network),
    "Read-only project inspection is allowed; writes are confined to this workspace. Stop when the baseline artifact is materialized.",
  ].filter((line) => line !== "").join("\n");

  return runMissionController({
    prepared,
    options,
    mode: { kind: "start", baselineTask, baselineInstructions },
  });
}

export function candidateNetworkInstruction(network: readonly string[] | undefined): string {
  return network?.length
    ? `The operator permits supported network commands only to these hosts: ${network.join(", ")}. SSH/SCP require exact hostnames and simple commands without options or shell operators. This grants no external submission or additional filesystem access.`
    : "The sandbox enforces no network access.";
}


/**
 * Shared autonomous-loop controller for BOTH a fresh start (#112/#113) and
 * a recovered resume (#114). PRD §4 Stage 4 makes it a COMPOSITION, not a
 * pipeline: the caller has already run `prepareRun` (`run-preparation.ts`) and
 * hands over the frozen `PreparedRun`, and the controller then names the stages
 * in order —
 *
 *   baseline execute → finalizeRun → [Director decision → execute →
 *   finalizeRun]* → recover-or-terminate
 *
 * — through `run-dispatch.ts` (one bounded candidate Run, no research
 * judgement), `director-phases.ts` (blind → pinned Memory/Insight → revision,
 * judgement stays the Director's), `run-finalization.ts` (adopting a measured
 * outcome into Mission state) and `recovery.ts` (durable progress reuse plus
 * budget/Experiment-bound/interruption termination). What remains here is the
 * single abort owner, the derived Research Memory projection, locking and the
 * ledger the stages share. A resume supplies the reconciled record and enters
 * the SAME decision/Experiment loop without a baseline dispatch or any intake;
 * consumed budget and confirmed results are already on record.
 */
export interface ControllerInit {
  /**
   * Stage 1 (#254): the frozen authorization this Run executes under. The
   * controller consumes it instead of re-deriving lock, reservation, plan and
   * snapshot from the live options.
   */
  readonly prepared: PreparedRun;
  readonly options: StartMissionOptions;
  readonly mode:
    | { readonly kind: "start"; readonly baselineTask: DraftPlanTask; readonly baselineInstructions: string }
    | { readonly kind: "resume" };
}

export async function runMissionController(init: ControllerInit): Promise<StartMissionOutcome> {
  const { options, prepared } = init;
  const { draft, competition, releaseLock, snapshot } = prepared;
  const reserveCost = snapshot.budget.requested;
  let record: MissionRecord = prepared.record;
  // #114 observability seam (shadows the module writer; no call-site churn).
  const persist = makePersistNotifier(options);
  // Mode-derived baseline context: a fresh start names its baseline Run; a
  // resume enters with the reconciled record and no baseline to dispatch.
  const now = () => new Date().toISOString();
  const maxExperiments = options.maxExperiments ?? DEFAULT_MAX_EXPERIMENTS;
  const startMode = init.mode.kind === "start" ? init.mode : undefined;
  const baselineRunId = prepared.runId;
  const allowBash = (record.permissions ?? draft.constraints.permissions ?? []).includes("local-shell-in-workspace");
  const roleTools = [...READ_ONLY_TOOLS, "write", "edit", ...(allowBash ? ["bash"] : [])];
  // Per-competition context broker. Construction validates that the policy is
  // bound to THIS Mission's contract, so rules are never shared across
  // competitions; each Run then gets its own role-scoped context.
  const { broker, resourceRequest: competitionResourceRequest } = competition;

  // M1-T1/M1-T9: derived Mission-scoped Research Memory. Publication errors
  // surface; Memory Off writes nothing. The evaluation arm is the DURABLE one,
  // so a resume cannot silently switch arms. Injection needs the role-context
  // broker; the legacy no-role-context path projects but never injects.
  const researchMemoryMode = researchMemoryModeOf(record.researchMemoryMode);
  const researchMemoryEnabled = researchMemoryMode !== "off";
  const memoryDir = researchMemoryDir(options.projectRoot, draft.id);
  const refreshResearchMemory = async (current: MissionRecord): Promise<MissionRecord> => {
    if (!researchMemoryEnabled) return current;
    const source = missionResearchSource(current);
    if (source.runs.length === 0) return current;
    // Derived projection never costs authoritative history: persist the record
    // FIRST, so a rejection or I/O failure here cannot lose a measured Run.
    await persist(options.projectRoot, current);
    return projectAndPublishResearchMemory(options.projectRoot, current, researchMemoryMode);
  };

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
   * The EXECUTE stage (`run-dispatch.ts`): one authorized attempt → one bounded
   * candidate Run → one returned `AttemptOutcome`. No research decision, no
   * finalization, no terminal choice happens in the dispatcher.
   */
  const dispatchCandidate = (args: DispatchAttemptArgs) => dispatchCandidateAttempt({
    options,
    missionId: draft.id,
    ...(broker !== undefined ? { broker } : {}),
    ...(competitionResourceRequest !== undefined ? { competitionResourceRequest } : {}),
    roleTools,
    allowBash,
    signal: runController.signal,
    aborted,
    abortError,
    now,
    persist,
    releaseLock,
  }, args);

  /**
   * The caller-facing outcome reports the last attempt that really MEASURED.
   * A failed dispatch reports no result and never displaces the last confirmed
   * Run id or measurement (the pre-extraction behaviour).
   */
  const track = (runId: string, dispatched: { readonly result?: AgentRuntimeResult; readonly outcome: AttemptOutcome }): void => {
    if (dispatched.outcome.kind !== "measured") return;
    lastMeasurement = dispatched.outcome.measurement;
    lastRunId = runId;
    if (dispatched.result !== undefined) lastResult = dispatched.result;
  };

  // start mode carries the entry-built baseline context; resume never
  // dispatches a baseline, so these are the start mode's values or empty.
  const baselineTask = startMode?.baselineTask ?? draft.plan.tasks[0]!;
  const baselineInstructions = startMode?.baselineInstructions ?? "";

  const finalization: FinalizationPorts = {
    projectRoot: options.projectRoot,
    now,
    persist,
    refreshResearchMemory,
  };
  const outcomeOf = (r: MissionRecord) => missionOutcomeOf(r, {
    runId: lastRunId,
    ...(lastResult !== undefined ? { result: lastResult } : {}),
    ...(lastMeasurement !== undefined ? { measurement: lastMeasurement } : {}),
  });

  try {
    // ── Baseline (fresh start only; a resume reuses reconciled evidence) ──
    if (startMode) {
      const runId = baselineRunId;
      const dispatched = await dispatchCandidate({
        current: record,
        runId,
        attempt: 1,
        taskId: baselineTask.taskId,
        branchId: "baseline",
        roleName: "evok-baseline-candidate",
        instructions: baselineInstructions,
        objective: baselineTask.objective,
        expectedOutputs: draft.outputs,
        reserve: reserveCost,
        kind: "baseline",
      });
      record = dispatched.record;
      track(runId, dispatched);

      // The FINALIZE stage (`run-finalization.ts`): the baseline measurement (or
      // its failure) becomes the first authoritative observation.
      const finalized = await finalizeBaselineRun(record, {
        outcome: dispatched.outcome,
        runId,
        baselineTask,
        hasDirector: options.director !== undefined,
      }, finalization);
      record = finalized.record;

      if (finalized.kind === "failed-without-director") {
        await persist(options.projectRoot, record);
        await releaseLock();
        throw new Error(finalized.error);
      }
      if (finalized.kind === "measured-without-director") {
        await persist(options.projectRoot, record);
        await releaseLock();
        return outcomeOf(record);
      }
    } else if (!options.director) {
      // Resuming without a decision boundary would have nothing new to do.
      throw new MissionStartRejectedError("resuming a Mission without a Mission Director is not supported; the baseline path is not resumable work");
    } else {
      // A resume already verified/rebuilt the derived projection from
      // authoritative history (#216) before entering the loop; a fresh start
      // published it after the baseline above.
      await persist(options.projectRoot, record);
    }

    // ── #113 autonomous Research Loop ─────────────────────────────────────
    const director = options.director;
    // The T4 path returned above and a resume without a port is rejected
    // earlier; this guard keeps the loop honest for any future caller.
    if (director === undefined) {
      await releaseLock();
      throw new MissionStartRejectedError("autonomous continuation requires a Mission Director decision port");
    }

    // ── The DIRECTOR DECISION stage (`director-phases.ts`) ────────────────
    const phases = createDirectorPhases({
      projectRoot: options.projectRoot,
      missionId: draft.id,
      director,
      signal: runController.signal,
      aborted,
      abortError,
      now,
      persist,
      releaseLock,
      reserveCost,
      ...(options.priceModelCost !== undefined ? { priceModelCost: options.priceModelCost } : {}),
      memory: { enabled: researchMemoryEnabled, mode: researchMemoryMode, dir: memoryDir },
      ...(options.insightLedger !== undefined ? { insightLedger: options.insightLedger } : {}),
    });

    // Candidate Run attempts are numbered 1 (baseline), 2, 3, … across the
    // WHOLE Mission. A resume keeps climbing from the recovered trail so a
    // retried/abandoned attempt id is never reused or silently replayed.
    let nextAttemptNumber = nextRunAttempt(record);
    let experimentCount = 0; // Experiments dispatched in THIS controller run

    while (true) {
      // ── RECOVER-OR-TERMINATE (`recovery.ts`) ────────────────────────────
      const step = loopStep(record, { maxExperiments, experimentCount, aborted: aborted(), now });
      if (step.kind === "terminate") {
        record = step.record;
        break;
      }
      if (step.kind === "abort") {
        record = step.record;
        await persist(options.projectRoot, record);
        await releaseLock();
        throw abortError("Research Loop");
      }

      const directorInput = buildDirectorInput(record, {
        permissions: record.permissions ?? draft.constraints.permissions ?? [],
        hardRules: record.contract.hardRules,
        stopConditions: record.stopConditions ?? draft.stopConditions,
      });
      // F5 (#231): Memory Off drops historical narrative, never Mission state.
      // The state actually handed to this decision point must still carry the
      // scoreboard and current best the durable record measured.
      assertOffRetainsMissionState({
        mode: researchMemoryMode,
        scope: "decision-point",
        retained: missionRetainedState(directorInput.observations),
        expected: recordRetainedState(record),
      });

      // Blind → pinned Memory/Insight → revision. Only its validated proposal
      // can dispatch, and research judgement stays the Director's: the
      // controller neither invents nor edits an action.
      const decision = await phases.decideNextAction({ record, input: directorInput });
      record = decision.record;

      if (decision.proposal.action === "stop") {
        record = stopStep(record, decision.proposal, now());
        break;
      }

      // Apply the bounded proposal THROUGH the existing operations: one Task
      // Contract entry, then a fresh Run and independent measurement.
      const applied = applyDirectorProposal(record, {
        proposal: decision.proposal,
        stateVersion: decision.stateVersion,
        nextAttemptNumber,
        missionId: draft.id,
        at: now(),
      });
      record = applied.record;
      experimentCount += 1;
      nextAttemptNumber = Math.max(nextAttemptNumber, applied.application.attempt + 1);

      const runId = applied.application.runId;
      const dispatched = await dispatchCandidate({
        current: record,
        runId,
        attempt: applied.application.attempt,
        taskId: applied.application.taskId,
        branchId: `exp-${applied.application.attempt}`,
        roleName: `evok-experiment-${decision.proposal.action}`,
        instructions: experimentInstructions(decision.proposal, directorInput.observations, {
          objective: draft.objective,
          outputs: draft.outputs,
          evaluation: draft.evaluation,
          hardRules: record.contract.hardRules,
          network: options.network,
          brokered: broker !== undefined,
        }),
        objective: decision.proposal.task!.objective,
        expectedOutputs: decision.proposal.task!.expectedOutputs?.length ? decision.proposal.task!.expectedOutputs! : draft.outputs,
        evidenceRefs: directorInput.observations.flatMap((observation) => observation.evidenceRefs),
        reserve: decision.proposal.expectedCost ?? reserveCost,
        kind: "experiment",
      });
      record = dispatched.record;
      track(runId, dispatched);

      record = await finalizeExperimentRun(record, {
        outcome: dispatched.outcome,
        action: decision.proposal.action,
        task: applied.task,
        runId,
        attempt: applied.application.attempt,
      }, finalization);
      await persist(options.projectRoot, record);
      if (record.status === "budget-exhausted") break;
    }

    await persist(options.projectRoot, record);
    await releaseLock();
    return outcomeOf(record);
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
  readonly researchMemory?: ResearchMemorySummary;
  /** M1-T6 read-only anchoring measurement: objectives, Branch coverage, changes. */
  readonly diversity?: ResearchDiversity;
} {
  const experiments = record.experiments ?? [];
  const memoryInformedRevisions = (record.decisions ?? [])
    .filter((decision) => decision.phase === "revision" && decision.memory !== undefined).length;
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
    // One logical two-stage decision per decisionGroupId (#211); legacy
    // records without a group id keep counting one price line per decision.
    decisions: new Set((record.decisions ?? []).map((decision) => decision.decisionGroupId ?? decision.decisionId)).size,
    // Scientific refutations only: an OOM/timeout/invalid measurement is an
    // operational outcome, not Negative Evidence (#213).
    negativeEvidence: experiments.filter((entry) => classifyTrailEntry(entry).scientificNegativeEvidence).length,
    ...(record.researchMemory ? { researchMemory: record.researchMemory } : {}),
    ...(memoryInformedRevisions > 0 ? { diversity: projectDecisionAccountability(record).diversity } : {}),
  };
}

/** Maps authoritative Mission history into the projection's bounded source. */
export function missionResearchSource(record: MissionRecord): ResearchMemorySource {
  const runs: ResearchRunFinding[] = [];
  const seen = new Set<string>();
  if (record.baseline) {
    const evaluation = record.baseline.evaluation;
    seen.add(record.baseline.runId);
    runs.push({
      runId: record.baseline.runId,
      ok: evaluation.ok,
      ...(typeof evaluation.score === "number" ? { score: evaluation.score } : {}),
      ...(evaluation.ruleViolations?.length ? { ruleViolations: [...evaluation.ruleViolations] } : {}),
      evidenceRefs: record.baseline.evidenceRefs,
      snapshotDigest: record.baseline.snapshotDigest,
    });
  }
  for (const entry of record.experiments ?? []) {
    if (seen.has(entry.runId)) continue;
    seen.add(entry.runId);
    runs.push({
      runId: entry.runId,
      ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
      ...(entry.taskObjective !== "" ? { taskObjective: entry.taskObjective } : {}),
      ok: entry.ok,
      ...(typeof entry.evaluation?.score === "number" ? { score: entry.evaluation.score } : {}),
      ...(entry.ruleViolations?.length ? { ruleViolations: [...entry.ruleViolations] } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      evidenceRefs: entry.evidenceRefs,
      ...(entry.snapshotDigest ? { snapshotDigest: entry.snapshotDigest } : {}),
      ...(entry.configuration !== undefined ? { configuration: entry.configuration } : {}),
    });
  }
  const proposals = acceptedProposalsOf(record.synthesisProposals ?? []);
  return {
    missionId: record.id,
    ledgerRevision: record.stateVersion ?? 0,
    runs,
    conditions: missionConditions(record),
    ...(proposals.length > 0 ? { proposals } : {}),
  };
}

/**
 * The Mission-level conditions (#214), as applicability values: a card that
 * declared another Evaluation protocol is projected stale for revalidation in
 * the next deterministic snapshot, never reused as a direct prior. Only a
 * condition the record really publishes mission-wide is declared; the Objective
 * dimension belongs to a Task/experiment objective (not the Mission objective),
 * so dataset, method, runtime, objective and Contract digest stay unknown until
 * a Task declares them.
 */
function missionConditions(record: MissionRecord): string[] {
  return [`evaluation:${record.contract.evaluationMethod}`];
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
  // M1-T9: the evaluation arm is durable; resuming under another arm would mix
  // two comparisons into one Mission record.
  const acceptedMemoryMode = researchMemoryModeOf(previous.researchMemoryMode);
  assertResearchMemoryArmUnchanged(previous.researchMemoryMode, options.researchMemory);
  const preparedCompetitionContext = prepareCompetitionContext(options.competitionContext, researchMemoryProviderFor(options, draft.id, acceptedMemoryMode));

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
  if (researchMemoryModeOf(previous.researchMemoryMode) !== "off") {
    // M1-T7: verify/rebuild the derived Memory projection BEFORE any recovered
    // state is written, so unrebuildable corruption fails closed without
    // rewriting the authoritative record or serving an empty history.
    try {
      record = (await reconcileResearchMemory({ projectRoot: options.projectRoot, record, now })).record;
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }
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
    // Stage 1 (#254): recovery already established authority and reconciled
    // the durable state; this freezes exactly what it proved.
    prepared: prepareResumeRun({ draft, record, options, competition: preparedCompetitionContext, releaseLock }),
    options,
    mode: { kind: "resume" },
  });
  return { ...outcome, reconciliation };
}
