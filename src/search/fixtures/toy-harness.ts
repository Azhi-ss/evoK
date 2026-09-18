/**
 * Fixture/test facade only (ET-A2 / #122). Physical home:
 * `src/search/fixtures/`. Not a product control plane.
 *
 * Do not route new Mission / orchestration authority through this harness.
 * `ToyCompetitionAdapter.evaluate` is evaluation — not
 * `SearchSelectionPort.selectParent`.
 */
import {
  HumanAcceptanceGate,
  SandboxBoundary,
  SandboxViolation,
  SecretRedactor,
  TrustViolation,
  assertSnapshotIntegrity,
  clone,
  createTrustedSnapshot,
  deepFreeze,
  digestValue,
  evaluateTrustedSnapshot,
  type SandboxPolicy,
} from "../../security-boundary";
import {
  normalizeVerificationResult,
  verificationRoleContract,
  type VerificationContext,
  type VerificationHooks,
  type VerificationRole,
} from "../../verification-gates";
import { requireIdeaType } from "../../idea-types";
import type { HumanAcceptanceDecision } from "../../security-boundary";
import {
  SubmissionBroker,
  externalSubmissionsFromEvents,
  type SubmissionBrokerOptions,
  type SubmissionChampion,
  type SubmissionEventLike,
} from "../../submission-broker";
import {
  aggregateEvaluationFacts,
  buildEvaluationLadder,
  evaluationContractDigest,
  evaluationRunDigest,
  evaluationRunId,
  evaluationRunOrdinal,
  evaluationSeed,
  evaluationStageSides,
  normalizeEvaluationContract,
  resolveEvaluationContract,
  validateEvaluationLadder,
  type EvaluationContract,
  type EvaluationContractAccessor,
  type EvaluationLadderResult,
  type EvaluationRunContext,
  type EvaluationRunFact,
  type EvaluationRunInput,
  type NormalizedEvaluationContract,
} from "../../evaluation-noise";
import {
  LeakageViolation,
  auditCandidateFiles,
  resolveDataHonestyContract,
  type DataHonestyContract,
  type LeakageAuditContract,
  type LeakageFinding,
  type TestSignalPolicy,
} from "../../data-honesty";
import {
  MethodologyViolation,
  applyComponentFanOut,
  auditMethodology,
  isMethodologyContracts,
  resolveMethodologyContracts,
  validateEnsemblePromotion,
  type MethodologyContracts,
  type MethodologyDeclaration,
} from "../../methodology-contracts";
import {
  authorizePublicProbe,
  isValidationLadderContract,
  levelCanChampion,
  normaliseValidationLevel,
  publicProbesUsedFromEvents,
  resolveValidationLadder,
  type ValidationEventLike,
  type ValidationLadderContract,
  type ValidationLadderInput,
  type ValidationLadderProvider,
  type ValidationLevel,
} from "../../validation-ladder";
import {
  authorizeHeavySearch,
  baselineSatisfied,
  isBaselineTrackContract,
  resolveBaselineTrack,
  type BaselineTrackContract,
  type BaselineTrackInput,
  type BaselineTrackProvider,
  type BaselineTrackResult,
} from "../../baseline-track";
import {
  normalizePrediction,
  normalizeReconcile,
  reconcilePrediction,
  createClaimCard,
  type ClaimCard,
  type ClaimObjection,
  type PredictionArtifact,
  type ReconcileRecord,
} from "../../predict-reconcile";
import {
  DEFAULT_MODEL_MIX,
  ModelOrchestra,
  type ModelCatalog,
  type ModelConfig,
  type ModelMix,
  type OrchestraConfig,
  type OrchestraResolutionReason,
  type PatternModelPolicy,
  type RoleClass,
  type TierId,
} from "../../model-orchestra";

export {
  aggregateEvaluationFacts,
  buildEvaluationLadder,
  evaluationContractDigest,
  evaluationRunDigest,
  evaluationRunId,
  evaluationRunOrdinal,
  evaluationSeed,
  evaluationStageSides,
  normalizeEvaluationContract,
  resolveEvaluationContract,
  validateEvaluationLadder,
};
export type {
  EvaluationContract,
  EvaluationContractAccessor,
  EvaluationLadderResult,
  EvaluationRunContext,
  EvaluationRunFact,
  EvaluationRunInput,
  NormalizedEvaluationContract,
};
export { LeakageViolation, auditCandidateFiles, resolveDataHonestyContract };
export type { DataHonestyContract, LeakageAuditContract, LeakageFinding, TestSignalPolicy };
export {
  authorizePublicProbe,
  canReadScore,
  isValidationLadderContract,
  levelCanChampion,
  normaliseValidationLevel,
  publicProbesUsedFromEvents,
  resolveValidationLadder,
} from "../../validation-ladder";
export type { ValidationLadderContract, ValidationLadderInput, ValidationLadderProvider, ValidationLevel, ValidationReaderRole } from "../../validation-ladder";
export {
  MethodologyViolation,
  applyComponentFanOut,
  auditMethodology,
  isMethodologyContracts,
  resolveMethodologyContracts,
  validateEnsemblePromotion,
} from "../../methodology-contracts";
export type { MethodologyContracts, MethodologyDeclaration, MethodologyProvider } from "../../methodology-contracts";
export {
  authorizeHeavySearch,
  baselineSatisfied,
  directorAuthorizeHeavyTask,
  isBaselineTrackContract,
  resolveBaselineTrack,
} from "../../baseline-track";
export type { BaselineTrackContract, BaselineTrackInput, BaselineTrackProvider, BaselineTrackResult, HeavySearchAuthorization } from "../../baseline-track";

export type MissionPhase = "CREATED" | "RUNNING" | "COMPLETED" | "STOPPED";

export type BranchStatus =
  | "QUEUED"
  | "TASK_SELECTED"
  | "PREPARED"
  | "CANDIDATE_PROPOSED"
  | "MATERIALIZED"
  | "PREFLIGHT_SELF_CHECK"
  | "RUNNING"
  | "VERIFYING"
  | "SCORED"
  | "REJECTED"
  | "QUARANTINED"
  | "PROMOTED_LOCAL";

export interface TaskContract {
  objective: string;
  constraints?: Record<string, unknown>;
  budget?: MissionBudget;
  expectedOutputs?: string[];
  /** Registered idea type (systems | algorithmic | open-search, or a registered extension). */
  ideaType?: string;
}

export interface MissionBudget {
  maxCandidates?: number;
  maxAttempts?: number;
  /** T42: total real (external) submissions allowed for the mission; dry-runs are free. */
  submissionQuota?: number;
  [key: string]: number | undefined;
}

export interface CandidateSnapshot {
  missionId: string;
  branchId: string;
  attempt: number;
  files: Record<string, string>;
  contract: TaskContract;
  /** The registered idea type this candidate pursues; mirrors the task contract. */
  ideaType?: string;
  /** Integrity fields are present on snapshots created by the harness. */
  digest?: string;
  filesDigest?: string;
  contractDigest?: string;
  provenance: {
    runId: string;
    candidateId: string;
    fencingToken: number;
  };
}

export interface ScoreFact {
  name: string;
  value: string | number | boolean;
  source?: string;
}

/** The evaluator-owned score record; only this channel can feed grading or promotion. */
export interface TrustedScore {
  readonly kind: "trusted_score";
  readonly score: number;
  readonly evaluationDigest: string;
  readonly snapshotDigest: string;
  readonly contractDigest: string;
}

/** A derived agent-readable view over trusted Evidence; never a scorer, promotion input, independent Evaluator, or #11 noise protocol. */
export interface EvaluationFeedbackView {
  readonly kind: "feedback_view";
  readonly stage: "evaluation";
  readonly score: number;
  readonly facts: readonly ScoreFact[];
  readonly contractDigest: string;
  readonly sourceEvaluationDigest: string;
  readonly chain: readonly string[];
}

export interface EvaluationFeedbackOptions {
  /** Disabled by default; enabling this changes only the agent-readable channel. */
  readonly enabled?: boolean;
}

export interface EvaluationResult {
  score: number;
  facts?: ScoreFact[];
  evaluatorId?: string;
  evaluatorVersion?: string;
  snapshotDigest?: string;
  /** The immutable TaskContract digest retained for compatibility. */
  contractDigest?: string;
  /** The immutable adapter-owned evaluation protocol digest. */
  evaluationContractDigest?: string;
  evaluationContractVersion?: string;
  officialScore?: number;
  promotionScore?: number;
  runs?: readonly EvaluationRunFact[];
  ladder?: Readonly<EvaluationLadderResult>;
  /** Alias used by callers that name the result after the ladder. */
  evaluationLadder?: Readonly<EvaluationLadderResult>;
  evaluationDigest?: string;
  /** Trusted score identity; this is excluded from the digest payload as a derived label. */
  trustedScore?: Readonly<TrustedScore>;
  /** Agent-readable feedback identity; this is excluded from trusted evaluation digests. */
  feedbackView?: Readonly<EvaluationFeedbackView>;
  /** Optional evaluator output fields; the harness verifies them against its run identity. */
  runId?: string;
  seed?: number;
  digest?: string;
  /**
   * T41 validation ladder: which data split / leaderboard this score came from
   * (`inner_cv` | `outer_holdout` | `public_lb`). The promotion gate only
   * champions `outer_holdout` evidence.
   */
  validationLevel?: ValidationLevel;
}

export interface CompetitionAdapterDescription {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly rules: readonly string[];
  readonly artifacts: readonly string[];
  readonly metric: string;
}

