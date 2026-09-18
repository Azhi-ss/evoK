/**
 * Physical execution pack (ET-A4 / #124).
 *
 * Owns dynamic Team: Pattern specs, Team Coordinator, Roles, Pi runtime,
 * Policy Guard, and Team DAG scheduling. Does not own gate override or
 * replace the Evaluator.
 *
 * Thin execution default (B) stays: DEFAULT_BRANCH_WIDTH=1; verification
 * Roles (Falsifier and kin) run only when callbacks are provided.
 * Pattern files under `./patterns` are read-only specs — they do not
 * force a Coordinator runtime track-switch and are not Promotion keys.
 * C thickening (full Antigravity roster as v1 must-have) is rejected.
 */
export {
  ArtifactFanIn,
  Coordinator,
  Coordinator as TeamCoordinator,
  DEFAULT_BRANCH_WIDTH,
  DeterministicScheduler,
  PolicyGuard,
  createThinExecutionPlan,
} from "./team-execution";
export type {
  ArtifactReference,
  Branch,
  BranchBudget,
  BranchPlan,
  BranchVerification,
  BranchVerificationInput,
  CoordinatorInput,
  DiversityPolicy,
  Evaluation,
  ExecutionPlan,
  Falsifier,
  FalsifierResult,
  FanInResult,
  IndependentEvaluator,
  PolicyLimits,
  PromotionPolicy,
  ScheduleOptions,
  ScheduledBranchResult,
} from "./team-execution";
export * from "./dag-scheduler";
export * from "./model-orchestra";
export * from "./pi-agent-runtime";
export * from "./security-boundary";
