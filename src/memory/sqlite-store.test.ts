/**
 * M-b (#243): the SQLite store is a second implementation of the provider seam,
 * not a derived index. Every property PRD §4.1 requires of the file design gets
 * a named test here, plus parity with the file store: for one fixed Mission
 * record both stores must serve identical snapshot digests and identical packet
 * projections. M-c (#244) then made this store the default; the file store is
 * the rollback path (`default-store.test.ts`).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../execution/security-boundary";
import {
  createFileResearchMemoryStore,
  createResearchMemoryProvider,
  createSqliteResearchMemoryProvider,
  createSqliteResearchMemoryStore,
  migrateFileResearchMemory,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  publishResearchMemorySnapshot,
  shamResearchMemorySnapshot,
  type ResearchMemorySource,
} from "./index";
import type { MemoryProviderRequest } from "../execution/context-broker";
import type { SynthesisProposal } from "../evidence/synthesis-proposal";

const dirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-memory-sqlite-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function proposal(over: Partial<SynthesisProposal>): SynthesisProposal {
  return {
    schema: "evok.synthesis-proposal/v1",
    missionId: "m-sqlite",
    agentId: "agent-1",
    supportingRefs: [],
    contradictingRefs: [],
    competingRefs: [],
    unknowns: [],
    applicability: [],
    visibility: "mission",
    limitations: [],
    conditions: [],
    digest: "0".repeat(64),
    ...over,
  } as SynthesisProposal;
}

/** One Mission record's projection input: measured Runs plus a stored Proposal. */
function source(over: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-sqlite",
    ledgerRevision: 5,
    conditions: ["dataset:v2", "method:gbdt"],
    maxCards: 8,
    runs: [
      {
        runId: "m-sqlite:baseline:1",
        taskId: "t-1",
        taskObjective: "raise AUC",
        ok: true,
        score: 0.8,
        evidenceRefs: ["runs/1/result.json"],
      },
      {
        runId: "m-sqlite:exp:2",
        taskId: "t-1",
        taskObjective: "raise AUC",
        ok: false,
        error: "CUDA out of memory",
        configuration: "batch=512",
        evidenceRefs: ["runs/2/result.json"],
      },
    ],
    proposals: [
      proposal({
        proposalId: "p-1",
        operationId: "op-1",
        kind: "pitfall",
        statement: "Oversized batches OOM on the shared GPU",
        rationale: "keep batch <= 256",
        applicability: ["runtime:a800"],
        conditions: ["batch >= 512"],
      }),
    ],
    ...over,
  };
}

function snapshot(over: Partial<ResearchMemorySource> = {}) {
  return projectResearchMemorySnapshot(source(over));
}

function request(runId: string): MemoryProviderRequest {
  return {
    missionId: "m-sqlite",
    taskId: "t-1",
    runId,
    targetAgentId: "agent-2",
    role: "researcher",
    evidenceRefs: ["runs/9/result.json"],
  };
}

function raw(file: string): Database {
  return new Database(file);
}

