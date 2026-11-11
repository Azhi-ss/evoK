/**
 * SQLite Research Memory store (M-b / #243). A second implementation of the
 * store-neutral seam in `store.ts`, behind the same provider; the file store is
 * still the default until M-c (#244).
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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

const SCHEMA = `
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
    db.exec(SCHEMA);
    return fn(db);
  } finally {
    db.close();
  }
}

/** Inserts one immutable snapshot and its query projection; never switches the pointer. */
function insertSnapshot(db: Database, snapshot: ResearchMemorySnapshot, payload: string): void {
  const existing = db.prepare("SELECT payload FROM snapshots WHERE digest = ?").get(snapshot.digest) as SnapshotRow | null;
  if (existing !== null && existing.payload !== payload) {
    throw new MemorySliceError("research memory digest already names different payload bytes; refusing to overwrite published content");
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
  db.prepare(
    `INSERT INTO active (mission_id, arm, digest) VALUES (?, ?, ?)
     ON CONFLICT(mission_id, arm) DO UPDATE SET digest = excluded.digest`,
  ).run(snapshot.missionId, armOf(snapshot), snapshot.digest);
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

/** The SQLite store: same seam as the file store, one database file. */
export function createSqliteResearchMemoryStore(file: string): ResearchMemoryStore {
  return {
    async publish(snapshot): Promise<void> {
      const validated = validateResearchMemorySnapshot(snapshot);
      const payload = canonicalJson(validated);
      withDatabase(file, (db) => {
        db.transaction(() => {
          insertSnapshot(db, validated, payload);
          setActive(db, validated);
        })();
      });
    },
    async loadActive(): Promise<string | undefined> {
      return withDatabase(file, (db) => {
        // P6: the pointer read yields a digest, never content. One row is the
        // normal case; a Mission's arm is fixed at acceptance, so more than one
        // row means a mixed-arm or multi-Mission database, which is refused.
        const rows = db.prepare("SELECT digest FROM active ORDER BY mission_id, arm LIMIT 2").all() as Array<{ digest: string }>;
        if (rows.length === 0) return undefined;
        if (rows.length > 1) {
          throw new MemorySliceError("research memory database holds more than one active snapshot; refusing to guess which Mission it serves");
        }
        return rows[0].digest;
      });
    },
    async loadPinned(digest: string): Promise<ResearchMemorySnapshot> {
      return withDatabase(file, (db) => readPinned(db, digest));
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
