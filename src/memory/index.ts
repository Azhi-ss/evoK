/**
 * Research Memory: the single public export surface of `src/memory/`.
 *
 * Seventh directory, not a seventh logical owner (ADR-0016): the six-pack
 * authority map in ADR-0007 is unchanged. This directory owns only the derived
 * projection (`projection.ts`, `schema.ts`, `packet.ts`, `sham.ts`), durable
 * derived storage (`store.ts`), Run-bound slice assembly (`slice.ts`), and the
 * snapshot-pinned read-only serving tool (`tool.ts`). It owns no write path to
 * Mission history and no gate, promotion, admission, budget, T48, hang, or
 * submission authority.
 *
 * The names below are exactly the public surface the pre-move modules exposed:
 * other packages import from here, never from an individual memory module, so
 * the projection cannot grow a second back channel into the ledger, and a
 * module-private helper cannot leak by occupying a new file. Adding a name here
 * is a public-surface change, not an implementation detail.
 */
export {
  RESEARCH_MEMORY_SNAPSHOT_SCHEMA,
  RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
  SYNTHESIS_HYPOTHESIS_CARD_SCHEMA,
  SYNTHESIS_FINDING_CARD_SCHEMA,
  SYNTHESIS_PITFALL_CARD_SCHEMA,
  OPERATIONAL_PITFALL_CARD_SCHEMA,
  RESEARCH_CONTROL_CARD_SCHEMA,
  RESEARCH_MEMORY_REVISION,
  RESEARCH_DECISION_PACKET_SCHEMA,
  RESEARCH_MEMORY_RETRIEVAL_POLICY_REVISION,
  RESEARCH_MEMORY_DEFAULT_MAX_CARDS,
  RESEARCH_MEMORY_EVALUATION_MODES,
  researchMemoryModeOf,
  ResearchMemoryError,
  RESEARCH_APPLICABILITY_DIMENSIONS,
  RESEARCH_REVALIDATION_DIMENSIONS,
  assertMemorySafeText,
  validateResearchMemorySnapshot,
  summarizeResearchMemorySnapshot,
} from "./schema";
export type {
  ResearchMemoryEvaluationMode,
  ResearchCardLifecycle,
  ResearchApplicabilityDimension,
  ResearchCardLineage,
  ResearchCardWithdrawal,
  ResearchRunFinding,
  ResearchMemorySource,
  ResearchReplicationContext,
  ResearchFindingCard,
  ResearchOperationalPitfallCard,
  ResearchHypothesisCard,
  ResearchSynthesisFindingCard,
  ResearchPitfallCard,
  ResearchControlCard,
  ResearchMemoryCard,
  ResearchMemorySnapshot,
  ResearchDecisionPacket,
  ResearchPacketOmissions,
  ResearchMemorySummary,
  ResearchPriorQuery,
  ResearchPriorState,
  ResearchPriorVerdict,
  ResearchRetrieval,
} from "./schema";
export {
  projectResearchMemorySnapshot,
  evaluateResearchApplicability,
  retrieveResearchMemory,
} from "./projection";
export {
  projectResearchDecisionPacket,
  assertPacketCardRefs,
} from "./packet";
export {
  shamResearchMemorySnapshot,
  shamResearchDecisionPacket,
} from "./sham";
export {
  MEMORY_SLICE_SCHEMA,
  MEMORY_SLICE_RESEARCH_SCHEMA,
  MEMORY_WRITE_PROPOSAL_SCHEMA,
  AGENT_RESULT_SCHEMA,
  MEMORY_SENSITIVE_FIELDS,
  DEFAULT_MEMORY_READ_POLICY,
  MemorySliceError,
  createMemorySlice,
  createResearchMemorySlice,
  deriveDelegatedMemorySlice,
  validateMemorySlice,
  createMemoryWriteProposal,
  validateMemoryWriteProposal,
  validateAgentResult,
} from "./slice";
export type {
  MemoryReadPolicy,
  MemoryFact,
  MemoryFinding,
  MemorySliceInput,
  MemorySlice,
  ResearchMemorySliceInput,
  DelegatedMemorySliceInput,
  MemoryWriteProposalInput,
  MemoryWriteProposal,
  AgentResult,
} from "./slice";
export {
  RESEARCH_MEMORY_POINTER_SCHEMA,
  publishResearchMemorySnapshot,
  loadResearchMemorySnapshot,
  createResearchMemoryProvider,
  createDelegatedResearchMemoryProvider,
} from "./store";
export {
  MEMORY_READ_TOOL,
  MEMORY_READ_SCHEMA,
  readMemoryCard,
  createMemoryReadTool,
} from "./tool";
export type { MemoryReadBody, MemoryReadProvenance, MemoryReadRecord, MemoryReadTool } from "./tool";
