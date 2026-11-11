/**
 * SQLite Research Memory store (M-b / #243), the DEFAULT store since M-c (#244).
 * A second implementation of the store-neutral seam in `store.ts`, behind the
 * same provider; the file store is still the rollback path.
 *
 * It preserves the six properties of the file design (PRD §4.1):
 *
 * - P1 `digest` is a content address, and every read re-derives it from
 *   `payload` via `validateResearchMemorySnapshot` instead of trusting the row.
 * - P2 the snapshot row, its `cards` projection and the `active` pointer are
 *   written in ONE transaction, so a crash exposes the old or the new state.
 * - P3 any integrity failure throws; it never falls back to empty history.
 * - P4 `payload` is canonical JSON, so a rebuild from Mission history hashes to
 *   the same digest and keeps every completed Run reproducible.
 * - P5 `snapshots` is insert-only: the API has no update/delete, and triggers
 *   reject UPDATE/DELETE on published content.
 * - P6 reads of content take a digest (`loadPinned`); `loadActive` is the single
 *   pointer read that starts a Run, and the slice it produces stays pinned.
 *
 * `cards` is a query projection rebuilt from `payload`, never a second fact
 * source: a mismatch is corruption. Nothing here is an agent-facing write path;
 * `publish` is the trusted projection/publisher call.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../execution/security-boundary";
import type { MemoryProvider } from "../execution/context-broker";
import { RESEARCH_CONTROL_CARD_SCHEMA, validateResearchMemorySnapshot, type ResearchMemorySnapshot } from "./schema";
import { MemorySliceError } from "./slice";
import {
  loadFileResearchMemorySnapshots,
  loadResearchMemorySnapshot,
  researchMemoryProviderFromStore,
  type ResearchMemoryStore,
} from "./store";

const TABLES = `
CREATE TABLE IF NOT EXISTS snapshots (
  digest        TEXT PRIMARY KEY,
  snapshot_id   TEXT NOT NULL,
  mission_id    TEXT NOT NULL,
  ledger_rev    INTEGER NOT NULL,
  memory_rev    INTEGER NOT NULL,
  control       TEXT,
  payload       TEXT NOT NULL,
  published_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS active (
  mission_id    TEXT NOT NULL,
  arm           TEXT NOT NULL,
  digest        TEXT NOT NULL REFERENCES snapshots(digest),
  PRIMARY KEY (mission_id, arm)
);
CREATE TABLE IF NOT EXISTS cards (
  digest        TEXT NOT NULL REFERENCES snapshots(digest),
  card_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  lifecycle     TEXT NOT NULL,
  applicability TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  PRIMARY KEY (digest, card_id)
);
`;

/**
 * Published content is insert-only. The ONE exception is repair: a row whose
 * payload no longer hashes to its address holds no content at that address, so
 * republication restores it (see `repairCorruptSnapshotRow`).
 */
