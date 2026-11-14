/**
 * PRD §6 critical commit points: fault injection, then recovery (#253/#257).
 *
 * Stage 4 decomposed the controller into named stages. This suite is the
 * recovery contract those stages must keep, exercised at the four places a
 * crash can leave the durable state ambiguous:
 *
 * | Boundary | Fault | Durable state the crash leaves |
 * |---|---|---|
 * | after budget reservation | the process dies right after `BUDGET_RESERVED` | reservation held, baseline intent persisted, nothing executed |
 * | after execution start | the runtime crashes after intent dispatch | Run dispatched, outcome unknown, no artifact |
 * | after artifact write | the process dies inside the evaluator | snapshot bytes durable, no result record |
 * | before receipt persistence | the runtime crashes before result confirmation | Run finished, receipt/result never durable |
 *
 * Every scenario runs the REAL start/resume operations in an independent bun
 * subprocess (`tests/integration/recovery-lifecycle-driver.ts`), so recovery reconstructs
 * everything from durable records and confirmed artifacts only. Each resume must
 * then: never adopt what was not confirmed, never restore spent budget, never
 * re-dispatch the same attempt, and continue with a FRESH Run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DRIVER = join(here, "recovery-lifecycle-driver.ts");
const MISSION_ID = "m-t6lifecycle";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t6-fault-"));
  dirs.push(dir);
  return dir;
}

interface DriverResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

async function runDriver(project: string, mode: string, boundary?: string): Promise<DriverResult> {
  const proc = (globalThis as any).Bun.spawn(["bun", DRIVER, project, mode, ...(boundary ? [boundary] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  }) as {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  let json: any;
  try { json = JSON.parse(lastLine); } catch { json = undefined; }
  return { code, stdout, stderr, json };
}

function missionDir(project: string) {
  return join(project, ".evok", "missions", MISSION_ID);
}

async function readRecord(project: string): Promise<any> {
  return JSON.parse(await readFile(join(missionDir(project), "mission.json"), "utf8"));
}

/** The Run's snapshot files, or undefined when no snapshot was adopted. */
async function snapshotAnswer(project: string, runId: string): Promise<string | undefined> {
  return readFile(join(missionDir(project), "runs", runId, "snapshot", "answer.txt"), "utf8").catch(() => undefined);
}

async function resultRecord(project: string, runId: string): Promise<any> {
  return readFile(join(missionDir(project), "runs", runId, "result.json"), "utf8").then(
    (raw) => JSON.parse(raw),
    () => undefined,
  );
}

/** Semantic assertions every recovered Mission owes, whatever the fault was. */
function expectTruthfulRecovery(recovered: any, resumed: any): void {
  // Recovery is auditable and reuses durable facts, never a replay.
  expect(recovered.history.some((h: any) => h.type === "RECOVERY_COMPLETED")).toBe(true);
  expect(recovered.history.some((h: any) => h.type === "MISSION_RESUMED")).toBe(true);
  expect(resumed.ok).toBe(true);
  expect(["director-stopped", "iteration-limit"]).toContain(recovered.status);
  // Every measured Run has a distinct session and a distinct attempt id (ADR-0001).
  const measured = Object.values(recovered.runs as Record<string, any>).filter((run) => run.status === "measured");
  const sessions = measured.map((run) => run.sessionId);
  expect(new Set(sessions).size).toBe(sessions.length);
  const attempts = Object.values(recovered.runs as Record<string, any>).map((run) => run.attempt);
  expect(new Set(attempts).size).toBe(Object.keys(recovered.runs).length);
  // Budget is never restored: remaining + reserved stays inside the envelope and
  // consumed only grew.
  expect(recovered.budget.consumed).toBeGreaterThan(0);
  expect(recovered.budget.remaining).toBeCloseTo(recovered.budget.total - recovered.budget.consumed, 9);
  expect(recovered.reserved).toBeGreaterThanOrEqual(0);
}

