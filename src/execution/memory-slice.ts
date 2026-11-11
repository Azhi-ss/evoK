/**
 * Migration-period re-export shim. Physical home: `src/memory/slice.ts` (ADR-0016).
 *
 * It re-exports the directory entry point, so `src/memory/index.ts` stays the
 * only public export surface, and names exactly the surface this module exposed
 * before the move: nothing widens, nothing private leaks. M-e deletes this file.
 */
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
} from "../memory";
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
} from "../memory";
