/**
 * M-c (#244): SQLite is the default Research Memory store and the file reader is
 * the rollback path. The switch must not change one served byte: an existing
 * Mission's files migrate on first use with identical digests, and a Run pinned
 * before the migration still resolves its snapshot by content address after it.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryProviderRequest } from "../execution/context-broker";
import {
  RESEARCH_MEMORY_DATABASE_FILENAME,
  RESEARCH_MEMORY_STORE_ENV,
  createResearchMemoryProvider,
  loadActiveResearchMemorySnapshot,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  publishResearchMemorySnapshot,
  researchMemoryProviderFromStore,
  researchMemoryStoreFor,
  researchMemoryStoreName,
  type ResearchMemorySource,
  type ResearchMemoryStoreName,
} from "./index";

const dirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-memory-default-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env[RESEARCH_MEMORY_STORE_ENV];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

function source(over: Partial<ResearchMemorySource> = {}): ResearchMemorySource {
  return {
    missionId: "m-default",
    ledgerRevision: 4,
    conditions: ["dataset:v2"],
    maxCards: 8,
    runs: [
      { runId: "m-default:baseline:1", taskId: "t-1", taskObjective: "raise AUC", ok: true, score: 0.7, evidenceRefs: ["runs/1/result.json"] },
      { runId: "m-default:exp:2", taskId: "t-1", taskObjective: "raise AUC", ok: false, error: "OOM", configuration: "batch=512", evidenceRefs: ["runs/2/result.json"] },
    ],
    proposals: [],
    ...over,
  };
}

const snapshot = (over: Partial<ResearchMemorySource> = {}) => projectResearchMemorySnapshot(source(over));

function request(runId: string): MemoryProviderRequest {
  return { missionId: "m-default", taskId: "t-1", runId, targetAgentId: "agent-2", role: "researcher", evidenceRefs: [] };
}

describe("default Research Memory store (M-c #244)", () => {
  test("SQLite is the default store; the file store is an explicit rollback", async () => {
    expect(researchMemoryStoreName({})).toBe("sqlite" satisfies ResearchMemoryStoreName);
    expect(researchMemoryStoreName({ [RESEARCH_MEMORY_STORE_ENV]: "file" })).toBe("file");
    // A typo must never silently pick a store.
    expect(() => researchMemoryStoreName({ [RESEARCH_MEMORY_STORE_ENV]: "sqlite3" })).toThrow(/EVOK_RESEARCH_MEMORY_STORE/);

    const published = snapshot();
    const dir = await temp();
    const defaultStore = researchMemoryStoreFor(dir);
    await defaultStore.publish(published);
    expect(await defaultStore.loadActive()).toBe(published.digest);
    expect(await exists(join(dir, RESEARCH_MEMORY_DATABASE_FILENAME))).toBe(true);
    // The default writes ONE database file, not the file-store layout.
    expect(await exists(join(dir, "active.json"))).toBe(false);
    expect(await exists(join(dir, "snapshots"))).toBe(false);

    const rollbackDir = await temp();
    await researchMemoryStoreFor(rollbackDir, "file").publish(published);
    expect(await researchMemoryStoreFor(rollbackDir, "file").loadActive()).toBe(published.digest);
    expect(await exists(join(rollbackDir, "active.json"))).toBe(true);
    expect(await exists(join(rollbackDir, RESEARCH_MEMORY_DATABASE_FILENAME))).toBe(false);
  });

  test("the environment selects the store, so rollback is a configuration change", async () => {
    const dir = await temp();
    const published = snapshot();
    process.env[RESEARCH_MEMORY_STORE_ENV] = "file";
    await researchMemoryStoreFor(dir).publish(published);
    expect(await exists(join(dir, "active.json"))).toBe(true);
    expect(await exists(join(dir, RESEARCH_MEMORY_DATABASE_FILENAME))).toBe(false);
    expect(await researchMemoryStoreFor(dir).loadActive()).toBe(published.digest);
  });

  test("an existing Mission migrates on first use with identical served digests and packets", async () => {
    const dir = await temp();
    const earlier = snapshot({ ledgerRevision: 4 });
    const latest = snapshot({ ledgerRevision: 5 });
    await publishResearchMemorySnapshot(dir, earlier);
    await publishResearchMemorySnapshot(dir, latest);
    // What a pre-migration Run was served, over the file store.
    const before = (await createResearchMemoryProvider(dir)(request("run-7")))!;

    const store = researchMemoryStoreFor(dir);
    expect(await store.loadActive()).toBe(latest.digest);
    expect(await store.loadPinned(earlier.digest)).toEqual(earlier);
    const after = (await researchMemoryProviderFromStore(store)(request("run-7")))!;
    expect(after.digest).toBe(before.digest);
    expect(after).toEqual(before);
    expect(projectResearchDecisionPacket((await loadActiveResearchMemorySnapshot(store))!))
      .toEqual(projectResearchDecisionPacket(latest));
  });

  test("migration is one-shot: a populated database is never re-seeded from leftover files", async () => {
    const dir = await temp();
    const earlier = snapshot({ ledgerRevision: 4 });
    const newer = snapshot({ ledgerRevision: 5 });
    await publishResearchMemorySnapshot(dir, earlier);

    const store = researchMemoryStoreFor(dir);
    await store.publish(newer);
    expect(await store.loadActive()).toBe(newer.digest);

    // A fresh store instance keeps the database's pointer; the stale file
    // pointer must not drag serving backwards.
    expect(await researchMemoryStoreFor(dir).loadActive()).toBe(newer.digest);
    expect(await researchMemoryStoreFor(dir).loadPinned(earlier.digest)).toEqual(earlier);
  });

  test("a Run pinned before the migration is served the same snapshot by digest after it", async () => {
    const dir = await temp();
    const pinned = snapshot();
    await publishResearchMemorySnapshot(dir, pinned);
    // The Run started before the switch and recorded what it was served.
    const served = (await createResearchMemoryProvider(dir)(request("run-1")))!;
    const recordedDigest = served.research!.digest;
    const recordedPacket = projectResearchDecisionPacket(served.research!);

    const resumed = await researchMemoryStoreFor(dir).loadPinned(recordedDigest);
    expect(resumed.digest).toBe(recordedDigest);
    expect(resumed).toEqual(pinned);
    expect(projectResearchDecisionPacket(resumed)).toEqual(recordedPacket);
  });

  test("damaged files with an empty database surface the damage instead of serving empty history", async () => {
    const dir = await temp();
    await publishResearchMemorySnapshot(dir, snapshot());
    await writeFile(join(dir, "active.json"), "{not json", "utf8");

    // Nothing migrated: the store must refuse, not report "never published".
    await expect(researchMemoryStoreFor(dir).loadActive()).rejects.toThrow(/not valid JSON/);
    // Republishing still works (recovery rebuilds from Mission history), and a
    // pre-migration pinned digest reports WHY it is gone, not "missing".
    const intact = snapshot({ ledgerRevision: 9 });
    const store = researchMemoryStoreFor(dir);
    await store.publish(intact);
    expect(await researchMemoryStoreFor(dir).loadActive()).toBe(intact.digest);
    // The instance that saw the damage still reports it for a pre-migration
    // digest instead of pretending the Mission never published anything.
    await expect(store.loadPinned(snapshot().digest)).rejects.toThrow(/not valid JSON/);
  });

  test("rollback: the file reader keeps serving the pre-migration snapshot after the switch", async () => {
    const dir = await temp();
    const preSwitch = snapshot({ ledgerRevision: 4 });
    await publishResearchMemorySnapshot(dir, preSwitch);

    const store = researchMemoryStoreFor(dir);
    await store.publish(snapshot({ ledgerRevision: 5 }));
    // The database moved on; the file reader still holds its last snapshot, so
    // rollback is a pin to what the file store had, never a silent blend.
    expect(await researchMemoryStoreFor(dir, "file").loadActive()).toBe(preSwitch.digest);
  });

  test("a corrupt row is repaired by republication, valid content stays immutable", async () => {
    const dir = await temp();
    const published = snapshot();
    const store = researchMemoryStoreFor(dir);
    await store.publish(published);

    const file = join(dir, RESEARCH_MEMORY_DATABASE_FILENAME);
    const db = new Database(file);
    db.exec("DROP TRIGGER snapshots_immutable_update");
    db.prepare("UPDATE snapshots SET payload = ? WHERE digest = ?").run("{ corrupted", published.digest);
    db.prepare("DELETE FROM cards WHERE digest = ? AND ordinal = 0").run(published.digest);
    db.close();
    await expect(store.loadPinned(published.digest)).rejects.toThrow(/not valid JSON/);

    // Recovery republishes the deterministic rebuild: the address has no valid
    // content, so republication restores both the payload and its projection.
    await store.publish(published);
    expect(await store.loadPinned(published.digest)).toEqual(published);
    expect((await store.loadPinned(published.digest)).cards).toEqual(published.cards);
  });

  test("a database that is not a database is rebuilt by republication, not left unreadable", async () => {
    const dir = await temp();
    const published = snapshot();
    const store = researchMemoryStoreFor(dir);
    await store.publish(published);

    // File-level damage: the derived database holds no readable content.
    const database = join(dir, RESEARCH_MEMORY_DATABASE_FILENAME);
    await rm(`${database}-wal`, { force: true });
    await rm(`${database}-shm`, { force: true });
    await writeFile(database, "not a sqlite database at all", "utf8");
    await expect(researchMemoryStoreFor(dir).loadActive()).rejects.toThrow(/not a database/i);

    const rebuilt = researchMemoryStoreFor(dir);
    await rebuilt.publish(published);
    expect(await rebuilt.loadActive()).toBe(published.digest);
    expect(await rebuilt.loadPinned(published.digest)).toEqual(published);
  });
});
