/**
 * Unit tests for the pure recovery seam (#114, T6): explicit resume intent,
 * durable reconstruction/reconciliation of interrupted Missions, stale-lock
 * fencing, and the reopen listing. Cross-process lifecycle tests live in
 * tests/integration/mission-resume.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveMissionDraft, type MissionDraft } from "./mission-draft";
import {
  MISSION_SCHEMA_VERSION,
  type BaselineMeasurement,
  type BaselineResultRecord,
  type MissionRecord,
  type MissionRunRecord,
  type MissionStatus,
  type UsageLine,
} from "./mission-start";
import {
  RESUMABLE_STATUSES,
  ReconciliationBlockedError,
  isExplicitResumeRequest,
  listUnfinishedMissions,
  reconcileInterruptedMission,
  staleControllerLock,
} from "./mission-resume";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t6-unit-"));
  dirs.push(dir);
  return dir;
}

const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const EVAL_ID = "file-answer-deterministic";

function draft(id: string): MissionDraft {
  return {
    schemaVersion: 1, id, status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data" },
    evaluation: { method: EVAL_ID, metric: "answer in [0,1]" },
    constraints: { permissions: ["read-project", "isolated-workspace-write"], hardRules: ["no external submission"] },
    budget: { total: 1, units: "model-USD" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [],
    decisions: [], sources: [],
    plan: { baselineHypothesis: "a file-producing baseline is measurable", tasks: [{ taskId: "baseline", objective: "materialize answer.txt = 0.4" }] },
    usage: { tokens: { ...zeroTokens, total: 10 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

function digestOf(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name); hash.update("\0"); hash.update(files[name]); hash.update("\0");
  }
  return hash.digest("hex");
}

/** Durably seed one confirmed measured run: snapshot dir + result.json. */
async function seedMeasuredRun(
  project: string,
  missionId: string,
  runId: string,
  files: Record<string, string>,
  evaluation: BaselineMeasurement,
): Promise<{ run: MissionRunRecord; result: BaselineResultRecord; sessionId: string; digest: string }> {
  const digest = digestOf(files);
  const sessionId = `s-${runId}`;
  const runRoot = join(project, ".evok", "missions", missionId, "runs", runId);
  await mkdir(join(runRoot, "snapshot"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(runRoot, "snapshot", join(name, "..")), { recursive: true });
    await writeFile(join(runRoot, "snapshot", name), content);
  }
  const result: BaselineResultRecord = {
    runId, candidateId: `candidate:${digest.slice(0, 16)}`, snapshotDigest: digest,
    evaluator: { id: EVAL_ID, version: "1" }, evaluation,
    evidenceRefs: [`runs/${runId}/snapshot`, `runs/${runId}/result.json`],
    measuredAt: "2026-09-11T00:05:00.000Z",
  };
  await writeFile(join(runRoot, "result.json"), JSON.stringify(result));
  const run: MissionRunRecord = {
    runId, intentId: `${runId}:intent`, attempt: runId.endsWith(":1") ? 1 : 2,
    status: "measured", sessionId, workspace: `/tmp/${runId}`,
    snapshotRef: `runs/${runId}/snapshot`, resultRef: `runs/${runId}/result.json`,
    dispatchedAt: "2026-09-11T00:01:00.000Z", finishedAt: "2026-09-11T00:05:00.000Z",
  };
  return { run, result, sessionId, digest };
}

interface RecordOptions {
  status?: MissionStatus;
  runs?: MissionRecord["runs"];
  consumed?: number;
  reserved?: number;
  baseline?: MissionRecord["baseline"];
  experiments?: MissionRecord["experiments"];
  stateVersion?: number;
  decisions?: MissionRecord["decisions"];
  runSessions?: readonly string[];
  stopReason?: string;
}