const IMMUTABILITY_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS snapshots_immutable_update BEFORE UPDATE ON snapshots
BEGIN SELECT RAISE(ABORT, 'published snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_immutable_delete BEFORE DELETE ON snapshots
BEGIN SELECT RAISE(ABORT, 'published snapshots are immutable'); END;
`;

interface SnapshotRow {
  readonly payload: string;
}

interface CardRow {
  readonly card_id: string;
  readonly kind: string;
  readonly lifecycle: string;
  readonly applicability: string;
  readonly ordinal: number;
}

/**
 * The Sham arm is the one whose slots are Schema-only control cards. An `off`
 * Mission never publishes, so it has no snapshot and no active row: the arm
 * column only ever holds a published arm (PRD §4.2 lists all three values).
 */
function armOf(snapshot: ResearchMemorySnapshot): "sham" | "real" {
  return snapshot.cards.some((card) => card.schema === RESEARCH_CONTROL_CARD_SCHEMA) ? "sham" : "real";
}

/** One connection per operation: no dangling handles, and the API stays three methods. */
function withDatabase<T>(file: string, fn: (db: Database) => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  try {
    // WAL lets readers see the old rows while a publication commits; FULL sync
    // makes the pointer switch durable before publish() returns (P2).
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(TABLES);
    db.exec(IMMUTABILITY_TRIGGERS);
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A database that is not a readable database at all. Everything in it is a
 * derived projection (P4), so the file store's "corrupt snapshot file" case is
 * repaired the same way it was: rebuild the artifact from Mission history.
 */
function isUnreadableDatabase(error: unknown): boolean {
  return /not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(error instanceof Error ? error.message : String(error));
}

/** The database file and its WAL sidecars: no readable content, nothing to keep. */
function discardDatabase(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
}

/** True once the database holds any published state; an empty file is unseeded. */
function hasContent(db: Database): boolean {
  const row = db.prepare("SELECT (SELECT COUNT(*) FROM snapshots) + (SELECT COUNT(*) FROM active) AS n").get() as { n: number };
  return row.n > 0;
}

/** A payload that no longer hashes to its address is damage, not content. */
function payloadIsCorrupt(payload: string, digest: string): boolean {
  try {
    return validateResearchMemorySnapshot(JSON.parse(payload)).digest !== digest;
  } catch {
    return true;
  }
}

/**
 * Restores the bytes a content address names, which the file store does by
 * rewriting the snapshot file. Valid published content is never rewritten: P5
 * still holds for every row that really is the content its digest names.
 */
function repairCorruptSnapshotRow(db: Database, snapshot: ResearchMemorySnapshot, payload: string): void {
  db.exec("DROP TRIGGER IF EXISTS snapshots_immutable_update");
  try {
    db.prepare(
      `UPDATE snapshots SET snapshot_id = ?, mission_id = ?, ledger_rev = ?, memory_rev = ?, control = ?, payload = ?, published_at = ?
       WHERE digest = ?`,
    ).run(
      snapshot.snapshotId,
      snapshot.missionId,
      snapshot.ledgerRevision,
      snapshot.memoryRevision,
      armOf(snapshot) === "sham" ? "sham" : null,
      payload,
      new Date().toISOString(),
      snapshot.digest,
    );
  } finally {
    db.exec(IMMUTABILITY_TRIGGERS);
  }
}

/** Inserts one immutable snapshot and its query projection; never switches the pointer. */
function insertSnapshot(db: Database, snapshot: ResearchMemorySnapshot, payload: string): void {
  const existing = db.prepare("SELECT payload FROM snapshots WHERE digest = ?").get(snapshot.digest) as SnapshotRow | null;
  if (existing !== null && existing.payload !== payload) {
    if (!payloadIsCorrupt(existing.payload, snapshot.digest)) {
      throw new MemorySliceError("research memory digest already names different payload bytes; refusing to overwrite published content");
    }
    repairCorruptSnapshotRow(db, snapshot, payload);
  }
  if (existing !== null) {
    // `payload` is the served artifact and `cards` is rebuilt from it, so a
    // disagreement is repair from the authoritative copy (see readPinned).
    db.prepare("DELETE FROM cards WHERE digest = ?").run(snapshot.digest);
  }
  db.prepare(
    `INSERT INTO snapshots (digest, snapshot_id, mission_id, ledger_rev, memory_rev, control, payload, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING`,
  ).run(
    snapshot.digest,
    snapshot.snapshotId,
    snapshot.missionId,
    snapshot.ledgerRevision,
    snapshot.memoryRevision,
    armOf(snapshot) === "sham" ? "sham" : null,
    payload,
    new Date().toISOString(),
  );
  const insertCard = db.prepare(
    `INSERT INTO cards (digest, card_id, kind, lifecycle, applicability, ordinal)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(digest, card_id) DO NOTHING`,
  );
  snapshot.cards.forEach((card, ordinal) => {
    insertCard.run(snapshot.digest, card.cardId, card.kind, card.lifecycle, canonicalJson(card.applicability), ordinal);
  });
}

function setActive(db: Database, snapshot: ResearchMemorySnapshot): void {
  // One Mission owns one namespace, so it has exactly ONE active pointer: a
  // publication supersedes its own previous pointer, including one that named
  // the other arm (a migrated or repaired store may start there). Another
  // Mission's rows are left alone and make the database foreign, which reads
  // refuse rather than repair by deletion.
  db.prepare("DELETE FROM active WHERE mission_id = ?").run(snapshot.missionId);
  db.prepare("INSERT INTO active (mission_id, arm, digest) VALUES (?, ?, ?)").run(
    snapshot.missionId,
    armOf(snapshot),
    snapshot.digest,
  );
}

/** Rebuilds the cards projection from `payload` and refuses any disagreement. */
function assertCardsMatch(db: Database, snapshot: ResearchMemorySnapshot): void {
  const rows = db
    .prepare("SELECT card_id, kind, lifecycle, applicability, ordinal FROM cards WHERE digest = ? ORDER BY ordinal")
    .all(snapshot.digest) as CardRow[];
  const corrupt = (): never => {
    throw new MemorySliceError("research memory cards projection does not match its payload; refusing to serve corrupted history");
  };
  if (rows.length !== snapshot.cards.length) corrupt();
  snapshot.cards.forEach((card, ordinal) => {
    const row = rows[ordinal];
    if (
      row === undefined
      || row.ordinal !== ordinal
      || row.card_id !== card.cardId
      || row.kind !== card.kind
      || row.lifecycle !== card.lifecycle
      || row.applicability !== canonicalJson(card.applicability)
    ) corrupt();
  });
}

/**
 * One pinned read (P1, P6): the digest is re-derived from the stored payload.
 * Only `payload` + `digest` are served; `snapshot_id`/`ledger_rev`/`memory_rev`
 * are query aids derived from the same publication, not a second fact source.
 */
function readPinned(db: Database, digest: string): ResearchMemorySnapshot {
  const row = db.prepare("SELECT payload FROM snapshots WHERE digest = ?").get(digest) as SnapshotRow | null;
  if (row === null) {
    throw new MemorySliceError("research memory snapshot is missing; refusing to serve an empty history");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    throw new MemorySliceError("research memory snapshot payload is not valid JSON");
  }
  const snapshot = validateResearchMemorySnapshot(parsed);
  if (snapshot.digest !== digest) {
    throw new MemorySliceError("research memory snapshot payload does not match its content address");
  }
  assertCardsMatch(db, snapshot);
  return snapshot;
}

/**
 * The ONE active pointer (P6: a digest, never content). The API writes one row
 * per Mission database, so more than one row means a mixed-arm or foreign
 * database, which is refused rather than guessed at.
 */
function activeDigest(db: Database): string | undefined {
  const rows = db.prepare("SELECT digest FROM active ORDER BY mission_id, arm LIMIT 2").all() as Array<{ digest: string }>;
  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    throw new MemorySliceError("research memory database holds more than one active snapshot; refusing to guess which Mission it serves");
  }
  return rows[0].digest;
}

/** The SQLite store: same seam as the file store, one database file. */
export function createSqliteResearchMemoryStore(file: string, migrateFrom?: string): ResearchMemoryStore {
  /**
   * One-shot migration of a Mission's file store (M-c / #244). A populated
   * database is never re-seeded, so leftover files cannot drag serving
   * backwards; an empty one is seeded once, and a damaged file store is
   * reported instead of being mistaken for "nothing was ever published".
   */
  let migration: Promise<Error | undefined> | undefined;
  const ensureMigrated = (): Promise<Error | undefined> => (migration ??= (async () => {
    try {
      if (migrateFrom === undefined) return undefined;
      if (existsSync(file)) {
        if (withDatabase(file, hasContent)) return undefined;
      } else if (!existsSync(join(migrateFrom, "snapshots")) && !existsSync(join(migrateFrom, "active.json"))) {
        // Nothing to migrate: do not create a database just to read it.
        return undefined;
      }
      await migrateFileResearchMemory(migrateFrom, file);
      return undefined;
    } catch (error) {
      // Recorded, never thrown: a caller that is about to rebuild from Mission
      // history must still be able to publish, and a missing pinned digest
      // reports this damage instead of "never published".
      return error instanceof Error ? error : new Error(String(error));
    }
  })());

  /** A read never creates a database; a failed migration explains a missing one. */
  const readable = async (): Promise<boolean> => {
    const failed = await ensureMigrated();
    if (existsSync(file)) return true;
    // Never "nothing was published" when the seed files themselves are damaged.
    if (failed !== undefined) throw failed;
    return false;
  };

  return {
    async publish(snapshot): Promise<void> {
      const validated = validateResearchMemorySnapshot(snapshot);
      await ensureMigrated();
      const payload = canonicalJson(validated);
      const write = (): void => {
        withDatabase(file, (db) => {
          db.transaction(() => {
            insertSnapshot(db, validated, payload);
            setActive(db, validated);
          })();
        });
      };
      try {
        write();
      } catch (error) {
        if (!isUnreadableDatabase(error)) throw error;
        // Recovery republishing into a database that is not a database: the
        // derived file holds no readable content, so it is rebuilt, not blocked.
        discardDatabase(file);
        write();
      }
    },
    async loadActive(): Promise<string | undefined> {
      if (!await readable()) return undefined;
      return withDatabase(file, activeDigest);
    },
    async loadPinned(digest: string): Promise<ResearchMemorySnapshot> {
      if (!await readable()) {
        throw new MemorySliceError("research memory snapshot is missing; refusing to serve an empty history");
      }
      const failed = await ensureMigrated();
      return withDatabase(file, (db) => {
        const row = db.prepare("SELECT digest FROM snapshots WHERE digest = ?").get(digest) as { digest: string } | null;
        // This address is one the one-shot migration would have supplied, so a
        // failed migration is the real reason it is missing (never an empty history).
        if (row === null && failed !== undefined) throw failed;
        return readPinned(db, digest);
      });
    },
  };
}

/** The SQLite provider: one Run-bound slice from the pinned active snapshot. */
export function createSqliteResearchMemoryProvider(file: string): MemoryProvider {
  return researchMemoryProviderFromStore(createSqliteResearchMemoryStore(file));
}

/**
 * One-shot migration of a Mission's `snapshots/*.json` + `active.json` into the
 * SQLite store (PRD §4.4). Every file is re-validated before anything is
 * written, so a corrupt directory migrates nothing; re-running is a no-op.
 */
export async function migrateFileResearchMemory(dir: string, databaseFile: string): Promise<{ snapshots: number }> {
  // Every file is re-verified against its content address before anything is
  // written; a stray or corrupt name refuses the whole migration (P3).
  const snapshots = await loadFileResearchMemorySnapshots(dir);
  // The file store's pointer is the published state; a damaged pointer fails
  // the migration (P3).
  const active = await loadResearchMemorySnapshot(dir);
  withDatabase(databaseFile, (db) => {
    db.transaction(() => {
      for (const snapshot of snapshots) insertSnapshot(db, snapshot, canonicalJson(snapshot));
      if (active !== undefined) setActive(db, active);
    })();
  });
  return { snapshots: snapshots.length };
}