export interface CompetitionRuleValidation {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

export interface CompetitionArtifactReference {
  readonly artifactId: string;
  readonly address: string;
  readonly digest: string;
  readonly kind?: string;
}

export interface CandidateVerificationInput {
  missionId: string;
  branchId: string;
  snapshot: Readonly<CandidateSnapshot>;
  /** Optional agent-readable feedback; trusted scoring stays outside this channel. */
  feedbackView?: Readonly<EvaluationFeedbackView>;
  /** Resolved by the mission seam when a model catalog/orchestra is wired; runtime ports ignore it when absent. */
  model?: ModelConfig;
}

export interface EvidenceVerificationInput extends CandidateVerificationInput {
  evaluation: Readonly<EvaluationResult>;
}

export interface ToyAgentRuntime {
  selfVerify(input: {
    missionId: string;
    branchId: string;
    taskContract: TaskContract;
    context: Record<string, unknown>;
    workspace: Record<string, string>;
    /** Resolved by the mission seam when a model catalog/orchestra is wired. */
    model?: ModelConfig;
    tier?: string;
  }): { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  propose(input: {
    missionId: string;
    branchId: string;
    taskContract: TaskContract;
    workspace: Record<string, string>;
    /** Resolved by the mission seam when a model catalog/orchestra is wired. */
    model?: ModelConfig;
    tier?: string;
  }): { files: Record<string, string> } | Promise<{ files: Record<string, string> }>;
  falsify(input: {
    missionId: string;
    branchId: string;
    snapshot: Readonly<CandidateSnapshot>;
    /** Agent-readable feedback; absent when the layer is disabled. */
    feedbackView?: Readonly<EvaluationFeedbackView>;
    /** Resolved by the mission seam when a model catalog/orchestra is wired. */
    model?: ModelConfig;
    tier?: string;
  }): { ok: boolean; objections: string[] } | Promise<{ ok: boolean; objections: string[] }>;
  critic?: (input: CandidateVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  challenger?: (input: CandidateVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  auditor?: (input: EvidenceVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  successAuditor?: (input: EvidenceVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  /**
   * Promotion-gate cross-model agreement check (promotion_cross_model=both):
   * the runtime requests one tiered evaluation attempt per supplied
   * ModelConfig and reports whether the two tiers agree. It only observes —
   * promotion and submission authority stay with the harness.
   */
  crossModelCheck?: (input: CrossModelCheckInput) => CrossModelCheckResult | Promise<CrossModelCheckResult>;
}

export interface CrossModelCheckInput {
  missionId: string;
  branchId: string;
  snapshot: Readonly<CandidateSnapshot>;
  evaluation: Readonly<EvaluationResult>;
  /** Both tier ModelConfigs resolved by the mission seam (fast + deep). */
  models: { readonly fast: ModelConfig; readonly deep: ModelConfig };
}

export interface CrossModelCheckResult {
  /** True when the fast and deep tiered attempts agree. */
  readonly agreed: boolean;
  /** Required explicit reason when agreed is false. */
  readonly reason?: string;
}

/** Context handed to an adapter's runnable baseline port (T43). */
export interface BaselineRunContext {
  readonly missionId: string;
  /** Opaque entry declared by `baseline_track`; the adapter interprets it vendor-side. */
  readonly entry: string;
}

export type ToyCompetitionAdapter = {
  readonly name?: string;
  readonly describe?: () => CompetitionAdapterDescription;
  readonly validateRules?: (snapshot: Readonly<CandidateSnapshot>) => CompetitionRuleValidation;
  readonly collectArtifacts?: (snapshot: Readonly<CandidateSnapshot>) => readonly CompetitionArtifactReference[];
  /** Data honesty (T40): what held-out data exists and how test feedback may be used. */
  readonly leakage_audit?: (() => DataHonestyContract["leakage_audit"]) | DataHonestyContract["leakage_audit"];
  readonly leakageAudit?: (() => DataHonestyContract["leakage_audit"]) | DataHonestyContract["leakage_audit"];
  readonly test_signal_policy?: (() => DataHonestyContract["test_signal_policy"]) | DataHonestyContract["test_signal_policy"];
  readonly testSignalPolicy?: (() => DataHonestyContract["test_signal_policy"]) | DataHonestyContract["test_signal_policy"];
  /** Validation ladder (T41): three-level data-split / LB policy; absent → gate inactive. */
  readonly validation_ladder?: ValidationLadderProvider["validation_ladder"];
  readonly validationLadder?: ValidationLadderProvider["validationLadder"];
  /**
   * Methodology contracts (T44): component-level feature pipeline, OOF ensemble,
   * and time/group split discipline. Exposed via a snake/camel accessor (or plain
   * field). Absent → methodology gates inactive. Violating a declared
   * split_contract is a rule failure (MethodologyViolation → quarantine), and
   * ensemble promotion requires OOF (or a declared leakage-safe equivalent).
   */
  readonly methodology_contracts?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
  readonly methodologyContracts?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
  readonly methodology?: (() => MethodologyDeclaration | undefined) | MethodologyDeclaration;
  /**
   * Strong-baseline / AutoML track (T43): vendor-neutral declaration of the cheap
   * baseline command/entry and success predicate; an adapter may additionally bind a
   * runnable baseline port. Absent → baseline-first gate inactive.
   */
  readonly baseline_track?: (() => BaselineTrackInput | undefined) | BaselineTrackInput;
  readonly baselineTrack?: (() => BaselineTrackInput | undefined) | BaselineTrackInput;
  /** Runnable baseline entry; returns the baseline evaluation result. Adapter-provided, never vendor-bound. */
  readonly runBaselineTrack?: (context: BaselineRunContext) => BaselineTrackResult | Promise<BaselineTrackResult>;
  /** Adapter-owned immutable evaluation protocol; snake-case and camel-case forms are accepted. */
  readonly evaluation_contract?: EvaluationContractAccessor;
  readonly evaluationContract?: EvaluationContractAccessor;
  evaluate(snapshot: Readonly<CandidateSnapshot>, context?: EvaluationRunContext): EvaluationResult | Promise<EvaluationResult>;
  /** Optional richer ports for independent evaluators; legacy evaluate remains valid. */
  readonly evaluateWithContract?: (
    snapshot: Readonly<CandidateSnapshot>,
    contract: Readonly<NormalizedEvaluationContract>,
    context: EvaluationRunContext,
    manifest?: Readonly<import("./security-boundary").SnapshotManifest>,
  ) => EvaluationResult | Promise<EvaluationResult>;
  readonly evaluateRun?: (input: EvaluationRunInput) => EvaluationResult | Promise<EvaluationResult>;
}

/** A deliberately small reference adapter: the candidate's `score` file is the score. */
export class ScoreFileToyCompetitionAdapter implements ToyCompetitionAdapter {
  readonly name = "score-file";

  constructor(readonly scoreFile = "score") {}

  describe(): CompetitionAdapterDescription {
    return deepFreeze({
      name: "score-file",
      input: { scoreFile: this.scoreFile },
      rules: [`${this.scoreFile} must contain a finite numeric score`],
      artifacts: [this.scoreFile],
      metric: "score (higher is better)",
    });
  }

  validateRules(snapshot: Readonly<CandidateSnapshot>): CompetitionRuleValidation {
    const raw = snapshot.files[this.scoreFile];
    const score = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    const violations = Number.isFinite(score) ? [] : [`${this.scoreFile} is missing or not finite`];
    return deepFreeze({ ok: violations.length === 0, violations });
  }

  collectArtifacts(snapshot: Readonly<CandidateSnapshot>): readonly CompetitionArtifactReference[] {
    const content = snapshot.files[this.scoreFile] ?? "";
    const digest = digestValue(content);
    return deepFreeze([{ artifactId: `${this.scoreFile}:${digest}`, address: `artifact://${this.scoreFile}/${digest}`, digest, kind: "score" }]);
  }

  evaluate(snapshot: Readonly<CandidateSnapshot>): EvaluationResult {
    const validation = this.validateRules(snapshot);
    if (!validation.ok) throw new Error(`rule validation failed: ${validation.violations.join("; ")}`);
    const score = Number(snapshot.files[this.scoreFile]);
    return {
      score,
      facts: [{ name: "score-file", value: score, source: this.scoreFile }],
    };
  }
}

export class InfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfrastructureError";
  }
}

export type MissionEventType =
  | "MISSION_CREATED"
  | "MISSION_STARTED"
  | "BRANCH_RESERVED"
  | "TASK_SELECTED"
  | "PREFLIGHT_SELF_CHECK_PASSED"
  | "PREFLIGHT_SELF_CHECK_FAILED"
  | "AGENT_COMPLETED"
  | "CANDIDATE_GENERATED"
  | "CANDIDATE_MATERIALIZED"
  | "SNAPSHOT_COMMITTED"
  | "EVALUATION_STARTED"
  | "EVALUATION_RUN_COMPLETED"
  | "FEEDBACK_VIEW_CREATED"
  | "EVALUATOR_SUCCEEDED"
  | "EVALUATOR_FAILED"
  | "RECONCILED"
  | "FALSIFIER_COMPLETED"
  | "CRITIC_COMPLETED"
  | "CHALLENGER_COMPLETED"
  | "AUDITOR_COMPLETED"
  | "SUCCESS_AUDITOR_COMPLETED"
  | "KILL_TESTER_COMPLETED"
  | "LEAKAGE_DISCLOSURE"
  | "PUBLIC_PROBE_REFUSED"
  | "BASELINE_TRACK_STARTED"
  | "BASELINE_TRACK_PASSED"
  | "BASELINE_TRACK_FAILED"
  | "HEAVY_SEARCH_REFUSED"
  | "GAIN_BANKED"
  | "PROMOTED_LOCAL"
  | "BRANCH_REJECTED"
  | "BRANCH_QUARANTINED"
  | "HUMAN_ACCEPTED"
  | "SUBMISSION_REQUESTED"
  | "SUBMISSION_APPROVED"
  | "SUBMISSION_REJECTED"
  | "SUBMISSION_RESULT"
  | "RETRY_SCHEDULED"
  | "MODEL_RESOLVED"
  | "CROSS_MODEL_CHECK_COMPLETED"
  | "MISSION_COMPLETED"
  | "MISSION_STOPPED"
  | "EDGE_TRAVERSED"
  | "LATE_EVENT_REJECTED";

export interface MissionEvent {
  sequence: number;
  type: MissionEventType;
  payload: Record<string, unknown>;
}

/**
 * One RoleSession's model resolution as recorded in the mission ledger: the
 * resolved tier plus the decision context (mix, gate, reason, forced) and the
 * exact ModelConfig handed to the runtime, so model economics are replayable
 * (spec #27 decision 9).
 */
export interface RoleSessionResolution {
  readonly role: string;
  readonly tier: TierId | "default";
  readonly mix: ModelMix;
  /** The harness gate the session resolved under, or null for non-gate sessions. */
  readonly gate: string | null;
  readonly reason: OrchestraResolutionReason;
  /** True only when an accepted forced_tier override produced this resolution. */
  readonly forced: boolean;
  readonly model: ModelConfig;
}

export interface PromotionComparison {
  readonly officialScore: number;
  readonly promotionScore: number;
  readonly championScore?: number;
  readonly officialMargin?: number;
  readonly abScore?: number;
  readonly abDelta?: number;
  readonly tolerance: number;
  readonly tightMargin: number;
  readonly tight: boolean;
  readonly officialAbDisagreement: boolean;
  readonly agreement: boolean;
  readonly digest: string;
}

export interface GainBankEntry {
  readonly branchId: string;
  readonly championBranchId: string;
  readonly championDigest: string;
  readonly amount: number;
  readonly candidateScore: number;
  readonly championScore: number;
  readonly evaluationDigest: string;
  readonly evaluationContractDigest: string;
  readonly evaluationContractVersion?: string;
}

export interface PromotionCandidate {
  branchId: string;
  score: number;
  facts: ScoreFact[];
  snapshot: Readonly<CandidateSnapshot>;
  evaluation?: Readonly<EvaluationResult>;
  ladder?: Readonly<EvaluationLadderResult>;
  promotion?: Readonly<PromotionComparison>;
}

export interface BranchState {
  branchId: string;
  status: BranchStatus;
  attempt: number;
  fencingToken?: number;
  candidateGenerated: boolean;
  agentCompleted: boolean;
  evaluatorSucceeded: boolean;
  trustedScore?: Readonly<TrustedScore>;
  feedbackView?: Readonly<EvaluationFeedbackView>;
  prediction?: PredictionArtifact;
  claimCard?: ClaimCard;
  reconcile?: ReconcileRecord;
  score?: number;
  facts?: ScoreFact[];
  snapshot?: Readonly<CandidateSnapshot>;
  evaluation?: Readonly<EvaluationResult>;
  evaluationRuns?: readonly EvaluationRunFact[];
  evaluationContractVersion?: string;
  objections?: string[];
  rejectionReason?: string;
  promotionDecision?: string;
  verification: Partial<Record<VerificationRole, boolean>>;
  candidateFilesDigest?: string;
  snapshotDigest?: string;
  contractDigest?: string;
  evaluationContractDigest?: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
}

export interface MissionChampion {
  branchId: string;
  score: number;
  facts: ScoreFact[];
  snapshot: Readonly<CandidateSnapshot>;
  evaluation?: Readonly<EvaluationResult>;
  ladder?: Readonly<EvaluationLadderResult>;
  evaluationContractDigest?: string;
  evaluationContractVersion?: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
}

export interface MissionState {
  missionId: string;
  phase: MissionPhase;
  objective: string;
  constraints: Record<string, unknown>;
  budget: MissionBudget;
  adapterName: string;
  competitionId: string;
  quorum: number;
  verificationRoles: readonly VerificationRole[];
  contractDigest: string;
  evaluationFeedbackEnabled: boolean;
  evaluationContract?: Readonly<NormalizedEvaluationContract>;
  evaluationContractDigest?: string;
  /** T41 validation ladder contract; undefined = ladder inactive for this adapter. */
  validationLadder?: Readonly<ValidationLadderContract>;
  /** T43 strong-baseline track; undefined = baseline-first gate inactive for this adapter. */
  baselineTrack?: Readonly<BaselineTrackContract>;
  /** T43 result of the baseline run; absent until the baseline track completes. */
  baseline?: Readonly<BaselineTrackResult>;
  /** Number of Public LB probes already consumed (projected from the ledger). */
  publicProbesUsed?: number;
  /** T42: number of external submissions already spent against submissionQuota (projected from the ledger). */
  submissionQuotaUsed?: number;
  /** T42: remaining external submissions allowed; undefined when the mission budgets no quota. */
  submissionQuotaRemaining?: number;
  evaluationControlSnapshotDigest?: string;
  gainBank?: readonly GainBankEntry[];
  branches: Record<string, BranchState>;
  champion?: MissionChampion;
  humanAcceptance?: HumanAcceptanceDecision;
  stopReason?: string;
}

export interface PromotionPolicyInput {
  candidate: PromotionCandidate;
  champion?: MissionState["champion"];
  evaluationContract?: Readonly<NormalizedEvaluationContract>;
  gainBank?: readonly GainBankEntry[];
  /** T43: established strong-baseline score; local promotion must clear baseline + δ. */
  baselineScore?: number;
}

export interface PromotionPolicyDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

export type PromotionPolicy = (input: PromotionPolicyInput) => boolean | PromotionPolicyDecision;

export interface ToyMissionOptions {
  missionId: string;
  objective?: string;
  constraints?: Record<string, unknown>;
  budget?: MissionBudget;
  adapter?: ToyCompetitionAdapter;
  competitionAdapter?: ToyCompetitionAdapter;
  competitionId?: string;
  taskContract?: TaskContract;
  branchIds?: string[];
  runtime: ToyAgentRuntime;
  evaluate?: (snapshot: Readonly<CandidateSnapshot>) => EvaluationResult;
  promotionPolicy?: PromotionPolicy;
  policy?: {
    maxBranches: number;
    maxParallelBranches: number;
    maxAttempts?: number;
    quorum: number;
  };
  crashBeforeBranch?: string;
  /** Explicit prediction artifact required before a Candidate/BranchRun enters expensive execution. */
  prediction?: PredictionArtifact;
  /** Optional process/path policy used by the candidate boundary. */
  sandbox?: SandboxPolicy;
  /** Optional layer-internal verification roles; none of these can promote. */
  verification?: VerificationHooks;
  /** Optional immutable control snapshot used by symmetric A/B evaluation. */
  evaluationControlSnapshot?: Readonly<CandidateSnapshot>;
  /** Alias for callers that name the control snapshot a baseline. */
  baselineSnapshot?: Readonly<CandidateSnapshot>;
  /** Optional EnvHarness-style agent-readable evaluation information flow. Off by default. */
  evaluationFeedback?: EvaluationFeedbackOptions;
  /** Bound evaluation-run budget; a lower value leaves the ladder incomplete and non-promotable. */
  evaluationMaxRuns?: number;
  maxEvaluationRuns?: number;
  /** Optional replayable model economics via ModelOrchestra; unset/null = unconfigured (one default model). */
  orchestra?: OrchestraConfig | null;
  /** Read-only model catalog the orchestra validates tiers against; wiring it activates the mission seam. */
  modelCatalog?: ModelCatalog;
  /** Pattern-level model_mix/deep_gates policy resolved per role session. */
  pattern?: PatternModelPolicy;
  /** Operator tier override for every role session; honored only when Policy Guard + budget allow. */
  forcedTier?: TierId;
  /**
   * Promotion-gate cross-model agreement (spec #27 decision 7): the harness
   * requests two tiered evaluation attempts (fast + deep ModelConfigs) and
   * requires agreement before the existing promotion policy may run. The
   * orchestra only supplies the two ModelConfigs — it never decides the
   * champion or a submission. Requires modelCatalog + bound fast/deep tiers
   * and a runtime.crossModelCheck port; misconfig fails closed.
   */
  promotionCrossModel?: "both";
  secrets?: readonly string[];
  /**
   * Immutable plan/policy version this mission run executes under (spec #1
   * Graph Engineering 对照): re-plans must bump it, and every EdgeTraversal
   * record carries it. Defaults to 1.
   */
  planVersion?: number;
  /**
   * T43 forced strong-baseline track: overrides/declares the baseline when the
   * adapter exposes none. When active, heavy/scale candidate search is refused
   * until the baseline clears its success predicate, and local promotion must
   * beat `baseline + δ`.
   */
  baselineTrack?: BaselineTrackInput | BaselineTrackContract;
  /**
   * T44 methodology contracts (feature pipeline / OOF ensemble / split discipline).
   * May be a normalized bundle or a raw declaration; resolved fail-closed. The
   * adapter port is used when this is omitted.
   */
  methodologyContracts?: MethodologyContracts | MethodologyDeclaration;
}

function validateInteger(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidFence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validObjections(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validVerificationRoles(value: unknown): value is VerificationRole[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.includes("SelfVerifier") && value.includes("Falsifier")
    && value.every((role) => typeof role === "string" && VERIFICATION_ROLE_SET.has(role as VerificationRole));
}

/**
 * Content-addressed Evidence ids a verdict or evaluator record cites: the
 * committed snapshot, the evaluation digest, each evaluation-run digest, and
 * one observation ref per evaluator fact (same address space as reconciles).
 */
function evaluationEvidenceIds(evaluation: EvaluationResult, snapshot: CandidateSnapshot): string[] {
  const ids = new Set<string>();
  if (snapshot.digest) ids.add(`snapshot:${snapshot.digest}`);
  if (typeof evaluation.evaluationDigest === "string" && evaluation.evaluationDigest !== "") ids.add(`evaluation:${evaluation.evaluationDigest}`);
  for (const run of evaluation.runs ?? []) {
    if (typeof run.digest === "string" && run.digest !== "") ids.add(`evaluation-run:${run.digest}`);
  }
  for (const fact of evaluation.facts ?? []) {
    if (typeof fact.name === "string" && fact.name.trim() !== "") ids.add(`${evaluationDigest(evaluation)}:observation:${fact.name}`);
  }
  return [...ids];
}

function validEvidenceIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

/** Exact ordered match: the ids a verdict cites must equal the recomputed ids of the verified evaluation. */
function sameEvidenceIds(actual: unknown, expected: readonly string[]): boolean {
  return validEvidenceIds(actual) && actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

/** Derives the trusted post-evaluation reconcile from a verified evaluation; shared by emission and replay. */
function deriveEvaluationReconcile(missionId: string, branchId: string, snapshot: Readonly<CandidateSnapshot>, evaluation: EvaluationResult, prediction: PredictionArtifact): ReconcileRecord | undefined {
  const facts = evaluation.facts ?? [{ name: "score", value: evaluation.score, source: "evaluator" }];
  const observations: Record<string, string | number | boolean> = {};
  const observationRefs: string[] = [];
  const seen = new Set<string>();
  // Refs are content-addressed: observations address the durable verified evaluation facts (by
  // evaluation digest) and the artifact ref addresses the committed snapshot by its integrity digest.
  for (const fact of facts) {
    if (typeof fact.name !== "string" || fact.name.trim() === "" || seen.has(fact.name)) continue;
    seen.add(fact.name);
    observations[fact.name] = fact.value;
    observationRefs.push(`${evaluationDigest(evaluation)}:observation:${fact.name}`);
  }
  const evaluatorId = typeof evaluation.evaluatorId === "string" && evaluation.evaluatorId.trim() !== "" ? evaluation.evaluatorId : undefined;
  const gate = evaluatorId !== undefined;
  return reconcilePrediction({
    prediction,
    observations,
    observationRefs,
    evidenceRefs: observationRefs,
    artifactRefs: [`snapshot:${snapshot.digest}`],
    evaluatorId,
    independentEvaluator: gate,
    evidenceGatePassed: gate,
    score: evaluation.score,
    reconcileId: `${missionId}:${snapshot.provenance.candidateId}:reconcile`,
    taskId: branchId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function minimumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function validateBudget(budget: MissionBudget, source: string): void {
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined) validateInteger(`${source}.${name}`, value, name === "maxAttempts" ? 1 : 0);
  }
}

function validateOptions(options: ToyMissionOptions, branchIds: string[], budget: MissionBudget): void {
  if (branchIds.some((branchId) => typeof branchId !== "string" || branchId.trim() === "") || new Set(branchIds).size !== branchIds.length) {
    throw new RangeError("branchIds must contain unique, non-empty strings");
  }
  validateBudget(budget, "budget");
  const evaluationMaxRuns = options.evaluationMaxRuns ?? options.maxEvaluationRuns;
  if (evaluationMaxRuns !== undefined) validateInteger("evaluationMaxRuns", evaluationMaxRuns, 1);
  const policy = options.policy;
  if (!policy) return;
  validateInteger("policy.maxBranches", policy.maxBranches, 1);
  validateInteger("policy.maxParallelBranches", policy.maxParallelBranches, 1);
  if (policy.maxAttempts !== undefined) validateInteger("policy.maxAttempts", policy.maxAttempts, 1);
  validateInteger("policy.quorum", policy.quorum, 1);
  if (policy.maxParallelBranches > policy.maxBranches) throw new RangeError("maxParallelBranches cannot exceed maxBranches");
  if (policy.quorum > Math.min(policy.maxBranches, branchIds.length)) throw new RangeError("quorum cannot exceed available branches");
}

const DEFAULT_VERIFICATION_ROLES: readonly VerificationRole[] = Object.freeze(["SelfVerifier", "Falsifier"]);
const VERIFICATION_ROLE_SET = new Set<VerificationRole>([
  "SelfVerifier", "Falsifier", "Critic", "Challenger", "Auditor", "SuccessAuditor", "KillTester",
]);

function configuredVerificationRoles(options: ToyMissionOptions): VerificationRole[] {
  const roles: VerificationRole[] = [...DEFAULT_VERIFICATION_ROLES];
  if (typeof options.verification?.critic === "function" || typeof options.runtime.critic === "function") roles.push("Critic");
  if (typeof options.verification?.challenger === "function" || typeof options.runtime.challenger === "function") roles.push("Challenger");
  if (typeof options.verification?.auditor === "function" || typeof options.runtime.auditor === "function") roles.push("Auditor");
  if (typeof options.verification?.successAuditor === "function" || typeof options.runtime.successAuditor === "function") roles.push("SuccessAuditor");
  if (typeof options.verification?.killTestHang === "function") roles.push("KillTester");
  return roles;
}

function trustedControlSnapshot(snapshot: Readonly<CandidateSnapshot>, contract: Readonly<TaskContract>): Readonly<CandidateSnapshot> {
  try {
    if (!isPlainRecord(snapshot) || !isPlainRecord(snapshot.files) || !isPlainRecord(snapshot.contract) || !isPlainRecord(snapshot.provenance)) {
      throw new TrustViolation("evaluation control snapshot is malformed");
    }
    const manifest = assertSnapshotIntegrity(snapshot as unknown as Record<string, unknown>);
    if (manifest.contractDigest !== digestValue(contract)) throw new TrustViolation("evaluation control snapshot uses another task contract");
    return deepFreeze(clone(snapshot)) as Readonly<CandidateSnapshot>;
  } catch (error) {
    if (error instanceof TrustViolation) throw error;
    throw new TrustViolation("evaluation control snapshot failed integrity validation");
  }
}

function initialState(event: MissionEvent): MissionState {
  const p = event.payload;
  const branchIds = Array.isArray(p.branchIds) ? p.branchIds.filter((branchId): branchId is string => typeof branchId === "string") : [];
  const roles = validVerificationRoles(p.verificationRoles) ? [...p.verificationRoles] : [...DEFAULT_VERIFICATION_ROLES];
  const quorum = isValidFence(p.quorum) ? p.quorum : 1;
  if (typeof p.contractDigest !== "string" || p.contractDigest.trim() === "") {
    throw new TrustViolation("mission contract digest is required");
  }
  if (!isPlainRecord(p.contract) || typeof p.contract.objective !== "string" || p.contract.objective.trim() === "") {
    throw new TrustViolation("mission contract is required");
  }
  try {
    if (digestValue(p.contract) !== p.contractDigest) {
      throw new TrustViolation("mission contract digest does not match its contents");
    }
  } catch (error) {
    if (error instanceof TrustViolation) throw error;
    throw new TrustViolation("mission contract is not digestable");
  }
  let evaluationContract: Readonly<NormalizedEvaluationContract> | undefined;
  let evaluationDigest: string | undefined;
  let evaluationControlSnapshotDigest: string | undefined;
  if (p.evaluationControlSnapshotDigest !== undefined) {
    if (typeof p.evaluationControlSnapshotDigest !== "string" || p.evaluationControlSnapshotDigest.trim() === "") {
      throw new TrustViolation("evaluation control snapshot digest is malformed");
    }
    evaluationControlSnapshotDigest = p.evaluationControlSnapshotDigest;
  }
  const predictions: Record<string, PredictionArtifact> = {};
  if (p.predictions !== undefined) {
    if (!isPlainRecord(p.predictions)) throw new TrustViolation("mission predictions are malformed");
    for (const branchId of branchIds) {
      const value = p.predictions[branchId];
      if (value === undefined) continue;
      try {
        predictions[branchId] = deepFreeze(clone(normalizePrediction(value, `${String(p.missionId)}:${branchId}:prediction`))) as PredictionArtifact;
      } catch {
        throw new TrustViolation(`branch prediction is malformed: ${branchId}`);
      }
    }
  }
  if (p.evaluationContract !== undefined || p.evaluationContractDigest !== undefined) {
    try {
      evaluationContract = normalizeEvaluationContract(p.evaluationContract as EvaluationContract);
      evaluationDigest = typeof p.evaluationContractDigest === "string"
        ? p.evaluationContractDigest
        : evaluationContractDigest(evaluationContract);
      if (evaluationDigest !== evaluationContractDigest(evaluationContract)) {
        throw new TrustViolation("evaluation contract digest does not match its contents");
      }
    } catch (error) {
      if (error instanceof TrustViolation) throw error;
      throw new TrustViolation("evaluation contract is malformed");
    }
  }
  return {
    missionId: String(p.missionId),
    phase: "CREATED",
    objective: String(p.objective),
    constraints: clone((p.constraints as Record<string, unknown>) ?? {}),
    budget: clone((p.budget as MissionBudget) ?? {}),
    adapterName: String(p.adapterName ?? "toy"),
    competitionId: String(p.competitionId ?? p.adapterName ?? "toy"),
    quorum,
    verificationRoles: Object.freeze(roles),
    contractDigest: p.contractDigest,
    evaluationFeedbackEnabled: p.evaluationFeedbackEnabled === true,
    ...(evaluationContract === undefined ? {} : { evaluationContract, evaluationContractDigest: evaluationDigest }),
    ...(p.validationLadder === undefined ? {} : {
      validationLadder: isValidationLadderContract(p.validationLadder)
        ? p.validationLadder
        : resolveValidationLadder({ validation_ladder: p.validationLadder as ValidationLadderInput }),
    }),
    ...(p.baselineTrack === undefined ? {} : {
      baselineTrack: isBaselineTrackContract(p.baselineTrack)
        ? p.baselineTrack
        : resolveBaselineTrack({ baseline_track: p.baselineTrack as BaselineTrackInput }),
    }),
    ...(evaluationControlSnapshotDigest === undefined ? {} : { evaluationControlSnapshotDigest }),
    gainBank: [],
    branches: Object.fromEntries(branchIds.map((branchId) => [branchId, {
      branchId, status: "QUEUED", attempt: 0, candidateGenerated: false,
      agentCompleted: false, evaluatorSucceeded: false, verification: {},
      ...(predictions[branchId] === undefined ? {} : { prediction: predictions[branchId] }),
    } satisfies BranchState])),
  };
}

function isValidSnapshot(snapshot: unknown, state: MissionState, branch: BranchState, eventFence: number): snapshot is CandidateSnapshot {
  if (!isPlainRecord(snapshot)) return false;
  const candidate = snapshot as Partial<CandidateSnapshot>;
  const provenance = candidate.provenance;
  if (!(typeof candidate.missionId === "string"
    && candidate.missionId === state.missionId
    && typeof candidate.branchId === "string"
    && candidate.branchId === branch.branchId
    && isValidAttempt(candidate.attempt)
    && candidate.attempt === branch.attempt
    && isPlainRecord(candidate.files)
    && Object.values(candidate.files).every((value) => typeof value === "string")
    && isPlainRecord(candidate.contract)
    && typeof candidate.contract.objective === "string"
    && isPlainRecord(provenance)
    && provenance.runId === `${state.missionId}:${branch.branchId}:${branch.attempt}`
    && provenance.candidateId === `${branch.branchId}:${branch.attempt}`
    && isValidFence(provenance.fencingToken)
    && provenance.fencingToken === branch.fencingToken
    && provenance.fencingToken === eventFence
    && typeof candidate.digest === "string"
    && typeof candidate.filesDigest === "string"
    && typeof candidate.contractDigest === "string"
    && candidate.contractDigest === state.contractDigest
    && branch.candidateFilesDigest === candidate.filesDigest
    && (candidate.ideaType === undefined || candidate.ideaType === candidate.contract.ideaType))) return false;
  try {
    assertSnapshotIntegrity(candidate);
    return true;
  } catch {
    return false;
  }
}

const verificationEventRoles: Readonly<Record<string, VerificationRole>> = Object.freeze({
  FALSIFIER_COMPLETED: "Falsifier",
  CRITIC_COMPLETED: "Critic",
  CHALLENGER_COMPLETED: "Challenger",
  AUDITOR_COMPLETED: "Auditor",
  SUCCESS_AUDITOR_COMPLETED: "SuccessAuditor",
  KILL_TESTER_COMPLETED: "KillTester",
});

function validFacts(value: unknown): value is ScoreFact[] {
  return Array.isArray(value) && value.every((fact) => isPlainRecord(fact)
    && typeof fact.name === "string"
    && (typeof fact.value === "string" || typeof fact.value === "boolean" || typeof fact.value === "number" && Number.isFinite(fact.value))
    && (fact.source === undefined || typeof fact.source === "string"));
}

function sameFacts(left: unknown, right: unknown): boolean {
  try { return digestValue(left) === digestValue(right); } catch { return false; }
}

function validEvaluationRunFact(
  value: unknown,
  state: MissionState,
  branch: BranchState,
  configuredControlSnapshotDigest?: string,
): value is EvaluationRunFact {
  const contract = state.evaluationContract;
  const snapshot = branch.snapshot;
  if (!contract || !snapshot || !isPlainRecord(value)) return false;
  const run = value as unknown as EvaluationRunFact;
  const step = contract.escalationLadder.find((entry) => entry.stage === run.stage);
  const controlDigest = configuredControlSnapshotDigest
    ?? state.evaluationControlSnapshotDigest
    ?? state.champion?.snapshot.digest
    ?? snapshot.digest;
  if (!step || typeof run.runId !== "string" || typeof run.seed !== "number" || !Number.isSafeInteger(run.seed)
    || (run.side !== "candidate" && run.side !== "control") || run.side === "control" && run.stage !== "symmetric-a-b"
    || typeof run.repeat !== "number" || !Number.isSafeInteger(run.repeat) || run.repeat < 0 || run.repeat >= step.repeats
    || typeof run.score !== "number" || !Number.isFinite(run.score)
    || (run.facts !== undefined && !validFacts(run.facts))
    || run.candidateSnapshotDigest !== snapshot.digest || run.snapshotDigest !== (run.side === "candidate" ? snapshot.digest : controlDigest)
    || run.controlSnapshotDigest !== controlDigest || run.taskContractDigest !== state.contractDigest
    || run.contractDigest !== state.contractDigest || run.evaluationContractDigest !== evaluationContractDigest(contract)
    || run.protocolDigest !== evaluationContractDigest(contract)
    || typeof run.evaluatorId !== "string" || run.evaluatorId.trim() === ""
    || typeof run.evaluatorVersion !== "string" || run.evaluatorVersion.trim() === ""
    || run.runId !== evaluationRunId(state.missionId, branch.branchId, branch.attempt, run.stage, run.side, run.repeat)
    || run.seed !== evaluationSeed(state.missionId, branch.branchId, snapshot.digest, evaluationContractDigest(contract), contract.seed, run.stage, run.repeat)
    || typeof run.digest !== "string" || run.digest.trim() === "") return false;
  const { digest: _digest, ...withoutDigest } = run as unknown as Record<string, unknown>;
  return evaluationRunDigest(withoutDigest as Omit<EvaluationRunFact, "digest">) === run.digest;
}

function evaluationDigest(value: EvaluationResult): string {
  const { evaluationDigest: _evaluationDigest, trustedScore: _trustedScore, feedbackView: _feedbackView, ...content } = value;
  return digestValue(content);
}

function trustedScoreFromEvaluation(evaluation: EvaluationResult, snapshot: Readonly<CandidateSnapshot>): TrustedScore {
  if (typeof evaluation.evaluationDigest !== "string" || typeof snapshot.digest !== "string" || typeof snapshot.contractDigest !== "string") {
    throw new TrustViolation("trusted evaluation is missing immutable identity");
  }
  return deepFreeze({
    kind: "trusted_score",
    score: evaluation.score,
    evaluationDigest: evaluation.evaluationDigest,
    snapshotDigest: snapshot.digest,
    contractDigest: snapshot.contractDigest,
  });
}

function feedbackViewFromEvaluation(evaluation: EvaluationResult, snapshot: Readonly<CandidateSnapshot>): EvaluationFeedbackView {
  const trusted = trustedScoreFromEvaluation(evaluation, snapshot);
  return deepFreeze({
    kind: "feedback_view",
    stage: "evaluation",
    score: trusted.score,
    facts: clone(evaluation.facts ?? []),
    contractDigest: trusted.contractDigest,
    sourceEvaluationDigest: trusted.evaluationDigest,
    chain: Object.freeze([`trusted_score:${trusted.evaluationDigest}`]),
  });
}

function sameRunFacts(left: readonly EvaluationRunFact[] | undefined, right: readonly EvaluationRunFact[], requirePresent = false): boolean {
  if (left === undefined) return !requirePresent;
  if (left.length !== right.length) return false;
  return left.every((run, index) => run.digest === right[index]?.digest);
}

function withEvaluationLadderAlias(evaluation: EvaluationResult): EvaluationResult {
  if (evaluation.ladder === undefined || Object.prototype.hasOwnProperty.call(evaluation, "evaluationLadder")) return evaluation;
  Object.defineProperty(evaluation, "evaluationLadder", {
    value: evaluation.ladder,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return evaluation;
}

function verifiedEvaluationFromPayload(state: MissionState, branch: BranchState, payload: Record<string, unknown>): EvaluationResult | undefined {
  if (!branch.snapshot || !isFiniteNumber(payload.score) || !validFacts(payload.facts)
    || typeof payload.evaluatorId !== "string" || payload.evaluatorId.trim() === ""
    || typeof payload.evaluatorVersion !== "string" || payload.evaluatorVersion.trim() === ""
    || typeof payload.snapshotDigest !== "string" || payload.snapshotDigest !== branch.snapshot.digest
    || typeof payload.contractDigest !== "string" || payload.contractDigest !== branch.snapshot.contractDigest) return undefined;
  const payloadScore = payload.score;
  const payloadFacts = payload.facts;
  const payloadEvaluatorId = payload.evaluatorId as string;
  const payloadEvaluatorVersion = payload.evaluatorVersion as string;
  const payloadSnapshotDigest = payload.snapshotDigest as string;
  const payloadContractDigest = payload.contractDigest as string;
  if (!state.evaluationContract) {
    const evaluation: EvaluationResult = {
      score: payloadScore,
      facts: clone(payloadFacts),
      evaluatorId: payloadEvaluatorId,
      evaluatorVersion: payloadEvaluatorVersion,
      snapshotDigest: payloadSnapshotDigest,
      contractDigest: payloadContractDigest,
      ...(payload.validationLevel === undefined ? {} : { validationLevel: normaliseValidationLevel(payload.validationLevel) }),
    };
    return { ...evaluation, evaluationDigest: evaluationDigest(evaluation) };
  }
  const ladder = payload.ladder ?? payload.evaluationLadder;
  if (!validateEvaluationLadder(ladder, {
    contract: state.evaluationContract,
    missionId: state.missionId,
    branchId: branch.branchId,
    attempt: branch.attempt,
    taskContractDigest: state.contractDigest,
    candidateSnapshotDigest: branch.snapshot.digest,
    controlSnapshotDigest: state.evaluationControlSnapshotDigest
      ?? state.champion?.snapshot.digest
      ?? branch.snapshot.digest,
    championScore: state.champion?.score,
  })) return undefined;
  if (ladder.evaluatorId !== payloadEvaluatorId || ladder.evaluatorVersion !== payloadEvaluatorVersion
    || typeof payload.evaluationContractDigest !== "string" || payload.evaluationContractDigest !== state.evaluationContractDigest
    || typeof payload.evaluationContractVersion !== "string" || payload.evaluationContractVersion !== state.evaluationContract.version
    || payloadScore !== ladder.promotionScore
    || payload.officialScore !== ladder.officialScore
    || payload.promotionScore !== ladder.promotionScore
    || typeof payload.evaluationDigest !== "string") return undefined;
  const evaluation: EvaluationResult = {
    score: payloadScore,
    facts: clone(payloadFacts),
    evaluatorId: payloadEvaluatorId,
    evaluatorVersion: payloadEvaluatorVersion,
    snapshotDigest: payloadSnapshotDigest,
    contractDigest: payloadContractDigest,
    evaluationContractDigest: payload.evaluationContractDigest as string,
    evaluationContractVersion: payload.evaluationContractVersion as string,
    officialScore: payload.officialScore as number,
    promotionScore: payload.promotionScore as number,
    runs: clone(ladder.runs),
    ladder: deepFreeze(clone(ladder)),
    evaluationDigest: payload.evaluationDigest as string,
    ...(payload.validationLevel === undefined ? {} : { validationLevel: normaliseValidationLevel(payload.validationLevel) }),
  };
  return evaluationDigest(evaluation) === payload.evaluationDigest ? withEvaluationLadderAlias(evaluation) : undefined;
}

function verificationComplete(state: MissionState, branch: BranchState): boolean {
  return state.verificationRoles.every((role) => branch.verification[role] === true);
}

/**
 * T45 claim-card promotion gate, shared by emission and replay: a promotion verdict
 * needs the finalized claim card plus evaluator evidence ids, no violated prediction,
 * and no uncleared objections — score alone never promotes. An unknown status (no
 * declared metrics) stays eligible for the existing policy; a violated one never does.
 */
function claimCardJustifiesPromotion(branch: BranchState): boolean {
  const card = branch.claimCard;
  return card !== undefined && card.status !== "violated" && card.evidenceGatePassed
    && card.evidenceRefs.length > 0 && card.objections.length === 0;
}

function project(events: readonly MissionEvent[]): MissionState {
  const created = events[0];
  if (!created || created.type !== "MISSION_CREATED" || created.sequence !== 1 || !isPlainRecord(created.payload)) {
    throw new Error("ledger must start with MISSION_CREATED at sequence 1");
  }
  const state = initialState(created);
  let expectedSequence = 2;
  let retryableFence: number | undefined;
  for (const event of events.slice(1)) {
    if (!isPlainRecord(event) || event.sequence !== expectedSequence || typeof event.type !== "string" || !isPlainRecord(event.payload)) break;
    expectedSequence += 1;
    const p = event.payload;
    if ((state.phase === "COMPLETED" || state.phase === "STOPPED")
      && event.type !== "HUMAN_ACCEPTED"
      && !["SUBMISSION_REQUESTED", "SUBMISSION_APPROVED", "SUBMISSION_REJECTED", "SUBMISSION_RESULT"].includes(event.type)) continue;
    const branchScoped = Object.prototype.hasOwnProperty.call(p, "branchId");
    if (branchScoped && typeof p.branchId !== "string") continue;
    const branch = branchScoped ? state.branches[p.branchId as string] : undefined;
    const eventFence = p.fencingToken;
    if (branchScoped && event.type !== "BRANCH_RESERVED" && !isValidFence(eventFence)) continue;
    if (branch && event.type !== "BRANCH_RESERVED" && eventFence !== branch.fencingToken) continue;
    if ((event.type === "SNAPSHOT_COMMITTED" || event.type === "PROMOTED_LOCAL")
      && (!branch || !isValidFence(eventFence) || !isValidSnapshot(p.snapshot, state, branch, eventFence))) continue;
    switch (event.type) {
      case "MISSION_STARTED":
        if (state.phase === "CREATED") state.phase = "RUNNING";
        break;
      case "BRANCH_RESERVED": {
        const attempt = p.attempt;
        const carriesSnapshot = !!branch && retryableFence === branch.fencingToken && branch.snapshot !== undefined;
        const carriedVerification = carriesSnapshot && branch ? { ...branch.verification } : {};
        const carriedFilesDigest = carriesSnapshot && branch ? branch.candidateFilesDigest ?? branch.snapshot?.filesDigest : undefined;
        if (state.phase === "RUNNING" && branch && isValidFence(eventFence) && isValidAttempt(attempt)
          && attempt === branch.attempt + 1
          && (branch.fencingToken === undefined || eventFence > branch.fencingToken)
          && !["PROMOTED_LOCAL", "REJECTED", "QUARANTINED"].includes(branch.status)
          && (branch.status !== "SCORED" || retryableFence === branch.fencingToken)) {
          branch.attempt = attempt;
          branch.fencingToken = eventFence;
          branch.status = "TASK_SELECTED";
          branch.candidateGenerated = false;
          branch.agentCompleted = false;
          branch.evaluatorSucceeded = false;
          branch.trustedScore = undefined;
          branch.feedbackView = undefined;
          branch.reconcile = undefined;
          branch.score = undefined;
          branch.facts = undefined;
          branch.snapshot = undefined;
          branch.candidateFilesDigest = carriedFilesDigest;
          branch.snapshotDigest = undefined;
          branch.contractDigest = undefined;
          branch.evaluation = undefined;
          branch.evaluationRuns = undefined;
          branch.evaluationContractDigest = undefined;
          branch.evaluationContractVersion = undefined;
          branch.evaluatorId = undefined;
          branch.evaluatorVersion = undefined;
          branch.promotionDecision = undefined;
          branch.objections = undefined;
          branch.rejectionReason = undefined;
          branch.verification = carriedVerification;
          retryableFence = undefined;
        }
        break;
      }
      case "PREFLIGHT_SELF_CHECK_PASSED":
        if (branch && branch.status === "TASK_SELECTED" && p.ok === true && validObjections(p.objections ?? [])) {
          branch.status = "PREFLIGHT_SELF_CHECK";
          branch.verification.SelfVerifier = true;
        }
        break;
      case "PREFLIGHT_SELF_CHECK_FAILED":
        if (branch && branch.status === "TASK_SELECTED" && p.ok !== true && validObjections(p.objections ?? [])) {
          branch.verification.SelfVerifier = false;
          branch.status = "REJECTED";
          branch.objections = clone(p.objections as string[]);
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "self-check failed";
        }
        break;
      case "AGENT_COMPLETED":
        if (branch && branch.status === "PREFLIGHT_SELF_CHECK" && p.ok === true) branch.agentCompleted = true;
        break;
      case "CANDIDATE_GENERATED": {
        let filesDigest: string | undefined;
        try {
          if (isPlainRecord(p.files)) filesDigest = digestValue(p.files);
        } catch {
          filesDigest = undefined;
        }
        if (branch && branch.status === "PREFLIGHT_SELF_CHECK" && branch.agentCompleted
          && filesDigest !== undefined && p.filesDigest === filesDigest
          && Object.values(p.files as Record<string, unknown>).every((value) => typeof value === "string")) {
          branch.candidateGenerated = true;
          branch.candidateFilesDigest = filesDigest;
          branch.status = "CANDIDATE_PROPOSED";
        }
        break;
      }
      case "CANDIDATE_MATERIALIZED":
        if (branch && branch.status === "CANDIDATE_PROPOSED" && branch.candidateGenerated) {
          branch.status = "MATERIALIZED";
          if (branch.prediction) branch.claimCard = createClaimCard(branch.prediction, `${branch.branchId}:${branch.attempt}:claim`);
        }
        break;
      case "SNAPSHOT_COMMITTED": {
        if (!branch) break;
        const snapshot = p.snapshot as CandidateSnapshot;
        const duplicate = branch.snapshot?.digest === snapshot.digest;
        const recoverable = branch.status === "TASK_SELECTED" && p.recovered === true;
        if (duplicate && branch.status === "RUNNING") break;
        if (!(branch.status === "MATERIALIZED" || recoverable)) break;
        branch.snapshot = deepFreeze(clone(snapshot));
        branch.snapshotDigest = branch.snapshot.digest;
        branch.contractDigest = branch.snapshot.contractDigest;
        branch.status = "RUNNING";
        break;
      }
      case "EVALUATION_STARTED":
        if (branch && branch.snapshot && branch.status === "RUNNING") branch.status = "VERIFYING";
        break;
      case "EVALUATION_RUN_COMPLETED": {
        const run = p.run;
        if (branch && branch.status === "VERIFYING" && validEvaluationRunFact(run, state, branch)
          && !(branch.evaluationRuns ?? []).some((entry) => entry.runId === (run as EvaluationRunFact).runId)) {
          branch.evaluationRuns = Object.freeze([...(branch.evaluationRuns ?? []), deepFreeze(clone(run as EvaluationRunFact))]);
        }
        break;
      }
      case "FEEDBACK_VIEW_CREATED": {
        if (!branch || branch.status !== "SCORED" || !state.evaluationFeedbackEnabled
          || branch.feedbackView !== undefined || !branch.evaluation || !branch.snapshot || p.snapshotDigest !== branch.snapshot.digest) break;
        const feedbackView = p.feedback_view;
        const expected = feedbackViewFromEvaluation(branch.evaluation, branch.snapshot);
        if (!isPlainRecord(feedbackView) || !sameFacts(feedbackView, expected)) break;
        branch.feedbackView = expected;
        break;
      }
      case "EVALUATOR_SUCCEEDED": {
        if (!branch || !branch.snapshot || branch.status !== "VERIFYING") break;
        const evaluation = verifiedEvaluationFromPayload(state, branch, p);
        if (!evaluation) break;
        if (state.evaluationContract && !sameRunFacts(branch.evaluationRuns, evaluation.ladder?.runs ?? [], true)) break;
        branch.evaluatorSucceeded = true;
        branch.trustedScore = trustedScoreFromEvaluation(evaluation, branch.snapshot);
        branch.score = evaluation.score;
        branch.facts = clone(evaluation.facts ?? []);
        branch.evaluation = deepFreeze(clone(evaluation));
        branch.evaluationRuns = evaluation.runs === undefined ? branch.evaluationRuns : deepFreeze(clone(evaluation.runs));
        branch.evaluationContractDigest = evaluation.evaluationContractDigest;
        branch.evaluationContractVersion = evaluation.evaluationContractVersion;
        branch.evaluatorId = evaluation.evaluatorId;
        branch.evaluatorVersion = evaluation.evaluatorVersion;
        branch.status = "SCORED";
        break;
      }
      case "RECONCILED": {
        // Trusted reconciles are fully re-derived from the branch's verified evaluation: the projected
        // reconcile must match a fresh derive from the trusted evaluation (status, refs, evaluator
        // identity, and snapshot binding), so payload relabeling is rejected.
        // Failure reconciles are only admitted as inconclusive, gate-free records whose observation ref
        // is content-addressed to the reported evaluator-failure reason, and only while evaluation was
        // actually in flight (VERIFYING/SCORED).
        if (!branch || !branch.prediction || branch.reconcile !== undefined) break;
        try {
          const reconcile = normalizeReconcile({ ...(p.reconcile as Record<string, unknown> ?? {}), taskId: branch.branchId }, branch.prediction);
          const trusted = !!branch.evaluation && branch.evaluatorSucceeded && !!branch.snapshot;
          if (trusted) {
            const expected = deriveEvaluationReconcile(state.missionId, branch.branchId, branch.snapshot!, branch.evaluation!, branch.prediction);
            if (!expected || digestValue(expected) !== digestValue(reconcile)) break;
          } else {
            if (reconcile.status !== "inconclusive" || reconcile.evidenceGatePassed) break;
            if (branch.status !== "VERIFYING" && branch.status !== "SCORED") break;
            if (typeof p.failureReason !== "string" || !branch.snapshot || reconcile.observationRefs.length !== 1
              || reconcile.observationRefs[0] !== `evaluator-failed:${digestValue({ candidateId: branch.snapshot.provenance.candidateId, reason: p.failureReason })}`) break;
          }
          branch.reconcile = deepFreeze(clone(reconcile));
          branch.claimCard = deepFreeze(clone(reconcile.claim));
        } catch { break; }
        break;
      }
      case "EVALUATOR_FAILED":
        if (branch && (branch.status === "VERIFYING" || branch.status === "SCORED")
          && typeof p.reason === "string" && p.reason.trim() !== "") {
          branch.objections = [p.reason];
        }
        break;
      case "LEAKAGE_DISCLOSURE":
        // disclose_only (T40): an auditable Evidence event. It never changes branch status,
        // objections, evaluation, or promotion — the event ledger itself is the audit record;
        // replay projects branch state from verdicts, not from observations (docs/ledger-event-types.md).
        break;
      case "RETRY_SCHEDULED":
        if (branch && (branch.status === "VERIFYING" || branch.status === "SCORED")
          && isValidFence(eventFence) && eventFence === branch.fencingToken
          && isValidAttempt(p.nextAttempt) && p.nextAttempt === branch.attempt + 1
          && typeof p.reason === "string" && p.reason.trim() !== "") retryableFence = eventFence;
        break;
      case "FALSIFIER_COMPLETED":
      case "CRITIC_COMPLETED":
      case "CHALLENGER_COMPLETED":
      case "AUDITOR_COMPLETED":
      case "SUCCESS_AUDITOR_COMPLETED":
      case "KILL_TESTER_COMPLETED": {
        const role = verificationEventRoles[event.type];
        if (!branch || !role || !state.verificationRoles.includes(role) || p.role !== role
          || typeof p.ok !== "boolean" || !validObjections(p.objections) || !branch.snapshot
          || p.snapshotDigest !== branch.snapshot.digest
          || p.contractDigest !== branch.snapshot.contractDigest
          || branch.verification[role] !== undefined) break;
        const early = role === "Falsifier" || role === "Critic" || role === "Challenger";
        if (early ? !["VERIFYING", "SCORED"].includes(branch.status) : branch.status !== "SCORED") break;
        branch.verification[role] = p.ok;
        branch.objections = clone(p.objections);
        // Claim-card objection write-back (T45): role objections become durable, structured
        // ClaimObjection entries on the candidate's card so the next expansion sees them even
        // when the branch is rejected or discarded.
        if (branch.claimCard && validObjections(p.objections)) {
          branch.claimCard = deepFreeze(clone({
            ...branch.claimCard,
            objections: [
              ...branch.claimCard.objections,
              ...(p.objections as string[]).map((statement, index) => ({
                objectionId: `${branch.branchId}:${role.toLowerCase()}:${index + 1}`,
                source: role,
                statement,
                evidenceRefs: [],
              })),
            ],
          })) as ClaimCard;
        }
        if (!p.ok) {
          branch.status = "REJECTED";
          branch.rejectionReason = `${role} objection`;
        }
        break;
      }
      case "GAIN_BANKED": {
        const evaluation = branch?.evaluation;
        const champion = state.champion;
        const amount = p.amount;
        if (state.evaluationContract && branch && branch.status === "SCORED" && evaluation?.evaluationDigest
          && champion && typeof amount === "number" && Number.isFinite(amount) && amount > 0
          && p.branchId === branch.branchId
          && p.championBranchId === champion.branchId
          && p.championDigest === champion.snapshot.digest
          && p.evaluationDigest === evaluation.evaluationDigest
          && p.evaluationContractDigest === state.evaluationContractDigest
          && p.evaluationContractVersion === state.evaluationContract.version
          && p.candidateScore === branch.score && p.championScore === champion.score
          && amount <= (state.evaluationContract?.marginPolicy.microGain ?? 0)) {
          const candidateScore = branch.score;
          const evaluationDigestValue = evaluation.evaluationDigest;
          if (typeof candidateScore !== "number" || typeof evaluationDigestValue !== "string" || typeof state.evaluationContractDigest !== "string") break;
          const entry: GainBankEntry = {
            branchId: branch.branchId,
            championBranchId: champion.branchId,
            championDigest: champion.snapshot.digest!,
            amount,
            candidateScore,
            championScore: champion.score,
            evaluationDigest: evaluationDigestValue,
            evaluationContractDigest: state.evaluationContractDigest,
            evaluationContractVersion: state.evaluationContract.version,
          };
          state.gainBank = [...(state.gainBank ?? []), deepFreeze(clone(entry))];
          branch.promotionDecision = "gain-banked";
        }
        break;
      }
      case "BRANCH_REJECTED":
        if (branch && branch.status !== "PROMOTED_LOCAL" && branch.status !== "QUARANTINED") {
          branch.status = "REJECTED";
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "rejected";
          branch.promotionDecision = branch.rejectionReason;
        }
        break;
      case "BRANCH_QUARANTINED":
        if (branch && branch.status !== "PROMOTED_LOCAL" && branch.status !== "REJECTED") {
          branch.status = "QUARANTINED";
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "sandbox or trust violation";
          branch.objections = validObjections(p.objections) ? clone(p.objections) : [branch.rejectionReason];
        }
        break;
      case "PROMOTED_LOCAL": {
        const promotedSnapshot = p.snapshot as CandidateSnapshot;
        const evaluation = branch?.evaluation;
        const ladder = evaluation?.ladder;
        const protocolValid = !state.evaluationContract || !!(evaluation && ladder?.complete === true
          && p.evaluationContractDigest === state.evaluationContractDigest
          && p.evaluationContractVersion === state.evaluationContract.version
          && p.evaluationDigest === evaluation.evaluationDigest
          && p.ladderDigest === ladder.digest);
        if (!branch || branch.status !== "SCORED" || !branch.evaluatorSucceeded || !verificationComplete(state, branch)
          || !protocolValid || p.branchId !== branch.branchId || !branch.snapshot
          // A promotion without a verifiable evaluation ref or evidence ids is
          // a forged verdict and never produces a champion (T46).
          || evaluation === undefined || typeof p.evaluationRef !== "string" || p.evaluationRef.trim() === ""
          || p.evaluationRef !== evaluationDigest(evaluation)
          || !sameEvidenceIds(p.evidenceIds, evaluationEvidenceIds(evaluation, promotedSnapshot))
          // T45: even a payload-perfect verdict cannot champion when the projected
          // claim card is missing, violated, ungated, or carries uncleared objections.
          || !claimCardJustifiesPromotion(branch)
          || promotedSnapshot.digest !== branch.snapshot.digest
          || p.snapshotDigest !== branch.snapshot.digest || p.contractDigest !== branch.snapshot.contractDigest
          || !isFiniteNumber(p.score) || p.score !== branch.score || !validFacts(p.facts)
          || !sameFacts(p.facts, branch.facts)
          || state.evaluationContract !== undefined && (
            typeof p.evaluatorId !== "string" || p.evaluatorId !== branch.evaluatorId
            || typeof p.evaluatorVersion !== "string" || p.evaluatorVersion !== branch.evaluatorVersion
            || p.evaluationContractVersion !== branch.evaluationContractVersion
          )) break;
        branch.status = "PROMOTED_LOCAL";
        if (state.champion?.snapshot.digest !== promotedSnapshot.digest) state.humanAcceptance = undefined;
        state.champion = {
          branchId: branch.branchId, score: p.score, facts: clone(p.facts),
          snapshot: deepFreeze(clone(promotedSnapshot)),
          ...(evaluation === undefined ? {} : { evaluation: deepFreeze(clone(evaluation)), ladder: deepFreeze(clone(ladder)) }),
          ...(state.evaluationContractDigest === undefined ? {} : { evaluationContractDigest: state.evaluationContractDigest }),
          ...(typeof p.evaluationContractVersion === "string" ? { evaluationContractVersion: p.evaluationContractVersion } : {}),
          ...(typeof p.evaluatorId === "string" ? { evaluatorId: p.evaluatorId } : {}),
          ...(typeof p.evaluatorVersion === "string" ? { evaluatorVersion: p.evaluatorVersion } : {}),
        };
        break;
      }
      case "HUMAN_ACCEPTED":
        if (state.champion && typeof p.championDigest === "string" && p.championDigest === state.champion.snapshot.digest
          && typeof p.acceptedBy === "string" && p.acceptedBy.trim() !== ""
          && typeof p.decisionId === "string" && p.decisionId.trim() !== ""
          && isFiniteNumber(p.acceptedAt)) {
          state.humanAcceptance = deepFreeze({
            championDigest: p.championDigest,
            ...(typeof p.artifactDigest === "string" ? { artifactDigest: p.artifactDigest } : {}),
            acceptedBy: p.acceptedBy,
            decisionId: p.decisionId,
            acceptedAt: p.acceptedAt,
            ...(typeof p.requestId === "string" ? { requestId: p.requestId } : {}),
            ...(isFiniteNumber(p.expiresAt) ? { expiresAt: p.expiresAt } : {}),
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          });
        }
        break;
      case "MISSION_COMPLETED":
        if (state.phase === "RUNNING" && Object.values(state.branches).filter((value) => value.status === "PROMOTED_LOCAL").length >= state.quorum) {
          state.phase = "COMPLETED";
        }
        break;
      case "MISSION_STOPPED":
        if (state.phase === "RUNNING" && typeof p.reason === "string" && p.reason.trim() !== "") {
          state.phase = "STOPPED";
          state.stopReason = p.reason;
        }
        break;
    }
  }
  // T41: spent Public LB probes are projected from evaluator-succeeded events.
  state.publicProbesUsed = publicProbesUsedFromEvents(events as readonly ValidationEventLike[]);
  // T42: spent submission quota and remaining balance are projected from external SUBMISSION_RESULT events.
  state.submissionQuotaUsed = externalSubmissionsFromEvents(events as readonly SubmissionEventLike[]);
  const quotaLimit = state.budget.submissionQuota;
  state.submissionQuotaRemaining = typeof quotaLimit === "number"
    ? Math.max(0, quotaLimit - state.submissionQuotaUsed) : undefined;
  // T43: the established strong baseline is the last baseline verdict (passed or failed).
  const baselineVerdict = [...events].reverse().find((event) => event.type === "BASELINE_TRACK_PASSED" || event.type === "BASELINE_TRACK_FAILED");
  if (baselineVerdict) {
    state.baseline = Object.freeze({
      ok: baselineVerdict.type === "BASELINE_TRACK_PASSED",
      ...(typeof baselineVerdict.payload.score === "number" ? { score: baselineVerdict.payload.score } : {}),
      ...(typeof baselineVerdict.payload.evidence === "string" ? { evidence: baselineVerdict.payload.evidence } : {}),
    }) as BaselineTrackResult;
  }
  return state;
}

/** Fixture/test facade. Not a second Mission control plane. */
export class ToyCompetitionHarness {
  private readonly ledger: MissionEvent[];
  private crashed = false;
  private readonly options: ToyMissionOptions;
  private readonly adapter: ToyCompetitionAdapter;
  private readonly orchestra?: ModelOrchestra;
  private readonly effectiveBudget: MissionBudget;
  private readonly sandbox: SandboxBoundary;
  private readonly redactor: SecretRedactor;
  private readonly evaluationContract?: Readonly<NormalizedEvaluationContract>;
  private readonly evaluationContractDigest?: string;
  /** T40 data honesty contract; undefined = gate inactive for this adapter. */
  private readonly dataHonesty?: Readonly<DataHonestyContract>;
  /** T41 validation ladder; undefined = the three-level split policy is inactive. */
  private readonly validationLadder?: Readonly<ValidationLadderContract>;
  /** T44 methodology contracts (feature pipeline / OOF ensemble / split discipline); undefined = inactive. */
  private readonly methodology?: Readonly<MethodologyContracts>;
  /** T43 strong-baseline track; undefined = baseline-first gate inactive. */
  private readonly baselineTrack?: Readonly<BaselineTrackContract>;
  private readonly evaluationControlSnapshot?: Readonly<CandidateSnapshot>;
  private readonly planVersion: number;
  private contractValue?: Readonly<TaskContract>;
  private readonly humanAcceptance = new HumanAcceptanceGate();

  constructor(options: ToyMissionOptions) {
    if (typeof options.missionId !== "string" || options.missionId.trim() === "") throw new TypeError("missionId is required");
    if (options.competitionId !== undefined && (typeof options.competitionId !== "string" || options.competitionId.trim() === "")) throw new TypeError("competitionId must be a non-empty string");
    this.options = options;
    if (options.modelCatalog !== undefined) {
      this.orchestra = new ModelOrchestra(options.modelCatalog, options.orchestra ?? null);
      // Fail closed before the mission starts: an invalid pattern (unknown deep
      // gates, bad mix), unbound or rejected forced tier, or missing default
      // model is a configuration error, not a per-branch runtime surprise
      // (spec #27 decision 20).
      this.orchestra.resolve({ pattern: options.pattern, forcedTier: options.forcedTier });
    } else if (options.orchestra !== undefined && options.orchestra !== null) {
      throw new TypeError("modelCatalog is required when orchestra tiers are configured");
    }
    if (options.promotionCrossModel !== undefined) {
      if (options.promotionCrossModel !== "both") {
        throw new TypeError('promotionCrossModel must be "both"');
      }
      if (!this.orchestra) {
        throw new TypeError("modelCatalog and orchestra tiers are required when promotionCrossModel is configured");
      }
      if ((options.pattern?.modelMix ?? DEFAULT_MODEL_MIX) === "flash_only") {
        throw new TypeError('promotionCrossModel "both" requires a model_mix that permits deep routing');
      }
      if (typeof options.runtime.crossModelCheck !== "function") {
        throw new TypeError("runtime.crossModelCheck is required when promotionCrossModel is configured");
      }
      // Fail closed: the dual fast+deep path must actually be bound.
      if (!this.orchestra.crossModelConfigs()) {
        throw new TypeError('promotionCrossModel "both" requires bound fast and deep tiers');
      }
    }
    this.sandbox = new SandboxBoundary({ ...options.sandbox, root: options.sandbox?.root ?? `/tmp/evok-${encodeURIComponent(options.missionId)}` });
    this.redactor = new SecretRedactor(options.secrets ?? []);
    this.adapter = options.adapter ?? options.competitionAdapter ?? { name: "toy", evaluate: options.evaluate ?? new ScoreFileToyCompetitionAdapter().evaluate.bind(new ScoreFileToyCompetitionAdapter()) };
    // Data honesty gate (T40): inactive when the adapter declares no contract; fail-closed on malformed declarations.
    this.dataHonesty = resolveDataHonestyContract(this.adapter);
    // Validation ladder (T41): inactive when the adapter declares none; fail-closed on a non-holdout basis or bad cap.
    this.validationLadder = resolveValidationLadder(this.adapter);
    // Methodology contracts (T44): inactive when the adapter declares none; fail-closed on malformed declarations.
    this.methodology = isMethodologyContracts(options.methodologyContracts)
      ? options.methodologyContracts as Readonly<MethodologyContracts>
      : resolveMethodologyContracts(this.adapter);
    // T43 baseline-first gate: resolve from the adapter port, or an explicit mission
    // option; inactive when neither declares a track. Malformed declarations fail closed.
    this.baselineTrack = isBaselineTrackContract(options.baselineTrack)
      ? options.baselineTrack
      : resolveBaselineTrack(this.adapter) ?? resolveBaselineTrack(
        options.baselineTrack === undefined ? undefined : { baseline_track: options.baselineTrack as BaselineTrackInput },
      );
    const resolvedEvaluationContract = resolveEvaluationContract(this.adapter);
    this.evaluationContract = resolvedEvaluationContract;
    this.evaluationContractDigest = resolvedEvaluationContract === undefined ? undefined : evaluationContractDigest(resolvedEvaluationContract);
    const contract = this.contract;
    const configuredControl = options.evaluationControlSnapshot ?? options.baselineSnapshot;
    this.evaluationControlSnapshot = configuredControl === undefined ? undefined : trustedControlSnapshot(configuredControl, contract);
    const branchIds = this.branchIds;
    const contractBudget = contract.budget ?? {};
    const topLevelBudget = options.budget ?? {};
    validateBudget(contractBudget, "taskContract.budget");
    validateBudget(topLevelBudget, "budget");
    const effectiveBudget: MissionBudget = {};
    for (const name of new Set([...Object.keys(contractBudget), ...Object.keys(topLevelBudget)])) {
      const value = minimumDefined(contractBudget[name], topLevelBudget[name]);
      if (value !== undefined) effectiveBudget[name] = value;
    }
    const maxCandidates = minimumDefined(effectiveBudget.maxCandidates, options.policy?.maxBranches);
    const maxAttempts = minimumDefined(effectiveBudget.maxAttempts, options.policy?.maxAttempts);
    if (maxCandidates !== undefined) effectiveBudget.maxCandidates = maxCandidates;
    if (maxAttempts !== undefined) effectiveBudget.maxAttempts = maxAttempts;
    this.effectiveBudget = effectiveBudget;
    validateOptions(options, branchIds, this.effectiveBudget);
    if (options.planVersion !== undefined) validateInteger("planVersion", options.planVersion, 1);
    this.planVersion = options.planVersion ?? 1;
    const prediction = options.prediction === undefined ? undefined
      : normalizePrediction(options.prediction, `${options.missionId}:prediction`);
    const maxBranches = this.effectiveBudget.maxCandidates ?? branchIds.length;
    const quorum = options.policy?.quorum ?? 1;
    if (quorum > Math.min(maxBranches, branchIds.length)) throw new RangeError("quorum cannot exceed available branches");
    this.ledger = [{
      sequence: 1,
      type: "MISSION_CREATED",
      payload: {
        missionId: options.missionId, objective: contract.objective, constraints: clone(contract.constraints ?? options.constraints ?? {}),
        budget: clone(this.effectiveBudget), branchIds, adapterName: this.adapter.name ?? "toy",
        competitionId: options.competitionId ?? this.adapter.name ?? "toy", quorum,
        contract: clone(contract), contractDigest: digestValue(contract),
        ...(this.evaluationContract === undefined ? {} : {
          evaluationContract: clone(this.evaluationContract),
          evaluationContractDigest: this.evaluationContractDigest,
        }),
        ...(this.validationLadder === undefined ? {} : {
          validationLadder: clone(this.validationLadder),
        }),
        ...(this.baselineTrack === undefined ? {} : {
          baselineTrack: clone(this.baselineTrack),
        }),
        ...(this.evaluationControlSnapshot === undefined ? {} : {
          evaluationControlSnapshotDigest: this.evaluationControlSnapshot.digest,
        }),
        verificationRoles: configuredVerificationRoles(options),
        planVersion: this.planVersion,
        evaluationFeedbackEnabled: this.options.evaluationFeedback?.enabled === true,
        ...(prediction === undefined ? {} : {
          predictions: Object.fromEntries(branchIds.map((branchId) => [branchId, prediction])),
        }),
      },
    }];
  }

  private get contract(): TaskContract {
    if (!this.contractValue) {
      const contract = this.options.taskContract ?? {
        objective: this.options.objective ?? "",
        constraints: clone(this.options.constraints ?? {}),
        budget: clone(this.options.budget ?? {}),
      };
      this.contractValue = deepFreeze(this.redactor.redact(clone(contract))) as Readonly<TaskContract>;
      if (this.contractValue.ideaType !== undefined) requireIdeaType(this.contractValue.ideaType);
    }
    return this.contractValue as TaskContract;
  }

  private get branchIds(): string[] {
    return this.options.branchIds?.slice() ?? ["candidate-1"];
  }

  static fromEvents(options: ToyMissionOptions, events: readonly MissionEvent[]): ToyCompetitionHarness {
    const harness = new ToyCompetitionHarness(options);
    harness.ledger.splice(0, harness.ledger.length, ...clone(events));
    return harness;
  }

  static replay(events: readonly MissionEvent[]): MissionState { return project(events); }
  replay(): MissionState { return project(this.ledger); }
  state(): MissionState { return this.replay(); }
  events(): readonly MissionEvent[] { return deepFreeze(clone(this.ledger)); }
  ledgerEvents(): readonly MissionEvent[] { return this.events(); }

  /** Queryable EdgeTraversal records: which join/route edges this run actually took (T46). */
  edgeTraversals(): readonly MissionEvent[] {
    return this.events().filter((event) => event.type === "EDGE_TRAVERSED");
  }

  private append(type: MissionEventType, payload: Record<string, unknown> = {}): void {
    const safe = this.redactor.redact(payload);
    if (["CANDIDATE_GENERATED", "SNAPSHOT_COMMITTED", "EVALUATION_RUN_COMPLETED", "FEEDBACK_VIEW_CREATED", "EVALUATOR_SUCCEEDED", "PROMOTED_LOCAL"].includes(type)) {
      let unchanged = false;
      try { unchanged = JSON.stringify(safe) === JSON.stringify(payload); } catch { unchanged = false; }
      if (!unchanged) throw new SandboxViolation("credential", "integrity-bearing event contains a secret");
    }
    this.ledger.push({ sequence: this.ledger.length + 1, type, payload: clone(safe) });
  }

  private promotionDecision(candidate: PromotionCandidate, state: MissionState): PromotionPolicyDecision {
    // T43: local promotion must clear baseline + δ. Fail closed when the baseline has not
    // been established, before any promotion policy can promote.
    const baselineGate = baselineSatisfied(this.baselineTrack, state.baseline, candidate.score);
    if (!baselineGate.allowed) return { approved: false, reason: baselineGate.reason };
    const policy = this.options.promotionPolicy;
    if (!policy) return { approved: !state.champion || candidate.score > state.champion.score };
    const decision = policy({
      candidate,
      champion: state.champion,
      evaluationContract: this.evaluationContract,
      gainBank: state.gainBank,
      ...(state.baseline?.score === undefined ? {} : { baselineScore: state.baseline.score }),
    });
    return typeof decision === "boolean" ? { approved: decision } : decision ?? { approved: false };
  }

  /**
   * T41 validation ladder gate, run after an evaluation is produced and before
   * it becomes trusted Evidence: tags the score with its declared validation
   * level, and for a Public LB probe refuses (records `PUBLIC_PROBE_REFUSED` +
   * rejects the branch) once the explicit probe cap is exhausted, so no public
   * score is recorded past the budget. Returns `{ stop: true }` when the branch
   * is terminally rejected; otherwise `{ evaluation }` with the level attached.
   */
  private validationLadderGate(
    branchId: string,
    fencingToken: number,
    evaluation: EvaluationResult,
  ): { stop: true } | { evaluation: EvaluationResult } {
    const ladder = this.validationLadder;
    if (!ladder) return { evaluation };
    const token = evaluation.validationLevel
      ?? (evaluation as unknown as Record<string, unknown>).validation_level;
    let level: ValidationLevel | undefined;
    if (token !== undefined) {
      try {
        level = normaliseValidationLevel(token);
      } catch {
        level = undefined;
      }
    }
    if (level === undefined) {
      this.append("BRANCH_REJECTED", {
        branchId,
        fencingToken,
        reason: "validation ladder active but evaluation declared no validation level (inner_cv/outer_holdout/public_lb)",
      });
      return { stop: true };
    }
    if (level === "public_lb") {
      const spent = publicProbesUsedFromEvents(this.ledger as readonly ValidationEventLike[]);
      const authorization = authorizePublicProbe(ladder, spent);
      if (!authorization.allowed) {
        // Refused before any public score is recorded: the probe never becomes Evidence.
        this.append("PUBLIC_PROBE_REFUSED", {
          branchId,
          fencingToken,
          cap: ladder.publicProbeCap,
          spent,
          reason: authorization.reason,
        });
        this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `public LB probe refused: ${authorization.reason}` });
        return { stop: true };
      }
    }
    return { evaluation: { ...evaluation, validationLevel: level } };
  }

  /**
   * T44 OOF ensemble gate (spec #1 G5): an ensemble candidate may be promoted
   * only with out-of-fold predictions (or a contract-declared leakage-safe
   * equivalent). The candidate signals `component=ensemble` and OOF presence
   * via evaluation facts; absence of an OOF signal is treated as no-OOF and the
   * promotion is rejected. Non-ensemble candidates and missions with no declared
   * oof_ensemble pass through.
   */
  private oofEnsembleGate(branchId: string, fencingToken: number, evaluation: EvaluationResult): { stop: true } | { ok: true } {
    const methodology = this.methodology;
    if (!methodology?.oof_ensemble) return { ok: true };
    const facts = evaluation.facts ?? [];
    const fact = (name: string): string | undefined => {
      const hit = facts.find((f) => typeof f?.name === "string" && f.name.toLowerCase() === name);
      return hit === undefined ? undefined : String(hit.value).toLowerCase();
    };
    const component = fact("component") ?? fact("component_kind") ?? "model";
    const isEnsemble = component === "ensemble" || component === "oof_ensemble";
    if (!isEnsemble) return { ok: true };
    const oofPresent = fact("oof_predictions") === "true" || fact("oof_present") === "true" || fact("oof") === "true";
    const decision = validateEnsemblePromotion(methodology, { component, oofPredictionsPresent: oofPresent });
    if (!decision.ok) {
      this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: decision.reasons.join("; ") });
      return { stop: true };
    }
    return { ok: true };
  }

  private controlSnapshot(snapshot: Readonly<CandidateSnapshot>, state: MissionState): Readonly<CandidateSnapshot> {
    return this.evaluationControlSnapshot ?? state.champion?.snapshot ?? snapshot;
  }

  private async invokeEvaluation(
    snapshot: Readonly<CandidateSnapshot>,
    contract: Readonly<NormalizedEvaluationContract>,
    context: EvaluationRunContext,
    manifest: Readonly<import("./security-boundary").SnapshotManifest>,
  ): Promise<EvaluationResult> {
    const adapter = this.adapter;
    if (adapter.evaluateRun) {
      return adapter.evaluateRun({ snapshot, contract, context, run: context, manifest });
    }
    if (adapter.evaluateWithContract) return adapter.evaluateWithContract(snapshot, contract, context, manifest);
    return adapter.evaluate(snapshot, context);
  }

  private async evaluateRunFact(
    snapshot: Readonly<CandidateSnapshot>,
    context: EvaluationRunContext,
  ): Promise<{ fact: EvaluationRunFact; validationLevel?: ValidationLevel }> {
    const protocol = this.evaluationContract!;
    const protocolDigest = this.evaluationContractDigest!;
    const trusted = await evaluateTrustedSnapshot(
      snapshot as unknown as Record<string, unknown>,
      this.contract,
      async (candidate, _taskContract, manifest) => this.invokeEvaluation(
        candidate as unknown as CandidateSnapshot,
        protocol,
        context,
        manifest,
      ),
    );
    const raw = trusted.result;
    if (!isRecord(raw) || !isFiniteNumber(raw.score)
      || raw.facts !== undefined && !validFacts(raw.facts)
      || raw.evaluatorId !== undefined && (typeof raw.evaluatorId !== "string" || raw.evaluatorId.trim() === "")
      || raw.evaluatorVersion !== undefined && (typeof raw.evaluatorVersion !== "string" || raw.evaluatorVersion.trim() === "")
      || raw.snapshotDigest !== undefined && raw.snapshotDigest !== trusted.manifest.snapshotDigest
      || raw.contractDigest !== undefined && raw.contractDigest !== trusted.manifest.contractDigest
      || raw.evaluationContractDigest !== undefined && raw.evaluationContractDigest !== protocolDigest
      || raw.runId !== undefined && raw.runId !== context.runId
      || raw.seed !== undefined && raw.seed !== context.seed) {
      throw new TrustViolation("evaluator returned a malformed or unbound run result");
    }
    const evaluatorId = typeof raw.evaluatorId === "string" ? raw.evaluatorId : this.adapter.name ?? "toy-evaluator";
    const evaluatorVersion = typeof raw.evaluatorVersion === "string"
      ? raw.evaluatorVersion
      : protocol.evaluatorVersion ?? "1";
    const base: Omit<EvaluationRunFact, "digest"> = {
      runId: context.runId,
      seed: context.seed,
      stage: context.stage,
      side: context.side,
      repeat: context.repeat,
      score: raw.score,
      facts: clone((raw.facts as ScoreFact[] | undefined) ?? [{ name: "score", value: raw.score, source: evaluatorId }]),
      candidateSnapshotDigest: context.candidateSnapshotDigest,
      snapshotDigest: trusted.manifest.snapshotDigest,
      controlSnapshotDigest: context.controlSnapshotDigest ?? context.candidateSnapshotDigest,
      taskContractDigest: trusted.manifest.contractDigest,
      contractDigest: trusted.manifest.contractDigest,
      evaluationContractDigest: protocolDigest,
      protocolDigest,
      evaluatorId,
      evaluatorVersion,
    };
    const fact = { ...base, digest: evaluationRunDigest(base) } as EvaluationRunFact;
    if (raw.digest !== undefined && raw.digest !== fact.digest) throw new TrustViolation("evaluator returned a forged run digest");
    // T41: the evaluator names the data split / leaderboard this score came from.
    // A malformed level token fails closed on any side; only the candidate's level tags the result.
    let validationLevel: ValidationLevel | undefined;
    const levelToken = isRecord(raw) ? (raw.validationLevel ?? raw.validation_level) : undefined;
    if (levelToken !== undefined) {
      const normalized = normaliseValidationLevel(levelToken);
      if (context.side === "candidate") validationLevel = normalized;
    }
    return { fact: deepFreeze(fact) as EvaluationRunFact, validationLevel };
  }

  private async evaluateWithNoiseProtocol(
    snapshot: Readonly<CandidateSnapshot>,
    branchId: string,
    fencingToken: number,
    attempt: number,
    existingRuns: readonly EvaluationRunFact[] = [],
  ): Promise<EvaluationResult> {
    const protocol = this.evaluationContract!;
    const protocolDigest = this.evaluationContractDigest!;
    const before = this.state();
    const control = this.controlSnapshot(snapshot, before);
    const controlDigest = control.digest ?? snapshot.digest;
    const runs = [...existingRuns];
    let runValidationLevel: ValidationLevel | undefined;
    for (const run of runs) {
      if (!validEvaluationRunFact(run, before, before.branches[branchId]!, controlDigest)) {
        throw new TrustViolation("evaluation run fact is not bound to the trusted protocol");
      }
    }
    let evaluatorId = runs[0]?.evaluatorId ?? this.adapter.name ?? "toy-evaluator";
    let evaluatorVersion = runs[0]?.evaluatorVersion ?? protocol.evaluatorVersion ?? "1";
    const runLimit = this.options.evaluationMaxRuns ?? this.options.maxEvaluationRuns;
    outer: for (const step of protocol.escalationLadder) {
      for (let repeat = 0; repeat < step.repeats; repeat += 1) {
        for (const side of evaluationStageSides(step.stage)) {
          const runId = evaluationRunId(this.options.missionId, branchId, attempt, step.stage, side, repeat);
          if (runs.some((run) => run.runId === runId)) continue;
          if (runLimit !== undefined && runs.length >= runLimit) break outer;
          const seed = evaluationSeed(this.options.missionId, branchId, snapshot.digest!, protocolDigest, protocol.seed, step.stage, repeat);
          const target = side === "candidate" ? snapshot : control;
          const context = deepFreeze({
            stage: step.stage,
            runId,
            seed,
            repeat,
            side,
            missionId: this.options.missionId,
            branchId,
            candidateSnapshotDigest: snapshot.digest!,
            snapshotDigest: target.digest!,
            controlSnapshotDigest: controlDigest,
            ...(this.evaluationControlSnapshot !== undefined || before.champion === undefined ? {} : { controlBranchId: before.champion.branchId }),
            candidateSnapshot: snapshot,
            controlSnapshot: control,
            candidate: snapshot,
            control,
            taskContractDigest: snapshot.contractDigest!,
            evaluationContractDigest: protocolDigest,
            evaluationContractVersion: protocol.version,
            evaluationContract: protocol,
            contract: protocol,
            ordinal: evaluationRunOrdinal(protocol, step.stage, side, repeat),
          }) as Readonly<EvaluationRunContext>;
          const { fact, validationLevel } = await this.evaluateRunFact(target, context);
          if (validationLevel !== undefined) runValidationLevel = validationLevel;
          if (fact.evaluatorId !== evaluatorId && runs.length > 0) throw new TrustViolation("evaluator identity changed during ladder");
          if (runs.length === 0) evaluatorId = fact.evaluatorId;
          if (fact.evaluatorVersion !== evaluatorVersion && runs.length > 0) throw new TrustViolation("evaluator version changed during ladder");
          if (runs.length === 0) evaluatorVersion = fact.evaluatorVersion;
          runs.push(fact);
          this.append("EVALUATION_RUN_COMPLETED", { branchId, fencingToken, run: fact });
        }
      }
    }
    const state = this.state();
    const ladder = buildEvaluationLadder({
      contract: protocol,
      runs,
      taskContractDigest: snapshot.contractDigest!,
      candidateSnapshotDigest: snapshot.digest!,
      controlSnapshotDigest: controlDigest,
      championScore: state.champion?.score,
      evaluatorId,
      evaluatorVersion,
    });
    const facts = aggregateEvaluationFacts(runs, ladder);
    const base: EvaluationResult = {
      score: ladder.promotionScore,
      facts,
      evaluatorId,
      evaluatorVersion,
      snapshotDigest: snapshot.digest,
      contractDigest: snapshot.contractDigest,
      evaluationContractDigest: protocolDigest,
      evaluationContractVersion: protocol.version,
      officialScore: ladder.officialScore,
      promotionScore: ladder.promotionScore,
      runs: ladder.runs,
      ladder,
      ...(runValidationLevel === undefined ? {} : { validationLevel: runValidationLevel }),
    };
    const result = { ...base, evaluationDigest: evaluationDigest(base) } as EvaluationResult;
    return deepFreeze(withEvaluationLadderAlias(result)) as EvaluationResult;
  }

  private verificationContext(role: VerificationRole, branchId: string, snapshot?: Readonly<CandidateSnapshot>, evaluation?: Readonly<EvaluationResult>): VerificationContext {
    return deepFreeze({
      role,
      contract: Object.freeze({ ...verificationRoleContract(role) }),
      missionId: this.options.missionId,
      branchId,
      taskContract: deepFreeze(clone(this.contract)),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(evaluation === undefined ? {} : { evaluation }),
    });
  }

  /**
   * Mission main seam: resolves the ModelConfig for one role session and
   * records the decision in the ledger. Inactive (undefined) when no model
   * catalog is wired, so legacy missions run exactly as before. Throws on
   * invalid pattern/gate configuration so misconfig fails closed.
   */
  private resolveSession(role: string, roleClass: RoleClass, gate?: string): RoleSessionResolution | undefined {
    if (!this.orchestra) return undefined;
    const resolution = this.orchestra.resolve({
      pattern: this.options.pattern,
      roleClass,
      gate,
      forcedTier: this.options.forcedTier,
    });
    return {
      role,
      tier: resolution.tier,
      mix: this.options.pattern?.modelMix ?? DEFAULT_MODEL_MIX,
      gate: gate ?? null,
      reason: resolution.reason,
      forced: resolution.reason === "forced",
      model: { ...resolution.model },
    };
  }

  private appendModelResolved(branchId: string, fencingToken: number, session: RoleSessionResolution): void {
    this.append("MODEL_RESOLVED", { branchId, fencingToken, ...session });
  }

  private async runVerificationRole(
    role: VerificationRole,
    branchId: string,
    fencingToken: number,
    snapshot: Readonly<CandidateSnapshot>,
    evaluation?: Readonly<EvaluationResult>,
    feedbackView?: Readonly<EvaluationFeedbackView>,
  ): Promise<{ ok: boolean; objections: string[] }> {
    const hooks = this.options.verification;
    const runtime = this.options.runtime;
    const context = this.verificationContext(role, branchId, snapshot, evaluation);
    const roleInput = { ...context, ...(feedbackView === undefined ? {} : { feedbackView }) };
    // Model resolution only applies when the runtime executes the role;
    // verification hooks are harness-side callbacks and consume no model.
    const viaRuntime = (invoke: (model?: ModelConfig) => unknown): unknown => {
      const session = this.resolveSession(role, "adversarial", role === "SuccessAuditor" ? "success_audit" : undefined);
      if (session) this.appendModelResolved(branchId, fencingToken, session);
      return invoke(session?.model);
    };
    let result: unknown;
    if (role === "Falsifier") {
      if (hooks?.falsifier) result = await hooks.falsifier(roleInput);
      else result = await viaRuntime((model) => runtime.falsify({ missionId: this.options.missionId, branchId, snapshot, feedbackView, model }));
    } else if (role === "Critic") {
      if (hooks?.critic) result = await hooks.critic(roleInput);
      else if (runtime.critic) result = await viaRuntime((model) => runtime.critic!({ missionId: this.options.missionId, branchId, snapshot, feedbackView, model }));
      else return { ok: true, objections: [] };
    } else if (role === "Challenger") {
      if (hooks?.challenger) result = await hooks.challenger(roleInput);
      else if (runtime.challenger) result = await viaRuntime((model) => runtime.challenger!({ missionId: this.options.missionId, branchId, snapshot, feedbackView, model }));
      else return { ok: true, objections: [] };
    } else if (role === "Auditor") {
      if (hooks?.auditor) result = await hooks.auditor(roleInput);
      else if (runtime.auditor) result = await viaRuntime((model) => runtime.auditor!({ missionId: this.options.missionId, branchId, snapshot, evaluation: evaluation!, feedbackView, model }));
      else return { ok: true, objections: [] };
    } else if (role === "SuccessAuditor") {
      if (hooks?.successAuditor) result = await hooks.successAuditor(roleInput);
      else if (runtime.successAuditor) result = await viaRuntime((model) => runtime.successAuditor!({ missionId: this.options.missionId, branchId, snapshot, evaluation: evaluation!, feedbackView, model }));
      else return { ok: true, objections: [] };
    } else if (role === "KillTester") {
      if (hooks?.killTestHang) result = await hooks.killTestHang(roleInput);
      else return { ok: true, objections: [] };
    } else {
      const callback = hooks?.selfVerifier;
      if (!callback) return { ok: true, objections: [] };
      result = await callback(context);
    }
    const normalized = normalizeVerificationResult(result, role);
    return { ok: normalized.ok, objections: [...normalized.objections] };
  }

  private appendVerification(
    role: VerificationRole,
    branchId: string,
    fencingToken: number,
    snapshot: Readonly<CandidateSnapshot>,
    result: { ok: boolean; objections: string[] },
  ): void {
    const type: MissionEventType = role === "Falsifier" ? "FALSIFIER_COMPLETED"
      : role === "Critic" ? "CRITIC_COMPLETED"
        : role === "Challenger" ? "CHALLENGER_COMPLETED"
          : role === "Auditor" ? "AUDITOR_COMPLETED"
            : role === "SuccessAuditor" ? "SUCCESS_AUDITOR_COMPLETED"
              : "KILL_TESTER_COMPLETED";
    this.append(type, {
      branchId, fencingToken, role, ok: result.ok, objections: result.objections,
      snapshotDigest: snapshot.digest, contractDigest: snapshot.contractDigest,
    });
  }

  private quarantine(branchId: string, fencingToken: number, error: unknown): void {
    const safe = this.redactor.error(error);
    const leakage = error instanceof LeakageViolation
      ? {
        leakageFindings: error.findings.map((finding) => ({ kind: finding.kind, token: finding.token, detail: finding.detail })),
        // Stable violation fingerprint: the same confirmed violation path is never auto-retried.
        violationFingerprint: error.fingerprint(),
      }
      : {};
    this.append("BRANCH_QUARANTINED", { branchId, fencingToken, reason: safe.message, objections: [safe.message], ...leakage });
  }

  /**
   * Promotion-gate cross-model agreement (promotion_cross_model=both): the
   * mission seam resolves both tier ModelConfigs and requests two tiered
   * evaluation attempts from the runtime. Disagreement must carry an explicit
   * reason (fail closed otherwise). The orchestra supplies configs only —
   * evaluation, agreement recording, and the promotion decision stay here.
   *
   * ponytail: v0 runs the dual check regardless of budget pressure; the
   * harness has no budget→allowDeep plumbing yet and the promotion policy
   * remains the final authority. Add a budget gate when deep spend limits
   * reach the mission seam.
   */
  private async runCrossModelCheck(
    branchId: string,
    fencingToken: number,
    snapshot: Readonly<CandidateSnapshot>,
    evaluation: Readonly<EvaluationResult>,
  ): Promise<{ agreed: boolean; reason?: string }> {
    // Construction validated both tiers are bound when promotionCrossModel is set.
    const models = this.orchestra!.crossModelConfigs()!;
    const result = await this.options.runtime.crossModelCheck!({
      missionId: this.options.missionId,
      branchId,
      snapshot,
      evaluation,
      models,
    });
    if (!isPlainRecord(result) || typeof result.agreed !== "boolean") {
      throw new TrustViolation("cross-model check returned a malformed result");
    }
    const reason = result.reason;
    if (!result.agreed && (typeof reason !== "string" || reason.trim() === "")) {
      throw new TrustViolation("cross-model disagreement must carry an explicit reason");
    }
    const agreed = result.agreed;
    this.append("CROSS_MODEL_CHECK_COMPLETED", {
      branchId,
      fencingToken,
      agreed,
      ...(agreed ? {} : { reason }),
      fastModel: models.fast.id,
      deepModel: models.deep.id,
      snapshotDigest: snapshot.digest,
      contractDigest: snapshot.contractDigest,
    });
    return { agreed, ...(agreed ? {} : { reason }) };
  }

  acceptChampion(request: Omit<Parameters<HumanAcceptanceGate["accept"]>[0], "championDigest"> & { championDigest?: string }): Readonly<HumanAcceptanceDecision> {
    const state = this.state();
    if (!state.champion) throw new Error("cannot accept a mission without a local champion");
    const digest = request.championDigest ?? state.champion.snapshot.digest;
    if (!digest || digest !== state.champion.snapshot.digest) throw new TrustViolation("human acceptance must name the current champion digest");
    let artifactDigest: string | undefined;
    if (request.requestId !== undefined || request.artifactDigest !== undefined) {
      artifactDigest = digest;
      if (this.adapter.collectArtifacts) {
        const references = this.adapter.collectArtifacts(state.champion.snapshot);
        const reference = references?.[0];
        if (!Array.isArray(references) || !isPlainRecord(reference) || typeof reference.digest !== "string" || reference.digest.trim() === "") {
          throw new TrustViolation("human acceptance could not bind an artifact digest");
        }
        artifactDigest = reference.digest;
      }
      if (request.artifactDigest !== undefined && request.artifactDigest !== artifactDigest) {
        throw new TrustViolation("human acceptance must name the current artifact digest");
      }
    }
    const decision = this.humanAcceptance.accept({
      ...request,
      championDigest: digest,
      ...(artifactDigest === undefined ? {} : { artifactDigest }),
    });
    this.append("HUMAN_ACCEPTED", decision as Record<string, unknown>);
    return decision;
  }

  createSubmissionBroker(options: Omit<SubmissionBrokerOptions, "ledger" | "championProvider">): SubmissionBroker {
    const missionId = this.options.missionId;
    const ledger = {
      append: (event: { readonly type: "SUBMISSION_REQUESTED" | "HUMAN_ACCEPTED" | "SUBMISSION_APPROVED" | "SUBMISSION_REJECTED" | "SUBMISSION_RESULT"; readonly payload: Record<string, unknown> }) => {
        this.append(event.type as MissionEventType, { ...event.payload });
      },
      events: () => this.events() as unknown as import("./submission-broker").SubmissionEvent[],
    };
    return new SubmissionBroker({
      ...options,
      // T42: default the quota to the mission budget dimension when the caller
      // did not set one explicitly; the gain threshold stays caller-configured.
      ...(options.submissionQuota === undefined && this.effectiveBudget.submissionQuota !== undefined
        ? { submissionQuota: this.effectiveBudget.submissionQuota } : {}),
      secrets: [...(this.options.secrets ?? []), ...(options.secrets ?? [])],
      ledger,
      championProvider: (requestedMissionId): SubmissionChampion | undefined => {
        if (requestedMissionId !== missionId) return undefined;
        const state = this.state();
        const champion = state.champion;
        if (!champion) return undefined;
        const branch = state.branches[champion.branchId];
        const digest = champion.snapshot.digest;
        if (!branch || typeof digest !== "string" || digest.trim() === "") return undefined;
        let artifact = {
          artifactId: champion.snapshot.provenance.candidateId,
          address: `artifact://${state.competitionId}/${digest}`,
          digest,
          payload: champion.snapshot,
        };
        if (this.adapter.collectArtifacts) {
          let references: readonly CompetitionArtifactReference[];
          try { references = this.adapter.collectArtifacts(champion.snapshot); } catch { return undefined; }
          const reference = references?.[0];
          if (!Array.isArray(references) || !isPlainRecord(reference) || typeof reference.artifactId !== "string" || reference.artifactId.trim() === ""
            || typeof reference.address !== "string" || reference.address.trim() === ""
            || typeof reference.digest !== "string" || reference.digest.trim() === "") return undefined;
          artifact = {
            artifactId: reference.artifactId,
            address: reference.address,
            digest: reference.digest,
            payload: champion.snapshot,
          };
        }
        return {
          missionId,
          competition: state.competitionId,
          branchId: champion.branchId,
          championDigest: digest,
          artifactDigest: artifact.digest,
          artifact,
          snapshot: champion.snapshot,
          score: champion.score,
          evaluatorSucceeded: branch.evaluatorSucceeded,
          successAuditorPassed: branch.verification.SuccessAuditor === true,
          promotionApproved: branch.status === "PROMOTED_LOCAL",
          verification: branch.verification,
          status: branch.status,
        };
      },
    });
  }

  private async processBranch(branchId: string): Promise<void> {
    const state = this.state();
    const branch = state.branches[branchId];
    if (!branch || ["PROMOTED_LOCAL", "REJECTED", "QUARANTINED"].includes(branch.status)) return;
    const maxAttempts = this.effectiveBudget.maxAttempts ?? 1;
    let snapshot = branch.snapshot;
    let attempt = branch.attempt;
    let recoveredStage: BranchStatus | undefined = snapshot ? branch.status : undefined;
    let reservation = branch.status === "TASK_SELECTED" && !snapshot && branch.attempt > 0 && branch.fencingToken !== undefined
      ? { attempt: branch.attempt, fencingToken: branch.fencingToken }
      : undefined;
    let verifiedRoles = new Set<VerificationRole>(Object.entries(branch.verification)
      .filter(([, passed]) => passed === true)
      .map(([role]) => role as VerificationRole));

    // A reservation is a resumable attempt, not a new attempt after a crash.
    while (attempt < maxAttempts || reservation || recoveredStage) {
      let fencingToken: number;
      let evaluationAlreadyStarted = recoveredStage === "VERIFYING" || recoveredStage === "SCORED";
      let evaluationAlreadySucceeded = recoveredStage === "SCORED";
      if (recoveredStage) {
        attempt = branch.attempt;
        fencingToken = branch.fencingToken!;
      } else if (reservation) {
        attempt = reservation.attempt;
        fencingToken = reservation.fencingToken;
        reservation = undefined;
      } else {
        attempt += 1;
        const carriesSnapshot = snapshot !== undefined;
        const carriedRoles = carriesSnapshot ? new Set(verifiedRoles) : new Set<VerificationRole>();
        const fences = this.ledger
          .filter((event) => event.type === "BRANCH_RESERVED" && isValidFence(event.payload.fencingToken))
          .map((event) => event.payload.fencingToken as number);
        fencingToken = (fences.length > 0 ? Math.max(...fences) : 0) + 1;
        this.append("BRANCH_RESERVED", { branchId, attempt, fencingToken });
        if (snapshot) {
          snapshot = createTrustedSnapshot({
            ...clone(snapshot),
            attempt,
            provenance: {
              ...clone(snapshot.provenance),
              runId: `${this.options.missionId}:${branchId}:${attempt}`,
              candidateId: `${branchId}:${attempt}`,
              fencingToken,
            },
          }) as Readonly<CandidateSnapshot>;
          this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot, recovered: true });
        }
        verifiedRoles = carriedRoles;
        recoveredStage = undefined;
        evaluationAlreadyStarted = false;
        evaluationAlreadySucceeded = false;
      }
      if (this.options.crashBeforeBranch === branchId && !this.crashed && !snapshot) {
        this.crashed = true;
        throw new Error("simulated crash");
      }
      // Prediction gate: no Candidate/BranchRun may enter expensive execution without an explicit,
      // validated prediction artifact. Missing prediction fails the branch before any candidate work,
      // snapshot commitment, or evaluation run.
      const prediction = this.state().branches[branchId]?.prediction;
      if (!prediction) {
        this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "prediction required before expensive execution" });
        return;
      }
      // T43 baseline-first Policy Guard: heavy/expensive candidate search is refused until
      // the strong baseline clears its success predicate. Cheap branches are never gated.
      const branchIdeaType = this.state().branches[branchId]?.snapshot?.ideaType ?? this.contract.ideaType;
      const baselineDecision = authorizeHeavySearch(this.baselineTrack, this.state().baseline, branchIdeaType);
      if (!baselineDecision.allowed) {
        this.append("HEAVY_SEARCH_REFUSED", { branchId, fencingToken, reason: baselineDecision.reason });
        this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `heavy search refused: ${baselineDecision.reason}` });
        return;
      }
      if (!snapshot) {
        try {
          const workspace = this.sandbox.createWorkspace();
          const context: Record<string, unknown> = {};
          const taskContract = deepFreeze(clone(this.contract)) as TaskContract;
          let rawCheck: unknown;
          if (typeof this.options.verification?.selfVerifier === "function") {
            rawCheck = await this.options.verification.selfVerifier(this.verificationContext("SelfVerifier", branchId));
          } else {
            const selfVerifySession = this.resolveSession("SelfVerifier", "execution");
            if (selfVerifySession) this.appendModelResolved(branchId, fencingToken, selfVerifySession);
            rawCheck = await this.options.runtime.selfVerify({ missionId: this.options.missionId, branchId, taskContract, context, workspace, model: selfVerifySession?.model, tier: selfVerifySession?.tier });
          }
          const check = normalizeVerificationResult(rawCheck, "SelfVerifier");
          if (!check.ok) {
            this.append("PREFLIGHT_SELF_CHECK_FAILED", { branchId, fencingToken, objections: check.objections, reason: "self-check failed" });
            return;
          }
          this.append("PREFLIGHT_SELF_CHECK_PASSED", { branchId, fencingToken, ok: true, objections: check.objections });
          const proposeSession = this.resolveSession("Worker", "execution");
          if (proposeSession) this.appendModelResolved(branchId, fencingToken, proposeSession);
          const proposal = await this.options.runtime.propose({ missionId: this.options.missionId, branchId, taskContract, workspace, model: proposeSession?.model, tier: proposeSession?.tier });
          const files = this.sandbox.validateCandidateFiles(proposal?.files);
          if (JSON.stringify(this.redactor.redact(files)) !== JSON.stringify(files)) {
            throw new SandboxViolation("credential", "candidate output contains a configured secret");
          }
          // Data honesty gate (T40): audit proposed files for held-out label/test leakage and
          // test-signal peeking before any snapshot, evaluation, or evidence exists. forbid →
          // terminal quarantine (LeakageViolation is a TrustViolation); disclose_only → durable
          // auditable disclosure; test feedback never feeds grading or promotion.
          if (this.dataHonesty) {
            const findings = auditCandidateFiles(this.dataHonesty, files);
            if (findings.length > 0) {
              if (this.dataHonesty.test_signal_policy.mode === "forbid") {
                throw new LeakageViolation(findings);
              }
              this.append("LEAKAGE_DISCLOSURE", {
                branchId,
                fencingToken,
                mode: "disclose_only",
                findingKinds: [...new Set(findings.map((finding) => finding.kind))],
                findings: findings.map((finding) => ({ kind: finding.kind, token: finding.token, detail: finding.detail })),
                filesDigest: digestValue(files),
              });
            }
          }
          // Methodology split discipline (T44): a candidate that re-declares a random/
          // shuffling splitter against a declared time/group split_contract is a RULE
          // failure (MethodologyViolation is a TrustViolation → terminal quarantine),
          // not merely a worse score. Inner search may not silently rewrite the split.
          if (this.methodology) {
            const methodologyFindings = auditMethodology(this.methodology, files);
            if (methodologyFindings.length > 0) {
              throw new MethodologyViolation(methodologyFindings);
            }
          }
          this.append("AGENT_COMPLETED", { branchId, fencingToken, ok: true });
          this.append("CANDIDATE_GENERATED", { branchId, fencingToken, files, filesDigest: digestValue(files) });
          this.append("CANDIDATE_MATERIALIZED", { branchId, fencingToken });
          snapshot = createTrustedSnapshot({
            missionId: this.options.missionId,
            branchId,
            ...(this.contract.ideaType === undefined ? {} : { ideaType: this.contract.ideaType }),
            attempt,
            files,
            contract: clone(taskContract),
            provenance: { runId: `${this.options.missionId}:${branchId}:${attempt}`, candidateId: `${branchId}:${attempt}`, fencingToken },
          }) as Readonly<CandidateSnapshot>;
          this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot });
        } catch (error) {
          if (error instanceof SandboxViolation || error instanceof TypeError && /read only|readonly|frozen|extensible|property/i.test(error.message)) {
            this.quarantine(branchId, fencingToken, error instanceof SandboxViolation ? error : new TrustViolation("candidate attempted to mutate trusted input"));
            return;
          }
          const reason = this.redactor.error(error).message;
          if (!(error instanceof InfrastructureError) || attempt >= maxAttempts) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
            return;
          }
          this.append("RETRY_SCHEDULED", { branchId, fencingToken, nextAttempt: attempt + 1, reason });
          recoveredStage = undefined;
          continue;
        }
      }
      if (!snapshot) return;
      try {
        assertSnapshotIntegrity(snapshot as unknown as Record<string, unknown>);
      } catch (error) {
        this.quarantine(branchId, fencingToken, error instanceof TrustViolation ? error : new TrustViolation("untrusted snapshot failed integrity validation"));
        return;
      }

      if (!evaluationAlreadyStarted && typeof this.adapter.validateRules === "function") {
        try {
          const rules = this.adapter.validateRules(snapshot);
          if (!rules.ok) throw new Error(`rule validation failed: ${rules.violations.join("; ")}`);
        } catch (error) {
          if (error instanceof SandboxViolation) {
            this.quarantine(branchId, fencingToken, error);
            return;
          }
          const reason = this.redactor.error(error).message;
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
          return;
        }
      }

      try {
        if (!evaluationAlreadyStarted) this.append("EVALUATION_STARTED", { branchId, fencingToken });

        let evaluation: EvaluationResult;
        if (evaluationAlreadySucceeded) {
          const recoveredEvaluation = branch.evaluation;
          evaluation = recoveredEvaluation ?? {
            score: branch.score!,
            facts: branch.facts ?? [],
            snapshotDigest: snapshot.digest,
            contractDigest: snapshot.contractDigest,
            evaluatorId: branch.evaluatorId,
            evaluatorVersion: branch.evaluatorVersion,
          };
        } else if (this.evaluationContract) {
          evaluation = await this.evaluateWithNoiseProtocol(
            snapshot,
            branchId,
            fencingToken,
            attempt,
            branch.evaluationRuns ?? [],
          );
          // T41 validation ladder: tag the score level and refuse an exhausted Public probe.
          const gated = this.validationLadderGate(branchId, fencingToken, evaluation);
          if ("stop" in gated) return;
          evaluation = gated.evaluation;
          this.append("EVALUATOR_SUCCEEDED", { branchId, fencingToken, ...evaluation, trusted_score: trustedScoreFromEvaluation(evaluation, snapshot), evidenceIds: evaluationEvidenceIds(evaluation, snapshot) });
        } else {
          const trusted = await evaluateTrustedSnapshot(
            snapshot as unknown as Record<string, unknown>,
            this.contract,
            async (candidate) => this.adapter.evaluate(candidate as unknown as CandidateSnapshot),
          );
          const raw = trusted.result;
          if (!isRecord(raw) || !isFiniteNumber(raw.score) || (raw.facts !== undefined && !validFacts(raw.facts))
            || raw.evaluatorId !== undefined && (typeof raw.evaluatorId !== "string" || raw.evaluatorId.trim() === "")
            || raw.evaluatorVersion !== undefined && (typeof raw.evaluatorVersion !== "string" || raw.evaluatorVersion.trim() === "")) {
            throw new TrustViolation("evaluator returned a malformed result");
          }
          if (raw.snapshotDigest !== undefined && raw.snapshotDigest !== trusted.manifest.snapshotDigest) {
            throw new TrustViolation("evaluator result is bound to another snapshot");
          }
          if (raw.contractDigest !== undefined && raw.contractDigest !== trusted.manifest.contractDigest) {
            throw new TrustViolation("evaluator result is bound to another contract");
          }
          evaluation = {
            score: raw.score,
            facts: clone((raw.facts as ScoreFact[] | undefined) ?? [{ name: "score", value: raw.score, source: this.adapter.name ?? "toy-evaluator" }]),
            evaluatorId: typeof raw.evaluatorId === "string" ? raw.evaluatorId : this.adapter.name ?? "toy-evaluator",
            evaluatorVersion: typeof raw.evaluatorVersion === "string" ? raw.evaluatorVersion : "1",
            snapshotDigest: trusted.manifest.snapshotDigest,
            contractDigest: trusted.manifest.contractDigest,
          };
          // T41 validation ladder: tag the score level and refuse an exhausted Public probe.
          const legacyLevelToken = (raw as Record<string, unknown>).validationLevel ?? (raw as Record<string, unknown>).validation_level;
          if (legacyLevelToken !== undefined) {
            try {
              evaluation = { ...evaluation, validationLevel: normaliseValidationLevel(legacyLevelToken) };
            } catch {
              /* fall through to the gate, which rejects an undeclared/invalid level */
            }
          }
          const gated = this.validationLadderGate(branchId, fencingToken, evaluation);
          if ("stop" in gated) return;
          evaluation = gated.evaluation;
          // Every evaluator record is content-addressed so verdicts can cite it (T46).
          evaluation = { ...evaluation, evaluationDigest: evaluationDigest(evaluation) };
          this.append("EVALUATOR_SUCCEEDED", { branchId, fencingToken, ...evaluation, trusted_score: trustedScoreFromEvaluation(evaluation, snapshot), evidenceIds: evaluationEvidenceIds(evaluation, snapshot) });
        }

        const feedbackView = this.options.evaluationFeedback?.enabled === true
          ? feedbackViewFromEvaluation(evaluation, snapshot)
          : undefined;
        if (feedbackView) this.append("FEEDBACK_VIEW_CREATED", {
          branchId,
          fencingToken,
          snapshotDigest: snapshot.digest,
          feedback_view: feedbackView,
        });

        // Every completed evaluation must leave a durable reconcile derived from the verified evaluator
        // facts, not from agent self-report: evaluator identity and snapshot digest come from the trusted
        // evaluation above and are validated again on replay.
        if (this.state().branches[branchId]?.reconcile === undefined) {
          const reconcile = this.reconcileEvaluation(branchId, snapshot, evaluation, prediction);
          if (reconcile) this.append("RECONCILED", { branchId, fencingToken, reconcile, snapshotDigest: snapshot.digest });
        }

        const earlyRoles: VerificationRole[] = ["Falsifier", "Critic", "Challenger"];
        for (const role of earlyRoles) {
          const callbackExists = role === "Falsifier"
            || role === "Critic" && (typeof this.options.verification?.critic === "function" || typeof this.options.runtime.critic === "function")
            || role === "Challenger" && (typeof this.options.verification?.challenger === "function" || typeof this.options.runtime.challenger === "function");
          if (!callbackExists || verifiedRoles.has(role)) continue;
          const result = await this.runVerificationRole(role, branchId, fencingToken, snapshot, undefined, feedbackView);
          this.appendVerification(role, branchId, fencingToken, snapshot, result);
          verifiedRoles.add(role);
          if (!result.ok) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `${role} objection` });
            return;
          }
        }

        for (const role of ["Auditor", "SuccessAuditor"] as const) {
          const callbackExists = role === "Auditor"
            ? typeof this.options.verification?.auditor === "function" || typeof this.options.runtime.auditor === "function"
            : typeof this.options.verification?.successAuditor === "function" || typeof this.options.runtime.successAuditor === "function";
          if (!callbackExists || verifiedRoles.has(role)) continue;
          const result = await this.runVerificationRole(role, branchId, fencingToken, snapshot, evaluation, feedbackView);
          this.appendVerification(role, branchId, fencingToken, snapshot, result);
          verifiedRoles.add(role);
          if (!result.ok) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `${role} objection` });
            return;
          }
        }

        const ladder = evaluation.ladder;
        const candidate = deepFreeze({
          branchId,
          score: evaluation.score,
          facts: evaluation.facts ?? [],
          snapshot,
          ...(evaluation.ladder === undefined ? {} : { evaluation, ladder: evaluation.ladder, promotion: evaluation.ladder.comparison }),
        }) as PromotionCandidate;
        const promotionState = this.state();
        if (this.evaluationContract) {
          if (!ladder || ladder.complete !== true) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "evaluation-ladder-incomplete" });
            return;
          }
          if (this.evaluationContract.marginPolicy.requireAgreement
            && ladder.comparison.tight && ladder.comparison.officialAbDisagreement) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "official-a-b-disagreement" });
            return;
          }
          const champion = promotionState.champion;
          if (champion && this.evaluationContract.marginPolicy.bankMicroGains) {
            const amount = ladder.comparison.abDelta ?? evaluation.score - champion.score;
            if (amount > 0 && amount <= this.evaluationContract.marginPolicy.microGain) {
              this.append("GAIN_BANKED", {
                branchId,
                fencingToken,
                championBranchId: champion.branchId,
                championDigest: champion.snapshot.digest,
                amount,
                candidateScore: evaluation.score,
                championScore: champion.score,
                evaluationDigest: evaluation.evaluationDigest,
                evaluationContractDigest: this.evaluationContractDigest,
                evaluationContractVersion: this.evaluationContract.version,
              });
              return;
            }
          }
        }
        // T41 validation ladder: only outer-holdout evidence may champion. An
        // inner-CV-only improvement or a Public LB probe is rejected even when
        // its raw score is higher — the unattended promotion basis is the outer
        // holdout, never the Public probe.
        if (this.validationLadder) {
          const level = evaluation.validationLevel;
          if (level === undefined || !levelCanChampion(level)) {
            this.append("BRANCH_REJECTED", {
              branchId,
              fencingToken,
              reason: level === undefined
                ? "validation level undeclared; cannot champion without outer-holdout evidence"
                : level === "public_lb"
                  ? "Public LB probe evidence can never champion (local promotion uses the outer holdout)"
                  : "inner-CV-only improvement cannot champion without outer-holdout evidence",
            });
            return;
          }
        }
        if (this.methodology?.oof_ensemble) {
          const oofGate = this.oofEnsembleGate(branchId, fencingToken, evaluation);
          if ("stop" in oofGate) return;
        }
        if (typeof this.options.verification?.killTestHang === "function" && !verifiedRoles.has("KillTester")) {
          const result = await this.runVerificationRole("KillTester", branchId, fencingToken, snapshot, evaluation, feedbackView);
          this.appendVerification("KillTester", branchId, fencingToken, snapshot, result);
          verifiedRoles.add("KillTester");
          if (!result.ok) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "KillTester objection" });
            return;
          }
        }
        if (this.options.promotionCrossModel === "both") {
          // Cross-model agreement is required before the promotion policy may
          // run. Agreement only keeps the candidate eligible — it never
          // auto-promotes and never submits.
          const agreement = await this.runCrossModelCheck(branchId, fencingToken, snapshot, evaluation);
          if (!agreement.agreed) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `cross-model disagreement: ${agreement.reason}` });
            return;
          }
        }
        // Claim-card promotion gate (T45, Co-Scientist-light ranking): shared with the replay
        // projector via claimCardJustifiesPromotion.
        const claimCard = this.state().branches[branchId]?.claimCard;
        const branchState = this.state().branches[branchId]!;
        if (!claimCardJustifiesPromotion(branchState)) {
          this.append("BRANCH_REJECTED", {
            branchId,
            fencingToken,
            reason: claimCard === undefined
              ? "claim card required for promotion"
              : claimCard.objections.length > 0 ? `uncleared claim objections: ${claimCard.objections.map((entry) => entry.source).join(", ")}`
              : "claim card does not justify promotion",
          });
          return;
        }
        // Re-read the state: the cross-model check awaited, so a sibling
        // branch may have promoted in the meantime and promotionState above
        // is stale.
        const decision = this.promotionDecision(candidate, this.state());
        if (decision.approved) {
          this.append("PROMOTED_LOCAL", {
            branchId,
            fencingToken,
            score: evaluation.score,
            facts: evaluation.facts ?? [],
            snapshot,
            snapshotDigest: evaluation.snapshotDigest,
            contractDigest: evaluation.contractDigest,
            // The promotion verdict must cite the Evaluation record it rests on
            // and the Evidence ids that record cites (spec #1, T46): the
            // projector refuses a promotion without a verifiable evaluation ref.
            evaluationRef: evaluation.evaluationDigest,
            evidenceIds: evaluationEvidenceIds(evaluation, snapshot),
            ...(evaluation.evaluationContractDigest === undefined ? {} : {
              evaluationContractDigest: evaluation.evaluationContractDigest,
              evaluationContractVersion: evaluation.evaluationContractVersion,
              evaluatorId: evaluation.evaluatorId,
              evaluatorVersion: evaluation.evaluatorVersion,
              evaluationDigest: evaluation.evaluationDigest,
              ladderDigest: ladder?.digest,
            }),
          });
        } else {
          const reason = typeof decision.reason === "string" && decision.reason.trim() !== "" ? decision.reason : "promotion policy rejected";
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
        }
        return;
      } catch (error) {
        if (error instanceof SandboxViolation) {
          this.quarantine(branchId, fencingToken, error);
          return;
        }
        const reason = this.redactor.error(error).message;
        // Every failed evaluation leaves a durable inconclusive reconcile addressing the failure record.
        this.appendFailureReconcile(branchId, fencingToken, snapshot, prediction, reason);
        if (!(error instanceof InfrastructureError) || attempt >= maxAttempts) {
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
          return;
        }
        this.append("EVALUATOR_FAILED", { branchId, fencingToken, reason });
        this.append("RETRY_SCHEDULED", { branchId, fencingToken, nextAttempt: attempt + 1, reason });
        recoveredStage = undefined;
      }
    }
  }

  /**
   * T43: establishes the strong baseline before any heavy/expensive search. Runs the
   * adapter-provided baseline entry (vendor-neutral), records the verdict as Evidence
   * (BASELINE_TRACK_PASSED/FAILED), and returns the result. Idempotent: once a verdict is
   * on the ledger it is replayed, not re-run. No-op when no baseline track is declared.
   */
  async establishBaseline(): Promise<BaselineTrackResult | undefined> {
    const existing = this.state().baseline;
    if (existing !== undefined) return existing;
    const contract = this.baselineTrack;
    if (!contract) return undefined;
    const port = this.adapter.runBaselineTrack;
    if (typeof port !== "function") {
      // Declared but no runnable entry: the gate stays closed (fail safe) and the
      // reason is recorded so a supervisor can wire the adapter's baseline entry.
      const reason = `baseline track '${contract.entry}' declares no runnable runBaselineTrack entry`;
      this.append("BASELINE_TRACK_FAILED", { entry: contract.entry, reason, evidence: reason });
      return this.state().baseline;
    }
    this.append("BASELINE_TRACK_STARTED", { entry: contract.entry, at: Date.now() });
    let result: BaselineTrackResult;
    try {
      result = await port.call(this.adapter, { missionId: this.options.missionId, entry: contract.entry });
    } catch (error) {
      result = { ok: false, evidence: this.redactor.error(error).message };
    }
    const score = typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined;
    const passed = result.ok === true && score !== undefined && score >= contract.successScore;
    this.append(passed ? "BASELINE_TRACK_PASSED" : "BASELINE_TRACK_FAILED", {
      entry: contract.entry,
      ...(score === undefined ? {} : { score }),
      successScore: contract.successScore,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    });
    return this.state().baseline;
  }

  async run(): Promise<MissionState> {
    const current = this.state();
    if (current.phase === "COMPLETED" || current.phase === "STOPPED") return current;
    if (current.phase === "CREATED") { this.append("MISSION_STARTED"); }
    // T43 baseline-first: a strong baseline must be established before heavy/expensive search.
    if (this.baselineTrack) await this.establishBaseline();
    const maxBranches = this.effectiveBudget.maxCandidates ?? this.branchIds.length;
    const ids = this.branchIds.slice(0, maxBranches);
    const concurrency = Math.max(1, this.options.policy?.maxParallelBranches ?? 1);
    let cursor = 0;
    const worker = async () => { while (cursor < ids.length) { const id = ids[cursor++]; await this.processBranch(id); } };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure) throw failure.reason;
    const final = this.state();
    const quorum = this.options.policy?.quorum ?? 1;
    const promotedBranches = Object.values(final.branches).filter((branch) => branch.status === "PROMOTED_LOCAL");
    const released = promotedBranches.length >= quorum;
    // EdgeTraversal (spec #1 Graph Engineering 对照): the fan-in edge the run
    // actually took — defined edge vs traversed edge stay separate records.
    this.append("EDGE_TRAVERSED", {
      edge_id: `join:mission-quorum:${this.options.missionId}`,
      condition_ref: "policy:quorum",
      condition_version: this.planVersion,
      source_attempt: ids.length,
      run_id: this.options.missionId,
      target: released ? "MISSION_COMPLETED" : "MISSION_STOPPED",
      evidence_ids: promotedBranches.flatMap((branch) => [
        ...(branch.snapshot?.digest ? [`snapshot:${branch.snapshot.digest}`] : []),
        ...(typeof branch.evaluation?.evaluationDigest === "string" ? [`evaluation:${branch.evaluation.evaluationDigest}`] : []),
      ]),
      plan_version: this.planVersion,
      captured_at: Date.now(),
    });
    if (released) this.append("MISSION_COMPLETED", { champion: final.champion });
    else this.append("MISSION_STOPPED", { reason: "join quorum not met" });
    return this.state();
  }

  async resume(): Promise<MissionState> { return this.run(); }

  /** Derives the post-evaluation reconcile from the prediction and the verified evaluation facts. */
  private reconcileEvaluation(branchId: string, snapshot: Readonly<CandidateSnapshot>, evaluation: EvaluationResult, prediction: PredictionArtifact): ReconcileRecord | undefined {
    return deriveEvaluationReconcile(this.options.missionId, branchId, snapshot, evaluation, prediction);
  }

  /** Inconclusive reconcile for a failed evaluation; its observation ref is content-addressed to the failure reason. */
  private appendFailureReconcile(branchId: string, fencingToken: number, snapshot: Readonly<CandidateSnapshot>, prediction: PredictionArtifact, reason: string): void {
    const reconcile = reconcilePrediction({
      prediction,
      observations: {},
      observationRefs: [`evaluator-failed:${digestValue({ candidateId: snapshot.provenance.candidateId, reason })}`],
      artifactRefs: [],
      evidenceRefs: [],
      evaluatorId: undefined,
      independentEvaluator: false,
      evidenceGatePassed: false,
      reconcileId: `${this.options.missionId}:${snapshot.provenance.candidateId}:reconcile`,
      taskId: branchId,
    });
    this.append("RECONCILED", { branchId, fencingToken, reconcile, snapshotDigest: snapshot.digest, failureReason: reason });
  }

  injectLateCompletion(branchId: string, fencingToken: number, score: number): boolean {
    const branch = this.state().branches[branchId];
    if (!branch || branch.fencingToken !== fencingToken) {
      this.append("LATE_EVENT_REJECTED", { branchId, fencingToken, score, reason: "stale fencing token" });
      return false;
    }
    this.append("LATE_EVENT_REJECTED", { branchId, fencingToken, score, reason: "completion injection unsupported" });
    return false;
  }
}