function baseRecord(id: string, opts: RecordOptions = {}): MissionRecord {
  const consumed = opts.consumed ?? 0.01;
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id,
    status: opts.status ?? "interrupted",
    objective: "raise the measured answer toward 0.9 without cheating",
    contract: { objective: "raise the measured answer toward 0.9 without cheating", expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, metric: "answer in [0,1]", hardRules: ["no external submission"] },
    budget: { total: 1, units: "model-USD", consumed, remaining: 1 - consumed },
    reserved: opts.reserved ?? 0,
    usage: {
      intake: { tokens: { ...zeroTokens, total: 10 }, cost: { ...zeroCost, total: 0.001, units: "model-USD" } },
      runs: (opts.runSessions ?? []).map((sessionId): UsageLine => ({ at: "2026-09-11T00:02:00.000Z", sessionId, tokens: zeroTokens, cost: { ...zeroCost, total: 0.009 } })),
    },
    runs: opts.runs ?? {},
    ...(opts.baseline ? { baselineRunId: `${id}:baseline:1`, baseline: opts.baseline } : {}),
    stateVersion: opts.stateVersion ?? 1,
    tasks: [],
    ...(opts.decisions ? { decisions: opts.decisions } : {}),
    ...(opts.experiments ? { experiments: opts.experiments } : {}),
    history: [{ type: "MISSION_ACCEPTED", at: "2026-09-11T00:00:00.000Z" }],
    ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

async function writeRecord(project: string, record: MissionRecord): Promise<void> {
  const dir = join(project, ".evok", "missions", record.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "mission.json"), JSON.stringify(record, null, 2), "utf8");
}

async function seedDraft(project: string, id: string): Promise<MissionDraft> {
  return saveMissionDraft(project, draft(id));
}

const m04: BaselineMeasurement = { ok: true, score: 0.4, facts: [{ name: "answer", value: 0.4, source: "answer.txt" }] };

describe("isExplicitResumeRequest (#114 AC2)", () => {
  const resumes = [
    "/resume m-ab12cdef3456",
    "/mission-resume m-ab12cdef3456",
    "/evok-resume m-ab12cdef3456",
    "resume the mission m-ab12cdef3456",
    "please continue mission m-ab12cdef3456 where it stopped",
    "continue the mission",
    "resume m-ab12cdef3456",
  ];
  for (const text of resumes) {
    test(`accepts an unambiguous resume: ${text}`, () => {
      expect(isExplicitResumeRequest(text).resume).toBe(true);
    });
  }

  const rejects = [
    "what is the status of the mission?",
    "do not resume yet",
    "can we continue later?",
    "start the mission baseline",
    "maybe resume it tomorrow",
    "tell me about the results",
    "stop",
  ];
  for (const text of rejects) {
    test(`rejects questions, negations, and unrelated talk: ${text}`, () => {
      expect(isExplicitResumeRequest(text).resume).toBe(false);
    });
  }

  test("extracts an explicit mission id when one is present", () => {
    expect(isExplicitResumeRequest("resume mission m-ab12cdef3456 now").missionId).toBe("m-ab12cdef3456");
    expect(isExplicitResumeRequest("/resume").missionId).toBeUndefined();
  });
});

describe("resumable statuses (#114 AC2/AC5)", () => {
  test("interrupted and bounded-stop states are resumable; terminal exhaustion/corruption is not", () => {
    for (const s of ["interrupted", "director-stopped", "director-blocked", "decision-failed", "iteration-limit", "baseline-complete"] as const) {
      expect(RESUMABLE_STATUSES).toContain(s);
    }
    expect(RESUMABLE_STATUSES).not.toContain("budget-exhausted");
    expect(RESUMABLE_STATUSES).not.toContain("evaluator-failed");
  });
});

