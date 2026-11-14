import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectResearchMemorySnapshot } from "../memory";
import {
  MEMORY_SLICE_RESEARCH_SCHEMA, MemorySliceError, createMemorySlice, createResearchMemorySlice, validateMemorySlice,
} from "../memory";
import {
  createDelegatedResearchMemoryProvider,
  createResearchMemoryProvider,
  loadResearchMemorySnapshot,
  publishResearchMemorySnapshot,
} from "../memory";

const dirs: string[] = [];
async function memoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-research-memory-"));
  dirs.push(dir);
  return join(dir, "memory");
}

function snapshot(missionId = "m-memory") {
  return projectResearchMemorySnapshot({
    missionId,
    ledgerRevision: 1,
    runs: [
      { runId: `${missionId}:baseline:1`, ok: true, score: 0.75, evidenceRefs: [`runs/baseline/result.json`] },
      { runId: `${missionId}:exp:2`, ok: false, ruleViolations: ["answer.txt is missing"], evidenceRefs: [] },
    ],
  });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("research memory store (#210)", () => {
  test("publishes atomically and reloads the active snapshot", async () => {
    const dir = await memoryDir();
    const published = snapshot();
    await publishResearchMemorySnapshot(dir, published);
    expect(await loadResearchMemorySnapshot(dir)).toEqual(published);

    const pointer = JSON.parse(await readFile(join(dir, "active.json"), "utf8"));
    expect(pointer).toEqual({
      schema: "evok.research-memory-pointer/v1",
      snapshotId: published.snapshotId,
      digest: published.digest,
    });
  });

  test("no pointer means no memory yet (a first Run stays legacy)", async () => {
    expect(await loadResearchMemorySnapshot(await memoryDir())).toBeUndefined();
  });

  test("a damaged pointer or snapshot fails closed instead of serving empty memory", async () => {
    const dir = await memoryDir();
    const published = snapshot();
    await publishResearchMemorySnapshot(dir, published);

    await writeFile(join(dir, "active.json"), "{not json");
    await expect(loadResearchMemorySnapshot(dir)).rejects.toThrow(/not valid JSON/);

    await publishResearchMemorySnapshot(dir, published);
    const file = join(dir, "snapshots", `${published.digest}.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.cards[0].summary = "tampered";
    await writeFile(file, JSON.stringify(stored));
    await expect(loadResearchMemorySnapshot(dir)).rejects.toThrow(/digest mismatch/);
  });
});

describe("snapshot commit and pointer switch atomicity (#216)", () => {
  test("an orphaned or half-written snapshot is never served; the pointer names only a complete one", async () => {
    const dir = await memoryDir();
    const active = snapshot();
    await publishResearchMemorySnapshot(dir, active);
    // A newer snapshot fully written but never referenced (a crash before the
    // pointer switch), plus a half-written temp file from a crashed writer.
    const newer = projectResearchMemorySnapshot({
      missionId: "m-memory",
      ledgerRevision: 2,
      runs: [{ runId: "m-memory:baseline:1", ok: true, score: 0.9, evidenceRefs: [] }],
    });
    await writeFile(join(dir, "snapshots", `${newer.digest}.json`), JSON.stringify(newer));
    await writeFile(join(dir, "snapshots", `${newer.digest}.json.999.1.tmp`), '{"schema":');
    // Readers still see the complete OLD snapshot, never the orphan.
    expect(await loadResearchMemorySnapshot(dir)).toEqual(active);

    // Only after publication does the pointer name the newer snapshot.
    await publishResearchMemorySnapshot(dir, newer);
    expect(await loadResearchMemorySnapshot(dir)).toEqual(newer);
  });

  test("a pointer whose snapshot artifact is gone fails closed instead of serving empty memory", async () => {
    const dir = await memoryDir();
    const published = snapshot();
    await publishResearchMemorySnapshot(dir, published);
    await rm(join(dir, "snapshots", `${published.digest}.json`));
    await expect(loadResearchMemorySnapshot(dir)).rejects.toThrow(/missing snapshot/);
    // A pointer that names another snapshot is equally refused.
    await publishResearchMemorySnapshot(dir, published);
    const pointer = JSON.parse(await readFile(join(dir, "active.json"), "utf8"));
    await writeFile(join(dir, "active.json"), JSON.stringify({ ...pointer, digest: "f".repeat(64) }));
    await expect(loadResearchMemorySnapshot(dir)).rejects.toThrow(/missing snapshot/);
  });
});

describe("default research memory provider (#210)", () => {
  test("the provider refuses a pointer whose snapshotId is not its digest's address", async () => {
    const dir = await memoryDir();
    const published = snapshot();
    await publishResearchMemorySnapshot(dir, published);
    const pointer = JSON.parse(await readFile(join(dir, "active.json"), "utf8"));
    await writeFile(join(dir, "active.json"), JSON.stringify({ ...pointer, snapshotId: "research-memory:not-this-digest" }));
    await expect(createResearchMemoryProvider(dir)({
      missionId: "m-memory",
      taskId: "task-exp-2",
      runId: "m-memory:exp:2",
      targetAgentId: "agent",
      role: "researcher",
      evidenceRefs: [],
    })).rejects.toThrow(/does not match its snapshot/);
  });

  test("returns an additive v3 slice bound to this Run, with the pinned card and snapshot", async () => {
    const dir = await memoryDir();
    const pinned = snapshot();
    await publishResearchMemorySnapshot(dir, pinned);

    const request = {
      missionId: "m-memory",
      taskId: "task-exp-2",
      runId: "m-memory:exp:2",
      targetAgentId: "evok-experiment-investigate@m-memory:exp:2",
      role: "researcher" as const,
      evidenceRefs: ["runs/m-memory:baseline:1/result.json"],
    };
    const slice = (await createResearchMemoryProvider(dir)(request))!;
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
    await publishResearchMemorySnapshot(dir, snapshot("m-other"));
    await expect(createResearchMemoryProvider(dir)({
      missionId: "m-memory",
      taskId: "task-exp-2",
      runId: "m-memory:exp:2",
      targetAgentId: "agent@m-memory:exp:2",
      role: "researcher",
      evidenceRefs: [],
    })).rejects.toThrow(MemorySliceError);
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
    await publishResearchMemorySnapshot(dir, projectResearchMemorySnapshot({
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
    for (const request of [
      { ...childRequest, runId: "m-memory:exp:2:sub:2" },
      { ...childRequest, targetAgentId: "critic@m-memory:exp:2:sub:2" },
      { ...childRequest, taskId: "task-exp:9" },
    ]) {
      await expect(provider(request)).rejects.toThrow(/bound to child Task/);
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
