/**
 * Migration-period re-export shim. Physical home: `src/memory/store.ts` (ADR-0016).
 *
 * It re-exports the directory entry point, so `src/memory/index.ts` stays the
 * only public export surface, and names exactly the surface this module exposed
 * before the move: nothing widens, nothing private leaks. M-e deletes this file.
 */
export {
  RESEARCH_MEMORY_POINTER_SCHEMA,
  publishResearchMemorySnapshot,
  loadResearchMemorySnapshot,
  createResearchMemoryProvider,
  createDelegatedResearchMemoryProvider,
} from "../memory";