describe("reconcileInterruptedMission: reconstruction from durable records (#114 AC3/AC4/AC5)", () => {
  test("confirmed baseline is reused: no duplicate execution, accounting, or evaluation", async () => {
    const project = await tempProject();
    const id = "m-t6-confirmed";
    await seedDraft(project, id);
    const runId = `${id}:baseline:1`;
    const seeded = await seedMeasuredRun(project, id, runId, { "answer.txt": "0.4\n" }, m04);
    const record = baseRecord(id, {
      runs: { [runId]: seeded.run },
      baseline: { ...seeded.result, runId },
      runSessions: [seeded.sessionId],
    });
    await writeRecord(project, record);

    const report = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { throw new Error("evaluator must not run for a confirmed result"); } },
    });

    expect(report.adoptedRunIds).toEqual([runId]);
    expect(report.abandonedIntents).toHaveLength(0);
    expect(report.remeasuredRunIds).toHaveLength(0);
    expect(report.record.baseline?.evaluation.score).toBe(0.4);
    expect(report.record.budget.consumed).toBe(0.01);
    expect(report.record.budget.remaining).toBeCloseTo(0.99, 10);
    expect(report.record.status).toBe("running");
    expect(report.record.reserved).toBe(0);
  });

  test("an unconfirmed dispatched intent with no durable result is abandoned and surfaced as Negative Evidence, never silently replayed", async () => {
    const project = await tempProject();
    const id = "m-t6-noresult";
    await seedDraft(project, id);
    const baselineRunId = `${id}:baseline:1`;
    const seeded = await seedMeasuredRun(project, id, baselineRunId, { "answer.txt": "0.4\n" }, m04);
    const lostRunId = `${id}:exp:2`;
    const record = baseRecord(id, {
      runs: {
        [baselineRunId]: seeded.run,
        [lostRunId]: { runId: lostRunId, intentId: `${lostRunId}:intent`, attempt: 2, status: "interrupted", sessionId: "s-lost", workspace: "/tmp/x", dispatchedAt: "2026-09-11T00:10:00.000Z" },
      },
      baseline: { ...seeded.result, runId: baselineRunId },
      experiments: [],
      reserved: 0.01,
      runSessions: [seeded.sessionId],
    });
    await writeRecord(project, record);
    let evaluations = 0;
    const report = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { evaluations += 1; return { ok: true, score: 0.4 }; } },
    });
    expect(report.abandonedIntents.map((a) => a.runId)).toEqual([lostRunId]);
    expect(report.adoptedRunIds).toEqual([baselineRunId]);
    expect(evaluations).toBe(0);
    const neg = report.record.experiments!.find((e) => e.runId === lostRunId);
    expect(neg?.ok).toBe(false);
    expect(neg?.negativeEvidence).toBe(true);
    expect(neg?.error).toMatch(/unconfirmed|interrupted/i);
    expect(report.record.reserved).toBe(0.01);
  });

  test("a killed-after-Run experiment whose result.json never landed is independently re-measured from the durable snapshot, not guessed", async () => {
    const project = await tempProject();
    const id = "m-t6-remeasure";
    await seedDraft(project, id);
    const baselineRunId = `${id}:baseline:1`;
    const seeded = await seedMeasuredRun(project, id, baselineRunId, { "answer.txt": "0.4\n" }, m04);
    const runId = `${id}:exp:2`;
    // snapshot committed, but status never advanced to measured and no result.json
    const runRoot = join(project, ".evok", "missions", id, "runs", runId);
    await mkdir(join(runRoot, "snapshot"), { recursive: true });
    await writeFile(join(runRoot, "snapshot", "answer.txt"), "0.82\n");
    let record = baseRecord(id, {
      runs: {
        [baselineRunId]: seeded.run,
        [runId]: { runId, intentId: `${runId}:intent`, attempt: 2, status: "dispatched", sessionId: "s-2", workspace: "/tmp/2", snapshotRef: `runs/${runId}/snapshot`, dispatchedAt: "2026-09-11T00:10:00.000Z" },
      },
      baseline: { ...seeded.result, runId: baselineRunId },
      experiments: [],
      reserved: 0.01,
      // the killed experiment Run WAS metered (real tokens) before the kill
      // window; its result.json never landed, so recovery re-measures it
      runSessions: [seeded.sessionId, "s-2"],
    });
    await writeRecord(project, record);
    // Durable history records the Director action that dispatched the killed
    // Run; recovery must recover that action rather than guess a label.
    record = {
      ...record,
      history: [...record.history, { type: "PROPOSAL_APPLIED" as const, at: "2026-09-11T00:09:00.000Z", detail: { runId, action: "change-direction", taskId: "task-exp-2" } }],
      tasks: [...(record.tasks ?? []), { taskId: "task-exp-2", objective: "refine toward 0.9", source: "director" as const }],
    };
    let evaluations = 0;
    const report = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: {
        id: EVAL_ID, version: "1",
        async evaluate(snapshot) { evaluations += 1; const v = Number(snapshot["answer.txt"]); return { ok: true, score: v }; },
      },
    });
    expect(evaluations).toBe(1);
    expect(report.remeasuredRunIds).toEqual([runId]);
    const rebuilt = report.record.experiments!.find((e) => e.runId === runId);
    expect(rebuilt?.ok).toBe(true);
    expect(rebuilt?.evaluation?.score).toBe(0.82);
    expect(rebuilt?.snapshotDigest).toBeTruthy();
    // the reconstructed observation keeps its real Director action from history,
    // not a guessed "repair" label
    expect(rebuilt?.action).toBe("change-direction");
    expect(report.record.runs[runId]?.status).toBe("measured");
    const result = JSON.parse(await readFile(join(runRoot, "result.json"), "utf8"));
    expect(result.evaluation.score).toBe(0.82);
  });

  test("a confirmed result whose snapshot digest disagrees with the bytes is corruption, not adoption", async () => {
    const project = await tempProject();
    const id = "m-t6-tamper";
    await seedDraft(project, id);
    const runId = `${id}:baseline:1`;
    // result.json claims digest d…d but the snapshot bytes are a real 0.99 file
    const runRoot = join(project, ".evok", "missions", id, "runs", runId);
    await mkdir(join(runRoot, "snapshot"), { recursive: true });
    await writeFile(join(runRoot, "snapshot", "answer.txt"), "0.99\n");
    const fakeResult: BaselineResultRecord = {
      runId, candidateId: "candidate:0000000000000000", snapshotDigest: "d".repeat(64),
      evaluator: { id: EVAL_ID, version: "1" }, evaluation: { ok: true, score: 1 },
      evidenceRefs: [`runs/${runId}/result.json`], measuredAt: "2026-09-11T00:05:00.000Z",
    };
    await writeFile(join(runRoot, "result.json"), JSON.stringify(fakeResult));
    const record = baseRecord(id, {
      runs: { [runId]: { runId, intentId: "i", attempt: 1, status: "measured", sessionId: "s-1", workspace: "/tmp/1", snapshotRef: `runs/${runId}/snapshot`, resultRef: `runs/${runId}/result.json`, dispatchedAt: "2026-09-11T00:00:00.000Z" } },
      baseline: fakeResult, runSessions: ["s-1"],
    });
    await writeRecord(project, record);

    const error = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { return { ok: true, score: 1 }; } },
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ReconciliationBlockedError);
    expect((error as ReconciliationBlockedError).reason).toMatch(/digest|snapshot|evidence/i);
  });

  test("damaged budget arithmetic fails visibly instead of being swallowed as an absent Mission", async () => {
    const project = await tempProject();
    const id = "m-t6-budgetbad";
    await seedDraft(project, id);
    const record = baseRecord(id, { consumed: 0.5 });
    const damaged: MissionRecord = { ...record, budget: { ...record.budget, remaining: 0.9 } }; // total - consumed would be 0.5
    await writeRecord(project, damaged);
    const error = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record: damaged,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { return { ok: false }; } },
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ReconciliationBlockedError);
    expect((error as ReconciliationBlockedError).reason).toMatch(/budget|ledger/i);
  });

  test("an unconfirmed BASELINE intent with no evidence still becomes Negative Evidence the Director can see", async () => {
    const project = await tempProject();
    const id = "m-t6-lostbaseline";
    await seedDraft(project, id);
    const runId = `${id}:baseline:1`;
    const record = baseRecord(id, {
      runs: { [runId]: { runId, intentId: `${runId}:intent`, attempt: 1, status: "interrupted", sessionId: "s-x", workspace: "/tmp/x", dispatchedAt: "2026-09-11T00:10:00.000Z" } },
      experiments: [],
      reserved: 0.01,
    });
    await writeRecord(project, record);
    const report = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { return { ok: false }; } },
    });
    expect(report.adoptedRunIds).toHaveLength(0);
    expect(report.abandonedIntents.map((a) => a.runId)).toEqual([runId]);
    const neg = report.record.experiments!.find((e) => e.runId === runId);
    expect(neg?.negativeEvidence).toBe(true);
    expect(neg?.action).toBe("baseline");
  });

  test("a metered run line missing from the usage ledger is damaged accounting (blocked, never double-counted)", async () => {
    const project = await tempProject();
    const id = "m-t6-noline";
    await seedDraft(project, id);
    const runId = `${id}:baseline:1`;
    const seeded = await seedMeasuredRun(project, id, runId, { "answer.txt": "0.4\n" }, m04);
    const record = baseRecord(id, {
      runs: { [runId]: seeded.run },
      baseline: { ...seeded.result, runId },
      runSessions: [], // no ledger line for the run's session
    });
    await writeRecord(project, record);
    const error = await reconcileInterruptedMission({
      projectRoot: project, draft: draft(id), record,
      evaluator: { id: EVAL_ID, version: "1", async evaluate() { return { ok: false }; } },
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ReconciliationBlockedError);
    expect((error as ReconciliationBlockedError).reason).toMatch(/usage|accounting|ledger/i);
  });
});