export function createToyMission(options: ToyMissionOptions): ToyCompetitionHarness {
  return new ToyCompetitionHarness(options);
}

export function replayToyMission(events: readonly MissionEvent[]): MissionState {
  return ToyCompetitionHarness.replay(events);
}

export * from "../../idea-types";
export * from "../../ledger-kinds";
export * from "../../team-execution";
export * from "../../pi-agent-runtime";
export * from "../../predict-reconcile";
export * from "../../branch-recovery";
export * from "../../dag-scheduler";
export * from "../../security-boundary";
export * from "../../submission-broker";
export * from "../../verification-gates";
export * from "../../research-loop";
export * from "./second-toy-adapter";
export * as methodologyManifest from "../../methodology";
export {
  compileMethodologyBlock,
  readMethodologyManifest,
  readMethodologyEvidence,
  oofEnsembleGate,
} from "../../methodology";
export type {
  MethodologyContracts as ManifestMethodologyContracts,
  FeaturePipelineContract as ManifestFeaturePipelineContract,
  OofEnsembleContract as ManifestOofEnsembleContract,
  SplitContract as ManifestSplitContract,
  SplitRef,
  SplitDigestAgreement,
  PluginMethodologyBlock,
  MethodologyEvidence,
  MethodologyGateResult,
} from "../../methodology";
export * from "../../methodology-acceptance";
export * from "../../newapi-client";
export * from "../../llm-competition-runtime";
