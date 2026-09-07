import { deriveReconcileStatus, normalizeClaimCard, normalizePrediction, normalizeReconcile, type ClaimCard, type ClaimObjection, type PredictionArtifact, type ReconcileInput, type ReconcileRecord, type ReconcileStatus } from "./predict-reconcile";
import { requireIdeaType } from "./idea-types";
import {
  directorAuthorizeHeavyTask,
  isBaselineTrackContract,
  resolveBaselineTrack,
  type BaselineTrackContract,
  type BaselineTrackInput,
} from "./baseline-track";
import {
  assertBlueprintAllowsStop,
  assertBlueprintRefsConsistent,
  blueprintArtifactId,
  blueprintFileDigest,
  collectBlueprintEvidenceRefs,
  emptyBlueprint,
  isBlueprintArtifactId,
  isEvaluatorObservation,
  normalizeBlueprintFile,
  normalizeBlueprintFileRef,
  normalizeCrossReview,
  toBlueprintArtifact,
  type BlueprintFile,
  type BlueprintFileRef,
  type CrossReviewRecord,
  type MissionBlueprint,
} from "./file-blueprint";
import { deepFreeze, digestValue, validEvaluationPublicKey, verifyEvaluationDigest } from "./security-boundary";

export type { ClaimCard, PredictionArtifact, ReconcileInput, ReconcileRecord, ReconcileStatus } from "./predict-reconcile";
export type { BlueprintFile, BlueprintFileKind, BlueprintFileRef, CrossReviewRecord, MissionBlueprint } from "./file-blueprint";
export { directorAuthorizeHeavyTask, resolveBaselineTrack } from "./baseline-track";
export type { BaselineTrackContract, BaselineTrackInput } from "./baseline-track";

export type TaskReconcileInput = ReconcileInput;

export type ResearchDecisionAction = "Continue" | "Revise" | "Scale" | "Stop";
export type ResearchTaskStatus = "QUEUED" | "READY" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED";
export type EvidenceKind =
  | "problem"
  | "gap"
  | "hypothesis"
  | "candidate"
  | "experiment"
  | "observation"
  | "finding"
  | "claim"
  | "negative-evidence"
  | "pitfall";

export interface EvidenceScope {
  readonly competition?: string;
  readonly environment?: string;
  readonly validFrom?: number;
  readonly validUntil?: number;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly refs?: readonly string[];
  readonly verified?: boolean;
  readonly taskId?: string;
  readonly scope?: EvidenceScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Finding {
  readonly id: string;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly verified: boolean;
  readonly source?: "evaluator" | "verifier" | "operator" | "other";
  readonly relatedTaskIds?: readonly string[];
  readonly priorityDelta?: number;
  readonly recommendedAction?: ResearchDecisionAction;
  readonly stopReason?: string;
  readonly scope?: EvidenceScope;
}

export interface NegativeEvidence {
  readonly id: string;
  readonly statement: string;
  readonly category: "code" | "environment" | "metric" | "resource" | "hypothesis-refuted" | "inconclusive" | "rule-violation" | string;
  readonly evidenceRefs: readonly string[];
  readonly relatedTaskIds?: readonly string[];
  readonly priorityDelta?: number;
  readonly verified?: boolean;
  readonly scope?: EvidenceScope;
}

export interface Pitfall {
  readonly id: string;
  readonly pattern: string;
  readonly answerAgnostic: boolean;
  readonly evidenceRefs: readonly string[];
  readonly tags?: readonly string[];
  readonly scope?: EvidenceScope;
  readonly verified?: boolean;
}

export interface ResearchCandidateRef {
  readonly candidateId: string;
  readonly digest: string;
  readonly address?: string;
  /**
   * Registered idea type of the attempted candidate. When true, `promoted` records that the
   * candidate passed the promotion gate; it is caller-supplied audit input recorded with the
   * task completion, so verify it against the promotion-gate records before relying on the
   * derived promotion rate.
   */
  readonly ideaType?: string;
  readonly promoted?: boolean;
}

export interface ResearchArtifactRef {
  readonly artifactId: string;
  readonly digest: string;
  readonly address?: string;
}

export interface ResearchTask {
  readonly taskId: string;
  readonly objective: string;
  readonly dependencies?: readonly string[];
  readonly requiredEvidence?: readonly string[];
  readonly priority?: number;
  readonly uncertainty?: number;
  readonly estimatedCost?: number;
  readonly tags?: readonly string[];
  /** Registered idea type (systems | algorithmic | open-search, or a registered extension). */
  readonly ideaType?: string;
  /** Macro campaign this task is tagged to; its cost draws the campaign envelope on selection. */
  readonly campaignId?: string;
  readonly prediction?: PredictionArtifact;
}

export interface ResearchTaskState extends ResearchTask {
  readonly status: ResearchTaskStatus;
  readonly evidenceRefs: readonly string[];
  readonly candidateRefs: readonly ResearchCandidateRef[];
  readonly artifactRefs: readonly ResearchArtifactRef[];
  readonly priorityScore: number;
  readonly prediction?: PredictionArtifact;
  readonly reconcile?: ReconcileRecord;
  readonly claimCard?: ClaimCard;
  readonly objections?: readonly ClaimObjection[];
  readonly failureReason?: string;
}

export interface TaskCompletion {
  readonly operationId?: string;
  readonly evidence?: readonly EvidenceRecord[];
  readonly findings?: readonly Finding[];
  readonly negativeEvidence?: readonly NegativeEvidence[];
  readonly pitfalls?: readonly Pitfall[];
  readonly candidates?: readonly ResearchCandidateRef[];
  readonly artifacts?: readonly ResearchArtifactRef[];
  readonly reconcile?: TaskReconcileInput;
  readonly objections?: readonly ClaimObjection[];
}

export interface TaskFailure {
  readonly operationId?: string;
  readonly reason: string;
  readonly category?: NegativeEvidence["category"];
  readonly evidence?: readonly EvidenceRecord[];
  readonly negativeEvidence?: readonly NegativeEvidence[];
  readonly reconcile?: TaskReconcileInput;
  readonly objections?: readonly ClaimObjection[];
}

export interface ResearchBudgetState {
  readonly total: number;
  readonly consumed: number;
  readonly remaining: number;
}

/** Per-idea-type attempt and promotion counts for bias auditing. */
export interface IdeaTypeStats {
  readonly ideaType: string;
  readonly attempts: number;
  readonly promoted: number;
  readonly promotionRate: number;
}

/**
 * Completion condition of one campaign milestone. Parts are optional and combine with AND; each
 * declared part must be satisfied. A verifier threshold only counts evaluation evidence whose
 * digest-verified proof carries a signature from a trusted evaluator.
 */
export interface MilestoneCondition {
  readonly evidenceRefs?: readonly string[];
  readonly worldModelClaimIds?: readonly string[];
  readonly verifierThreshold?: { readonly fact: string; readonly minimum: number };
}

export interface CampaignMilestone {
  readonly milestoneId: string;
  readonly description: string;
  readonly condition: MilestoneCondition;
}

/**
 * A macro campaign: an explicit goal with allowed idea types, its own budget envelope, milestones,
 * and stop conditions. Campaigns ride the mission ledger as declarations on MISSION_CREATED and
 * PLAN_REVISED events; there is no separate authority state store.
 */
export interface Campaign {
  readonly campaignId: string;
  readonly goal: string;
  /** Allowed task idea types; when non-empty, tagged tasks must declare one of them. */
  readonly ideaTypes?: readonly string[];
  /** Campaign budget envelope: caps the total estimatedCost of selected tasks tagged to it. */
  readonly budget: number;
  readonly milestones: readonly CampaignMilestone[];
  /** Milestone ids whose joint completion marks the campaign goal as met. */
  readonly stopConditions?: readonly string[];
}

export interface CampaignMilestoneState extends CampaignMilestone {
  readonly completed: boolean;
  readonly completedVia: readonly ("evidence" | "world-model" | "verifier")[];
}

export interface CampaignState {
  readonly campaignId: string;
  readonly goal: string;
  readonly ideaTypes: readonly string[];
  readonly budget: ResearchBudgetState;
  readonly milestones: readonly CampaignMilestoneState[];
  readonly stopConditionsMet: boolean;
  readonly exhausted: boolean;
}

/** Ledger-visible macro vs micro spend split; macro spend also draws the mission budget. */
export interface ResearchSpendState {
  readonly micro: number;
  readonly macro: number;
}

export type ResearchBudgetInput = number | { readonly total?: number; readonly maxUnits?: number; readonly units?: number };

export interface ResearchMissionState {
  readonly missionId: string;
  readonly phase: "RUNNING" | "STOPPED";
  readonly objective: string;
  readonly scope?: EvidenceScope;
  readonly budget: ResearchBudgetState;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly tasks: Readonly<Record<string, ResearchTaskState>>;
  readonly candidates: readonly ResearchCandidateRef[];
  readonly artifacts: readonly ResearchArtifactRef[];
  readonly ideaTypeStats: readonly IdeaTypeStats[];
  readonly predictions: readonly PredictionArtifact[];
  readonly reconciles: readonly ReconcileRecord[];
  readonly worldModel: readonly ClaimCard[];
  readonly evidence: readonly EvidenceRecord[];
  readonly findings: readonly Finding[];
  readonly negativeEvidence: readonly NegativeEvidence[];
  readonly pitfalls: readonly Pitfall[];
  readonly decisions: readonly ResearchDecision[];
  readonly trustedEvaluators: readonly TrustedEvaluator[];
  readonly campaigns: readonly CampaignState[];
  readonly spend: ResearchSpendState;
  readonly suggestedAction?: ResearchDecisionAction;
  readonly suggestedStopReason?: string;
  readonly stopReason?: string;
  readonly blueprint: MissionBlueprint;
}

export interface ResearchDecision {
  readonly decisionId: string;
  readonly action: ResearchDecisionAction;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly stopReason?: string;
  readonly taskId?: string;
  /** Campaigns the decision references; a decision with campaign refs is a macro decision. */
  readonly campaignIds?: readonly string[];
  /** Ledger-visible macro vs micro decision classification, derived from campaign refs. */
  readonly scope?: "macro" | "micro";
}

export interface ResearchPlanProposal {
  readonly parentPlanDigest: string;
  readonly objective: string;
  readonly totalBudget: number;
  readonly tasks: readonly ResearchTask[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
  readonly operationId?: string;
  /** Redeclared campaign set; omitted keeps the current campaigns unchanged. */
  readonly campaigns?: readonly Campaign[];
}

export interface GenerateTasksInput {
  readonly sourceTaskId: string;
  readonly evidenceRefs: readonly string[];
  readonly tasks: readonly ResearchTask[];
  readonly operationId?: string;
}

export interface CommitBlueprintInput {
  readonly evidenceRefs?: readonly string[];
  readonly operationId?: string;
}

export interface RecordCrossReviewInput {
  readonly reviewId: string;
  readonly phase: "author" | "reviewer";
  readonly subjectRefs: readonly string[];
  readonly findings: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly operationId?: string;
}

export interface MissionDirectorOptions {
  readonly missionId: string;
  readonly objective: string;
  readonly budget: ResearchBudgetInput;
  readonly tasks?: readonly ResearchTask[];
  readonly scope?: EvidenceScope;
  readonly clock?: () => number;
  /** Declared macro campaigns; defaults to none. */
  readonly campaigns?: readonly Campaign[];
  /** Mission trust root: independent evaluators whose signed proofs may gate WORLD_MODEL admission. */
  readonly trustedEvaluators?: readonly TrustedEvaluator[];
  /**
   * Explicit user instruction for task selection: ordered preferred idea types. When absent,
   * the default soft preference rotates idea types so systems-heavy plans cannot starve
   * algorithmic / open-search tasks out of the ready set.
   */
  readonly ideaTypePreference?: readonly string[];
  /**
   * T43 forced strong-baseline track: when declared, heavy idea kinds (default
   * open-search) are ineligible for selection until a task tagged
   * `baseline_track` completes, so a trivial strong baseline is always run
   * first. Vendor-neutral; carries the same contract shape as the adapter.
   */
  readonly baselineTrack?: BaselineTrackInput | BaselineTrackContract;
}

export interface TrustedEvaluator {
  readonly evaluatorId: string;
  readonly publicKey: string;
}

export type ResearchEventType =
  | "MISSION_CREATED"
  | "TASK_SELECTED"
  | "PREDICTION_RECORDED"
  | "TASK_COMPLETED"
  | "RECONCILED"
  | "WORLD_MODEL_UPDATED"
  | "TASK_FAILED"
  | "TASKS_GENERATED"
  | "FINDING_RECORDED"
  | "FINDING_REJECTED"
  | "NEGATIVE_EVIDENCE_RECORDED"
  | "PITFALL_RECORDED"
  | "DECISION_RECORDED"
  | "PLAN_REVISED"
  | "BLUEPRINT_COMMITTED"
  | "CROSS_REVIEW_RECORDED"
  | "MISSION_STOPPED";

export interface ResearchEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: ResearchEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

const RESEARCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "MISSION_CREATED", "TASK_SELECTED", "PREDICTION_RECORDED", "TASK_COMPLETED", "RECONCILED", "WORLD_MODEL_UPDATED", "TASK_FAILED", "TASKS_GENERATED",
  "FINDING_RECORDED", "FINDING_REJECTED", "NEGATIVE_EVIDENCE_RECORDED", "PITFALL_RECORDED",
  "DECISION_RECORDED", "PLAN_REVISED", "BLUEPRINT_COMMITTED", "CROSS_REVIEW_RECORDED", "MISSION_STOPPED",
]);

export interface ResearchLedger {
  append(event: Omit<ResearchEvent, "sequence" | "eventId"> & { readonly sequence?: number; readonly eventId?: string }): ResearchEvent;
  events(): readonly ResearchEvent[];
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function finiteNonNegative(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0`);
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a finite integer >= 1`);
}

