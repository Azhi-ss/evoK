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
