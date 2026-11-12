/**
 * M-c (#244) made SQLite the default store; M-e (#246, ADR-0017) deleted the
 * file store and the `EVOK_RESEARCH_MEMORY_STORE` rollback switch, so this file
 * now pins what remains a contract: one database file per Mission, nothing else
 * on disk, pinned reads that survive later publication, and repair by
 * republication rather than by a second store.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryProviderRequest } from "../execution/context-broker";
import {
  RESEARCH_MEMORY_DATABASE_FILENAME,
  loadActiveResearchMemorySnapshot,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  researchMemoryProviderFromStore,
  researchMemoryStoreFor,
  type ResearchMemorySource,
} from "./index";

const dirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-memory-default-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
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

describe("default Research Memory store (M-c #244, single store since M-e #246)", () => {
  test("the default store writes ONE database file and no file-store layout", async () => {
    const published = snapshot();
    const dir = await temp();
    const store = researchMemoryStoreFor(dir);
    await store.publish(published);
    expect(await store.loadActive()).toBe(published.digest);
    expect(await exists(join(dir, RESEARCH_MEMORY_DATABASE_FILENAME))).toBe(true);
    // The deleted file layout must never reappear next to the database.
    expect(await exists(join(dir, "active.json"))).toBe(false);
    expect(await exists(join(dir, "snapshots"))).toBe(false);
  });

  test("a Run pinned before a later publication is served the same snapshot by digest", async () => {
    const dir = await temp();
    const pinned = snapshot();
    await researchMemoryStoreFor(dir).publish(pinned);
    // The Run started before the next projection and recorded what it was served.
    const served = (await researchMemoryProviderFromStore(researchMemoryStoreFor(dir))(request("run-1")))!;
    const recordedDigest = served.research!.digest;
    const recordedPacket = projectResearchDecisionPacket(served.research!);

    await researchMemoryStoreFor(dir).publish(snapshot({ ledgerRevision: 5 }));
    const resumed = await researchMemoryStoreFor(dir).loadPinned(recordedDigest);
    expect(resumed.digest).toBe(recordedDigest);
    expect(resumed).toEqual(pinned);
    expect(projectResearchDecisionPacket(resumed)).toEqual(recordedPacket);
  });

  test("a verified snapshot is served byte-for-byte by both the store and the packet projection", async () => {
    const dir = await temp();
    const latest = snapshot({ ledgerRevision: 5 });
    const store = researchMemoryStoreFor(dir);
    await store.publish(latest);
    expect(projectResearchDecisionPacket((await loadActiveResearchMemorySnapshot(store))!))
      .toEqual(projectResearchDecisionPacket(latest));
    expect((await researchMemoryProviderFromStore(store)(request("run-7")))!.research).toEqual(latest);
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