function strings(name: string, value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "") || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must contain unique, non-empty strings`);
  }
  return [...value];
}

function budgetTotal(value: ResearchBudgetInput): number {
  if (typeof value !== "number" && !isPlainRecord(value)) throw new TypeError("budget must be a number or an ordinary object");
  const total = typeof value === "number" ? value : value.total ?? value.maxUnits ?? value.units;
  finiteNonNegative("budget", total);
  return total;
}

function normalizeScope(scope: EvidenceScope | undefined): EvidenceScope | undefined {
  if (scope === undefined) return undefined;
  if (!isPlainRecord(scope)) throw new TypeError("evidence scope must be an ordinary object");
  for (const key of ["competition", "environment"] as const) {
    if (scope[key] !== undefined) nonEmpty(`scope.${key}`, scope[key]);
  }
  if (scope.validFrom !== undefined) finiteNonNegative("scope.validFrom", scope.validFrom);
  if (scope.validUntil !== undefined) finiteNonNegative("scope.validUntil", scope.validUntil);
  if (scope.validFrom !== undefined && scope.validUntil !== undefined && scope.validFrom > scope.validUntil) {
    throw new RangeError("scope.validFrom cannot exceed scope.validUntil");
  }
  const competition = scope.competition as string | undefined;
  const environment = scope.environment as string | undefined;
  const validFrom = scope.validFrom as number | undefined;
  const validUntil = scope.validUntil as number | undefined;
  return Object.freeze({
    ...(competition === undefined ? {} : { competition }),
    ...(environment === undefined ? {} : { environment }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
  });
}

function normalizeTask(task: ResearchTask): ResearchTask {
  if (!isPlainRecord(task)) throw new TypeError("research task must be an ordinary object");
  nonEmpty("taskId", task.taskId);
  nonEmpty("task objective", task.objective);
  const dependencies = strings("task dependencies", task.dependencies);
  const requiredEvidence = strings("task requiredEvidence", task.requiredEvidence);
  const tags = strings("task tags", task.tags);
  const prediction = task.prediction === undefined ? undefined : normalizePrediction(task.prediction, `${task.taskId}:prediction`);
  if (task.priority !== undefined) finiteNonNegative("task priority", task.priority);
  if (task.uncertainty !== undefined) finiteNonNegative("task uncertainty", task.uncertainty);
  const estimatedCost = task.estimatedCost ?? 1;
  if (typeof estimatedCost !== "number" || !Number.isFinite(estimatedCost) || estimatedCost <= 0) {
    throw new RangeError("task estimatedCost must be finite and > 0");
  }
  if (task.campaignId !== undefined) nonEmpty("task campaignId", task.campaignId);
  return Object.freeze({
    taskId: task.taskId,
    objective: task.objective,
    ...(dependencies.length === 0 ? {} : { dependencies: Object.freeze(dependencies) }),
    ...(requiredEvidence.length === 0 ? {} : { requiredEvidence: Object.freeze(requiredEvidence) }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.uncertainty === undefined ? {} : { uncertainty: task.uncertainty }),
    estimatedCost,
    ...(tags.length === 0 ? {} : { tags: Object.freeze(tags) }),
    ...(task.ideaType === undefined ? {} : { ideaType: requireIdeaType(task.ideaType) }),
    ...(task.campaignId === undefined ? {} : { campaignId: task.campaignId }),
    ...(prediction === undefined ? {} : { prediction }),
  });
}

function normalizeCandidates(value: readonly ResearchCandidateRef[] | undefined): ResearchCandidateRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("candidate refs must be an array");
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!isPlainRecord(candidate)) throw new TypeError("candidate ref must be an ordinary object");
    nonEmpty("candidateId", candidate.candidateId);
    nonEmpty("candidate digest", candidate.digest);
    if (ids.has(candidate.candidateId)) throw new RangeError("candidate refs must be unique");
    ids.add(candidate.candidateId);
    if (candidate.address !== undefined) nonEmpty("candidate address", candidate.address);
    const ideaType = candidate.ideaType === undefined ? undefined : requireIdeaType(candidate.ideaType);
    if (candidate.promoted !== undefined && typeof candidate.promoted !== "boolean") throw new TypeError("candidate promoted must be boolean");
    return Object.freeze({
      candidateId: candidate.candidateId,
      digest: candidate.digest,
      ...(candidate.address === undefined ? {} : { address: candidate.address }),
      ...(ideaType === undefined ? {} : { ideaType }),
      ...(candidate.promoted === undefined ? {} : { promoted: candidate.promoted }),
    });
  });
}

function normalizeArtifacts(value: readonly ResearchArtifactRef[] | undefined): ResearchArtifactRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("artifact refs must be an array");
  const ids = new Set<string>();
  return value.map((artifact) => {
    if (!isPlainRecord(artifact)) throw new TypeError("artifact ref must be an ordinary object");
    nonEmpty("artifactId", artifact.artifactId);
    nonEmpty("artifact digest", artifact.digest);
    if (ids.has(artifact.artifactId)) throw new RangeError("artifact refs must be unique");
    ids.add(artifact.artifactId);
    if (artifact.address !== undefined) nonEmpty("artifact address", artifact.address);
    return Object.freeze({ artifactId: artifact.artifactId, digest: artifact.digest, ...(artifact.address === undefined ? {} : { address: artifact.address }) });
  });
}

function normalizeEvidence(value: EvidenceRecord, taskId?: string): EvidenceRecord {
  if (!isPlainRecord(value)) throw new TypeError("evidence must be an ordinary object");
  nonEmpty("evidence id", value.id);
  nonEmpty("evidence summary", value.summary);
  const kinds: readonly EvidenceKind[] = ["problem", "gap", "hypothesis", "candidate", "experiment", "observation", "finding", "claim", "negative-evidence", "pitfall"];
  if (!kinds.includes(value.kind)) throw new RangeError(`unknown evidence kind: ${String(value.kind)}`);
  const refs = strings("evidence refs", value.refs);
  if (value.verified !== undefined && typeof value.verified !== "boolean") throw new TypeError("evidence verified must be boolean");
  if (value.taskId !== undefined) {
    nonEmpty("evidence taskId", value.taskId);
    if (taskId !== undefined && value.taskId !== taskId) throw new Error("evidence taskId does not match its completion task");
  }
  const scope = normalizeScope(value.scope);
  return deepFreeze({
    id: value.id,
    kind: value.kind,
    summary: value.summary,
    ...(refs.length === 0 ? {} : { refs }),
    ...(value.verified === undefined ? {} : { verified: value.verified }),
    ...(value.taskId === undefined && taskId === undefined ? {} : { taskId: value.taskId ?? taskId }),
    ...(scope === undefined ? {} : { scope }),
    ...(value.metadata === undefined ? {} : { metadata: clone(value.metadata) }),
  }) as EvidenceRecord;
}

function normalizeFinding(value: Finding): Finding {
  if (!isPlainRecord(value)) throw new TypeError("finding must be an ordinary object");
  nonEmpty("finding id", value.id);
  nonEmpty("finding statement", value.statement);
  const evidenceRefs = strings("finding evidenceRefs", value.evidenceRefs);
  if (typeof value.verified !== "boolean") throw new TypeError("finding verified must be boolean");
  if (value.source !== undefined && !["evaluator", "verifier", "operator", "other"].includes(value.source as string)) {
    throw new RangeError("unknown finding source");
  }
  const relatedTaskIds = strings("finding relatedTaskIds", value.relatedTaskIds);
  if (value.priorityDelta !== undefined) {
    if (typeof value.priorityDelta !== "number") throw new TypeError("finding priorityDelta must be a number");
    finiteNonNegative("finding priorityDelta", Math.abs(value.priorityDelta));
  }
  if (value.recommendedAction !== undefined && !["Continue", "Revise", "Scale", "Stop"].includes(value.recommendedAction)) throw new RangeError("unknown finding action");
  if (value.stopReason !== undefined) nonEmpty("finding stopReason", value.stopReason);
  return deepFreeze({
    id: value.id,
    statement: value.statement,
    evidenceRefs,
    verified: value.verified,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(relatedTaskIds.length === 0 ? {} : { relatedTaskIds }),
    ...(value.priorityDelta === undefined ? {} : { priorityDelta: value.priorityDelta }),
    ...(value.recommendedAction === undefined ? {} : { recommendedAction: value.recommendedAction }),
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
    ...(value.scope === undefined ? {} : { scope: normalizeScope(value.scope) }),
  }) as Finding;
}

function normalizeNegative(value: NegativeEvidence): NegativeEvidence {
  if (!isPlainRecord(value)) throw new TypeError("negative evidence must be an ordinary object");
  nonEmpty("negative evidence id", value.id);
  nonEmpty("negative evidence statement", value.statement);
  nonEmpty("negative evidence category", value.category);
  const evidenceRefs = strings("negative evidence evidenceRefs", value.evidenceRefs);
  const relatedTaskIds = strings("negative evidence relatedTaskIds", value.relatedTaskIds);
  if (value.priorityDelta !== undefined) {
    if (typeof value.priorityDelta !== "number") throw new TypeError("negative evidence priorityDelta must be a number");
    finiteNonNegative("negative evidence priorityDelta", Math.abs(value.priorityDelta));
  }
  if (value.verified !== undefined && typeof value.verified !== "boolean") throw new TypeError("negative evidence verified must be boolean");
  return deepFreeze({
    id: value.id, statement: value.statement, category: value.category, evidenceRefs,
    ...(relatedTaskIds.length === 0 ? {} : { relatedTaskIds }),
    ...(value.priorityDelta === undefined ? {} : { priorityDelta: value.priorityDelta }),
    ...(value.verified === undefined ? {} : { verified: value.verified }),
    ...(value.scope === undefined ? {} : { scope: normalizeScope(value.scope) }),
  }) as NegativeEvidence;
}

function normalizePitfall(value: Pitfall): Pitfall {
  if (!isPlainRecord(value)) throw new TypeError("pitfall must be an ordinary object");
  nonEmpty("pitfall id", value.id);
  nonEmpty("pitfall pattern", value.pattern);
  if (value.answerAgnostic !== true) throw new TypeError("pitfall must be answer-agnostic");
  const evidenceRefs = strings("pitfall evidenceRefs", value.evidenceRefs);
  const tags = strings("pitfall tags", value.tags);
  if (value.verified !== undefined && typeof value.verified !== "boolean") throw new TypeError("pitfall verified must be boolean");
  return deepFreeze({
    id: value.id, pattern: value.pattern, answerAgnostic: true, evidenceRefs,
    ...(tags.length === 0 ? {} : { tags }),
    ...(value.scope === undefined ? {} : { scope: normalizeScope(value.scope) }),
    ...(value.verified === undefined ? {} : { verified: value.verified }),
  }) as Pitfall;
}

function normalizeDecision(value: unknown): ResearchDecision {
  if (!isPlainRecord(value)) throw new TypeError("decision must be an ordinary object");
  nonEmpty("decisionId", value.decisionId);
  if (!["Continue", "Revise", "Scale", "Stop"].includes(value.action as string)) throw new RangeError("unknown decision action");
  const evidenceRefs = strings("decision evidenceRefs", value.evidenceRefs as string[] | undefined);
  if (evidenceRefs.length === 0) throw new Error("decision requires evidence references");
  nonEmpty("decision reason", value.reason);
  if (value.stopReason !== undefined) nonEmpty("decision stopReason", value.stopReason);
  if (value.taskId !== undefined) nonEmpty("decision taskId", value.taskId);
  const campaignIds = strings("decision campaignIds", value.campaignIds as string[] | undefined);
  const stopReason = value.action === "Stop" ? value.stopReason ?? value.reason : value.stopReason;
  return deepFreeze({
    decisionId: value.decisionId,
    action: value.action,
    evidenceRefs,
    reason: value.reason,
    scope: campaignIds.length === 0 ? "micro" : "macro",
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(campaignIds.length === 0 ? {} : { campaignIds: Object.freeze(campaignIds) }),
  }) as ResearchDecision;
}

function same(value: unknown, other: unknown): boolean {
  try { return digestValue(value) === digestValue(other); } catch { return false; }
}

function scopeMatches(value: EvidenceScope | undefined, query: EvidenceScope | undefined): boolean {
  if (query === undefined || Object.values(query).every((entry) => entry === undefined)) return true;
  if (value === undefined) return false;
  if (query.competition !== undefined && value.competition !== query.competition) return false;
  if (query.environment !== undefined && value.environment !== query.environment) return false;
  if (query.validFrom !== undefined && value.validUntil !== undefined && value.validUntil < query.validFrom) return false;
  if (query.validUntil !== undefined && value.validFrom !== undefined && value.validFrom > query.validUntil) return false;
  return true;
}

interface SearchQuery {
  readonly text?: string;
  readonly scope?: EvidenceScope;
}

function searchQuery(value: string | SearchQuery | undefined): SearchQuery {
  return typeof value === "string" ? { text: value } : value ?? {};
}

function matchesText(values: readonly string[], query: string | undefined): boolean {
  if (query === undefined || query.trim() === "") return true;
  const needle = query.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(needle));
}

export class EvidenceMemory {
  private readonly evidenceById = new Map<string, EvidenceRecord>();
  private readonly findingsById = new Map<string, Finding>();
  private readonly negativeById = new Map<string, NegativeEvidence>();
  private readonly pitfallsById = new Map<string, Pitfall>();

  constructor(input: {
    readonly evidence?: readonly EvidenceRecord[];
    readonly findings?: readonly Finding[];
    readonly negativeEvidence?: readonly NegativeEvidence[];
    readonly pitfalls?: readonly Pitfall[];
  } = {}) {
    for (const record of input.evidence ?? []) this.addEvidence(record);
    for (const finding of input.findings ?? []) this.addFinding(finding);
    for (const negative of input.negativeEvidence ?? []) this.addNegativeEvidence(negative);
    for (const pitfall of input.pitfalls ?? []) this.addPitfall(pitfall);
  }

  has(id: string): boolean {
    const record = this.evidenceById.get(id);
    return record !== undefined && record.verified !== false;
  }
  get(id: string): EvidenceRecord | undefined { return this.evidenceById.get(id); }
  getFinding(id: string): Finding | undefined { return this.findingsById.get(id); }
  getNegativeEvidence(id: string): NegativeEvidence | undefined { return this.negativeById.get(id); }
  getPitfall(id: string): Pitfall | undefined { return this.pitfallsById.get(id); }

  addEvidence(value: EvidenceRecord): EvidenceRecord {
    const record = normalizeEvidence(value);
    const existing = this.evidenceById.get(record.id);
    if (existing) {
      if (!same(existing, record)) throw new Error(`evidence id already contains different data: ${record.id}`);
      return existing;
    }
    for (const ref of record.refs ?? []) if (!this.has(ref)) throw new Error(`evidence references an unknown item: ${ref}`);
    this.evidenceById.set(record.id, record);
    return record;
  }

  addFinding(value: Finding): boolean {
    const finding = normalizeFinding(value);
    const existing = this.findingsById.get(finding.id);
    if (existing) {
      if (!same(existing, finding)) throw new Error(`finding id already contains different data: ${finding.id}`);
      return existing.verified;
    }
    if (!finding.verified) return false;
    if (finding.evidenceRefs.length === 0) throw new Error("verified finding requires evidence references");
    for (const ref of finding.evidenceRefs) if (!this.has(ref)) throw new Error(`finding references an unknown item: ${ref}`);
    this.findingsById.set(finding.id, finding);
    this.addEvidence({ id: finding.id, kind: "finding", summary: finding.statement, refs: finding.evidenceRefs, verified: true, scope: finding.scope });
    return true;
  }

  addNegativeEvidence(value: NegativeEvidence): NegativeEvidence | undefined {
    const negative = normalizeNegative(value);
    const existing = this.negativeById.get(negative.id);
    if (existing) {
      if (!same(existing, negative)) throw new Error(`negative evidence id already contains different data: ${negative.id}`);
      return existing;
    }
    if (negative.verified === false) return undefined;
    for (const ref of negative.evidenceRefs) if (!this.has(ref)) throw new Error(`negative evidence references an unknown item: ${ref}`);
    this.negativeById.set(negative.id, negative);
    this.addEvidence({ id: negative.id, kind: "negative-evidence", summary: negative.statement, refs: negative.evidenceRefs, verified: true, scope: negative.scope });
    return negative;
  }

  addPitfall(value: Pitfall): Pitfall | undefined {
    const pitfall = normalizePitfall(value);
    const existing = this.pitfallsById.get(pitfall.id);
    if (existing) {
      if (!same(existing, pitfall)) throw new Error(`pitfall id already contains different data: ${pitfall.id}`);
      return existing;
    }
    if (pitfall.verified === false) return undefined;
    for (const ref of pitfall.evidenceRefs) if (!this.has(ref)) throw new Error(`pitfall references an unknown item: ${ref}`);
    this.pitfallsById.set(pitfall.id, pitfall);
    this.addEvidence({ id: pitfall.id, kind: "pitfall", summary: pitfall.pattern, refs: pitfall.evidenceRefs, verified: true, scope: pitfall.scope });
    return pitfall;
  }

  records(): readonly EvidenceRecord[] { return frozenArray([...this.evidenceById.values()]); }
  findings(): readonly Finding[] { return frozenArray([...this.findingsById.values()]); }
  negativeEvidence(): readonly NegativeEvidence[] { return frozenArray([...this.negativeById.values()]); }
  pitfalls(): readonly Pitfall[] { return frozenArray([...this.pitfallsById.values()]); }

  chain(id: string): readonly EvidenceRecord[] {
    const result: EvidenceRecord[] = [];
    const visiting = new Set<string>();
    const visit = (current: string): void => {
      if (visiting.has(current)) throw new Error(`evidence chain is cyclic at ${current}`);
      const record = this.evidenceById.get(current);
      if (!record || record.verified === false) throw new Error(`unknown or unverified evidence item: ${current}`);
      visiting.add(current);
      for (const ref of record.refs ?? []) visit(ref);
      visiting.delete(current);
      if (!result.some((entry) => entry.id === record.id)) result.push(record);
    };
    visit(id);
    return frozenArray(result);
  }

  searchPitfalls(input?: string | SearchQuery): readonly Pitfall[] {
    const query = searchQuery(input);
    return frozenArray([...this.pitfallsById.values()].filter((pitfall) =>
      matchesText([pitfall.pattern, ...(pitfall.tags ?? [])], query.text) && scopeMatches(pitfall.scope, query.scope)));
  }

  searchNegativeEvidence(input?: string | SearchQuery): readonly NegativeEvidence[] {
    const query = searchQuery(input);
    return frozenArray([...this.negativeById.values()].filter((negative) =>
      matchesText([negative.statement, negative.category], query.text) && scopeMatches(negative.scope, query.scope)));
  }

  searchFindings(input?: string | SearchQuery): readonly Finding[] {
    const query = searchQuery(input);
    return frozenArray([...this.findingsById.values()].filter((finding) =>
      matchesText([finding.statement], query.text) && scopeMatches(finding.scope, query.scope)));
  }
}

function frozenArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze(values.map((value) => deepFreeze(clone(value)))) as readonly T[];
}

interface MutableTaskState {
  task: ResearchTask;
  status: ResearchTaskStatus;
  evidenceRefs: string[];
  candidateRefs: ResearchCandidateRef[];
  artifactRefs: ResearchArtifactRef[];
  prediction?: PredictionArtifact;
  reconcile?: ReconcileRecord;
  failureReason?: string;
}

interface MutableResearchState {
  missionId: string;
  phase: "RUNNING" | "STOPPED";
  objective: string;
  scope?: EvidenceScope;
  budgetTotal: number;
  budgetConsumed: number;
  campaigns: Map<string, Campaign>;
  campaignConsumed: Map<string, number>;
  planVersion: number;
  planDigest: string;
  tasks: Map<string, MutableTaskState>;
  candidates: Map<string, ResearchCandidateRef>;
  artifacts: Map<string, ResearchArtifactRef>;
  memory: EvidenceMemory;
  decisions: ResearchDecision[];
  predictions: Map<string, PredictionArtifact>;
  reconciles: Map<string, ReconcileRecord>;
  worldModel: Map<string, ClaimCard>;
  trustedEvaluators: Map<string, string>;
  suggestedAction?: ResearchDecisionAction;
  suggestedStopReason?: string;
  stopReason?: string;
  blueprint: MissionBlueprint;
  operations: Map<string, { type: ResearchEventType; payload: Readonly<Record<string, unknown>> }>;
}

function normalizeMilestone(value: unknown): CampaignMilestone {
  if (!isPlainRecord(value)) throw new TypeError("milestone must be an ordinary object");
  nonEmpty("milestoneId", value.milestoneId);
  nonEmpty("milestone description", value.description);
  if (!isPlainRecord(value.condition)) throw new TypeError("milestone condition must be an ordinary object");
  const evidenceRefs = strings("milestone evidenceRefs", value.condition.evidenceRefs as string[] | undefined);
  const worldModelClaimIds = strings("milestone worldModelClaimIds", value.condition.worldModelClaimIds as string[] | undefined);
  let verifierThreshold: { fact: string; minimum: number } | undefined;
  if (value.condition.verifierThreshold !== undefined) {
    const threshold = value.condition.verifierThreshold;
    if (!isPlainRecord(threshold)) throw new TypeError("milestone verifierThreshold must be an ordinary object");
    nonEmpty("verifierThreshold fact", threshold.fact);
    finiteNonNegative("verifierThreshold minimum", threshold.minimum);
    verifierThreshold = { fact: threshold.fact, minimum: threshold.minimum };
  }
  if (evidenceRefs.length === 0 && worldModelClaimIds.length === 0 && verifierThreshold === undefined) {
    throw new Error("milestone condition requires evidence refs, world model claims, or a verifier threshold");
  }
  return Object.freeze({
    milestoneId: value.milestoneId,
    description: value.description,
    condition: Object.freeze({
      ...(evidenceRefs.length === 0 ? {} : { evidenceRefs: Object.freeze(evidenceRefs) }),
      ...(worldModelClaimIds.length === 0 ? {} : { worldModelClaimIds: Object.freeze(worldModelClaimIds) }),
      ...(verifierThreshold === undefined ? {} : { verifierThreshold: Object.freeze(verifierThreshold) }),
    }),
  }) as CampaignMilestone;
}

function normalizeCampaigns(value: unknown): Map<string, Campaign> {
  const result = new Map<string, Campaign>();
  if (value === undefined) return result;
  if (!Array.isArray(value)) throw new TypeError("campaigns must be an array");
  for (const entry of value) {
    if (!isPlainRecord(entry)) throw new TypeError("campaign must be an ordinary object");
    nonEmpty("campaignId", entry.campaignId);
    nonEmpty("campaign goal", entry.goal);
    if (result.has(entry.campaignId)) throw new RangeError(`duplicate campaign: ${String(entry.campaignId)}`);
    const ideaTypes = strings("campaign ideaTypes", entry.ideaTypes as string[] | undefined).map(requireIdeaType);
    finiteNonNegative("campaign budget", entry.budget);
    if (!Array.isArray(entry.milestones)) throw new TypeError("campaign milestones must be an array");
    const milestones = entry.milestones.map(normalizeMilestone);
    const milestoneIds = new Set(milestones.map((milestone) => milestone.milestoneId));
    const stopConditions = strings("campaign stopConditions", entry.stopConditions as string[] | undefined);
    for (const id of stopConditions) if (!milestoneIds.has(id)) throw new RangeError(`campaign stop condition references an unknown milestone: ${id}`);
    result.set(entry.campaignId, Object.freeze({
      campaignId: entry.campaignId,
      goal: entry.goal,
      ...(ideaTypes.length === 0 ? {} : { ideaTypes: Object.freeze(ideaTypes) }),
      budget: entry.budget,
      milestones: Object.freeze(milestones),
      ...(stopConditions.length === 0 ? {} : { stopConditions: Object.freeze(stopConditions) }),
    }) as Campaign);
  }
  return result;
}

function taskPlan(task: ResearchTask): ResearchTask {
  return {
    taskId: task.taskId,
    objective: task.objective,
    ...(task.dependencies === undefined ? {} : { dependencies: [...task.dependencies] }),
    ...(task.requiredEvidence === undefined ? {} : { requiredEvidence: [...task.requiredEvidence] }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.uncertainty === undefined ? {} : { uncertainty: task.uncertainty }),
    ...(task.estimatedCost === undefined ? {} : { estimatedCost: task.estimatedCost }),
    ...(task.tags === undefined ? {} : { tags: [...task.tags] }),
    ...(task.ideaType === undefined ? {} : { ideaType: task.ideaType }),
    ...(task.campaignId === undefined ? {} : { campaignId: task.campaignId }),
    ...(task.prediction === undefined ? {} : { prediction: clone(task.prediction) }),
  };
}

function campaignPlan(campaign: Campaign): Campaign {
  return {
    campaignId: campaign.campaignId,
    goal: campaign.goal,
    ...(campaign.ideaTypes === undefined ? {} : { ideaTypes: [...campaign.ideaTypes] }),
    budget: campaign.budget,
    milestones: campaign.milestones.map((milestone) => ({ milestoneId: milestone.milestoneId, description: milestone.description, condition: { ...milestone.condition } })),
    ...(campaign.stopConditions === undefined ? {} : { stopConditions: [...campaign.stopConditions] }),
  };
}

function planDigest(objective: string, totalBudget: number, tasks: readonly ResearchTask[], scope: EvidenceScope | undefined, campaigns: readonly Campaign[] = []): string {
  return digestValue({ objective, totalBudget, tasks: tasks.map(taskPlan), scope, campaigns: campaigns.map(campaignPlan) });
}

function validateTaskGraph(tasks: readonly ResearchTask[], externalIds: ReadonlySet<string> = new Set(), campaigns?: ReadonlyMap<string, Campaign>): ResearchTask[] {
  const normalized = tasks.map(normalizeTask);
  const ids = new Set<string>();
  for (const task of normalized) {
    if (ids.has(task.taskId)) throw new RangeError(`duplicate research task: ${task.taskId}`);
    ids.add(task.taskId);
  }
  if (campaigns !== undefined) {
    for (const task of normalized) {
      if (task.campaignId === undefined) continue;
      const campaign = campaigns.get(task.campaignId);
      if (!campaign) throw new RangeError(`task ${task.taskId} references an unknown campaign: ${task.campaignId}`);
      const allowed = campaign.ideaTypes ?? [];
      if (allowed.length > 0 && (task.ideaType === undefined || !allowed.includes(task.ideaType))) {
        throw new RangeError(`task ${task.taskId} idea type is not allowed by campaign ${task.campaignId}`);
      }
    }
  }
  for (const task of normalized) {
    for (const dependency of task.dependencies ?? []) {
      if (!ids.has(dependency) && !externalIds.has(dependency)) throw new RangeError(`task ${task.taskId} references unknown dependency ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new RangeError(`research task dependency cycle includes ${id}`);
    if (visited.has(id) || !ids.has(id)) return;
    visiting.add(id);
    for (const dependency of normalized.find((task) => task.taskId === id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of normalized) visit(task.taskId);
  return normalized;
}

