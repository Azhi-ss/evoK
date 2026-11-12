/**
 * Which Research Memory store a Mission's Runs are served from (M-c / #244).
 *
 * There is exactly one since M-e (#246): SQLite, in one database file per
 * Mission. The file store and the `EVOK_RESEARCH_MEMORY_STORE=file` rollback
 * switch are deleted (ADR-0017); this module stays the single place that names
 * the database file, so no caller builds that path by hand.
 */
import { join } from "node:path";
import type { MemoryProvider } from "../execution/context-broker";
import { createSqliteResearchMemoryStore } from "./sqlite-store";
import { researchMemoryProviderFromStore, type ResearchMemoryStore } from "./store";

/** The one database file inside a Mission's `memory/` namespace. */
export const RESEARCH_MEMORY_DATABASE_FILENAME = "research-memory.sqlite";

/** The store for one Mission's memory namespace. */
export function researchMemoryStoreFor(dir: string): ResearchMemoryStore {
  return createSqliteResearchMemoryStore(join(dir, RESEARCH_MEMORY_DATABASE_FILENAME));
}

/** The provider a Run is served from, through the default store. */
export function defaultResearchMemoryProvider(dir: string): MemoryProvider {
  return researchMemoryProviderFromStore(researchMemoryStoreFor(dir));
}
