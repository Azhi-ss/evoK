/**
 * Physical competition pack (ET-A5 / #125).
 *
 * Owns contest-arm runtime and local Evaluator adapters (`suite-metric`
 * plus the LLM arm). Does not own
 * evidence gates (hang / T48 / Broker) or Mission propose/assemble glue.
 * Live stays explicit `{ live: true }`; product path must not open the
 * arm via env alone. Model allowlist is DeepSeek* / Gemini* only — GPT*
 * stays banned. True External Submission stays frozen.
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
  SUITE_METRIC_ID,
  SUITE_REPORT_REF,
  SuiteMetricContractError,
  createSuiteMetricEvaluator,
  evaluateSuiteMetric,
  normalizeSuiteMetricContract,
} from "./suite-metric";
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
