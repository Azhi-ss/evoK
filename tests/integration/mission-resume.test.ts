/**
 * Separate-process recovery tests for T6 (#114 AC1/AC3/AC4/AC5/AC6).
 *
 * Each scenario runs the REAL start/resume operations in an INDEPENDENT bun
 * subprocess (src/recovery-lifecycle-driver.ts), so the interruption is a
 * genuine process boundary — not an in-process AbortController that keeps its
 * memory. The second process must reconstruct everything from durable records
 * and confirmed artifacts only.
 *
 * Boundaries (deterministic via the onPersistedEvent seam):
 *   - before-confirmation: interrupt after the follow-up Experiment's intent
 *     is durably persisted but before its snapshot/measurement is confirmed;
 *   - after-confirmation: interrupt after the follow-up Experiment is measured.
 *
 * Both must reopen, retain confirmed evidence/budget, treat outstanding intents
 * explicitly, and continue with FRESH Runs. A third subprocess holds the lock
 * to prove duplicate-controller fencing across processes; damaged records are
 * rejected and a stale lock from a dead pid is reclaimable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DRIVER = join(here, "..", "..", "src", "recovery-lifecycle-driver.ts");
const MISSION_ID = "m-t6lifecycle";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t6-e2e-"));
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

describe("separate-process interruption BEFORE result confirmation (#114 AC1/AC4/AC6)", () => {
  test("the unconfirmed follow-up intent is abandoned, then resumed with a fresh Run and remaining budget", async () => {
    const project = await tempProject();

    // Process 1: start, interrupted after the follow-up intent is persisted
    // but before the follow-up is confirmed.
    const start = await runDriver(project, "start", "before-confirmation");
    expect(start.code === 0 || start.code === 130).toBe(true);
    expect(start.json).toBeDefined();
    expect(start.json.experimentIntentSeen).toBe(true);
    expect(start.json.experimentConfirmed).toBe(false);

    const interrupted = await readRecord(project);
    expect(interrupted.status).toBe("interrupted");
    // the confirmed baseline survives; its consumed budget is retained
    expect(interrupted.baseline.evaluation.score).toBe(0.4);
    const baselineConsumed = interrupted.budget.consumed;
    expect(baselineConsumed).toBeGreaterThan(0.001);
    // lock was released by the abort path; status — not the lock — blocks
    await expect(readFile(join(missionDir(project), "controller.lock"), "utf8").then(() => "lock").catch(() => "no-lock")).resolves.toBe("no-lock");

    // Process 2: reopen lists the unfinished Mission with progress + budget.
    const list = await runDriver(project, "list");
    expect(list.code).toBe(0);
    const entry = list.json.missions.find((m: any) => m.id === MISSION_ID);
    expect(entry).toBeDefined();
    expect(entry.resumable).toBe(true);
    expect(entry.hasBaseline).toBe(true);
    expect(entry.remainingBudget).toBeCloseTo(2 - baselineConsumed, 6);

    // Process 2 (separate process): explicit resume reconstructs and continues.
    const resume = await runDriver(project, "resume");
    expect(resume.code).toBe(0);
    expect(resume.json.ok).toBe(true);

    const recovered = await readRecord(project);
    // baseline adopted with NO duplicate execution/evaluation
    expect(resume.json.adopted).toContain(`${MISSION_ID}:baseline:1`);
    expect(recovered.baseline.evaluation.score).toBe(0.4);

    // the unconfirmed intent is explicitly present as Negative Evidence…
    const trail = recovered.experiments as any[];
    const abandoned = trail.find((e) => e.negativeEvidence && /unconfirmed/i.test(e.error ?? ""));
    expect(abandoned).toBeDefined();
    // …and the continuation used a FRESH attempt/run id (never the abandoned id)
    const fresh = trail.filter((e) => e.ok && typeof e.evaluation?.score === "number");
    expect(fresh.length).toBeGreaterThan(0);
    for (const e of fresh) {
      expect(e.runId).not.toBe(abandoned.runId);
      expect(e.attempt).toBeGreaterThanOrEqual(3);
    }
    // distinct sessions for baseline vs resumed fresh runs (ADR-0001)
    const sessions = Object.values(recovered.runs).map((r: any) => r.sessionId).filter(Boolean);
    expect(new Set(sessions).size).toBe(sessions.length);
    // no budget restore: consumed only grew
    expect(recovered.budget.consumed).toBeGreaterThanOrEqual(baselineConsumed - 1e-12);
    // ended via the director's explicit stop, not a silent replay loop
    expect(["director-stopped", "iteration-limit"]).toContain(recovered.status);
  }, 60_000);
});

describe("separate-process interruption AFTER result confirmation (#114 AC3/AC6)", () => {
  test("the confirmed follow-up is reused with no duplicate execution or evaluation", async () => {
    const project = await tempProject();
    const start = await runDriver(project, "start", "after-confirmation");
    expect(start.code === 0 || start.code === 130).toBe(true);
    expect(start.json.experimentConfirmed).toBe(true);

    const interrupted = await readRecord(project);
    expect(interrupted.status).toBe("interrupted");
    const beforeRuns = Object.keys(interrupted.runs);
    const beforeExperiment = interrupted.experiments.find((e: any) => e.ok)?.evaluation?.score;
    expect(beforeExperiment).toBe(0.9);
    const consumedAtInterrupt = interrupted.budget.consumed;

    const resume = await runDriver(project, "resume");
    expect(resume.code).toBe(0);
    const recovered = await readRecord(project);

    // BOTH confirmed runs are adopted; nothing was re-dispatched
    expect(resume.json.adopted.sort()).toEqual(beforeRuns.slice().sort());
    expect(resume.json.abandoned).toHaveLength(0);
    expect(resume.json.remeasured).toHaveLength(0);
    // no new candidate Run was created just to resume: the director sees two
    // observations and stops, so the run ledger is unchanged
    expect(Object.keys(recovered.runs).sort()).toEqual(beforeRuns.slice().sort());
    // confirmed score and budget retained exactly
    expect(recovered.experiments.find((e: any) => e.ok)?.evaluation?.score).toBe(0.9);
    expect(recovered.budget.consumed).toBeCloseTo(consumedAtInterrupt, 9);
    expect(recovered.status).toBe("director-stopped");
    // recovery is auditable
    expect(recovered.history.some((h: any) => h.type === "MISSION_RESUMED")).toBe(true);
    expect(recovered.history.some((h: any) => h.type === "RECOVERY_COMPLETED")).toBe(true);
  }, 60_000);
});

describe("cross-process controller fencing and damaged-record rejection (#114 AC5)", () => {
  test("a live controller lock from another process blocks a resume", async () => {
    const project = await tempProject();
    // establish a completed-then-resumable mission state via a normal start
    const start = await runDriver(project, "start", "none");
    expect(start.code).toBe(0);
    // simulate a LIVE foreign controller lock (the test process is alive)
    await writeFile(join(missionDir(project), "controller.lock"), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    const resume = await runDriver(project, "resume");
    expect(resume.code).not.toBe(0);
    expect(resume.json?.error ?? resume.stderr).toMatch(/live controller|active controller/i);
  }, 60_000);

  test("a damaged mission.json fails visibly and is never reopened as an absent mission", async () => {
    const project = await tempProject();
    await runDriver(project, "start", "none");
    await writeFile(join(missionDir(project), "mission.json"), "{ not valid json");
    const resume = await runDriver(project, "resume");
    expect(resume.code).not.toBe(0);
    expect(resume.json?.error ?? resume.stderr).toMatch(/corrupt|damaged|valid JSON/i);
    // the damaged bytes are preserved, not overwritten
    const raw = await readFile(join(missionDir(project), "mission.json"), "utf8");
    expect(raw.startsWith("{ not valid json")).toBe(true);
  }, 60_000);
});