function initialMutable(event: ResearchEvent): MutableResearchState {
  const p = event.payload;
  if (!isPlainRecord(p)) throw new Error("mission event payload must be an ordinary object");
  nonEmpty("missionId", p.missionId);
  nonEmpty("mission objective", p.objective);
  finiteNonNegative("mission budget", p.totalBudget);
  const campaigns = normalizeCampaigns(p.campaigns);
  const tasks = validateTaskGraph(Array.isArray(p.tasks) ? p.tasks as ResearchTask[] : [], new Set(), campaigns);
  if (tasks.length === 0) throw new RangeError("research mission requires at least one task");
  const scope = normalizeScope(p.scope as EvidenceScope | undefined);
  if (p.planVersion !== 1) throw new Error("mission plan version must start at 1");
  if (p.operationId !== undefined) nonEmpty("mission operationId", p.operationId);
  if (typeof p.planDigest !== "string" || p.planDigest !== planDigest(p.objective, p.totalBudget, tasks, scope, [...campaigns.values()])) {
    throw new Error("mission plan digest does not match its contents");
  }
  const state: MutableResearchState = {
    missionId: p.missionId,
    phase: "RUNNING",
    objective: p.objective,
    ...(scope === undefined ? {} : { scope }),
    budgetTotal: p.totalBudget,
    budgetConsumed: 0,
    campaigns,
    campaignConsumed: new Map(),
    planVersion: 1,
    planDigest: p.planDigest,
    tasks: new Map(tasks.map((task) => [task.taskId, queuedTask(task)])),
    candidates: new Map(),
    artifacts: new Map(),
    memory: new EvidenceMemory(),
    decisions: [],
    predictions: new Map(tasks.flatMap((task) => task.prediction === undefined ? [] : [[task.taskId, task.prediction] as const])),
    reconciles: new Map(),
    worldModel: new Map(),
    trustedEvaluators: normalizeTrustedEvaluators(p.trustedEvaluators),
    blueprint: emptyBlueprint(),
    operations: new Map(typeof p.operationId === "string" ? [[p.operationId, { type: "MISSION_CREATED" as const, payload: p }]] : []),
  };
  refreshStatuses(state);
  return state;
}

function predictionFor(task: MutableTaskState): PredictionArtifact | undefined {
  return task.prediction ?? task.task.prediction;
}

