import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectResearchMemorySnapshot } from "../evidence/research-memory";
import { MEMORY_SLICE_RESEARCH_SCHEMA, MemorySliceError, createMemorySlice, validateMemorySlice } from "./memory-slice";
import {
  createResearchMemoryProvider,
  loadResearchMemorySnapshot,
  publishResearchMemorySnapshot,
} from "./research-memory-provider";

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
      { runId: `${missionId}:exp:2`, ok: false, negativeEvidence: true, ruleViolations: ["answer.txt is missing"], evidenceRefs: [] },
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

describe("default research memory provider (#210)", () => {
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