describe("PRD §6 critical commit point: after budget reservation", () => {
  test("the reserved, never-executed attempt is abandoned, not adopted, and a fresh Run continues", async () => {
    const project = await tempProject();
    const start = await runDriver(project, "start", "after-budget-reservation");
    // The process died at the boundary: no graceful exit code, no record repair.
    expect(start.code).toBe(137);

    const crashed = await readRecord(project);
    const baselineId = `${MISSION_ID}:baseline:1`;
    // The reservation is durable and nothing executed.
    expect(crashed.history.map((h: any) => h.type)).toContain("BUDGET_RESERVED");
    expect(crashed.reserved).toBeCloseTo(0.0001, 12);
    expect(crashed.runs[baselineId].status).toBe("dispatched");
    expect(crashed.runs[baselineId].snapshotRef).toBeUndefined();
    expect(await snapshotAnswer(project, baselineId)).toBeUndefined();
    expect(await resultRecord(project, baselineId)).toBeUndefined();
    const consumedBefore = crashed.budget.consumed;

    const resumed = await runDriver(project, "resume");
    const recovered = await readRecord(project);
    expectTruthfulRecovery(recovered, resumed.json);

    // The unconfirmed attempt is surfaced as abandoned and never adopted.
    expect(resumed.json.abandoned).toContain(baselineId);
    expect(resumed.json.adopted).not.toContain(baselineId);
    expect(resumed.json.remeasured).not.toContain(baselineId);
    expect(recovered.baseline).toBeUndefined();
    // A FRESH Run continues; the abandoned attempt id is never reused.
    const fresh = (recovered.experiments as any[]).filter((entry) => entry.ok);
    expect(fresh.length).toBeGreaterThan(0);
    for (const entry of fresh) expect(entry.runId).not.toBe(baselineId);
    expect(fresh[0].attempt).toBeGreaterThanOrEqual(2);
    // Spend is never restored and the held reservation is never refunded by
    // recovery (an unknown spend must not be dispatchable twice).
    expect(recovered.budget.consumed).toBeGreaterThanOrEqual(consumedBefore - 1e-12);
    expect(recovered.reserved).toBeGreaterThanOrEqual(0.0001);
  }, 60_000);
});

describe("PRD §6 critical commit point: after execution start", () => {
  test("an unknown in-flight execution never becomes a result and is not replayed", async () => {
    const project = await tempProject();
    const start = await runDriver(project, "start", "after-execution-start");
    // The harness crashed after dispatch: the Run has no confirmed outcome.
    expect(start.json?.experimentConfirmed).toBe(false);

    const crashed = await readRecord(project);
    const baselineId = `${MISSION_ID}:baseline:1`;
    expect(crashed.status).toBe("iteration-limit");
    // Failure is recorded truthfully; it is operational, never a refutation (#213).
    const failed = (crashed.experiments as any[]).find((entry) => entry.runId === baselineId);
    expect(failed.ok).toBe(false);
    expect(failed.negativeEvidence).toBeUndefined();
    expect(failed.error).toMatch(/fault injection: crash after intent sent/);
    expect(crashed.baseline).toBeUndefined();
    expect(await snapshotAnswer(project, baselineId)).toBeUndefined();
    expect(await resultRecord(project, baselineId)).toBeUndefined();
    const consumedBefore = crashed.budget.consumed;

    const resumed = await runDriver(project, "resume");
    const recovered = await readRecord(project);
    expectTruthfulRecovery(recovered, resumed.json);

    // Recovery neither adopted nor re-measured the unconfirmed Run, and did not
    // duplicate its trail entry.
    expect(resumed.json.adopted).not.toContain(baselineId);
    expect(resumed.json.remeasured).not.toContain(baselineId);
    expect((recovered.experiments as any[]).filter((entry) => entry.runId === baselineId)).toHaveLength(1);
    expect(recovered.baseline).toBeUndefined();
    // A fresh Run measured something real; the faulted attempt is untouched.
    const fresh = (recovered.experiments as any[]).filter((entry) => entry.ok);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].attempt).toBeGreaterThanOrEqual(2);
    expect(recovered.budget.consumed).toBeGreaterThanOrEqual(consumedBefore - 1e-12);
  }, 60_000);
});