function normalizeTrustedEvaluators(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  if (!Array.isArray(value)) throw new TypeError("trusted evaluators must be an array");
  for (const entry of value) {
    if (!isPlainRecord(entry)) throw new TypeError("trusted evaluator must be an ordinary object");
    nonEmpty("trusted evaluator id", entry.evaluatorId);
    if (typeof entry.publicKey !== "string" || !validEvaluationPublicKey(entry.publicKey)) {
      throw new Error(`trusted evaluator public key is invalid: ${String(entry.evaluatorId)}`);
    }
    if (result.has(entry.evaluatorId)) throw new RangeError(`duplicate trusted evaluator: ${String(entry.evaluatorId)}`);
    result.set(entry.evaluatorId, entry.publicKey);
  }
  return result;
}

function queuedTask(task: ResearchTask): MutableTaskState {
  return { task, status: "QUEUED", evidenceRefs: [], candidateRefs: [], artifactRefs: [], ...(task.prediction === undefined ? {} : { prediction: task.prediction }) };
}

function defaultFailureReconcile(taskId: string, evidenceRefs: readonly string[], artifactRefs: readonly string[]): TaskReconcileInput {
  return {
    reconcileId: `${taskId}:reconcile`, status: "inconclusive", observationRefs: evidenceRefs, artifactRefs,
    evidenceRefs, evaluatorId: "research-loop-failure", independentEvaluator: false, evidenceGatePassed: false,
  };
}

/**
 * Content-addressed evaluator proof carried on evidence metadata. WORLD_MODEL admission never trusts a
 * boolean assertion: the proof digest is recomputed and must carry a signature from an evaluator
 * registered in the mission trust root; the evaluator identity is cross-checked with the reconcile and
 * the evaluated snapshot digest must match a digest already registered in the mission artifact registry.
 */
interface EvaluationEvidenceProof {
  readonly evaluatorId: string;
  readonly snapshotDigest: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

function evaluationProof(value: unknown): EvaluationEvidenceProof | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (typeof value.evaluatorId !== "string" || value.evaluatorId.trim() === "" || typeof value.snapshotDigest !== "string" || value.snapshotDigest.trim() === "") return undefined;
  if (!isPlainRecord(value.facts) || Object.values(value.facts).some((fact) => typeof fact !== "string" && typeof fact !== "number" && typeof fact !== "boolean")) return undefined;
  return value as unknown as EvaluationEvidenceProof;
}

/**
 * Derives whether a reconcile is actually backed by independent evaluator evidence instead of trusting
 * the caller's own gate flags. Every evidence ref must resolve to a verified record whose metadata
 * carries a digest-verified evaluation proof that is (a) signed with the private key of an evaluator
 * registered in the mission trust root, (b) bound to a snapshot digest already registered in the
 * mission artifact registry, and (c) naming the same evaluator as the reconcile. A raw self-report
 * cannot pass the gate even with a self-consistent digest chain because it never holds the evaluator's
 * private key.
 */
function independentlyEvaluated(memory: EvidenceMemory, reconcile: ReconcileRecord, artifactDigests: ReadonlySet<string>, trustedEvaluators: ReadonlyMap<string, string>, prediction: PredictionArtifact): boolean {
  if (!reconcile.evidenceGatePassed || reconcile.independentEvaluator !== true || !reconcile.evaluatorId || reconcile.evidenceRefs.length === 0) return false;
  return reconcile.evidenceRefs.every((ref) => {
    const evidence = memory.get(ref);
    if (evidence?.verified === false) return false;
    const metadata = evidence?.metadata;
    if (!metadata || typeof metadata.evaluationDigest !== "string" || typeof metadata.signature !== "string") return false;
    const proof = evaluationProof(metadata.evaluation);
    if (!proof || proof.evaluatorId !== reconcile.evaluatorId || !artifactDigests.has(proof.snapshotDigest)) return false;
    const publicKey = trustedEvaluators.get(proof.evaluatorId);
    if (publicKey === undefined) return false;
    try {
      // The signed facts determine the verdict: the reconcile status must match what the proof derives,
      // so a caller holding a valid proof cannot relabel a refutation as a confirmation.
      return digestValue(proof) === metadata.evaluationDigest
        && deriveReconcileStatus(prediction, proof.facts) === reconcile.status
        && verifyEvaluationDigest(metadata.evaluationDigest, metadata.signature, publicKey);
    } catch {
      return false;
    }
  });
}

function requireReconcileRefs(memory: EvidenceMemory, reconcile: ReconcileRecord, artifactIds: ReadonlySet<string>, artifactDigests: ReadonlySet<string>, trustedEvaluators: ReadonlyMap<string, string>, prediction: PredictionArtifact, taskId: string): void {
  for (const ref of reconcile.evidenceRefs) if (!memory.has(ref)) throw new Error(`unknown reconcile evidence reference: ${ref}`);
  for (const ref of [...reconcile.observationRefs, ...reconcile.artifactRefs]) {
    if (!memory.has(ref) && !artifactIds.has(ref)) throw new Error(`unknown reconcile observation or artifact reference: ${ref}`);
  }
  if (reconcile.evidenceGatePassed && !independentlyEvaluated(memory, reconcile, artifactDigests, trustedEvaluators, prediction)) {
    throw new Error(`reconcile claims a passed evidence gate without matching independent evaluator evidence: ${taskId}`);
  }
}

function applyReconcile(state: MutableResearchState, task: MutableTaskState, raw: unknown, taskId: string): void {
  const prediction = task.prediction ?? task.task.prediction;
  if (!prediction) throw new Error(`reconcile requires a prediction: ${taskId}`);
  const input = (raw ?? {}) as Record<string, unknown>;
  const reconcile = normalizeReconcile({ ...input, reconcileId: input.reconcileId ?? `${taskId}:reconcile`, taskId, predictionId: prediction.predictionId }, prediction);
  requireReconcileRefs(
    state.memory,
    reconcile,
    new Set(state.artifacts.keys()),
    new Set([...state.artifacts.values()].map((artifact) => artifact.digest)),
    state.trustedEvaluators,
    prediction,
    taskId,
  );
  const existing = state.reconciles.get(taskId);
  if (existing && !same(existing, reconcile)) throw new Error(`reconcile id already contains different data: ${taskId}`);
  task.prediction = prediction;
  task.reconcile = existing ?? reconcile;
  state.predictions.set(taskId, prediction);
  state.reconciles.set(taskId, task.reconcile);
  // A refuted hypothesis is reusable #8 Negative Evidence, but only when the refutation passed the same
  // independent-evaluator gate as WORLD_MODEL admission: raw self-report must not be able to steer future
  // planning through the evidence memory either. Ungated refuted reconciles stay queryable in state.reconciles.
  if (task.reconcile.status === "refuted" && independentlyEvaluated(state.memory, task.reconcile, new Set([...state.artifacts.values()].map((artifact) => artifact.digest)), state.trustedEvaluators, prediction)) {
    const refs = [...new Set([...task.reconcile.evidenceRefs, ...task.reconcile.observationRefs])].filter((ref) => state.memory.has(ref));
    if (refs.length > 0) {
      state.memory.addNegativeEvidence({
        id: `${task.reconcile.reconcileId}:negative`,
        statement: prediction.hypothesis,
        category: "hypothesis-refuted",
        evidenceRefs: refs,
        verified: true,
      });
    }
  }
}

function taskReady(state: MutableResearchState, task: MutableTaskState): boolean {
  if (task.status !== "QUEUED" && task.status !== "READY") return false;
  const prediction = task.prediction ?? task.task.prediction;
  if (prediction === undefined) return false;
  const hypothesis = prediction.hypothesis.toLowerCase();
  // Hypothesis equivalence is an exact normalized match; semantic paraphrase matching is out of scope
  // here and belongs to the Claim-card objection layer (#38).
  const refutedByWorldModel = [...state.worldModel.values()].some((claim) => claim.reconcileStatus === "refuted" && claim.hypothesis.toLowerCase() === hypothesis);
  const refutedByNegativeEvidence = state.memory.negativeEvidence().some((negative) => negative.category === "hypothesis-refuted" && negative.statement.toLowerCase() === hypothesis);
  if (refutedByWorldModel || refutedByNegativeEvidence) return false;
  if ((task.task.dependencies ?? []).some((id) => state.tasks.get(id)?.status !== "COMPLETED")) return false;
  return (task.task.requiredEvidence ?? []).every((id) => state.memory.has(id));
}

function refreshStatuses(state: MutableResearchState): void {
  for (let pass = 0; pass <= state.tasks.size; pass += 1) {
    let changed = false;
    for (const task of state.tasks.values()) {
      const before = task.status;
      if (task.status === "QUEUED" || task.status === "READY") task.status = taskReady(state, task) ? "READY" : "QUEUED";
      if (task.status === "QUEUED" && (task.task.dependencies ?? []).some((id) => ["FAILED", "BLOCKED"].includes(state.tasks.get(id)?.status ?? ""))) task.status = "BLOCKED";
      changed ||= task.status !== before;
    }
    if (!changed) break;
  }
}

/** Derives per-idea-type attempt and promotion counts from the candidate registry for bias auditing. */
function ideaTypeStats(state: MutableResearchState): readonly IdeaTypeStats[] {
  const counts = new Map<string, { attempts: number; promoted: number }>();
  for (const candidate of state.candidates.values()) {
    const ideaType = candidate.ideaType ?? "untyped";
    const entry = counts.get(ideaType) ?? { attempts: 0, promoted: 0 };
    entry.attempts += 1;
    if (candidate.promoted === true) entry.promoted += 1;
    counts.set(ideaType, entry);
  }
  return frozenArray([...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ideaType, entry]) => ({
      ideaType,
      attempts: entry.attempts,
      promoted: entry.promoted,
      promotionRate: entry.attempts === 0 ? 0 : entry.promoted / entry.attempts,
    })));
}

/**
 * A verifier threshold only counts evaluation evidence whose proof digest recomputes, whose
 * snapshot digest belongs to the mission artifact registry, and whose signature verifies against
 * an evaluator registered in the mission trust root: raw self-reports, unregistered snapshots, or
 * forged signatures cannot complete a milestone.
 */
function verifierThresholdMet(memory: EvidenceMemory, trustedEvaluators: ReadonlyMap<string, string>, artifactDigests: ReadonlySet<string>, threshold: { readonly fact: string; readonly minimum: number }): boolean {
  for (const record of memory.records()) {
    const metadata = record.metadata;
    if (!metadata || typeof metadata.evaluationDigest !== "string" || typeof metadata.signature !== "string") continue;
    const proof = evaluationProof(metadata.evaluation);
    if (!proof) continue;
    const fact = proof.facts[threshold.fact];
    if (typeof fact !== "number" || fact < threshold.minimum || !artifactDigests.has(proof.snapshotDigest)) continue;
    const publicKey = trustedEvaluators.get(proof.evaluatorId);
    if (publicKey === undefined) continue;
    try {
      if (digestValue(proof) === metadata.evaluationDigest && verifyEvaluationDigest(metadata.evaluationDigest, metadata.signature, publicKey)) return true;
    } catch {
      // Malformed proof cannot satisfy a verifier threshold.
    }
  }
  return false;
}

/** Derives one milestone's completion from the mission memory, WORLD_MODEL, and verifier evidence. */
function milestoneState(state: MutableResearchState, milestone: CampaignMilestone): CampaignMilestoneState {
  const condition = milestone.condition;
  const via: ("evidence" | "world-model" | "verifier")[] = [];
  const evidenceRefs = condition.evidenceRefs ?? [];
  const worldModelClaimIds = condition.worldModelClaimIds ?? [];
  const evidenceMet = evidenceRefs.length === 0 || evidenceRefs.every((ref) => state.memory.has(ref));
  if (evidenceMet && evidenceRefs.length > 0) via.push("evidence");
  const worldModelMet = worldModelClaimIds.length === 0 || worldModelClaimIds.every((id) => state.worldModel.has(id));
  if (worldModelMet && worldModelClaimIds.length > 0) via.push("world-model");
  const verifierMet = condition.verifierThreshold === undefined
    || verifierThresholdMet(state.memory, state.trustedEvaluators, new Set([...state.artifacts.values()].map((artifact) => artifact.digest)), condition.verifierThreshold);
  if (verifierMet && condition.verifierThreshold !== undefined) via.push("verifier");
  return {
    milestoneId: milestone.milestoneId,
    description: milestone.description,
    condition: milestone.condition,
    completed: evidenceMet && worldModelMet && verifierMet,
    completedVia: Object.freeze(via),
  };
}

/** Derived campaign view: envelope accounting plus milestone and stop-condition status. */
function campaignState(state: MutableResearchState, campaign: Campaign): CampaignState {
  const consumed = state.campaignConsumed.get(campaign.campaignId) ?? 0;
  const milestones = campaign.milestones.map((milestone) => milestoneState(state, milestone));
  const stop = campaign.stopConditions ?? [];
  return {
    campaignId: campaign.campaignId,
    goal: campaign.goal,
    ideaTypes: Object.freeze([...(campaign.ideaTypes ?? [])]),
    budget: { total: campaign.budget, consumed, remaining: campaign.budget - consumed },
    milestones,
    stopConditionsMet: stop.length > 0 && stop.every((id) => milestones.some((milestone) => milestone.milestoneId === id && milestone.completed)),
    exhausted: campaign.budget - consumed <= 0,
  };
}

/** Whether a task's campaign envelope still covers its estimated cost. */
function campaignAllows(state: MutableResearchState, task: MutableTaskState): boolean {
  const campaignId = task.task.campaignId;
  if (campaignId === undefined) return true;
  const campaign = state.campaigns.get(campaignId);
  return campaign !== undefined && (state.campaignConsumed.get(campaignId) ?? 0) + (task.task.estimatedCost ?? 1) <= campaign.budget;
}

/** Shared PLAN_REVISED guards: active tasks must survive unchanged and spent campaign envelopes must not shrink. */
function assertActiveTasksPreserved(state: MutableResearchState, preserved: readonly MutableTaskState[], tasks: readonly ResearchTask[], errorPrefix: string): void {
  if (preserved.some((task) => !tasks.some((candidate) => candidate.taskId === task.task.taskId))) throw new Error(`${errorPrefix} drops an active task`);
  for (const task of preserved) {
    const replacement = tasks.find((candidate) => candidate.taskId === task.task.taskId);
    if (!replacement || !same(replacement, task.task)) throw new Error(`${errorPrefix} rewrites active task ${task.task.taskId}`);
  }
}

function assertCampaignEnvelopesPreserved(state: MutableResearchState, campaigns: ReadonlyMap<string, Campaign>, errorPrefix: string): void {
  for (const [campaignId, consumed] of state.campaignConsumed) {
    if (consumed <= 0) continue;
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.budget < consumed) throw new Error(`${errorPrefix} drops or shrinks a campaign with consumed budget: ${campaignId}`);
  }
}