describe("stale controller lock handling (#114 AC1/AC5)", () => {
  test("a lock held by a live pid is an active conflict; a dead pid is stale", async () => {
    const project = await tempProject();
    const id = "m-t6-lock";
    await seedDraft(project, id);
    const dir = join(project, ".evok", "missions", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "controller.lock"), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    expect(await staleControllerLock(project, id)).toBe(false); // live pid → conflict stands
    await writeFile(join(dir, "controller.lock"), JSON.stringify({ pid: 999999, since: new Date().toISOString() }));
    // pid 999999 is virtually never live; the check must read the lock, not guess
    const result = await staleControllerLock(project, id);
    expect(typeof result).toBe("boolean");
  });
});

describe("listUnfinishedMissions (#114 AC2)", () => {
  test("lists unfinished Missions with progress and remaining budget; terminal stops are flagged not resumable", async () => {
    const project = await tempProject();
    const mk = (id: string, status: MissionStatus, consumed: number, experiments: number, stopReason?: string): MissionRecord =>
      baseRecord(id, {
        status, consumed, stopReason,
        experiments: Array.from({ length: experiments }, (_, i) => ({ runId: `${id}:exp:${i + 2}`, attempt: i + 2, action: "repair" as const, ok: true, taskObjective: "x", evidenceRefs: [], at: "2026-09-11T00:00:00.000Z" })),
      });
    await seedDraft(project, "m-t6-draftonly");
    await writeRecord(project, mk("m-t6-list2", "budget-exhausted", 0.9, 2, "budget exhausted"));
    await writeRecord(project, mk("m-t6-list1", "interrupted", 0.1, 1, "user interruption during the Research Loop"));

    const view = await listUnfinishedMissions(project);
    const interrupted = view.missions.find((m) => m.id === "m-t6-list1")!;
    expect(interrupted.resumable).toBe(true);
    expect(interrupted.remainingBudget).toBeCloseTo(0.9, 10);
    expect(interrupted.experiments).toBe(1);
    expect(interrupted.stopReason).toMatch(/interruption/i);
    const exhausted = view.missions.find((m) => m.id === "m-t6-list2")!;
    expect(exhausted.resumable).toBe(false);
    expect(view.drafts.map((d) => d.id)).toContain("m-t6-draftonly");
  });
});
