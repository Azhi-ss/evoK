/**
 * Durable Research Memory serving seam (M1-T1 / #210). Physical home: `src/memory/`.
 *
 * Snapshots are derived projections of Mission history, stored project-locally
 * under the Mission's generated `memory/` namespace (never in Git). There is
 * exactly ONE store behind this seam since M-e (#246): the SQLite store in
 * `sqlite-store.ts` (ADR-0017). The seam stays because it is what the provider
 * and the recovery path are written against, not because a second
 * implementation is expected back.
 *
 * Serving fails closed on a damaged pointer/snapshot; it never treats
 * corruption as an empty research history.
 */
import type { MemoryProvider } from "../execution/context-broker";
import {
  MemorySliceError,
  createResearchMemorySlice,
  deriveDelegatedMemorySlice,
  type MemorySlice,
} from "./slice";
import type { ResearchMemorySnapshot } from "./schema";

/**
 * Store-neutral serving seam. The provider builds a slice from exactly one
 * pinned snapshot, so a later publication can never reach an already-served Run.
 */
export interface ResearchMemoryStore {
  /** Publishes one immutable snapshot and switches the active pointer atomically. */
  publish(snapshot: ResearchMemorySnapshot): Promise<void>;
  /** The active pointer DIGEST; undefined means nothing was ever published. */
  loadActive(): Promise<string | undefined>;
  /** One pinned snapshot by content address; never "latest". */
  loadPinned(digest: string): Promise<ResearchMemorySnapshot>;
}

/**
 * The default durable provider: a fresh Run-bound slice from the pinned
 * snapshot. Returns undefined before any measured Run exists, so a first Run
 * keeps the legacy prompt. Another Mission's snapshot fails closed.
 */
export function researchMemoryProviderFromStore(store: ResearchMemoryStore): MemoryProvider {
  return async (request): Promise<MemorySlice | undefined> => {
    const digest = await store.loadActive();
    if (digest === undefined) return undefined;
    // P6: one pointer read starts the Run; everything it is served is pinned.
    const snapshot = await store.loadPinned(digest);
    if (snapshot.missionId !== request.missionId) {
      throw new MemorySliceError(`research memory snapshot belongs to Mission "${snapshot.missionId}", not "${request.missionId}"`);
    }
    return createResearchMemorySlice({
      sliceId: `${snapshot.snapshotId}:${request.runId}`,
      missionId: request.missionId,
      taskId: request.taskId,
      runId: request.runId,
      targetAgentId: request.targetAgentId,
      evidenceRefs: request.evidenceRefs,
      // The v3 `research` packet is the single carrier for these cards; copying
      // them into the legacy `findings` block would duplicate the bounded payload.
      findings: [],
      research: snapshot,
    });
  };
}

/**
 * The snapshot the active pointer names: one pointer read, then one pinned read
 * (P6). Undefined means nothing was ever published.
 */
export async function loadActiveResearchMemorySnapshot(store: ResearchMemoryStore): Promise<ResearchMemorySnapshot | undefined> {
  const digest = await store.loadActive();
  return digest === undefined ? undefined : store.loadPinned(digest);
}

/**
 * Delegated-child provider (M1-T8): the child's slice comes from the PARENT's
 * pinned snapshot, not from whatever the active pointer names by then. The
 * provider is bound to exactly one child Run/agent, so a sibling requesting
 * memory through it fails closed instead of inheriting the parent's packet.
 */
export function createDelegatedResearchMemoryProvider(args: {
  /** The delegating parent's own pinned slice. */
  readonly parent: MemorySlice;
  readonly taskId: string;
  readonly runId: string;
  readonly targetAgentId: string;
}): MemoryProvider {
  return async (request): Promise<MemorySlice> => {
    if (request.taskId !== args.taskId || request.runId !== args.runId || request.targetAgentId !== args.targetAgentId) {
      throw new MemorySliceError(
        `delegated research memory is bound to child Task "${args.taskId}"/Run "${args.runId}"/agent "${args.targetAgentId}", not "${request.taskId}"/"${request.runId}"/"${request.targetAgentId}"`,
      );
    }
    return deriveDelegatedMemorySlice({
      parent: args.parent,
      missionId: request.missionId,
      taskId: request.taskId,
      runId: request.runId,
      targetAgentId: request.targetAgentId,
    });
  };
}