/** Idea type of the most recently selected task, when one exists. */
function lastSelectedIdeaType(events: readonly ResearchEvent[], tasks: Readonly<Record<string, ResearchTaskState>>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "TASK_SELECTED") continue;
    const taskId = event.payload.taskId;
    if (typeof taskId === "string") return tasks[taskId]?.ideaType;
  }
  return undefined;
}

/**
 * Applies the idea type preference to the eligible ready tasks. An explicit ordered preference
 * list (a user instruction) wins; otherwise the default soft preference rotates away from the
 * most recently selected idea type so a systems-heavy backlog cannot starve algorithmic /
 * open-search tasks out of the ready set. This is a soft tie-break over priority order only:
 * it never changes which tasks are ready and never touches evaluation or promotion gates.
 */
function preferByIdeaType(
  eligible: readonly ResearchTaskState[],
  explicit: readonly string[] | undefined,
  lastType: string | undefined,
): ResearchTaskState | undefined {
  if (eligible.length === 0) return undefined;
  if (explicit !== undefined && explicit.length > 0) {
    return eligible.find((task) => task.ideaType !== undefined && explicit.includes(task.ideaType!)) ?? eligible[0];
  }
  if (lastType === undefined) return eligible[0];
  return eligible.find((task) => task.ideaType !== undefined && task.ideaType !== lastType) ?? eligible[0];
}

/**
 * When the most recent Scale decision names campaigns, prefer ready tasks inside those campaigns
 * (which by readiness still have envelope margin) over deepening micro search. Soft selection
 * preference only: it never changes readiness, evaluation, or promotion gates.
 */
function preferScaledCampaign(eligible: readonly ResearchTaskState[], decisions: readonly ResearchDecision[]): ResearchTaskState | undefined {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (decision.action !== "Scale" || (decision.campaignIds ?? []).length === 0) continue;
    const pick = eligible.find((task) => task.campaignId !== undefined && decision.campaignIds!.includes(task.campaignId));
    if (pick !== undefined) return pick;
  }
  return undefined;
}

function priorityScore(state: MutableResearchState, task: MutableTaskState): number {
  let score = task.task.priority ?? 0;
  score += task.task.uncertainty ?? 0;
  for (const finding of state.memory.findings()) {
    if (finding.relatedTaskIds?.includes(task.task.taskId)) score += finding.priorityDelta ?? 0;
  }
  for (const negative of state.memory.negativeEvidence()) {
    if (negative.relatedTaskIds?.includes(task.task.taskId)) score += negative.priorityDelta ?? 0;
  }
  return score;
}

function taskState(state: MutableResearchState, task: MutableTaskState): ResearchTaskState {
  return deepFreeze({
    ...taskPlan(task.task),
    status: task.status,
    evidenceRefs: [...task.evidenceRefs],
    candidateRefs: clone(task.candidateRefs),
    artifactRefs: clone(task.artifactRefs),
    priorityScore: priorityScore(state, task),
    ...(task.prediction === undefined ? {} : { prediction: clone(task.prediction) }),
    ...(task.reconcile === undefined ? {} : { reconcile: clone(task.reconcile) }),
    ...(task.reconcile?.claim === undefined ? {} : { claimCard: clone(task.reconcile.claim) }),
    ...(task.reconcile?.objections === undefined ? {} : { objections: clone(task.reconcile.objections) }),
    ...(task.failureReason === undefined ? {} : { failureReason: task.failureReason }),
  }) as ResearchTaskState;
}

function publicState(state: MutableResearchState): ResearchMissionState {
  refreshStatuses(state);
  const macroSpend = [...state.campaignConsumed.values()].reduce((sum, value) => sum + value, 0);
  return deepFreeze({
    missionId: state.missionId,
    phase: state.phase,
    objective: state.objective,
    ...(state.scope === undefined ? {} : { scope: state.scope }),
    budget: { total: state.budgetTotal, consumed: state.budgetConsumed, remaining: state.budgetTotal - state.budgetConsumed },
    planVersion: state.planVersion,
    planDigest: state.planDigest,
    tasks: Object.fromEntries([...state.tasks].map(([id, task]) => [id, taskState(state, task)])),
    candidates: frozenArray([...state.candidates.values()]),
    artifacts: frozenArray([...state.artifacts.values()]),
    ideaTypeStats: ideaTypeStats(state),
    predictions: frozenArray([...state.predictions.values()]),
    reconciles: frozenArray([...state.reconciles.values()]),
    worldModel: frozenArray([...state.worldModel.values()]),
    evidence: state.memory.records(),
    findings: state.memory.findings(),
    negativeEvidence: state.memory.negativeEvidence(),
    pitfalls: state.memory.pitfalls(),
    decisions: frozenArray(state.decisions),
    trustedEvaluators: frozenArray([...state.trustedEvaluators].map(([evaluatorId, publicKey]) => ({ evaluatorId, publicKey }))),
    campaigns: frozenArray([...state.campaigns.values()].map((campaign) => campaignState(state, campaign))),
    spend: { micro: state.budgetConsumed - macroSpend, macro: macroSpend },
    ...(state.suggestedAction === undefined ? {} : { suggestedAction: state.suggestedAction }),
    ...(state.suggestedStopReason === undefined ? {} : { suggestedStopReason: state.suggestedStopReason }),
    ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    blueprint: state.blueprint,
  }) as ResearchMissionState;
}

function knownOperation(state: MutableResearchState, event: ResearchEvent): boolean {
  const operationId = event.payload.operationId;
  if (typeof operationId !== "string" || operationId.trim() === "") throw new Error("research event operationId is required");
  const existing = state.operations.get(operationId);
  if (existing) {
    if (existing.type !== event.type || !same(existing.payload, event.payload)) {
      throw new Error(`operationId already contains a different research operation: ${operationId}`);
    }
    return true;
  }
  state.operations.set(operationId, { type: event.type, payload: event.payload });
  return false;
}

function absorbFinding(state: MutableResearchState, value: Finding): void {
  const finding = normalizeFinding(value);
  if (!state.memory.addFinding(finding)) return;
  if (finding.recommendedAction !== undefined) state.suggestedAction = finding.recommendedAction;
  if (finding.stopReason !== undefined || finding.recommendedAction === "Stop") {
    state.suggestedStopReason = finding.stopReason ?? finding.statement;
  }
}

function requireRefs(state: MutableResearchState, refs: readonly string[]): void {
  for (const ref of refs) if (!state.memory.has(ref)) throw new Error(`unknown evidence reference: ${ref}`);
}

function isBlueprintReadableEvidence(state: MutableResearchState, ref: string): boolean {
  if (!state.memory.has(ref)) return false;
  if (isBlueprintArtifactId(ref)) return true;
  return state.blueprint.crossReviews.some((review) => review.reviewId === ref || `cross-review:${review.reviewId}` === ref);
}

function replaceBlueprintArtifact(state: MutableResearchState, ref: { readonly artifactId: string; readonly digest: string; readonly address?: string }): void {
  const artifact = toBlueprintArtifact(ref);
  const existing = state.artifacts.get(artifact.artifactId);
  if (existing && existing.digest !== artifact.digest) state.artifacts.delete(artifact.artifactId);
  mergeArtifactRefs(state, normalizeArtifacts([artifact]));
}

function requireScoreboardEvaluatorCitations(state: MutableResearchState, file: BlueprintFile): void {
  if (file.kind !== "SCOREBOARD") return;
  for (const row of file.rows) {
    const evidence = state.memory.get(row.evaluationRef);
    if (!evidence || !isEvaluatorObservation(evidence.metadata)) {
      throw new Error(`SCOREBOARD evaluationRef must cite an independent evaluator observation: ${row.evaluationRef}`);
    }
  }
}

function requireCrossReviewPhase(state: MutableResearchState, review: CrossReviewRecord): void {
  if (review.phase === "author") {
    const committed = new Set(Object.values(state.blueprint.files).flatMap((file) => file === undefined ? [] : [file.artifactId]));
    if (!review.subjectRefs.every((ref) => committed.has(ref))) {
      throw new Error("author Cross-review must cite committed File Blueprint artifacts");
    }
    return;
  }
  const authors = state.blueprint.crossReviews.filter((entry) => entry.phase === "author");
  if (!review.subjectRefs.some((ref) => authors.some((author) => author.artifactId === ref))) {
    throw new Error("reviewer Cross-review requires an author Cross-review subject");
  }
}

function requireTaskEvidence(state: MutableResearchState, task: MutableTaskState, refs: readonly string[]): void {
  const available = new Set<string>();
  for (const direct of task.evidenceRefs) {
    if (!state.memory.has(direct)) continue;
    for (const record of state.memory.chain(direct)) available.add(record.id);
  }
  for (const ref of refs) {
    if (available.has(ref) || isBlueprintReadableEvidence(state, ref)) continue;
    throw new Error(`evidence is not part of task ${task.task.taskId}: ${ref}`);
  }
}

function applyBlueprintCommit(state: MutableResearchState, payload: Record<string, unknown>): void {
  const file = normalizeBlueprintFile(payload.file);
  const ref = normalizeBlueprintFileRef(payload.ref);
  if (ref.kind !== file.kind) throw new Error("BLUEPRINT_COMMITTED kind does not match its file");
  if (ref.digest !== blueprintFileDigest(file)) throw new Error(`blueprint ${file.kind} digest does not match its contents`);
  if (file.kind === "GOAL" && file.objective !== state.objective) {
    throw new Error("GOAL objective must match the mission research objective");
  }
  requireRefs(state, ref.evidenceRefs);
  requireScoreboardEvaluatorCitations(state, file);
  replaceBlueprintArtifact(state, ref);
  const evidence = payload.evidence === undefined ? undefined : normalizeEvidence(payload.evidence as EvidenceRecord);
  if (evidence) state.memory.addEvidence(evidence);
  state.blueprint = deepFreeze({
    files: { ...state.blueprint.files, [file.kind]: ref },
    crossReviews: state.blueprint.crossReviews,
  }) as MissionBlueprint;
  assertBlueprintRefsConsistent(state.blueprint, {
    hasEvidence: (id) => state.memory.has(id),
    artifactDigest: (artifactId) => state.artifacts.get(artifactId)?.digest,
  });
}

function applyCrossReview(state: MutableResearchState, payload: Record<string, unknown>): void {
  const review = normalizeCrossReview(payload.review);
  const bodyDigest = digestValue({
    reviewId: review.reviewId,
    phase: review.phase,
    subjectRefs: review.subjectRefs,
    findings: review.findings,
    evidenceRefs: review.evidenceRefs,
  });
  if (review.digest !== bodyDigest) throw new Error(`cross-review ${review.reviewId} digest does not match its contents`);
  requireRefs(state, review.evidenceRefs);
  requireCrossReviewPhase(state, review);
  const existing = state.blueprint.crossReviews.find((entry) => entry.reviewId === review.reviewId);
  if (existing && !same(existing, review)) throw new Error(`cross-review id already contains different data: ${review.reviewId}`);
  replaceBlueprintArtifact(state, review);
  const evidence = payload.evidence === undefined ? undefined : normalizeEvidence(payload.evidence as EvidenceRecord);
  if (evidence) state.memory.addEvidence(evidence);
  if (!existing) {
    state.blueprint = deepFreeze({
      files: state.blueprint.files,
      crossReviews: [...state.blueprint.crossReviews, review],
    }) as MissionBlueprint;
  }
  assertBlueprintRefsConsistent(state.blueprint, {
    hasEvidence: (id) => state.memory.has(id),
    artifactDigest: (artifactId) => state.artifacts.get(artifactId)?.digest,
  });
}


function mergeCandidateRefs(state: MutableResearchState, refs: readonly ResearchCandidateRef[]): void {
  for (const ref of refs) {
    const existing = state.candidates.get(ref.candidateId);
    if (existing && existing.digest !== ref.digest) throw new Error(`candidate id already contains a different digest: ${ref.candidateId}`);
    if (!existing) state.candidates.set(ref.candidateId, ref);
  }
}

function mergeArtifactRefs(state: MutableResearchState, refs: readonly ResearchArtifactRef[]): void {
  for (const ref of refs) {
    const existing = state.artifacts.get(ref.artifactId);
    if (existing && existing.digest !== ref.digest) throw new Error(`artifact id already contains a different digest: ${ref.artifactId}`);
    if (!existing) state.artifacts.set(ref.artifactId, ref);
  }
}

function applyCompletion(state: MutableResearchState, taskId: string, payload: Record<string, unknown>, event: ResearchEvent): void {
  const task = state.tasks.get(taskId);
  if (!task || task.status !== "RUNNING") throw new Error(`task is not running: ${taskId}`);
  const evidence = Array.isArray(payload.evidence) ? payload.evidence as EvidenceRecord[] : [];
  const findings = Array.isArray(payload.findings) ? payload.findings as Finding[] : [];
  const negatives = Array.isArray(payload.negativeEvidence) ? payload.negativeEvidence as NegativeEvidence[] : [];
  const pitfalls = Array.isArray(payload.pitfalls) ? payload.pitfalls as Pitfall[] : [];
  const candidates = normalizeCandidates(payload.candidates as ResearchCandidateRef[] | undefined);
  const artifacts = normalizeArtifacts(payload.artifacts as ResearchArtifactRef[] | undefined);
  for (const record of evidence) state.memory.addEvidence(normalizeEvidence(record, taskId));
  for (const finding of findings) absorbFinding(state, finding);
  for (const negative of negatives) state.memory.addNegativeEvidence(negative);
  for (const pitfall of pitfalls) state.memory.addPitfall(pitfall);
  requireRefs(state, [...(payload.evidenceRefs as string[] ?? []), ...findings.flatMap((finding) => finding.evidenceRefs), ...negatives.flatMap((negative) => negative.evidenceRefs), ...pitfalls.flatMap((pitfall) => pitfall.evidenceRefs)]);
  mergeCandidateRefs(state, candidates);
  mergeArtifactRefs(state, artifacts);
  task.status = "COMPLETED";
  task.evidenceRefs = [...new Set(evidence.filter((record) => record.verified !== false).map((record) => record.id)
    .concat(findings.filter((finding) => finding.verified).map((finding) => finding.id))
    .concat(negatives.filter((negative) => negative.verified !== false).map((negative) => negative.id))
    .concat(pitfalls.filter((pitfall) => pitfall.verified !== false).map((pitfall) => pitfall.id)))];
  task.candidateRefs = candidates;
  task.artifactRefs = artifacts;
  if (payload.reconcile === undefined) throw new Error(`task completion requires reconciliation: ${taskId}`);
  if (payload.reconcile !== undefined) applyReconcile(state, task, payload.reconcile, taskId);
}