describe("PRD §6 critical commit point: after artifact write", () => {
  test("recovery re-measures the durable snapshot instead of replaying the model", async () => {
    const project = await tempProject();
    const start = await runDriver(project, "start", "after-artifact-write");
    expect(start.code).toBe(137);

    const crashed = await readRecord(project);
    const baselineId = `${MISSION_ID}:baseline:1`;
    // The artifact is durable and content-addressed, but the record never heard
    // about it and no result exists.
    expect(await snapshotAnswer(project, baselineId)).toBe("0.4\n");
    expect(await resultRecord(project, baselineId)).toBeUndefined();
    expect(crashed.runs[baselineId].status).toBe("dispatched");
    expect(crashed.runs[baselineId].snapshotRef).toBeUndefined();
    expect(crashed.baseline).toBeUndefined();

    const resumed = await runDriver(project, "resume");
    const recovered = await readRecord(project);
    expectTruthfulRecovery(recovered, resumed.json);

    // The durable snapshot is independently re-measured — no model call, no
    // snapshot rewrite — and adopted as the baseline.
    expect(resumed.json.remeasured).toContain(baselineId);
    expect(resumed.json.adopted).toHaveLength(0);
    expect(recovered.baseline.evaluation.score).toBe(0.4);
    expect(recovered.baseline.runId).toBe(baselineId);
    expect(recovered.runs[baselineId].status).toBe("measured");
    expect((await resultRecord(project, baselineId)).evaluation.score).toBe(0.4);
    // The continuation is a FRESH Run, not a replay of the baseline.
    const fresh = (recovered.experiments as any[]).filter((entry) => entry.ok && entry.runId !== baselineId);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].attempt).toBeGreaterThanOrEqual(2);

    // The recovered Run never settled its cost, and the record says so durably:
    // the reservation stays held rather than the spend being booked as free.
    // A SECOND resume must therefore still pass the record's own integrity
    // check — a state recovery produced may not read back as damaged accounting.
    expect(recovered.runs[baselineId].metering).toBe("unsettled");
    expect(recovered.runs[baselineId].sessionId).toBeUndefined();
    expect(recovered.reserved).toBeGreaterThanOrEqual(0.0001);
    const secondResume = await runDriver(project, "resume");
    expect(secondResume.code).toBe(0);
    expect(secondResume.json?.error).toBeUndefined();
    const again = await readRecord(project);
    expect(again.runs[baselineId]).toMatchObject({ status: "measured", metering: "unsettled" });
    expect(again.baseline.evaluation.score).toBe(0.4);
  }, 60_000);
});

describe("PRD §6 critical commit point: before receipt persistence", () => {
  test("a Run whose receipt was never persisted is never adopted and never re-measured", async () => {
    const project = await tempProject();
    const start = await runDriver(project, "start", "before-receipt-persistence");
    expect(start.json?.experimentConfirmed).toBe(false);

    const crashed = await readRecord(project);
    const baselineId = `${MISSION_ID}:baseline:1`;
    // The Run finished its model work but its receipt/result never became
    // durable, so the Mission holds no confirmed outcome.
    expect(crashed.runs[baselineId].status).toBe("failed");
    expect(await snapshotAnswer(project, baselineId)).toBeUndefined();
    expect(await resultRecord(project, baselineId)).toBeUndefined();
    expect(crashed.baseline).toBeUndefined();
    const historyTypes = crashed.history.map((h: any) => h.type);
    expect(historyTypes).toContain("RUN_FAILED");
    expect(historyTypes).not.toContain("EVALUATION_MEASURED");

    const resumed = await runDriver(project, "resume");
    const recovered = await readRecord(project);
    expectTruthfulRecovery(recovered, resumed.json);

    expect(resumed.json.adopted).toHaveLength(0);
    expect(resumed.json.remeasured).toHaveLength(0);
    // Recovery sees an attempt with no durable result or snapshot, so it treats
    // it as an unconfirmed intent. That is a classification of missing evidence,
    // not a claim about the outcome: the recorded RUN_FAILED stays in history,
    // the trail entry is never duplicated, and nothing is adopted.
    expect(resumed.json.abandoned).toContain(baselineId);
    expect(recovered.history.some((h: any) => h.type === "RUN_FAILED")).toBe(true);
    expect((recovered.experiments as any[]).filter((entry) => entry.runId === baselineId)).toHaveLength(1);
    expect(recovered.baseline).toBeUndefined();
    const fresh = (recovered.experiments as any[]).filter((entry) => entry.ok);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0].attempt).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
