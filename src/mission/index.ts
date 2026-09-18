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
  startAuthorizedMission,
  resumeAuthorizedMission,
  isExplicitStartRequest,
  isExplicitResumeRequest,
  listUnfinishedMissions,
  summarizeMission,
  loadMissionRecord,
} from "./mission-start";
export {
  runGoldenPath,
  assembleV1GoldenPath,
  attachGoldenPathHang,
  projectGoldenPathReview,
  V1_GOLDEN_HYPOTHESIS_ID,
  V1_GOLDEN_PLAN_ID,
} from "./v1-golden-path";
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