function applyEvent(state: MutableResearchState, event: ResearchEvent): void {
  const p = event.payload;
  if (!isPlainRecord(p)) return;
  if (p.missionId !== undefined && p.missionId !== state.missionId) throw new Error("research event belongs to another mission");
  if (state.phase === "STOPPED" && event.type !== "MISSION_STOPPED") return;
  if (event.type !== "MISSION_CREATED" && knownOperation(state, event)) return;
  switch (event.type) {
    case "PREDICTION_RECORDED": {
      const task = typeof p.taskId === "string" ? state.tasks.get(p.taskId) : undefined;
      if (!task || task.status !== "QUEUED" && task.status !== "READY") throw new Error("PREDICTION_RECORDED references a task that is not queued");
      const prediction = normalizePrediction(p.prediction, `${task.task.taskId}:prediction`);
      const existing = state.predictions.get(task.task.taskId);
      if (existing && !same(existing, prediction)) throw new Error(`PREDICTION_RECORDED conflicts with the recorded prediction: ${task.task.taskId}`);
      task.prediction = prediction;
      state.predictions.set(task.task.taskId, prediction);
      break;
    }
    case "TASK_SELECTED": {
      const task = typeof p.taskId === "string" ? state.tasks.get(p.taskId) : undefined;
      if (!task) throw new Error("TASK_SELECTED references an unknown task");
      if (!taskReady(state, task)) throw new Error(`TASK_SELECTED references a task that is not ready: ${task.task.taskId}`);
      const cost = task.task.estimatedCost ?? 1;
      if (state.budgetConsumed + cost > state.budgetTotal) throw new Error(`TASK_SELECTED exceeds the mission budget: ${task.task.taskId}`);
      if (task.task.campaignId !== undefined) {
        const campaign = state.campaigns.get(task.task.campaignId)!; // task declaration validated the campaign
        const consumed = state.campaignConsumed.get(task.task.campaignId) ?? 0;
        if (consumed + cost > campaign.budget) throw new Error(`TASK_SELECTED exceeds the campaign budget envelope: ${task.task.taskId}`);
        state.campaignConsumed.set(task.task.campaignId, consumed + cost);
      }
      task.status = "RUNNING";
      state.budgetConsumed += cost;
      break;
    }
    case "RECONCILED": {
      const task = typeof p.taskId === "string" ? state.tasks.get(p.taskId) : undefined;
      if (!task || (task.status !== "COMPLETED" && task.status !== "FAILED")) throw new Error("RECONCILED references a task that is not complete");
      applyReconcile(state, task, p.reconcile, p.taskId as string);
      break;
    }
    case "WORLD_MODEL_UPDATED": {
      const task = typeof p.taskId === "string" ? state.tasks.get(p.taskId) : undefined;
      const reconcile = task && state.reconciles.get(task.task.taskId);
      const prediction = task && (task.prediction ?? task.task.prediction);
      if (!reconcile || !prediction) throw new Error("WORLD_MODEL_UPDATED has no reconciled prediction");
      if (!independentlyEvaluated(state.memory, reconcile, new Set([...state.artifacts.values()].map((artifact) => artifact.digest)), state.trustedEvaluators, prediction)) {
        throw new Error("WORLD_MODEL_UPDATED lacks independent evaluator evidence");
      }
      requireRefs(state, reconcile.evidenceRefs);
      for (const ref of [...reconcile.observationRefs, ...reconcile.artifactRefs]) {
        if (!state.memory.has(ref) && !state.artifacts.has(ref)) throw new Error(`WORLD_MODEL_UPDATED references an unknown observation or artifact: ${ref}`);
      }
      const claim = normalizeClaimCard(p.claim, prediction);
      if (claim.reconcileStatus !== reconcile.status || !claim.evidenceGatePassed || !same(claim, reconcile.claim)) {
        throw new Error("WORLD_MODEL_UPDATED claim does not match its reconcile");
      }
      const existing = state.worldModel.get(claim.claimId);
      if (existing && !same(existing, claim)) throw new Error(`world model claim id already contains different data: ${claim.claimId}`);
      state.worldModel.set(claim.claimId, existing ?? claim);
      break;
    }
    case "TASK_COMPLETED":
      if (typeof p.taskId === "string") applyCompletion(state, p.taskId, p, event);
      break;
    case "TASK_FAILED": {
      const task = typeof p.taskId === "string" ? state.tasks.get(p.taskId) : undefined;
      if (!task || task.status !== "RUNNING") return;
      task.status = "FAILED";
      task.failureReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "task failed";
      const evidence = Array.isArray(p.evidence) ? p.evidence as EvidenceRecord[] : [];
      for (const record of evidence) state.memory.addEvidence(normalizeEvidence(record, task.task.taskId));
      const negatives = Array.isArray(p.negativeEvidence) ? p.negativeEvidence as NegativeEvidence[] : [];
      for (const negative of negatives) state.memory.addNegativeEvidence(negative);
      task.evidenceRefs = [...new Set(evidence.filter((record) => record.verified !== false).map((record) => record.id)
        .concat(negatives.filter((negative) => negative.verified !== false).map((negative) => negative.id)))];
      if (p.reconcile === undefined) throw new Error(`task failure requires reconciliation: ${task.task.taskId}`);
      if (p.reconcile !== undefined) applyReconcile(state, task, p.reconcile, task.task.taskId);
      break;
    }
    case "TASKS_GENERATED": {
      const source = typeof p.sourceTaskId === "string" ? state.tasks.get(p.sourceTaskId) : undefined;
      const evidenceRefs = Array.isArray(p.evidenceRefs) ? p.evidenceRefs as string[] : [];
      if (!source || source.status !== "COMPLETED") throw new Error("TASKS_GENERATED requires a completed source task");
      if (evidenceRefs.length === 0) throw new Error("TASKS_GENERATED requires evidence references");
      requireRefs(state, evidenceRefs);
      requireTaskEvidence(state, source, evidenceRefs);
      const tasks = validateTaskGraph(Array.isArray(p.tasks) ? p.tasks as ResearchTask[] : [], new Set(state.tasks.keys()), state.campaigns);
      if (typeof p.planVersion !== "number" || p.planVersion !== state.planVersion + 1 || typeof p.planDigest !== "string") {
        throw new Error("TASKS_GENERATED plan version or digest is invalid");
      }
      const allTasks = [...state.tasks.values()].map((value) => value.task).concat(tasks);
      if (p.planDigest !== planDigest(state.objective, state.budgetTotal, allTasks, state.scope, [...state.campaigns.values()])) {
        throw new Error("TASKS_GENERATED plan digest does not match its contents");
      }
      for (const task of tasks) {
        if (state.tasks.has(task.taskId)) throw new Error(`research task already exists: ${task.taskId}`);
        state.tasks.set(task.taskId, queuedTask(task));
      }
      state.planVersion = p.planVersion;
      state.planDigest = p.planDigest;
      break;
    }
    case "FINDING_RECORDED": {
      const finding = normalizeFinding(p.finding as Finding);
      requireRefs(state, finding.evidenceRefs);
      if (finding.verified) absorbFinding(state, finding);
      break;
    }
    case "FINDING_REJECTED":
      break;
    case "NEGATIVE_EVIDENCE_RECORDED": {
      const negative = normalizeNegative(p.negativeEvidence as NegativeEvidence);
      state.memory.addNegativeEvidence(negative);
      break;
    }
    case "PITFALL_RECORDED": {
      const pitfall = normalizePitfall(p.pitfall as Pitfall);
      state.memory.addPitfall(pitfall);
      break;
    }
    case "DECISION_RECORDED": {
      const decision = normalizeDecision(p.decision);
      requireRefs(state, decision.evidenceRefs);
      if (state.decisions.some((entry) => entry.decisionId === decision.decisionId)) return;
      state.decisions.push(decision);
      state.suggestedAction = decision.action;
      if (decision.action === "Stop") state.suggestedStopReason = decision.stopReason ?? decision.reason;
      break;
    }
    case "BLUEPRINT_COMMITTED":
      applyBlueprintCommit(state, p);
      break;
    case "CROSS_REVIEW_RECORDED":
      applyCrossReview(state, p);
      break;
    case "PLAN_REVISED": {
      if (p.objective !== state.objective || typeof p.totalBudget !== "number" || !Number.isFinite(p.totalBudget)
        || p.totalBudget < state.budgetConsumed || p.totalBudget > state.budgetTotal
        || typeof p.reason !== "string" || p.reason.trim() === "") {
        throw new Error("PLAN_REVISED budget, objective, or reason is invalid");
      }
      const evidenceRefs = Array.isArray(p.evidenceRefs) ? p.evidenceRefs as string[] : [];
      requireRefs(state, evidenceRefs);
      if (typeof p.parentPlanDigest !== "string" || p.parentPlanDigest !== state.planDigest
        || typeof p.planVersion !== "number" || p.planVersion !== state.planVersion + 1
        || typeof p.planDigest !== "string") {
        throw new Error("PLAN_REVISED plan version or digest is invalid");
      }
      const campaigns = p.campaigns === undefined ? state.campaigns : normalizeCampaigns(p.campaigns);
      const preserved = [...state.tasks.values()].filter((task) => task.status === "COMPLETED" || task.status === "RUNNING");
      const tasks = validateTaskGraph(Array.isArray(p.tasks) ? p.tasks as ResearchTask[] : [], new Set(preserved.map((task) => task.task.taskId)), campaigns);
      if (p.planDigest !== planDigest(state.objective, p.totalBudget, tasks, state.scope, [...campaigns.values()])) {
        throw new Error("PLAN_REVISED plan digest does not match its contents");
      }
      assertActiveTasksPreserved(state, preserved, tasks, "PLAN_REVISED");
      assertCampaignEnvelopesPreserved(state, campaigns, "PLAN_REVISED");
      state.tasks = new Map(tasks.map((task) => {
        const old = state.tasks.get(task.taskId);
        if (old && (old.status === "COMPLETED" || old.status === "RUNNING")) return [task.taskId, old];
        return [task.taskId, queuedTask(task)];
      }));
      state.campaigns = campaigns;
      state.planVersion = p.planVersion;
      state.planDigest = p.planDigest;
      state.budgetTotal = p.totalBudget;
      break;
    }
    case "MISSION_STOPPED":
      if (typeof p.reason !== "string" || p.reason.trim() === "" || typeof p.decisionId !== "string") {
        throw new Error("MISSION_STOPPED reason or decision id is invalid");
      }
      const stopDecision = state.decisions.find((decision) => decision.decisionId === p.decisionId && decision.action === "Stop");
      if (!stopDecision || p.reason !== (stopDecision.stopReason ?? stopDecision.reason)
        || !Array.isArray(p.evidenceRefs) || !same(p.evidenceRefs, stopDecision.evidenceRefs)) {
        throw new Error("MISSION_STOPPED does not match a recorded Stop decision");
      }
      state.phase = "STOPPED";
      state.stopReason = p.reason;
      break;
    case "MISSION_CREATED":
      throw new Error("MISSION_CREATED must be the first research event");
  }
  refreshStatuses(state);
}

function project(events: readonly ResearchEvent[]): MutableResearchState {
  const first = events[0];
  if (!first || first.type !== "MISSION_CREATED" || first.sequence !== 1 || typeof first.eventId !== "string" || first.eventId.trim() === "") {
    throw new Error("research ledger must start with MISSION_CREATED at sequence 1");
  }
  const state = initialMutable(first);
  const seenEventIds = new Set([first.eventId]);
  let expected = 2;
  for (const event of events.slice(1)) {
    if (!event || event.sequence !== expected) throw new Error(`research ledger sequence gap at ${expected}`);
    if (typeof event.eventId !== "string" || event.eventId.trim() === "") throw new Error(`research ledger event ${expected} has no eventId`);
    if (seenEventIds.has(event.eventId)) throw new Error(`research ledger repeats eventId: ${event.eventId}`);
    if (typeof event.type !== "string" || !RESEARCH_EVENT_TYPES.has(event.type)) throw new Error(`unknown research event type: ${String(event.type)}`);
    if (!isPlainRecord(event.payload)) throw new Error(`research event ${expected} has an invalid payload`);
    seenEventIds.add(event.eventId);
    expected += 1;
    applyEvent(state, event);
  }
  return state;
}

export class InMemoryResearchLedger implements ResearchLedger {
  private readonly entries: ResearchEvent[] = [];

  append(event: Omit<ResearchEvent, "sequence" | "eventId"> & { readonly sequence?: number; readonly eventId?: string }): ResearchEvent {
    const sequence = event.sequence ?? this.entries.length + 1;
    if (sequence !== this.entries.length + 1) throw new Error("research event sequence must be monotonic");
    const eventId = event.eventId ?? `research-event-${sequence}`;
    nonEmpty("eventId", eventId);
    if (this.entries.some((entry) => entry.eventId === eventId)) throw new Error(`duplicate research eventId: ${eventId}`);
    const payload = deepFreeze(clone(event.payload));
    const entry = deepFreeze({ sequence, eventId, type: event.type, payload }) as ResearchEvent;
    this.entries.push(entry);
    return entry;
  }

  events(): readonly ResearchEvent[] { return frozenArray(this.entries); }
}

export class MissionDirector {
  readonly ledger: ResearchLedger;
  private readonly missionId: string;
  private readonly clock: () => number;
  private readonly ideaTypePreference: readonly string[] | undefined;
  private readonly baselineTrack?: Readonly<BaselineTrackContract>;
  private nextOperation = 1;

