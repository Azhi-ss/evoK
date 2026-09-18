import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResearchAuthorityRejectedError,
  ResearchContinueRejectedError,
  continueResearch,
  parseResearchCommand,
  readResearchStatus,
  recoverResearchStatus,
  type MissionControlEvent,
} from "./research-entry";

const MISSION_ID = "m-evt138demo01";

function event(
  sequence: number,
  type: MissionControlEvent["type"],
  payload: Record<string, unknown> = {},
  extras: Partial<MissionControlEvent> = {},
): MissionControlEvent {
  return {
    eventId: extras.eventId ?? `evt-${sequence}`,
    sequence,
    type,
    at: extras.at ?? `2026-09-19T00:00:0${sequence}.000Z`,
    missionId: extras.missionId ?? MISSION_ID,
    ...(extras.action ? { action: extras.action } : {}),
    payload,
  };
}

describe("parseResearchCommand — evoK product entry, not Pi slash table", () => {
  test("recognizes /research status and defaults the bare command to status", () => {
    expect(parseResearchCommand("/research")).toEqual({ verb: "status" });
    expect(parseResearchCommand("/research status")).toEqual({ verb: "status" });
    expect(parseResearchCommand("/research status m-evt138demo01")).toEqual({
      verb: "status",
      missionId: "m-evt138demo01",
    });
  });

  test("recognizes one authorized continue path", () => {
    expect(parseResearchCommand("/research continue")).toEqual({ verb: "continue" });
    expect(parseResearchCommand("/research continue m-evt138demo01")).toEqual({
      verb: "continue",
      missionId: "m-evt138demo01",
    });
  });

  test("does not intercept Pi /model /new or Mission /start /resume", () => {
    expect(parseResearchCommand("/model")).toBeUndefined();
    expect(parseResearchCommand("/new")).toBeUndefined();
    expect(parseResearchCommand("/start")).toBeUndefined();
    expect(parseResearchCommand("/resume")).toBeUndefined();
    expect(parseResearchCommand("please continue the chat")).toBeUndefined();
  });
});

describe("Mission control event recovery skeleton", () => {
  test("replays authorize → baseline → one experiment so status is readable", () => {
    const view = recoverResearchStatus([
      event(1, "MISSION_AUTHORIZED", { objective: "measure a baseline then one experiment" }, { action: "authorize" }),
      event(2, "BASELINE_RECORDED", { runId: "m-evt138demo01:baseline:1", ok: true, score: 0.41 }),
      event(3, "EXPERIMENT_ENTERED", { experimentId: "exp-1", objective: "try one bounded change", source: "skeleton" }),
    ]);
    expect(view.missionId).toBe(MISSION_ID);
    expect(view.authorized).toBe(true);
    expect(view.phase).toBe("experimenting");
    expect(view.objective).toBe("measure a baseline then one experiment");
    expect(view.baseline).toEqual({
      runId: "m-evt138demo01:baseline:1",
      ok: true,
      score: 0.41,
      at: "2026-09-19T00:00:02.000Z",
    });
    expect(view.experiments).toEqual([
      {
        experimentId: "exp-1",
        objective: "try one bounded change",
        source: "skeleton",
        at: "2026-09-19T00:00:03.000Z",
      },
    ]);
    expect(view.recoveredFrom).toBe("events");
  });

  test("a chat transcript is not Mission authority and cannot authorize", () => {
    const view = recoverResearchStatus([
      event(1, "CHAT_TRANSCRIPT" as MissionControlEvent["type"], { text: "user said start it" }),
    ]);
    expect(view.authorized).toBe(false);
    expect(view.phase).toBe("unauthorized");
    expect(view.baseline).toBeUndefined();
    expect(view.experiments).toEqual([]);
  });

  test("duplicate event ids are idempotent and unknown types do not corrupt the projection", () => {
    const authorized = event(1, "MISSION_AUTHORIZED", { objective: "keep the projection" }, { action: "authorize" });
    const view = recoverResearchStatus([
      authorized,
      { ...authorized, sequence: 2 },
      event(3, "UNKNOWN_WAKE" as MissionControlEvent["type"], { lease: "stolen" }),
      event(4, "BASELINE_RECORDED", { runId: "run-b", ok: true, score: 0.2 }),
    ]);
    expect(view.authorized).toBe(true);
    expect(view.phase).toBe("baseline");
    expect(view.baseline?.runId).toBe("run-b");
    expect(view.experiments).toEqual([]);
  });

  test("stop is terminal; later continue or experiment entries are ignored", () => {
    const view = recoverResearchStatus([
      event(1, "MISSION_AUTHORIZED", { objective: "stop wins" }, { action: "authorize" }),
      event(2, "BASELINE_RECORDED", { runId: "run-b", ok: true }),
      event(3, "MISSION_STOPPED", { reason: "human stop" }, { action: "stop" }),
      event(4, "MISSION_CONTINUED", {}, { action: "continue" }),
      event(5, "EXPERIMENT_ENTERED", { experimentId: "late", objective: "must not appear", source: "skeleton" }),
    ]);
    expect(view.phase).toBe("stopped");
    expect(view.lastAction).toBe("stop");
    expect(view.stopReason).toBe("human stop");
    expect(view.experiments).toEqual([]);
  });
});

