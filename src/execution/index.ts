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
export {
  HOST_INVENTORY_SCHEMA,
  HostInventoryError,
  hostInventoryDigest,
  parseNvidiaSmiGpuRows,
  probeHostInventory,
  validateHostInventory,
} from "./host-inventory";
export type {
  GpuDevice,
  HostCpu,
  HostDisk,
  HostInventory,
  HostInventoryProbeOptions,
  HostMemory,
} from "./host-inventory";
export {
  checkHostCapabilities,
  gpuBackendFromName,
} from "./host-capabilities";
export {
  RESOURCE_EXIT_REASONS,
  RESOURCE_LEASE_SCHEMA,
  RESOURCE_USAGE_SCHEMA,
  ResourceCapabilityError,
  grantResourceLease,
  recordResourceUsage,
  validateResourceLease,
  validateResourceUsage,
} from "./resource-lease";
export type {
  GpuLease,
  GrantLeaseOptions,
  ResourceCapabilityMismatch,
  ResourceExitReason,
  ResourceLease,
  ResourceRequest,
  ResourceUsage,
} from "./resource-lease";
export {
  RUN_MANIFEST_SCHEMA,
  RunManifestError,
  completeRunManifest,
  createRunManifest,
  parseRunManifest,
  serializeRunManifest,
  validateRunManifest,
} from "./run-manifest";
export type {
  CreateRunManifestInput,
  RunManifest,
  RunOutcome,
} from "./run-manifest";
export {
  RESEARCHER_CONTEXT_FORBIDDEN_FIELDS,
  RESEARCHER_CONTEXT_SCHEMA,
  ResearcherContextError,
  buildResearcherContext,
  summarizeLeaseResources,
  validateResearcherContext,
} from "./researcher-context";
export type {
  ResearcherCompetitionSummary,
  ResearcherContext,
  ResearcherResourceSummary,
} from "./researcher-context";
export {
  EXECUTION_CONTEXT_SCHEMA,
  ExecutionContextError,
  createExecutionContext,
  validateExecutionContext,
} from "./execution-context";
export type {
  CreateExecutionContextInput,
  EvaluationDataAccess,
  ExecutionAudience,
  ExecutionContext,
} from "./execution-context";
export {
  ROLE_CONTEXT_SCHEMA,
  RoleContextError,
  assembleRoleContext,
  validateRoleContext,
} from "./role-context";
export type {
  AssembleRoleContextInput,
  RoleContextAudit,
  RoleTaskContext,
} from "./role-context";
export {
  DELEGATABLE_CAPABILITIES,
  FORBIDDEN_DELEGATION_CAPABILITIES,
  SubagentAuthorityError,
  assertDelegationPermitted,
  createPiSubagentsAdapter,
} from "./subagents-adapter";
export type {
  DelegatableCapability,
  ForbiddenDelegationCapability,
  SubagentDelegation,
  SubagentDelegationResult,
  SubagentTransport,
} from "./subagents-adapter";
export {
  AGENT_RESULT_SCHEMA,
  DEFAULT_MEMORY_READ_POLICY,
  MEMORY_SENSITIVE_FIELDS,
  MEMORY_SLICE_RESEARCH_SCHEMA,
  MEMORY_SLICE_SCHEMA,
  MEMORY_WRITE_PROPOSAL_SCHEMA,
  MemorySliceError,
  createMemorySlice,
  createMemoryWriteProposal,
  createResearchMemorySlice,
  validateAgentResult,
  validateMemorySlice,
  validateMemoryWriteProposal,
} from "./memory-slice";
export type {
  AgentResult,
  MemoryFact,
  MemoryFinding,
  MemoryReadPolicy,
  MemorySlice,
  MemorySliceInput,
  MemoryWriteProposal,
  MemoryWriteProposalInput,
  ResearchMemorySliceInput,
} from "./memory-slice";
export {
  RESEARCH_MEMORY_POINTER_SCHEMA,
  createResearchMemoryProvider,
  loadResearchMemorySnapshot,
  publishResearchMemorySnapshot,
} from "./research-memory-provider";
export {
  BROKERED_CONTEXT_SCHEMA,
  CONTEXT_ROLES,
  ContextBroker,
  ContextBrokerError,
  TRUSTED_CONTEXT_ROLES,
  isTrustedContextRole,
  validateBrokeredContext,
} from "./context-broker";
export type {
  AssembleRunContextInput,
  BrokeredContext,
  BrokeredContextBody,
  ContextBrokerOptions,
  ContextRole,
  MemoryProvider,
  MemoryProviderRequest,
  TrustedContextRole,
} from "./context-broker";
export * from "./dag-scheduler";
export * from "./model-orchestra";
export * from "./pi-agent-runtime";
export * from "./security-boundary";