  constructor(options: MissionDirectorOptions, ledger: ResearchLedger = new InMemoryResearchLedger()) {
    nonEmpty("missionId", options.missionId);
    nonEmpty("mission objective", options.objective);
    const totalBudget = budgetTotal(options.budget);
    const scope = normalizeScope(options.scope);
    const declaredCampaigns = normalizeCampaigns(options.campaigns);
    this.missionId = options.missionId;
    this.clock = options.clock ?? (() => Date.now());
    this.ledger = ledger;
    this.ideaTypePreference = options.ideaTypePreference === undefined ? undefined : Object.freeze([...options.ideaTypePreference].map(requireIdeaType));
    // T43 baseline-first: resolve the declared baseline track; inactive when absent.
    this.baselineTrack = isBaselineTrackContract(options.baselineTrack)
      ? options.baselineTrack
      : resolveBaselineTrack(options.baselineTrack === undefined ? undefined : { baseline_track: options.baselineTrack });
    const trustedEvaluators = normalizeTrustedEvaluators(options.trustedEvaluators);
    if (ledger.events().length === 0) {
      const tasks = validateTaskGraph(options.tasks ?? [], new Set(), declaredCampaigns);
      if (tasks.length === 0) throw new RangeError("research mission requires at least one task");
      this.append("MISSION_CREATED", {
        missionId: options.missionId,
        objective: options.objective,
        totalBudget,
        tasks,
        ...(scope === undefined ? {} : { scope }),
        ...(declaredCampaigns.size === 0 ? {} : { campaigns: [...declaredCampaigns.values()] }),
        planVersion: 1,
        planDigest: planDigest(options.objective, totalBudget, tasks, scope, [...declaredCampaigns.values()]),
        ...(this.baselineTrack === undefined ? {} : { baselineTrack: clone(this.baselineTrack) }),
        ...(trustedEvaluators.size === 0 ? {} : { trustedEvaluators: [...trustedEvaluators].map(([evaluatorId, publicKey]) => ({ evaluatorId, publicKey })) }),
      }, "mission-created");
    } else {
      const state = project(ledger.events());
      if (state.missionId !== options.missionId) throw new Error("ledger belongs to another mission");
      if (state.objective !== options.objective) throw new Error("ledger belongs to another research objective");
      const initialBudget = ledger.events()[0]?.payload.totalBudget;
      if (typeof initialBudget !== "number" || totalBudget !== initialBudget) throw new Error("ledger belongs to another research budget");
      if (options.scope !== undefined && !same(scope, state.scope)) throw new Error("ledger belongs to another research scope");
      const initialCampaigns = normalizeCampaigns(ledger.events()[0]?.payload.campaigns);
      if (!same([...initialCampaigns.values()], [...declaredCampaigns.values()])) throw new Error("ledger belongs to another campaign declaration");
      const registered = [...state.trustedEvaluators].map(([evaluatorId, publicKey]) => ({ evaluatorId, publicKey }));
      if (!same(options.trustedEvaluators ?? [], registered)) throw new Error("ledger belongs to another evaluator trust root");
      // T43: the baseline-first policy is mission configuration; a resumed ledger must not silently change it.
      const initialBaseline = ledger.events()[0]?.payload.baselineTrack;
      if (!same(initialBaseline ?? undefined, this.baselineTrack ? clone(this.baselineTrack) : undefined)) {
        throw new Error("ledger belongs to another baseline-track policy");
      }
    }
  }

  private operation(prefix: string, supplied?: string): string {
    if (supplied !== undefined) { nonEmpty("operationId", supplied); return supplied; }
    let operation: string;
    do operation = `${prefix}-${this.nextOperation++}`;
    while (this.ledger.events().some((event) => event.payload.operationId === operation));
    return operation;
  }

  private operationEvent(operationId: string | undefined): ResearchEvent | undefined {
    if (operationId === undefined) return undefined;
    nonEmpty("operationId", operationId);
    return this.ledger.events().find((event) => event.payload.operationId === operationId);
  }

  private assertOperation(type: ResearchEventType, payload: Record<string, unknown>, operationId: string): void {
    const existing = this.operationEvent(operationId);
    if (existing && (existing.type !== type || !same(existing.payload, { ...payload, missionId: this.missionId, operationId }))) {
      throw new Error(`operationId already contains a different research operation: ${operationId}`);
    }
  }

  private append(type: ResearchEventType, payload: Record<string, unknown>, operationId: string): boolean {
    const expectedPayload = { ...payload, missionId: this.missionId, operationId };
    const existing = this.operationEvent(operationId);
    if (existing) {
      this.assertOperation(type, payload, operationId);
      return false;
    }
    this.ledger.append({ type, payload: expectedPayload });
    return true;
  }

  static fromEvents(options: MissionDirectorOptions, events: readonly ResearchEvent[]): MissionDirector {
    const ledger = new InMemoryResearchLedger();
    for (const event of events) ledger.append({ sequence: event.sequence, type: event.type, payload: clone(event.payload), eventId: event.eventId });
    return new MissionDirector(options, ledger);
  }

  static replay(events: readonly ResearchEvent[]): ResearchMissionState {
    return publicState(project(events));
  }

  events(): readonly ResearchEvent[] { return this.ledger.events(); }
  state(): ResearchMissionState { return publicState(project(this.ledger.events())); }
  evidenceMemory(): EvidenceMemory { return new EvidenceMemory(this.state()); }

  /** T43: whether the baseline track has been established (a completed `baseline_track`-tagged task). */
  private baselineEstablished(state?: MutableResearchState): boolean {
    if (!this.baselineTrack) return true;
    const projected = state ?? project(this.ledger.events());
    return [...projected.tasks.values()].some(
      (task) => task.status === "COMPLETED" && (task.task.tags ?? []).includes("baseline_track"),
    );
  }

  /** T43: heavy idea-kind tasks are ineligible until the baseline is established. */
  private baselineGateAllows(task: MutableTaskState, baselineEstablished: boolean): boolean {
    return directorAuthorizeHeavyTask(this.baselineTrack, task.task.ideaType, baselineEstablished, task.task.tags).allowed;
  }

  readyTasks(): readonly ResearchTaskState[] {
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") return Object.freeze([]);
    refreshStatuses(state);
    const baselineEstablished = this.baselineEstablished(state);
    return frozenArray([...state.tasks.values()]
      .filter((task) => taskReady(state, task) && state.budgetConsumed + (task.task.estimatedCost ?? 1) <= state.budgetTotal && campaignAllows(state, task))
      .filter((task) => this.baselineGateAllows(task, baselineEstablished))
      .sort((left, right) => priorityScore(state, right) - priorityScore(state, left) || (left.task.estimatedCost ?? 1) - (right.task.estimatedCost ?? 1) || left.task.taskId.localeCompare(right.task.taskId))
      .map((task) => taskState(state, task)));
  }

  selectNextTask(): ResearchTaskState | undefined {
    const current = this.state();
    if (current.phase === "STOPPED") return undefined;
    const ready = this.readyTasks();
    const eligible = ready.filter((task) => task.status === "READY" && current.budget.consumed + (task.estimatedCost ?? 1) <= current.budget.total);
    const selected = preferScaledCampaign(eligible, current.decisions)
      ?? preferByIdeaType(eligible, this.ideaTypePreference, lastSelectedIdeaType(this.ledger.events(), current.tasks));
    if (!selected) return undefined;
    this.append("TASK_SELECTED", {
      taskId: selected.taskId,
      selectedAt: this.clock(),
      spend: selected.campaignId === undefined ? "micro" : "macro",
      ...(selected.campaignId === undefined ? {} : { campaignId: selected.campaignId }),
    }, this.operation(`select-${selected.taskId}`));
    return this.state().tasks[selected.taskId];
  }

