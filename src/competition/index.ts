/**
 * Physical competition pack (ET-A5 / #125).
 *
 * Owns contest-arm runtime and local Evaluator adapters (`suite-metric`
 * plus the LLM arm) and the orthogonal DeployArena graph / COI adapter.
 * Does not own evidence gates (hang / T48 / Broker) or Mission
 * propose/assemble glue. Live stays explicit `{ live: true }`; product
 * path must not open the arm via env alone. Model allowlist is
 * DeepSeek* / Gemini* only — GPT* stays banned. Contest-arm auto-submit
 * is evidence-owned and fail-closed. DeployArena opens only when
 * `competitionId=deploy-arena`.
 */
export {
  LiveLlmCompetitionRuntime,
  MOCK_LLM_CANDIDATE_FILES,
  MOCK_LLM_METHODOLOGY_FILES,
  MockLlmCompetitionRuntime,
  createLlmCompetitionRuntime,
  parseLiveProposalFiles,
} from "./llm-competition-runtime";
export type {
  LlmCompetitionRuntimeOptions,
  MockLlmCompetitionRuntimeOptions,
} from "./llm-competition-runtime";
export { runLlmCompArmBeforePromotion } from "./llm-comp-arm-before-promotion";
export type {
  LlmCompArmBeforePromotionRun,
  RunLlmCompArmBeforePromotionInput,
} from "./llm-comp-arm-before-promotion";
export {
  FIXTURE_MANIFEST_RUNNER,
  LOCAL_JS_EXPORTS_RUNNER,
  SUITE_METRIC_ID,
  SUITE_REPORT_REF,
  SuiteMetricContractError,
  createSuiteMetricEvaluator,
  evaluateSuiteMetric,
  normalizeSuiteMetricContract,
} from "./suite-metric";
export { localJsExportsRunner } from "./local-js-exports-runner";
export {
  COMPETITION_CONTRACT_SCHEMA,
  COMPETITION_GPU_BACKENDS,
  CompetitionContractError,
  competitionContractDigest,
  createCompetitionContract,
  validateCompetitionContract,
} from "./competition-contract";
export type {
  CompetitionContract,
  CompetitionContractInput,
  CompetitionDataSplit,
  CompetitionGpuBackend,
  CompetitionGpuRequirements,
  CompetitionLimits,
  CompetitionResourceRequirements,
  CompetitionScoring,
  CompetitionSplitKind,
  CompetitionSubmission,
} from "./competition-contract";
export {
  CAPABILITY_GATE_THRESHOLD,
  DEFAULT_DEPLOY_ARENA_CHALLENGE_ID,
  DEPLOY_ARENA_COMPETITION_ID,
  DEPLOY_ARENA_SMOKE_GRAPH,
  DeployArenaContractError,
  aggregateDeployArenaMetrics,
  assembleDeployArenaSubmission,
  createPlaygroundContestSubmitSeam,
  playgroundSubmitArgv,
  playgroundTaskDownloadArgv,
  runDeployArenaGraph,
} from "./deploy-arena";
export type {
  DeployArenaAggregation,
  DeployArenaGraph,
  DeployArenaGraphResult,
  DeployArenaObservation,
  DeployArenaSubmission,
  DeployArenaWorker,
} from "./deploy-arena";
export {
  PHASE2_CHALLENGE_ID,
  PHASE2_HARBOR_PIN,
  PHASE2_MODEL_ALLOWLIST,
  PHASE2_ORGANIZER_SUBJECT,
  PHASE2_STATE_SCHEMA,
  PHASE2_SUBMISSION_PLACEHOLDERS,
  Phase2AmbiguousSubmitError,
  Phase2Error,
  Phase2PlaygroundAdapter,
  buildPhase2SubmissionJson,
  createPhase2JsonStore,
  emptyPhase2State,
  isPhase2Eligible,
  parsePhase2OfficialStatus,
  phase2AttemptPendingOfficial,
  phase2AttemptSubmitted,
  phase2AttemptUnconfirmed,
  phase2LatestScore,
  phase2Spent,
  strongestPhase2Revision,
} from "./phase2-playground";
export type {
  Phase2Attempt,
  Phase2AttemptState,
  Phase2Check,
  Phase2Evidence,
  Phase2EvidenceKind,
  Phase2KitStatus,
  Phase2Platform,
  Phase2QuotaStatus,
  Phase2Revision,
  Phase2State,
  Phase2Store,
  Phase2SubmitResult,
} from "./phase2-playground";
export { CliPhase2Platform, digestPhase2Directory, runPhase2Command } from "./phase2-cli-platform";
export type { Phase2CliPlatformOptions, Phase2CliRunner } from "./phase2-cli-platform";
export { FakePhase2Platform } from "./phase2-fake-platform";
export type { FakePhase2Script } from "./phase2-fake-platform";
export {
  RULE_AUDIENCE_ROLES,
  RULE_SUMMARY_FIELDS,
  RULE_VISIBILITY_SCHEMA,
  RuleVisibilityError,
  createRuleVisibilityPolicy,
  ruleVisibilityDigest,
  summarizeRulesForRole,
  validateRuleVisibilityPolicy,
} from "./rule-visibility";
export type {
  RuleAudienceRole,
  RuleSummaryField,
  RuleVisibilityPolicy,
  RuleVisibilityPolicyInput,
} from "./rule-visibility";
export type {
  SuiteEvalStatus,
  SuiteMetricContract,
  SuiteMetricEvaluateOptions,
  SuiteMetricResult,
  SuiteReport,
  SuiteRunner,
  SuiteRunnerInput,
  SuiteRunnerOutcome,
} from "./suite-metric";
export {
  AUTO_RESEARCH_ARENA_ID,
  AutoArenaContractError,
  DEFAULT_AUTOARENA_CONTEXT_FILE,
  autoArenaGateMargin,
  autoArenaRankKey,
  checkAutoArenaCandidateSource,
  compareAutoArenaRankKeys,
  computeAutoArenaRelativeImprovement,
  createAutoArenaEvaluator,
  defaultAutoArenaCommandRunner,
  evaluateAutoArenaAdmissibility,
  loadAutoArenaBundle,
  loadProjectAutoArenaEvaluator,
  normalizeAutoArenaEvaluationContract,
  renderAutoArenaTaskBrief,
  stageAutoArenaMissionProject,
  validateAutoArenaContext,
  validateAutoArenaTask,
} from "./auto-research-arena";
export type {
  AutoArenaAdmissibilityVerdict,
  AutoArenaCommandRunner,
  AutoArenaConstraint,
  AutoArenaContext,
  AutoArenaDirection,
  AutoArenaEvaluationContract,
  AutoArenaEvaluationResponse,
  AutoArenaFrozenRegion,
  AutoArenaOperator,
  AutoArenaRankingMetric,
  AutoArenaReferenceResult,
  AutoArenaTask,
  CreateAutoArenaEvaluatorOptions,
  StageAutoArenaProjectOptions,
  StagedAutoArenaProject,
} from "./auto-research-arena";
