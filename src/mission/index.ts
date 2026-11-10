/**
 * Physical mission pack (ET-A3 / #123).
 *
 * Product control plane: authorize, budget, continue / repair / stop.
 * Hang / T48 stay in `src/evidence/`. CLI is a thin shell in `src/cli/`.
 * Golden path stays mock-default; live is explicit `{ live: true }` only.
 */
export {
  MissionDirector,
  EvidenceMemory,
} from "./research-loop";
export {
  projectDecisionAccountability,
  DIRECTION_CONCENTRATION_MIN_REVISIONS,
  DIRECTION_CONCENTRATION_RECOMMENDATION,
} from "./decision-accountability";
export {
  RESEARCH_MEMORY_CONTROL_CAVEAT,
  RESEARCH_MEMORY_CONCLUSION_KIND,
  RESEARCH_MEMORY_DIRECTION_CAVEAT,
  RESEARCH_MEMORY_DIRECTIONAL_METRICS,
  RESEARCH_MEMORY_EVALUATION_ASSUMPTIONS,
  RESEARCH_MEMORY_EVALUATION_KIND,
  RESEARCH_MEMORY_EVALUATION_SCHEMA,
  RESEARCH_MEMORY_INTEGRITY_CLAIM,
  RESEARCH_MEMORY_INTEGRITY_NOTE,
  RESEARCH_MEMORY_L2_MIN_L1_DECISION_POINTS,
  assertNoFutureInformation,
  compareResearchMemoryArms,
  concludeResearchMemory,
  evaluateResearchMemory,
  initialStateDigestOf,
  replayResearchMemory,
  researchMemoryArmMetrics,
} from "./memory-evaluation";
export {
  DECISION_POINT_CAVEATS,
  DECISION_POINT_EVALUATION_KIND,
  DECISION_POINT_EVALUATION_SCHEMA,
  DECISION_POINT_MIN_SAMPLE,
  DECISION_POINT_TRAJECTORY_CAVEAT,
  evaluateDecisionPoint,
  summarizeDecisionPoints,
} from "./decision-point-evaluation";
export type {
  DecisionPointActionTaken,
  DecisionPointArmReading,
  DecisionPointArmResult,
  DecisionPointDirection,
  DecisionPointDirectionReading,
  DecisionPointEvaluationReport,
  DecisionPointPacket,
  DecisionPointResult,
  FrozenDecisionPoint,
} from "./decision-point-evaluation";
export type {
  ReplayedRunMemory,
  ResearchMemoryArmMetrics,
  ResearchMemoryArmOrigin,
  ResearchMemoryComparison,
  ResearchMemoryComparisonDelta,
  ResearchMemoryComparisonReading,
  ResearchMemoryControlCheck,
  ResearchMemoryControlName,
  ResearchMemoryDirection,
  ResearchMemoryDirectionalConclusion,
  ResearchMemoryDirectionalMetric,
  ResearchMemoryEvaluationArm,
  ResearchMemoryEvaluationIntegrity,
  ResearchMemoryEvaluationMode,
  ResearchMemoryEvaluationPlan,
  ResearchMemoryEvaluationReplay,
  ResearchMemoryEvaluationReport,
  ResearchMemoryArmControls,
  ResearchMemoryL1DirectionReading,
  ResearchMemoryL1Gate,
  ResearchMemoryL1Signal,
  ResearchMemoryMetricDirection,
  ResearchMemoryMissionDirections,
  ResearchMemoryStageCalls,
  ResearchMemoryStageCosts,
} from "./memory-evaluation";
export type {
  DecisionAccountability,
  DecisionAccountabilitySource,
  DecisionAccountabilityView,
  DirectionConcentrationReview,
  RejectedDirectionAccountability,
  ResearchDiversity,
} from "./decision-accountability";
export {
  startAuthorizedMission,
  resumeAuthorizedMission,
  submitSynthesisProposal,
  isExplicitStartRequest,
  isExplicitResumeRequest,
  listUnfinishedMissions,
  summarizeMission,
  loadMissionRecord,
} from "./mission-start";
export type {
  SubmitSynthesisProposalOptions,
  SynthesisProposalRecord,
  SynthesisProposalSubmission,
} from "./mission-start";
export {
  DEMO_START_RELATIVE_PATH,
  DEMO_SUITE_RELATIVE_PATH,
  EVALUATION_TEMPLATE_RELATIVE_PATH,
  formatStartHardGateReport,
  inspectStartHardGates,
} from "./start-hard-gates";
export {
  runGoldenPath,
  assembleV1GoldenPath,
  attachGoldenPathHang,
  projectGoldenPathReview,
  V1_GOLDEN_HYPOTHESIS_ID,
  V1_GOLDEN_PLAN_ID,
} from "./v1-golden-path";
export {
  ORCH_GAP_KIND,
  ORCHESTRA_KIND_THIN_IMPL,
  runOrchGap,
} from "./orch-gap";
export {
  DEPLOY_ARENA_ORCH_KIND,
  runDeployArenaOrch,
} from "./deploy-arena-orch";
export type {
  DeployArenaOrchInput,
  DeployArenaOrchResult,
} from "./deploy-arena-orch";
export { Phase2Research, initPhase2Research, isPhase2Eligible } from "./phase2-research";
export { createPhase2WorkspaceRunner } from "./phase2-workspace-runner";
export type { Phase2WorkspaceRunnerOptions } from "./phase2-workspace-runner";
export type {
  Phase2DirectorView,
  Phase2NextAction,
  Phase2ResearcherView,
  Phase2RevisionScore,
} from "./phase2-research";
export { assembleLlmCompArmSetup } from "./llm-propose-outer-min";
export { assembleOuterMinPath } from "./outer-min-path";
export { assembleOuterE2eMinPath } from "./outer-e2e-min-path";
export {
  continueResearch,
  formatResearchStatus,
  parseResearchCommand,
  readResearchStatus,
  recoverResearchStatus,
  resolveResearchMissionId,
} from "./research-entry";
export {
  SKILL_CATEGORIES,
  SKILL_WRITEBACK_STATUS,
  SkillAdmissionRefusedError,
  SkillBudgetRefusedError,
  acceptedSkillFilesFromDiscovered,
  attemptSkillAccepted,
  defaultContextPointers,
  demoteSkill,
  requireSkillAccepted,
  discloseSkill,
  formatSkillsDirectory,
  isEvokCatalogSkill,
  isEvokTagged,
  listSkillsDirectory,
  parseSkillDiscloseCommand,
  parseSkillsCommand,
  routeSkills,
  skillWritebackStatus,
} from "./skills-routing";