  recordPrediction(taskId: string, prediction: PredictionArtifact, operationId?: string): PredictionArtifact {
    nonEmpty("taskId", taskId);
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`unknown research task: ${taskId}`);
    if (task.status !== "QUEUED" && task.status !== "READY") throw new Error(`prediction must be recorded before task selection: ${taskId}`);
    const normalized = normalizePrediction(prediction, `${taskId}:prediction`);
    const operation = this.operation(`prediction-${taskId}`, operationId);
    const existing = this.operationEvent(operation);
    if (existing) {
      this.assertOperation("PREDICTION_RECORDED", { taskId, prediction: normalized }, operation);
      return state.predictions.get(taskId)!;
    }
    this.append("PREDICTION_RECORDED", { taskId, prediction: normalized }, operation);
    return normalized;
  }

  reconcileTask(taskId: string, input: TaskReconcileInput): ReconcileRecord {
    nonEmpty("taskId", taskId);
    const state = project(this.ledger.events());
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`unknown research task: ${taskId}`);
    if (task.status !== "COMPLETED" && task.status !== "FAILED") throw new Error(`task is not complete: ${taskId}`);
    const prediction = predictionFor(task);
    if (!prediction) throw new Error(`reconcile requires a prediction: ${taskId}`);
    const reconcile = normalizeReconcile({ ...input, reconcileId: input.reconcileId ?? `${taskId}:reconcile`, taskId, predictionId: prediction.predictionId }, prediction);
    requireReconcileRefs(state.memory, reconcile, new Set(state.artifacts.keys()), new Set([...state.artifacts.values()].map((artifact) => artifact.digest)), state.trustedEvaluators, prediction, taskId);
    const existing = state.reconciles.get(taskId);
    if (existing) {
      if (!same(existing, reconcile)) throw new Error(`reconcile already contains different data: ${taskId}`);
      // Crash recovery: the reconcile may have persisted without its WORLD_MODEL admission event.
      this.ensureWorldModelAdmission(taskId, existing);
      return existing;
    }
    const operation = this.operation(`reconcile-${taskId}`, input.reconcileId);
    this.append("RECONCILED", { taskId, reconcile }, operation);
    this.ensureWorldModelAdmission(taskId, reconcile);
    return this.state().reconciles.find((entry) => entry.taskId === taskId)!;
  }

  /** Idempotently appends the WORLD_MODEL admission for a gate-backed reconcile that lacks it yet. */
  private ensureWorldModelAdmission(taskId: string, reconcile: ReconcileRecord): void {
    const current = project(this.ledger.events());
    const prediction = current.predictions.get(taskId) ?? current.tasks.get(taskId)?.prediction;
    if (!prediction) return;
    if (!independentlyEvaluated(current.memory, reconcile, new Set([...current.artifacts.values()].map((artifact) => artifact.digest)), current.trustedEvaluators, prediction)) return;
    const claim = reconcile.claim;
    if (current.worldModel.has(claim.claimId)) return;
    this.append("WORLD_MODEL_UPDATED", { taskId, claim }, `${claim.claimId}:world-model`);
  }

  searchWorldModel(query?: string): readonly ClaimCard[] {
    const needle = query?.trim().toLowerCase();
    return frozenArray(this.state().worldModel.filter((claim) => needle === undefined || needle === ""
      || [claim.hypothesis, claim.expectedObservation, claim.reconcileStatus].some((value) => value.toLowerCase().includes(needle))));
  }

  completeTask(taskId: string, completion: TaskCompletion): ResearchTaskState {
    nonEmpty("taskId", taskId);
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`unknown research task: ${taskId}`);
    const operationId = this.operation(`complete-${taskId}`, completion.operationId);
    const existingOperation = this.ledger.events().some((event) => event.payload.operationId === operationId);
    const conflictingOperation = this.operationEvent(operationId);
    if (conflictingOperation && conflictingOperation.type !== "TASK_COMPLETED") {
      throw new Error(`operationId already contains a different research operation: ${operationId}`);
    }
    if (task.status === "COMPLETED" && !existingOperation) throw new Error(`task completion is already recorded: ${taskId}`);
    if (task.status !== "RUNNING" && task.status !== "COMPLETED") throw new Error(`task is not running: ${taskId}`);
    if (!task.prediction) throw new Error(`task completion requires an explicit prediction: ${taskId}`);
    const evidence = (completion.evidence ?? []).map((record) => normalizeEvidence(record, taskId));
    const findings = (completion.findings ?? []).map(normalizeFinding);
    const negatives = (completion.negativeEvidence ?? []).map(normalizeNegative);
    const pitfalls = (completion.pitfalls ?? []).map(normalizePitfall);
    const candidates = normalizeCandidates(completion.candidates);
    const artifacts = normalizeArtifacts(completion.artifacts);
    mergeCandidateRefs(state, candidates);
    mergeArtifactRefs(state, artifacts);
    const memory = new EvidenceMemory({
      evidence: state.memory.records(),
      findings: state.memory.findings(),
      negativeEvidence: state.memory.negativeEvidence(),
      pitfalls: state.memory.pitfalls(),
    });
    for (const record of evidence) memory.addEvidence(record);
    for (const finding of findings) memory.addFinding(finding);
    for (const negative of negatives) memory.addNegativeEvidence(negative);
    for (const pitfall of pitfalls) memory.addPitfall(pitfall);
    const refs = [...findings.flatMap((finding) => finding.evidenceRefs), ...negatives.flatMap((negative) => negative.evidenceRefs), ...pitfalls.flatMap((pitfall) => pitfall.evidenceRefs)];
    for (const ref of refs) if (!memory.has(ref)) throw new Error(`unknown evidence reference: ${ref}`);
    const reconcileInput = completion.reconcile;
    if (reconcileInput === undefined) throw new Error(`task completion requires reconciliation: ${taskId}`);
    // Validate the whole completion (reconcile, refs, evidence gate) before the first ledger write so a
    // rejected completion cannot leave a half-applied TASK_COMPLETED behind.
    const reconcile = normalizeReconcile({ ...reconcileInput, reconcileId: reconcileInput.reconcileId ?? `${taskId}:reconcile`, taskId, predictionId: task.prediction.predictionId, ...(completion.objections === undefined ? {} : { objections: completion.objections }) }, task.prediction);
    requireReconcileRefs(
      memory,
      reconcile,
      new Set([...state.artifacts.keys(), ...artifacts.map((artifact) => artifact.artifactId)]),
      new Set([...state.artifacts.values(), ...artifacts].map((artifact) => artifact.digest)),
      state.trustedEvaluators,
      task.prediction,
      taskId,
    );
    const payload = { taskId, evidence, findings, negativeEvidence: negatives, pitfalls, candidates, artifacts, reconcile };
    this.append("TASK_COMPLETED", payload, operationId);
    this.append("RECONCILED", { taskId, reconcile }, `${operationId}-reconcile`);
    this.ensureWorldModelAdmission(taskId, reconcile);
    return this.state().tasks[taskId];
  }

  failTask(taskId: string, failure: TaskFailure): ResearchTaskState {
    nonEmpty("taskId", taskId);
    nonEmpty("failure reason", failure.reason);
    const state = project(this.ledger.events());
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`unknown research task: ${taskId}`);
    const operationId = this.operation(`fail-${taskId}`, failure.operationId);
    const failureObservation: EvidenceRecord = {
      id: `${taskId}-failure-observation-${operationId}`,
      kind: "observation",
      summary: failure.reason,
      verified: true,
      taskId,
    };
    const evidence = [failureObservation, ...(failure.evidence ?? [])].map((record) => normalizeEvidence(record, taskId));
    const negatives = (failure.negativeEvidence ?? [{ id: `${taskId}-negative-${operationId}`, statement: failure.reason, category: failure.category ?? "inconclusive", evidenceRefs: evidence.map((record) => record.id) }]).map(normalizeNegative);
    if (!predictionFor(task)) throw new Error(`reconcile requires a prediction: ${taskId}`);
    // The default failure reconcile must carry the persisted failure observation as a real observation ref.
    const defaultReconcile = defaultFailureReconcile(taskId, evidence.map((record) => record.id), []);
    const reconcileInput = failure.reconcile ?? defaultReconcile;
    // Validate the whole failure (reconcile and its refs) before the first ledger write.
    const reconcile = normalizeReconcile({ ...reconcileInput, reconcileId: reconcileInput.reconcileId ?? `${taskId}:reconcile`, taskId, predictionId: predictionFor(task)!.predictionId, ...(failure.objections === undefined ? {} : { objections: failure.objections }) }, predictionFor(task)!);
    const memory = new EvidenceMemory({
      evidence: state.memory.records(),
      findings: state.memory.findings(),
      negativeEvidence: state.memory.negativeEvidence(),
      pitfalls: state.memory.pitfalls(),
    });
    for (const record of evidence) memory.addEvidence(record);
    for (const negative of negatives) memory.addNegativeEvidence(negative);
    requireReconcileRefs(memory, reconcile, new Set(state.artifacts.keys()), new Set([...state.artifacts.values()].map((artifact) => artifact.digest)), state.trustedEvaluators, predictionFor(task)!, taskId);
    const payload = { taskId, reason: failure.reason, evidence, negativeEvidence: negatives, reconcile };
    const existing = this.operationEvent(operationId);
    if (existing) {
      if (existing.type !== "TASK_FAILED" || !same(existing.payload, { ...payload, missionId: this.missionId, operationId })) {
        throw new Error(`operationId already contains a different research operation: ${operationId}`);
      }
      return this.state().tasks[taskId];
    }
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    if (task.status !== "RUNNING") throw new Error(`task is not running: ${taskId}`);
    this.append("TASK_FAILED", payload, operationId);
    this.append("RECONCILED", { taskId, reconcile }, `${operationId}-reconcile`);
    this.ensureWorldModelAdmission(taskId, reconcile);
    return this.state().tasks[taskId];
  }

  generateTasks(input: GenerateTasksInput): readonly ResearchTaskState[] {
    nonEmpty("sourceTaskId", input.sourceTaskId);
    const state = project(this.ledger.events());
    const evidenceRefs = strings("generation evidenceRefs", input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new Error("task generation requires evidence references");
    const tasks = validateTaskGraph(input.tasks, new Set(state.tasks.keys()), state.campaigns);
    const existing = this.operationEvent(input.operationId);
    if (existing) {
      if (existing.type !== "TASKS_GENERATED"
        || existing.payload.sourceTaskId !== input.sourceTaskId
        || !same(existing.payload.evidenceRefs, evidenceRefs)
        || !same(existing.payload.tasks, tasks)) {
        throw new Error(`operationId already contains a different research operation: ${input.operationId}`);
      }
      const current = this.state();
      return frozenArray(tasks.map((task) => current.tasks[task.taskId]).filter((task): task is ResearchTaskState => task !== undefined));
    }
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    const source = state.tasks.get(input.sourceTaskId);
    if (!source || source.status !== "COMPLETED") throw new Error("tasks can only be generated from a completed task");
    requireRefs(state, evidenceRefs);
    requireTaskEvidence(state, source, evidenceRefs);
    if (tasks.some((task) => state.tasks.has(task.taskId))) throw new Error("generated task already exists");
    const operationId = this.operation(`generate-${input.sourceTaskId}`, input.operationId);
    const allTasks = [...state.tasks.values()].map((value) => value.task).concat(tasks);
    this.append("TASKS_GENERATED", {
      sourceTaskId: input.sourceTaskId,
      evidenceRefs,
      tasks,
      planVersion: state.planVersion + 1,
      planDigest: planDigest(state.objective, state.budgetTotal, allTasks, state.scope, [...state.campaigns.values()]),
    }, operationId);
    const next = this.state();
    return frozenArray(tasks.map((task) => next.tasks[task.taskId]));
  }

  recordFinding(value: Finding, operationId?: string): boolean {
    const finding = normalizeFinding(value);
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    requireRefs(state, finding.evidenceRefs);
    if (finding.verified && finding.evidenceRefs.length === 0) throw new Error("verified finding requires evidence references");
    const operation = this.operation(`finding-${finding.id}`, operationId);
    const eventType = finding.verified ? "FINDING_RECORDED" : "FINDING_REJECTED";
    const payload = { finding };
    const existing = state.memory.getFinding(finding.id);
    if (existing) {
      if (!same(existing, finding)) throw new Error(`finding id already contains different data: ${finding.id}`);
      this.assertOperation(eventType, payload, operation);
      return existing.verified;
    }
    this.append(eventType, payload, operation);
    return finding.verified;
  }

  recordNegativeEvidence(value: NegativeEvidence, operationId?: string): boolean {
    const negative = normalizeNegative(value);
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    requireRefs(state, negative.evidenceRefs);
    const operation = this.operation(`negative-${negative.id}`, operationId);
    const payload = { negativeEvidence: negative };
    const existing = state.memory.getNegativeEvidence(negative.id);
    if (existing) {
      if (!same(existing, negative)) throw new Error(`negative evidence id already contains different data: ${negative.id}`);
      this.assertOperation("NEGATIVE_EVIDENCE_RECORDED", payload, operation);
      return true;
    }
    if (negative.verified === false) {
      this.assertOperation("NEGATIVE_EVIDENCE_RECORDED", payload, operation);
      return false;
    }
    this.append("NEGATIVE_EVIDENCE_RECORDED", payload, operation);
    return true;
  }

  recordPitfall(value: Pitfall, operationId?: string): boolean {
    const pitfall = normalizePitfall(value);
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    requireRefs(state, pitfall.evidenceRefs);
    const operation = this.operation(`pitfall-${pitfall.id}`, operationId);
    const payload = { pitfall };
    const existing = state.memory.getPitfall(pitfall.id);
    if (existing) {
      if (!same(existing, pitfall)) throw new Error(`pitfall id already contains different data: ${pitfall.id}`);
      this.assertOperation("PITFALL_RECORDED", payload, operation);
      return true;
    }
    if (pitfall.verified === false) {
      this.assertOperation("PITFALL_RECORDED", payload, operation);
      return false;
    }
    this.append("PITFALL_RECORDED", payload, operation);
    return true;
  }

  commitBlueprintFile(file: BlueprintFile, input: CommitBlueprintInput = {}): BlueprintFileRef {
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    const normalized = normalizeBlueprintFile(file);
    if (normalized.kind === "GOAL" && normalized.objective !== state.objective) {
      throw new Error("GOAL objective must match the mission research objective");
    }
    const collected = collectBlueprintEvidenceRefs(normalized);
    const extra = strings("blueprint evidenceRefs", input.evidenceRefs);
    const evidenceRefs = [...new Set([...collected, ...extra])];
    requireRefs(state, evidenceRefs);
    requireScoreboardEvaluatorCitations(state, normalized);
    const digest = blueprintFileDigest(normalized);
    const ref = normalizeBlueprintFileRef({
      kind: normalized.kind,
      artifactId: blueprintArtifactId(normalized.kind),
      digest,
      evidenceRefs,
    });
    const operationId = this.operation(`blueprint-${normalized.kind}`, input.operationId);
    const payload = { file: normalized, ref };
    const existing = this.operationEvent(operationId);
    if (existing) {
      this.assertOperation("BLUEPRINT_COMMITTED", payload, operationId);
      return normalizeBlueprintFileRef(existing.payload.ref);
    }
    this.append("BLUEPRINT_COMMITTED", payload, operationId);
    return ref;
  }

  pendingCrossReviewSubjects(): readonly string[] {
    const state = project(this.ledger.events());
    const reviewed = new Set(state.blueprint.crossReviews.filter((review) => review.phase === "author").flatMap((review) => review.subjectRefs));
    return frozenArray(Object.values(state.blueprint.files).flatMap((file) => file === undefined || reviewed.has(file.artifactId) ? [] : [file.artifactId]));
  }

  recordCrossReview(input: RecordCrossReviewInput): CrossReviewRecord {
    const state = project(this.ledger.events());
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    nonEmpty("cross-review reviewId", input.reviewId);
    const evidenceRefs = strings("cross-review evidenceRefs", input.evidenceRefs);
    requireRefs(state, evidenceRefs);
    const body = {
      reviewId: input.reviewId,
      phase: input.phase,
      subjectRefs: strings("cross-review subjectRefs", input.subjectRefs),
      findings: strings("cross-review findings", input.findings),
      evidenceRefs,
    };
    const digest = digestValue(body);
    const review = normalizeCrossReview({
      ...body,
      artifactId: `cross-review:${input.reviewId}`,
      digest,
      authoritative: false,
    });
    requireCrossReviewPhase(state, review);
    const evidence: EvidenceRecord = {
      id: `cross-review:${input.reviewId}`,
      kind: "observation",
      summary: review.findings[0]!,
      refs: evidenceRefs,
      metadata: { digest, phase: review.phase, authoritative: false },
    };
    const operationId = this.operation(`cross-review-${input.reviewId}`, input.operationId);
    const payload = { review, evidence };
    const existing = this.operationEvent(operationId);
    if (existing) {
      this.assertOperation("CROSS_REVIEW_RECORDED", payload, operationId);
      return normalizeCrossReview(existing.payload.review);
    }
    this.append("CROSS_REVIEW_RECORDED", payload, operationId);
    return review;
  }

  decide(input: Omit<ResearchDecision, "decisionId"> & { readonly decisionId?: string }): ResearchDecision {
    const state = project(this.ledger.events());
    const evidenceRefs = strings("decision evidenceRefs", input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new Error("decision requires evidence references");
    requireRefs(state, evidenceRefs);
    const campaignIds = strings("decision campaignIds", input.campaignIds);
    if (campaignIds.some((id) => !state.campaigns.has(id))) throw new Error(`decision references an unknown campaign: ${campaignIds.join(", ")}`);
    nonEmpty("decision reason", input.reason);
    if (!["Continue", "Revise", "Scale", "Stop"].includes(input.action)) throw new RangeError("unknown decision action");
    const decisionId = input.decisionId ?? this.operation("decision-id");
    const decision = normalizeDecision({ ...input, decisionId });
    const existing = state.decisions.find((entry) => entry.decisionId === decision.decisionId);
    if (existing) {
      if (!same(existing, decision)) throw new Error(`decision id already contains different data: ${decision.decisionId}`);
      return existing;
    }
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    if (decision.action === "Stop") assertBlueprintAllowsStop(state.blueprint);
    const operationId = this.operation(`decision-${decision.decisionId}`);
    this.append("DECISION_RECORDED", { decision }, operationId);
    if (decision.action === "Stop") {
      this.append("MISSION_STOPPED", {
        decisionId: decision.decisionId,
        evidenceRefs: decision.evidenceRefs,
        reason: decision.stopReason!,
      }, `${operationId}-stop`);
    }
    return decision;
  }

  replan(proposal: ResearchPlanProposal): ResearchMissionState {
    const state = project(this.ledger.events());
    finiteNonNegative("re-plan totalBudget", proposal.totalBudget);
    const evidenceRefs = strings("re-plan evidenceRefs", proposal.evidenceRefs);
    nonEmpty("re-plan reason", proposal.reason);
    const preserved = [...state.tasks.values()].filter((task) => task.status === "COMPLETED" || task.status === "RUNNING");
    const campaigns = proposal.campaigns === undefined ? state.campaigns : normalizeCampaigns(proposal.campaigns);
    const tasks = validateTaskGraph(proposal.tasks, new Set(preserved.map((task) => task.task.taskId)), campaigns);
    const existing = this.operationEvent(proposal.operationId);
    if (existing) {
      if (existing.type !== "PLAN_REVISED"
        || existing.payload.parentPlanDigest !== proposal.parentPlanDigest
        || existing.payload.objective !== proposal.objective
        || existing.payload.totalBudget !== proposal.totalBudget
        || existing.payload.reason !== proposal.reason
        || !same(existing.payload.evidenceRefs, evidenceRefs)
        || !same(existing.payload.tasks, tasks)
        || !same(existing.payload.campaigns, [...campaigns.values()])) {
        throw new Error(`operationId already contains a different research operation: ${proposal.operationId}`);
      }
      return this.state();
    }
    if (state.phase === "STOPPED") throw new Error("mission is stopped");
    if (proposal.parentPlanDigest !== state.planDigest) throw new Error("re-plan parent digest is stale");
    if (proposal.objective !== state.objective) throw new Error("coordinator cannot change the mission objective");
    if (proposal.totalBudget < state.budgetConsumed) throw new Error("re-plan budget cannot be below consumed budget");
    if (proposal.totalBudget > state.budgetTotal) throw new Error("coordinator cannot expand the mission budget");
    requireRefs(state, evidenceRefs);
    assertActiveTasksPreserved(state, preserved, tasks, "re-plan cannot");
    assertCampaignEnvelopesPreserved(state, campaigns, "re-plan cannot");
    const nextVersion = state.planVersion + 1;
    const digest = planDigest(state.objective, proposal.totalBudget, tasks, state.scope, [...campaigns.values()]);
    const operationId = this.operation("replan", proposal.operationId);
    this.append("PLAN_REVISED", {
      parentPlanDigest: state.planDigest,
      objective: state.objective, totalBudget: proposal.totalBudget, tasks, evidenceRefs,
      reason: proposal.reason, planVersion: nextVersion, planDigest: digest,
      campaigns: [...campaigns.values()],
    }, operationId);
    return this.state();
  }

  async runNext(execute: (task: Readonly<ResearchTaskState>, memory: EvidenceMemory) => TaskCompletion | Promise<TaskCompletion>): Promise<ResearchTaskState | undefined> {
    const task = this.selectNextTask();
    if (!task) return undefined;
    try {
      return this.completeTask(task.taskId, await execute(task, this.evidenceMemory()));
    } catch (error) {
      if (this.state().tasks[task.taskId]?.status !== "RUNNING") throw error;
      return this.failTask(task.taskId, { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async run(
    execute: (task: Readonly<ResearchTaskState>, memory: EvidenceMemory) => TaskCompletion | Promise<TaskCompletion>,
    maxSteps = Number.POSITIVE_INFINITY,
  ): Promise<ResearchMissionState> {
    if (maxSteps !== Number.POSITIVE_INFINITY) positiveInteger("maxSteps", maxSteps);
    let steps = 0;
    while (steps < maxSteps && this.state().phase !== "STOPPED") {
      if (!(await this.runNext(execute))) break;
      steps += 1;
    }
    return this.state();
  }

  checkpoint(): Readonly<{ sequence: number; digest: string; state: ResearchMissionState }> {
    const events = this.events();
    return deepFreeze({ sequence: events.length, digest: digestValue(events), state: this.state() });
  }
}

export type ResearchLoop = MissionDirector;
export const ResearchLoop = MissionDirector;