function rowCount(file: string, sql: string, ...params: string[]): number {
  const db = raw(file);
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("SQLite research memory store (#243)", () => {
  test("P1 content addressing: the digest is recomputed and compared on every read", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const published = snapshot();
    await store.publish(published);

    const db = raw(file);
    db.exec("DROP TRIGGER snapshots_immutable_update");
    // Same digest key, different bytes: only a recomputed digest can catch this.
    db.prepare("UPDATE snapshots SET payload = ? WHERE digest = ?").run(
      JSON.stringify({ ...published, cards: [] }),
      published.digest,
    );
    db.close();

    await expect(store.loadPinned(published.digest)).rejects.toThrow(/digest mismatch/);
    // The pointer read is only an address; the provider re-derives the digest.
    await expect(createSqliteResearchMemoryProvider(file)(request("run-1"))).rejects.toThrow(/digest mismatch/);
  });

  test("P2 atomic publication: a failed transaction publishes neither rows nor a new pointer", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const first = snapshot({ ledgerRevision: 5 });
    const second = snapshot({ ledgerRevision: 6 });
    expect(second.digest).not.toBe(first.digest);
    await store.publish(first);

    // Fail at the LAST write (the pointer switch), after the snapshot row and
    // its cards were inserted: the whole publication must still roll back.
    const db = raw(file);
    db.exec("CREATE TRIGGER p2_fail_insert BEFORE INSERT ON active BEGIN SELECT RAISE(ABORT, 'p2-fail'); END");
    db.exec("CREATE TRIGGER p2_fail_update BEFORE UPDATE ON active BEGIN SELECT RAISE(ABORT, 'p2-fail'); END");
    db.close();

    await expect(store.publish(second)).rejects.toThrow(/p2-fail/);

    expect(await store.loadActive()).toBe(first.digest);
    expect(rowCount(file, "SELECT COUNT(*) AS n FROM snapshots")).toBe(1);
    expect(rowCount(file, "SELECT COUNT(*) AS n FROM snapshots WHERE digest = ?", second.digest)).toBe(0);
    expect(rowCount(file, "SELECT COUNT(*) AS n FROM cards WHERE digest = ?", second.digest)).toBe(0);
  });

  test("P3 corruption is never empty history: a damaged snapshot, pointer or cards projection throws", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const published = snapshot();
    await store.publish(published);

    // (a) Malformed payload JSON.
    let db = raw(file);
    db.exec("DROP TRIGGER snapshots_immutable_update");
    db.prepare("UPDATE snapshots SET payload = ? WHERE digest = ?").run("{not json", published.digest);
    db.close();
    await expect(store.loadPinned(published.digest)).rejects.toThrow(/not valid JSON/);

    // (b) The active pointer names a missing snapshot.
    db = raw(file);
    db.exec("DROP TRIGGER snapshots_immutable_delete");
    db.prepare("DELETE FROM snapshots WHERE digest = ?").run(published.digest);
    db.close();
    expect(await store.loadActive()).toBe(published.digest);
    await expect(store.loadPinned(published.digest)).rejects.toThrow(/snapshot is missing/);
    await expect(createSqliteResearchMemoryProvider(file)(request("run-1"))).rejects.toThrow(/snapshot is missing/);

    // (c) A cards row disagrees with the payload.
    await store.publish(published);
    db = raw(file);
    db.prepare("UPDATE cards SET kind = 'finding' WHERE digest = ? AND card_id = ?").run(
      published.digest,
      published.cards.find((card) => card.kind === "pitfall")!.cardId,
    );
    db.close();
    await expect(store.loadPinned(published.digest)).rejects.toThrow(/cards projection/);
  });

  test("P4 deterministic rebuild: re-projecting the same Mission history reproduces identical digests and payload bytes", async () => {
    // `projectResearchMemorySnapshot` is the rebuild seam recovery uses
    // (`reconcileResearchMemory`); a store that changed the bytes would break it.
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const first = snapshot();
    const rebuilt = snapshot();
    expect(rebuilt.digest).toBe(first.digest);
    await store.publish(first);
    await store.publish(rebuilt);

    expect(await store.loadPinned(first.digest)).toEqual(first);
    expect(rowCount(file, "SELECT COUNT(*) AS n FROM snapshots")).toBe(1);
    const db = raw(file);
    const payload = (db.prepare("SELECT payload FROM snapshots WHERE digest = ?").get(rebuilt.digest) as { payload: string }).payload;
    db.close();
    expect(payload).toBe(canonicalJson(rebuilt));
  });

  test("P5 immutable snapshots: content is insert-only in the API and by trigger", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    expect(Object.keys(store).sort()).toEqual(["loadActive", "loadPinned", "publish"]);

    const published = snapshot();
    await store.publish(published);
    const db = raw(file);
    expect(() => db.prepare("UPDATE snapshots SET payload = '{}'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM snapshots").run()).toThrow(/immutable/);
    db.close();
    expect(await store.loadPinned(published.digest)).toEqual(published);
  });

  test("P6 no future information: every read is pinned to a snapshot id, never latest", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const first = snapshot({ ledgerRevision: 5 });
    const second = snapshot({ ledgerRevision: 6 });
    await store.publish(first);

    // The Run is served one pinned snapshot; publishing later cannot reach it.
    const slice = (await createSqliteResearchMemoryProvider(file)(request("run-1")))!;
    expect(slice.research!.digest).toBe(first.digest);
    await store.publish(second);
    expect(slice.research!.digest).toBe(first.digest);
    expect(await store.loadPinned(first.digest)).toEqual(first);
    expect(await store.loadActive()).toBe(second.digest);
  });

  test("a Sham snapshot round-trips on the sham arm", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const sham = shamResearchMemorySnapshot(snapshot());
    await store.publish(sham);
    expect(await store.loadPinned(sham.digest)).toEqual(sham);
    expect(await store.loadActive()).toBe(sham.digest);
    const db = raw(file);
    expect((db.prepare("SELECT arm FROM active").get() as { arm: string }).arm).toBe("sham");
    db.close();
  });

  test("snapshots.payload is canonical JSON text of the served snapshot", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const published = snapshot();
    await store.publish(published);
    const db = raw(file);
    const payload = (db.prepare("SELECT payload FROM snapshots WHERE digest = ?").get(published.digest) as { payload: string }).payload;
    db.close();
    expect(JSON.parse(payload)).toEqual(published);
    expect(payload).toBe(canonicalJson(JSON.parse(payload)));
  });

  test("cards is a query projection of the payload, and a mismatch is corruption", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    const published = snapshot();
    await store.publish(published);
    const db = raw(file);
    const rows = db.prepare("SELECT card_id, kind, lifecycle, applicability, ordinal FROM cards WHERE digest = ? ORDER BY ordinal").all(published.digest) as Array<{
      card_id: string;
      kind: string;
      lifecycle: string;
      applicability: string;
      ordinal: number;
    }>;
    db.close();
    expect(rows.map((row) => row.card_id)).toEqual(published.cards.map((card) => card.cardId));
    expect(rows.map((row) => row.kind)).toEqual(published.cards.map((card) => card.kind));
    expect(rows.map((row) => row.ordinal)).toEqual(published.cards.map((_card, index) => index));
    expect(rows.map((row) => JSON.parse(row.applicability))).toEqual(published.cards.map((card) => card.applicability));
  });

  test("one-shot migration copies snapshots/*.json and the active pointer with digest verification", async () => {
    const root = await temp();
    const dir = join(root, "memory");
    const file = join(dir, "memory.sqlite");
    const first = snapshot({ ledgerRevision: 5 });
    const second = snapshot({ ledgerRevision: 6 });
    await publishResearchMemorySnapshot(dir, first);
    await publishResearchMemorySnapshot(dir, second);

    expect(await migrateFileResearchMemory(dir, file)).toEqual({ snapshots: 2 });
    const store = createSqliteResearchMemoryStore(file);
    expect(await store.loadPinned((await store.loadActive())!)).toEqual(second);
    expect(await store.loadPinned(first.digest)).toEqual(first);
    // Idempotent: a second run verifies and re-writes nothing new.
    expect(await migrateFileResearchMemory(dir, file)).toEqual({ snapshots: 2 });
    expect(rowCount(file, "SELECT COUNT(*) AS n FROM snapshots")).toBe(2);
  });

  test("migration refuses a file whose name is not its digest and writes nothing", async () => {
    const root = await temp();
    const dir = join(root, "memory");
    const file = join(dir, "memory.sqlite");
    const first = snapshot();
    await publishResearchMemorySnapshot(dir, first);
    await writeFile(join(dir, "snapshots", `${"a".repeat(64)}.json`), JSON.stringify(first), "utf8");

    await expect(migrateFileResearchMemory(dir, file)).rejects.toThrow(/content address/);
    expect(await createSqliteResearchMemoryStore(file).loadActive()).toBeUndefined();
  });

  test("parity: both stores serve identical snapshot digests and identical packet projections", async () => {
    const root = await temp();
    const dir = join(root, "memory");
    const database = join(root, "memory.sqlite");
    const fileStore = createFileResearchMemoryStore(dir);
    const sqliteStore = createSqliteResearchMemoryStore(database);
    // Both stores are driven from the SAME Mission record, each projecting it
    // independently, so a parity pass cannot hide behind one shared object.
    const fromRecordForFile = projectResearchMemorySnapshot(source());
    const fromRecordForSqlite = projectResearchMemorySnapshot(source());
    await fileStore.publish(fromRecordForFile);
    await sqliteStore.publish(fromRecordForSqlite);

    const fromFile = await fileStore.loadPinned((await fileStore.loadActive())!);
    const fromSqlite = await sqliteStore.loadPinned((await sqliteStore.loadActive())!);
    expect(fromSqlite.digest).toBe(fromFile.digest);
    expect(fromSqlite).toEqual(fromFile);
    expect(await sqliteStore.loadPinned(fromRecordForFile.digest)).toEqual(await fileStore.loadPinned(fromRecordForFile.digest));
    expect(projectResearchDecisionPacket(fromSqlite)).toEqual(projectResearchDecisionPacket(fromFile));

    // The providers are the same seam: one fixed Run request, identical slices.
    const fileSlice = (await createResearchMemoryProvider(dir)(request("run-9")))!;
    const sqliteSlice = (await createSqliteResearchMemoryProvider(database)(request("run-9")))!;
    expect(sqliteSlice).toEqual(fileSlice);
    expect(sqliteSlice.digest).toBe(fileSlice.digest);
    expect(sqliteSlice.research!.digest).toBe(fileSlice.research!.digest);
  });

  test("no agent-facing mutation: the store surface and served slices are read-only", async () => {
    const file = join(await temp(), "memory.sqlite");
    const store = createSqliteResearchMemoryStore(file);
    expect(Object.keys(store).sort()).toEqual(["loadActive", "loadPinned", "publish"]);
    // Nothing published: a first Run keeps the legacy prompt, never an empty slice.
    expect(await createSqliteResearchMemoryProvider(file)(request("run-1"))).toBeUndefined();
    await store.publish(snapshot());
    const served = (await createSqliteResearchMemoryProvider(file)(request("run-2")))!;
    expect(Object.isFrozen(served)).toBe(true);
    expect(Object.isFrozen(served.research)).toBe(true);
  });
});
