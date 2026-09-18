/**
 * Physical evidence pack (ET-A1 / #121; P6 barrel).
 *
 * Owns ledger, T48, kill/hang, promotion gates, Admission / method writeback,
 * and Broker simulation.
 * Does not own search-tree structure or Team Coordinator / Role planning.
 * True External Submission stays frozen. Hang / T48 three-state is unchanged.
 *
 * `methodology.ts` (T44 gate predicates) is the barrel methodology surface.
 * `methodology-contracts.ts` stays a sibling module — same names, different
 * contract shape; `export *` from both would collide.
 */
export {
  HypothesisLedger,
  InMemoryHypothesisLedger,
  T48MappedCatalog,
  asKillTestPass,
  killTestOutcomeIsPass,
  killTestOutcomeKillsHypothesis,
  projectHypothesisLedger,
} from "./hypothesis-ledger";
export type {
  HypothesisEvent,
  HypothesisLedgerState,
  HypothesisStatus,
  KillTestOutcome,
  KillTestPlan,
  KillTestResult,
  T48MappedRef,
} from "./hypothesis-ledger";
export {
  createKillTestHangHook,
  killTestOutcomeBlocksBroker,
  runKillTestHang,
} from "./kill-test-hang";
export type {
  KillTestHangDecision,
  KillTestHangInput,
} from "./kill-test-hang";
export {
  auditMethodology,
  compileMethodologyBlock,
  oofEnsembleGate,
  readMethodologyEvidence,
  readMethodologyManifest,
  resolveMethodologyContracts,
} from "./methodology";
export type {
  MethodologyContracts,
  MethodologyEvidence,
  MethodologyGateResult,
} from "./methodology";
export {
  ROLE_CONTRACTS,
  VERIFICATION_ROLE_CONTRACTS,
  normalizeVerificationResult,
  verificationRoleContract,
} from "./verification-gates";
export type {
  VerificationHook,
  VerificationResult,
  VerificationRole,
} from "./verification-gates";
export {
  authorizePublicProbe,
  canReadScore,
  isValidationLadderContract,
  levelCanChampion,
  resolveValidationLadder,
} from "./validation-ladder";
export {
  InMemorySubmissionLedger,
  SubmissionBroker,
  SubmissionRejected,
  externalSubmissionsFromEvents,
} from "./submission-broker";
export { LEDGER_EVENT_KINDS, ledgerEventKind } from "./ledger-kinds";
export {
  evaluateExperimentValidity,
  experimentValidityIsPass,
} from "./experiment-validity";
export type {
  ExperimentClaim,
  ExperimentSliceKind,
  ExperimentSliceObservation,
  ExperimentValidityDecision,
  ExperimentValidityInput,
  ExperimentValidityOutcome,
} from "./experiment-validity";
export {
  MethodWritebackIsolationError,
  MethodWritebackPhaseError,
  MethodWritebackSession,
  evaluateMethodAdmission,
} from "./method-admission";
export type {
  AdmissionMinimalSet,
  MethodAdmissionDecision,
  MethodAdmissionInput,
  MethodAssetState,
  MethodWritebackKind,
  MethodWritebackPhase,
  MethodWritebackSlice,
  MethodWritebackState,
} from "./method-admission";
