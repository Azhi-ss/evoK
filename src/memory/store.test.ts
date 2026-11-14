/**
 * The store seam's own tests (#210, #216), served by the ONE store since M-e
 * (#246): the SQLite store. The file-store equivalents went with the file store;
 * the properties they protected (P1-P6) are asserted in `sqlite-store.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_SLICE_RESEARCH_SCHEMA,
  MemorySliceError,
  createDelegatedResearchMemoryProvider,
  createMemorySlice,
  createResearchMemorySlice,
  defaultResearchMemoryProvider,
  loadActiveResearchMemorySnapshot,
  projectResearchMemorySnapshot,
  researchMemoryStoreFor,
  validateMemorySlice,
} from "./index";

const dirs: string[] = [];
async function memoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-research-memory-"));
  dirs.push(dir);
  return join(dir, "memory");
}

function snapshot(missionId = "m-memory", ledgerRevision = 1) {
  return projectResearchMemorySnapshot({
    missionId,
    ledgerRevision,
    runs: [
      { runId: `${missionId}:baseline:1`, ok: true, score: 0.75, evidenceRefs: [`runs/baseline/result.json`] },
      { runId: `${missionId}:exp:2`, ok: false, ruleViolations: ["answer.txt is missing"], evidenceRefs: [] },
    ],
  });
}

const request = (over: Record<string, unknown> = {}) => ({
  missionId: "m-memory",
  taskId: "task-exp-2",
  runId: "m-memory:exp:2",
  targetAgentId: "evok-experiment-investigate@m-memory:exp:2",
  role: "researcher" as const,
  evidenceRefs: ["runs/m-memory:baseline:1/result.json"],
  ...over,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("research memory store (#210)", () => {
  test("publishes and reloads the active snapshot", async () => {
    const store = researchMemoryStoreFor(await memoryDir());
    const published = snapshot();
    await store.publish(published);
    expect(await loadActiveResearchMemorySnapshot(store)).toEqual(published);
  });

  test("nothing published means no memory yet (a first Run stays legacy)", async () => {
    expect(await loadActiveResearchMemorySnapshot(researchMemoryStoreFor(await memoryDir()))).toBeUndefined();
  });

  test("a later publication moves the pointer and leaves the earlier snapshot readable by digest", async () => {
    const store = researchMemoryStoreFor(await memoryDir());
    const earlier = snapshot("m-memory", 1);
    await store.publish(earlier);
    const later = snapshot("m-memory", 2);
    await store.publish(later);
    // Republishing never rewrites the older address (P5): a Run pinned to it
    // still reads exactly what it was served.
    expect(await store.loadPinned(earlier.digest)).toEqual(earlier);
    expect(await loadActiveResearchMemorySnapshot(store)).toEqual(later);
  });
});

describe("default research memory provider (#210)", () => {
  test("returns an additive v3 slice bound to this Run, with the pinned card and snapshot", async () => {
    const dir = await memoryDir();
    const pinned = snapshot();
    await researchMemoryStoreFor(dir).publish(pinned);

    const slice = (await defaultResearchMemoryProvider(dir)(request()))!;
    expect(slice.schema).toBe(MEMORY_SLICE_RESEARCH_SCHEMA);
    expect(slice.schema).toBe("evok.memory-slice/v3");
    expect(slice.missionId).toBe("m-memory");
    expect(slice.taskId).toBe("task-exp-2");
    expect(slice.runId).toBe("m-memory:exp:2");
    expect(slice.targetAgentId).toBe("evok-experiment-investigate@m-memory:exp:2");
    expect(slice.research).toEqual(pinned);
    // v3 carries the cards once, in the pinned packet; the legacy block stays empty.
    expect(slice.findings).toEqual([]);
    expect(slice.research!.cards).toHaveLength(2);
    expect(validateMemorySlice(JSON.parse(JSON.stringify(slice)))).toEqual(slice);
    // No transcript or artifact body can travel in the slice.
    expect(JSON.stringify(slice)).not.toContain("MEMORY SLICE");
    expect(Object.keys(slice).sort()).toEqual([
      "artifactRefs", "digest", "evidenceRefs", "facts", "findings", "missionId", "readPolicy",
      "research", "runId", "schema", "sliceId", "sourceRefs", "targetAgentId", "taskId",
    ]);
  });

  test("a snapshot from another Mission fails closed", async () => {
    const dir = await memoryDir();
    await researchMemoryStoreFor(dir).publish(snapshot("m-other"));
    await expect(defaultResearchMemoryProvider(dir)(request())).rejects.toThrow(MemorySliceError);
  });
});

describe("memory slice v2 compatibility (#210)", () => {
  test("v3 is additive: a v2 payload still validates and carries no research packet", () => {
    const valid = createMemorySlice({
      sliceId: "slice-1",
      missionId: "m-1",
      taskId: "task-1",
      runId: "m-1:exp:2",
      targetAgentId: "researcher@m-1:exp:2",
      evidenceRefs: ["runs/1/result.json"],
      facts: [{ name: "score", value: 0.5 }],
      findings: [{ findingId: "f-1", summary: "drop the leaky column", ok: false }],
    });
    expect(valid.schema).toBe("evok.memory-slice/v2");
    expect(valid.research).toBeUndefined();
    expect(validateMemorySlice(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });
});

describe("delegated child research memory (#217)", () => {
  const parentSlice = () => createResearchMemorySlice({
    sliceId: "slice-parent",
    missionId: "m-memory",
    taskId: "task-exp:2",
    runId: "m-memory:exp:2",
    targetAgentId: "researcher@m-memory:exp:2",
    research: snapshot(),
  });
  const childRequest = {
    missionId: "m-memory",
    taskId: "task-exp:2:sub",
    runId: "m-memory:exp:2:sub:1",
    targetAgentId: "critic@m-memory:exp:2:sub:1",
    role: "critic" as const,
    evidenceRefs: [],
  };

  test("serves a fresh child-bound slice from the parent's pinned snapshot, not the active pointer", async () => {
    const dir = await memoryDir();
    // The active projection has already moved on to a newer snapshot.
    await researchMemoryStoreFor(dir).publish(projectResearchMemorySnapshot({
      missionId: "m-memory",
      ledgerRevision: 9,
      runs: [
        { runId: "m-memory:baseline:1", ok: true, score: 0.1, evidenceRefs: [] },
        { runId: "m-memory:exp:2", ok: false, ruleViolations: ["answer.txt is missing"], evidenceRefs: [] },
      ],
    }));
    const parent = parentSlice();
    const provider = createDelegatedResearchMemoryProvider({
      parent,
      taskId: childRequest.taskId,
      runId: childRequest.runId,
      targetAgentId: childRequest.targetAgentId,
    });
    const slice = (await provider(childRequest))!;
    expect(slice.schema).toBe(MEMORY_SLICE_RESEARCH_SCHEMA);
    expect(slice.runId).toBe(childRequest.runId);
    expect(slice.targetAgentId).toBe(childRequest.targetAgentId);
    expect(slice.sliceId).not.toBe(parent.sliceId);
    // Exactly the parent's pinned packet: never the newer active one.
    expect(slice.research).toEqual(parent.research);
    expect(slice.research!.ledgerRevision).toBe(1);
    expect(validateMemorySlice(JSON.parse(JSON.stringify(slice)))).toEqual(slice);
  });

  test("a sibling or otherwise mismatched request is refused", async () => {
    const provider = createDelegatedResearchMemoryProvider({
      parent: parentSlice(),
      taskId: childRequest.taskId,
      runId: childRequest.runId,
      targetAgentId: childRequest.targetAgentId,
    });
    for (const bad of [
      { ...childRequest, runId: "m-memory:exp:2:sub:2" },
      { ...childRequest, targetAgentId: "critic@m-memory:exp:2:sub:2" },
      { ...childRequest, taskId: "task-exp:9" },
    ]) {
      await expect(provider(bad)).rejects.toThrow(/bound to child Task/);
    }
    await expect(provider({ ...childRequest, missionId: "m-other" })).rejects.toThrow(/parent memory slice belongs to Mission/);
  });

  test("a legacy v2 parent keeps the v2 contract for its child", async () => {
    const parent = createMemorySlice({
      sliceId: "slice-parent-legacy", missionId: "m-memory", taskId: "task-exp:2",
      runId: "m-memory:exp:2", targetAgentId: "researcher@m-memory:exp:2",
      findings: [{ findingId: "f-1", summary: "grouped split needed" }],
    });
    const slice = (await createDelegatedResearchMemoryProvider({
      parent, taskId: childRequest.taskId, runId: childRequest.runId, targetAgentId: childRequest.targetAgentId,
    })(childRequest))!;
    expect(slice.schema).toBe("evok.memory-slice/v2");
    expect(slice.research).toBeUndefined();
    expect(slice.findings).toEqual(parent.findings);
  });
});