describe("thin /research continue path", () => {
  async function projectDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "evok-research-entry-"));
  }

  test("user-authorized continue after a durable baseline records one visible experiment", async () => {
    const projectRoot = await projectDir();
    try {
      const afterAuth = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: {
          requested: true,
          token: "/research continue",
          missionSelector: MISSION_ID,
          source: "user",
        },
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "demo baseline then one experiment" }, { action: "authorize" }),
          event(2, "BASELINE_RECORDED", { runId: `${MISSION_ID}:baseline:1`, ok: true, score: 0.5 }),
        ],
        clock: () => "2026-09-19T01:00:00.000Z",
        nextId: () => "exp-skeleton-1",
      });
      expect(afterAuth.phase).toBe("experimenting");
      expect(afterAuth.lastAction).toBe("continue");
      expect(afterAuth.experiments).toEqual([
        {
          experimentId: "exp-skeleton-1",
          objective: "demo baseline then one experiment",
          source: "skeleton",
          at: "2026-09-19T01:00:00.000Z",
        },
      ]);

      const recovered = await readResearchStatus(projectRoot, MISSION_ID);
      expect(recovered.phase).toBe("experimenting");
      expect(recovered.baseline?.runId).toBe(`${MISSION_ID}:baseline:1`);
      expect(recovered.experiments).toHaveLength(1);
      expect(recovered.experiments[0]?.experimentId).toBe("exp-skeleton-1");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("model-authored or missing authorization cannot continue", async () => {
    const projectRoot = await projectDir();
    try {
      const seed = [
        event(1, "MISSION_AUTHORIZED", { objective: "guard authority" }, { action: "authorize" }),
        event(2, "BASELINE_RECORDED", { runId: "run-b", ok: true }),
      ];
      await expect(continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: { requested: true, token: "/research continue", missionSelector: MISSION_ID, source: "model" },
        seedEvents: seed,
      })).rejects.toBeInstanceOf(ResearchAuthorityRejectedError);
      await expect(continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: { requested: false, token: "can we continue?", missionSelector: MISSION_ID, source: "user" },
        seedEvents: seed,
      })).rejects.toBeInstanceOf(ResearchAuthorityRejectedError);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("continue without a baseline is refused; status stays readable", async () => {
    const projectRoot = await projectDir();
    try {
      await expect(continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: {
          requested: true,
          token: "/research continue",
          missionSelector: MISSION_ID,
          source: "user",
        },
        seedEvents: [
          event(1, "MISSION_AUTHORIZED", { objective: "no baseline yet" }, { action: "authorize" }),
        ],
      })).rejects.toBeInstanceOf(ResearchContinueRejectedError);
      const view = await readResearchStatus(projectRoot, MISSION_ID);
      expect(view.phase).toBe("authorized");
      expect(view.experiments).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("continue after a MissionRecord baseline persists a visible skeleton experiment", async () => {
    const projectRoot = await projectDir();
    const missionDir = join(projectRoot, ".evok", "missions", MISSION_ID);
    await mkdir(missionDir, { recursive: true });
    await writeFile(join(missionDir, "mission.json"), JSON.stringify({
      schemaVersion: 1,
      id: MISSION_ID,
      status: "baseline-complete",
      objective: "record-only baseline then continue",
      contract: { objective: "record-only baseline then continue", expectedOutputs: [], evaluationMethod: "file", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.1, remaining: 0.9 },
      reserved: 0,
      usage: { intake: { tokens: { total: 0 }, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {},
      baselineRunId: `${MISSION_ID}:baseline:1`,
      baseline: {
        runId: `${MISSION_ID}:baseline:1`,
        evaluation: { ok: true, score: 0.44 },
        evidenceRefs: ["snap:rec"],
        measuredAt: "2026-09-19T05:00:00.000Z",
      },
      experiments: [],
      history: [],
      createdAt: "2026-09-19T05:00:00.000Z",
      updatedAt: "2026-09-19T05:00:00.000Z",
    }));
    try {
      const view = await continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: {
          requested: true,
          token: "/research continue",
          missionSelector: MISSION_ID,
          source: "user",
        },
        clock: () => "2026-09-19T05:10:00.000Z",
        nextId: () => "exp-from-record",
      });
      expect(view.phase).toBe("experimenting");
      expect(view.baseline?.runId).toBe(`${MISSION_ID}:baseline:1`);
      expect(view.experiments).toEqual([
        {
          experimentId: "exp-from-record",
          objective: "record-only baseline then continue",
          source: "skeleton",
          at: "2026-09-19T05:10:00.000Z",
        },
      ]);
      const recovered = await readResearchStatus(projectRoot, MISSION_ID);
      expect(recovered.phase).toBe("experimenting");
      expect(recovered.experiments).toHaveLength(1);
      expect(recovered.experiments[0]?.experimentId).toBe("exp-from-record");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("a non-resumable MissionRecord stop refuses continue", async () => {
    const projectRoot = await projectDir();
    const missionDir = join(projectRoot, ".evok", "missions", MISSION_ID);
    await mkdir(missionDir, { recursive: true });
    await writeFile(join(missionDir, "mission.json"), JSON.stringify({
      schemaVersion: 1,
      id: MISSION_ID,
      status: "budget-exhausted",
      objective: "stop is authority",
      contract: { objective: "stop is authority", expectedOutputs: [], evaluationMethod: "file", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 1, remaining: 0 },
      reserved: 0,
      usage: { intake: { tokens: { total: 0 }, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {},
      baselineRunId: `${MISSION_ID}:baseline:1`,
      baseline: {
        runId: `${MISSION_ID}:baseline:1`,
        evaluation: { ok: true, score: 0.1 },
        evidenceRefs: [],
        measuredAt: "2026-09-19T06:00:00.000Z",
      },
      experiments: [],
      history: [],
      stopReason: "budget exhausted",
      createdAt: "2026-09-19T06:00:00.000Z",
      updatedAt: "2026-09-19T06:00:00.000Z",
    }));
    try {
      await expect(continueResearch({
        projectRoot,
        missionId: MISSION_ID,
        authorization: {
          requested: true,
          token: "/research continue",
          missionSelector: MISSION_ID,
          source: "user",
        },
      })).rejects.toBeInstanceOf(ResearchContinueRejectedError);
      const view = await readResearchStatus(projectRoot, MISSION_ID);
      expect(view.phase).toBe("stopped");
      expect(view.stopReason).toBe("budget exhausted");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("hydrates baseline and one experiment from the durable MissionRecord, not chat files", async () => {
    const projectRoot = await projectDir();
    const missionDir = join(projectRoot, ".evok", "missions", MISSION_ID);
    await mkdir(missionDir, { recursive: true });
    await writeFile(join(missionDir, "mission.json"), JSON.stringify({
      schemaVersion: 1,
      id: MISSION_ID,
      status: "baseline-complete",
      objective: "hydrate from the Mission record",
      contract: { objective: "hydrate from the Mission record", expectedOutputs: [], evaluationMethod: "file", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.1, remaining: 0.9 },
      reserved: 0,
      usage: { intake: { tokens: { total: 0 }, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {},
      baselineRunId: `${MISSION_ID}:baseline:1`,
      baseline: {
        runId: `${MISSION_ID}:baseline:1`,
        evaluation: { ok: true, score: 0.33 },
        evidenceRefs: ["snap:abc"],
        measuredAt: "2026-09-19T02:00:00.000Z",
      },
      experiments: [{
        runId: `${MISSION_ID}:exp:2`,
        attempt: 1,
        action: "run-experiment",
        ok: true,
        taskObjective: "one visible experiment from the record",
        evidenceRefs: [],
        at: "2026-09-19T02:05:00.000Z",
      }],
      history: [],
      createdAt: "2026-09-19T02:00:00.000Z",
      updatedAt: "2026-09-19T02:05:00.000Z",
    }));
    await writeFile(join(missionDir, "transcript.md"), "the chat said we already finished three experiments");
    try {
      const view = await readResearchStatus(projectRoot, MISSION_ID);
      expect(view.authorized).toBe(true);
      expect(view.phase).toBe("experimenting");
      expect(view.objective).toBe("hydrate from the Mission record");
      expect(view.baseline).toEqual({
        runId: `${MISSION_ID}:baseline:1`,
        ok: true,
        score: 0.33,
        at: "2026-09-19T02:00:00.000Z",
      });
      expect(view.experiments).toEqual([
        {
          experimentId: `${MISSION_ID}:exp:2`,
          objective: "one visible experiment from the record",
          source: "mission-record",
          at: "2026-09-19T02:05:00.000Z",
          runId: `${MISSION_ID}:exp:2`,
        },
      ]);
      expect(view.recoveredFrom).toBe("mission-record");
      const transcript = await readFile(join(missionDir, "transcript.md"), "utf8");
      expect(transcript).toContain("three experiments");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
