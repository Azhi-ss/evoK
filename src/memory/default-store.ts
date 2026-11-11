/**
 * Which Research Memory store a Mission's Runs are served from (M-c / #244).
 *
 * SQLite is the default and the file store stays a working reader, so rollback
 * is a configuration change, not a code change. Both implement the ONE seam in
 * `store.ts`; nothing above this module knows which one is live, which is why
 * switching the default cannot change a served digest, a packet or a slice.
 *
 * The switch keeps the file reader alive for the soak period (PRD §4.4) and is
 * deliberately an environment variable rather than a Mission-record field: the
 * store is derived infrastructure, not something an arm comparison may vary.
 */
import { join } from "node:path";
import type { MemoryProvider } from "../execution/context-broker";
import { MemorySliceError } from "./slice";
import { createSqliteResearchMemoryStore } from "./sqlite-store";
import {
  createFileResearchMemoryStore,
  researchMemoryProviderFromStore,
  type ResearchMemoryStore,
} from "./store";

/** The one database file inside a Mission's `memory/` namespace. */
export const RESEARCH_MEMORY_DATABASE_FILENAME = "research-memory.sqlite";
/** Set to `file` to serve from the pre-migration file store (rollback). */
export const RESEARCH_MEMORY_STORE_ENV = "EVOK_RESEARCH_MEMORY_STORE";

export type ResearchMemoryStoreName = "sqlite" | "file";

/** A typo must never silently pick a store: an unknown name is refused. */
export function researchMemoryStoreName(env: NodeJS.ProcessEnv = process.env): ResearchMemoryStoreName {
  const raw = env[RESEARCH_MEMORY_STORE_ENV]?.trim();
  if (raw === undefined || raw === "" || raw === "sqlite") return "sqlite";
  if (raw === "file") return "file";
  throw new MemorySliceError(`${RESEARCH_MEMORY_STORE_ENV} must be "sqlite" or "file", not "${raw}"`);
}

/**
 * The store for one Mission's memory namespace. The SQLite store migrates that
 * Mission's existing files on first use, so switching the default serves the
 * same bytes; the file store reads exactly what it always wrote.
 */
export function researchMemoryStoreFor(
  dir: string,
  name: ResearchMemoryStoreName = researchMemoryStoreName(),
): ResearchMemoryStore {
  return name === "file"
    ? createFileResearchMemoryStore(dir)
    : createSqliteResearchMemoryStore(join(dir, RESEARCH_MEMORY_DATABASE_FILENAME), dir);
}

/** The provider a Run is served from, through the default store. */
export function defaultResearchMemoryProvider(dir: string, name?: ResearchMemoryStoreName): MemoryProvider {
  return researchMemoryProviderFromStore(researchMemoryStoreFor(dir, name));
}
