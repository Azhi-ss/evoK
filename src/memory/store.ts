/**
 * Durable Research Memory serving seam (M1-T1 / #210). Physical home: `src/memory/`.
 *
 * Snapshots are derived projections of Mission history, stored project-locally
 * under the Mission's generated `memory/` namespace (never in Git). Publication
 * writes the immutable snapshot first and only then atomically switches the
 * active pointer, so a crash exposes either the old complete snapshot or the
 * new one. Serving fails closed on a damaged pointer/snapshot; it never treats
 * corruption as an empty research history.
 */
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  snapshotIdFor,
  validateResearchMemorySnapshot,
  type ResearchMemorySnapshot,
} from "./schema";
import type { MemoryProvider } from "../execution/context-broker";
import {
  MemorySliceError,
  createResearchMemorySlice,
  deriveDelegatedMemorySlice,
  type MemorySlice,
} from "./slice";

export const RESEARCH_MEMORY_POINTER_SCHEMA = "evok.research-memory-pointer/v1" as const;
const POINTER_FILENAME = "active.json";
const SNAPSHOTS_DIRNAME = "snapshots";

interface ActivePointer {
  readonly schema: typeof RESEARCH_MEMORY_POINTER_SCHEMA;
  readonly snapshotId: string;
  readonly digest: string;
}

function pointerPath(dir: string): string {
  return join(dir, POINTER_FILENAME);
}

function snapshotPath(dir: string, digest: string): string {
  // Digest-derived filename: no caller-supplied path segment can escape the dir.
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new MemorySliceError("research memory digest must be a 64-char hex content address");
  return join(dir, SNAPSHOTS_DIRNAME, `${digest}.json`);
}

/**
 * Store-neutral serving seam. The file store and the SQLite store are
 * interchangeable behind it; the provider builds a slice from exactly one
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
 * Writes one file completely (fsync + atomic rename) before it can be seen.
 * The temp name can never be a digest path, so a crashed write is never served.
 */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Publishes an immutable snapshot, then atomically switches the serving
 * pointer. The snapshot bytes are durable before the pointer can name them, so
 * a crash leaves either the complete old pointer or the complete new one.
 */
export async function publishResearchMemorySnapshot(dir: string, snapshot: ResearchMemorySnapshot): Promise<void> {
  const validated = validateResearchMemorySnapshot(snapshot);
  await atomicWriteJson(snapshotPath(dir, validated.digest), validated);
  const pointer: ActivePointer = {
    schema: RESEARCH_MEMORY_POINTER_SCHEMA,
    snapshotId: validated.snapshotId,
    digest: validated.digest,
  };
  await atomicWriteJson(pointerPath(dir), pointer);
}

/** Reads ONE content-addressed snapshot file and re-verifies its digest. */
async function readPinnedSnapshot(dir: string, digest: string, missing: string): Promise<ResearchMemorySnapshot> {
  let stored: string;
  try {
    stored = await readFile(snapshotPath(dir, digest), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemorySliceError(missing);
    }
    throw error;
  }
  let snapshot: ResearchMemorySnapshot;
  try {
    snapshot = validateResearchMemorySnapshot(JSON.parse(stored));
  } catch (error) {
    if (error instanceof SyntaxError) throw new MemorySliceError("research memory snapshot is not valid JSON");
    throw error;
  }
  if (snapshot.digest !== digest) {
    throw new MemorySliceError("research memory snapshot bytes do not match their content address");
  }
  return snapshot;
}

/** Reads the active pointer only; content is always read through a pinned digest (P6). */
async function readActivePointer(dir: string): Promise<ActivePointer | undefined> {
  let raw: string;
  try {
    raw = await readFile(pointerPath(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let pointer: unknown;
  try {
    pointer = JSON.parse(raw);
  } catch {
    throw new MemorySliceError("research memory active pointer is not valid JSON; refusing to serve an empty history");
  }
  if (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)) {
    throw new MemorySliceError("research memory active pointer must be an object");
  }
  const { schema, snapshotId, digest } = pointer as Record<string, unknown>;
  if (schema !== RESEARCH_MEMORY_POINTER_SCHEMA || typeof snapshotId !== "string" || typeof digest !== "string") {
    throw new MemorySliceError("research memory active pointer is malformed; refusing to serve an empty history");
  }
  return { schema, snapshotId, digest };
}

/** Loads the active snapshot; undefined means no snapshot was ever published. */
export async function loadResearchMemorySnapshot(dir: string): Promise<ResearchMemorySnapshot | undefined> {
  const pointer = await readActivePointer(dir);
  if (pointer === undefined) return undefined;
  const snapshot = await readPinnedSnapshot(
    dir,
    pointer.digest,
    "research memory active pointer names a missing snapshot; refusing to serve an empty history",
  );
  if (snapshot.snapshotId !== pointer.snapshotId) {
    throw new MemorySliceError("research memory active pointer does not match its snapshot");
  }
  return snapshot;
}

/** The file store: the default implementation of the store-neutral seam. */
export function createFileResearchMemoryStore(dir: string): ResearchMemoryStore {
  return {
    publish: (snapshot) => publishResearchMemorySnapshot(dir, snapshot),
    loadActive: async () => {
      const pointer = await readActivePointer(dir);
      if (pointer === undefined) return undefined;
      // The pointer's id is derived from its digest; a disagreement is damage.
      if (pointer.snapshotId !== snapshotIdFor(pointer.digest)) {
        throw new MemorySliceError("research memory active pointer does not match its snapshot");
      }
      return pointer.digest;
    },
    loadPinned: (digest) => readPinnedSnapshot(dir, digest, "research memory snapshot is missing; refusing to serve an empty history"),
  };
}

/**
 * Every content-addressed snapshot file, each re-verified. The file layout
 * belongs to `store.ts`, so the SQLite migration (and M-c) do not re-implement it.
 */
export async function loadFileResearchMemorySnapshots(dir: string): Promise<readonly ResearchMemorySnapshot[]> {
  let names: string[];
  try {
    names = (await readdir(join(dir, SNAPSHOTS_DIRNAME))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots: ResearchMemorySnapshot[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const digest = name.slice(0, -".json".length);
    // The filename IS the content address: a stray name is not a snapshot.
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new MemorySliceError(`research memory file ${name} is not a content address; refusing to migrate it`);
    }
    snapshots.push(await readPinnedSnapshot(dir, digest, `research memory file ${name} is missing`));
  }
  return snapshots;
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
 * The default durable provider over the file store (the default store until M-c).
 */
export function createResearchMemoryProvider(dir: string): MemoryProvider {
  return researchMemoryProviderFromStore(createFileResearchMemoryStore(dir));
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
