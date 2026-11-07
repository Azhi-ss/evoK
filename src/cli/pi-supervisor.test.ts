import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisorRoundHost } from "./pi-supervisor";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "evok-supervisor-"));
  roots.push(directory);
  const entries: any[] = [];
  let now = new Date("2026-11-08T12:00:00Z");
  let budget = { remaining: 100, settledEstimate: 10, heldUnverified: 0, dailySpend: { "2026-11-08": 10 } };
  let budgetAvailable = true;
  let quota: { remaining: number | null } = { remaining: null };
  const write = (name: string, value: unknown) => writeFile(join(directory, name + ".json"), JSON.stringify(value));
  await write("state", { attempts: [], revisions: [] });
  await write("campaign", { revisions: {} });
  await write("status", { limits: { budgetFloorCNY: 40 } });
  function restart() {
    const hooks = new Map<string, any>();
    const host = createSupervisorRoundHost({
      on: (name: string, fn: any) => hooks.set(name, fn),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    } as never, {
      report: async () => null,
      acknowledge: async () => { throw Error("supervisors must not acknowledge a campaign job"); },
      openDirector: async () => { throw Error("polling must not call a model"); },
    }, { directory, status: async () => { if (!budgetAvailable) throw Error("budget unavailable"); return { budget, quota }; }, now: () => now });
    hooks.get("session_start")({}, { sessionManager: { getSessionId: () => "pi-1", getBranch: () => entries } });
    return host;
  }
  const delivered = (report: { id: string } | null) => {
    expect(report).not.toBeNull();
    entries.push({ type: "custom_message", customType: "evok-round", details: { id: report!.id } });
  };
  return { directory, write, restart, delivered, entries, time: (value: string) => { now = new Date(value); },
    budgetAvailable: (value: boolean) => { budgetAvailable = value; },
    quota: (remaining: number | null) => { quota = { remaining }; },
    budget: (value: Partial<typeof budget>) => { budget = { ...budget, ...value }; } };
}

test("ordinary campaign rounds still pass through the wrapper unchanged and keep their own acknowledgement", async () => {
  const w = await workspace();
  const round = { id: "round-1", jobId: "job-1", sessionId: "pi-1", summary: "proposal-003",
    state: "awaiting-decision", costCNY: 0.4, evidenceRefs: ["job.json"], budget: { remaining: 100 } };
  const acknowledged: string[] = [];
  let stops = 0;
  const hooks = new Map<string, any>();
  const host = createSupervisorRoundHost({
    on: (name: string, fn: any) => hooks.set(name, fn),
    appendEntry: () => {},
  } as never, {
    subscribe: () => () => { stops++; },
    report: async () => round,
    acknowledge: async report => { acknowledged.push(report.id); },
    openDirector: async () => ({ provider: "p", model: "m", close: async () => {} }),
  }, { directory: w.directory, status: async () => ({}) });
  hooks.get("session_start")({}, { sessionManager: { getSessionId: () => "pi-1", getBranch: () => [] } });
  const stop = host.subscribe!(() => {});
  expect(await host.report("pi-1")).toEqual(round);
  await host.acknowledge(round);
  expect(acknowledged).toEqual(["round-1"]);
  stop();
  expect(stops).toBe(1);
});

test("result wakes once per attempt score, preserving zero and deduping after restart", async () => {
  const w = await workspace();
  let host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  await w.write("campaign", { revisions: { abc: { id: "rev-1", phases: { screening: 0.75 } } } });
  const state = { revisions: [], attempts: [{ id: "attempt-1", revisionId: "rev-1", official: { score: 0, cost: 2.5 } }] };
  await w.write("state", state);
  const report = await host.report("pi-1");
  expect(report?.supervisor).toMatchObject({ watcher: "result", evidence: {
    attemptId: "attempt-1", score: 0, cost: 2.5, screeningMean: 0.75, deviation: -0.75,
  } });
  w.delivered(report);
  await host.acknowledge(report!);
  expect(await host.report("pi-1")).toBeNull();
  host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  state.attempts[0].official.score = 0.5;
  await w.write("state", state);
  const changed = await host.report("pi-1");
  expect(changed?.supervisor?.evidence.deviation).toBe(-0.25);
  w.delivered(changed);
  expect(await host.report("pi-1")).toBeNull();
});

test("result supervision stays independent when the shared budget view is unavailable", async () => {
  const w = await workspace();
  w.budgetAvailable(false);
  await w.write("state", { attempts: [{ id: "attempt-a", revisionId: "r", official: { score: 1, cost: 0 } }] });
  const report = await w.restart().report("pi-1");
  expect(report?.supervisor).toMatchObject({ watcher: "result", evidence: { score: 1, cost: 0, deviation: null } });
});

test("deadline proposes the strongest validated revision once per +08 day, including after restart", async () => {
  const w = await workspace();
  const revision = (id: string, score: number) => ({ id, evidence:
    ["screening", "withheld-validation", "noisy-repeat"].map(kind => ({ kind, score, cost: 1 })) });
  await w.write("state", { attempts: [], revisions: [revision("weak", 0.2), revision("best", 0.8),
    { id: "unvalidated", evidence: [{ kind: "screening", score: 1 }] }] });
  await w.write("campaign", { best: "old", revisions: { old: { id: "weak" }, abc: { id: "best" } } });
  let host = w.restart();
  w.time("2026-11-08T12:59:59Z");
  expect(await host.report("pi-1")).toBeNull();
  w.time("2026-11-08T13:00:00Z");
  const report = await host.report("pi-1");
  expect(report?.supervisor).toMatchObject({ watcher: "deadline", submitDue: true, evidence: {
    localDate: "2026-11-08", localTime: "21:00:00+08:00", remaining: 1,
    strongest: { revisionId: "best", candidateDigest: "abc" },
  } });
  w.delivered(report);
  expect(await host.report("pi-1")).toBeNull();
  host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  w.time("2026-11-09T13:00:00Z");
  const tomorrow = await host.report("pi-1");
  expect(tomorrow?.id).not.toBe(report?.id);
  w.delivered(tomorrow);
  expect(await host.report("pi-1")).toBeNull();
});

test("deadline honors a consumed local or account slot while an internal stop still alerts without submitDue", async () => {
  const w = await workspace();
  w.time("2026-11-08T13:00:00Z");
  w.quota(0);
  const host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  w.quota(null);
  await w.write("state", { revisions: [], attempts: [{ real: true, state: "accepted", history: [
    { state: "submitting", at: "2026-11-07T16:30:00Z" },
    { state: "accepted", at: "2026-11-07T16:31:00Z" },
  ] }] });
  expect(await host.report("pi-1")).toBeNull();
  // A retried attempt submits twice; only the latest "submitting" date is today's slot.
  await w.write("state", { revisions: [], attempts: [{ real: true, state: "scored", history: [
    { state: "submitting", at: "2026-11-06T16:30:00Z" },
    { state: "not-received", at: "2026-11-06T18:00:00Z" },
    { state: "submitting", at: "2026-11-08T05:00:00Z" },
    { state: "scored", at: "2026-11-08T08:00:00Z" },
  ] }] });
  expect(await host.report("pi-1")).toBeNull();
  await w.write("limits", { deadline: "2026-11-08T20:00:00+08:00" });
  const expired = await host.report("pi-1");
  expect(expired?.supervisor).toMatchObject({ rule: "internal-deadline", submitDue: false,
    evidence: { remaining: 0, strongest: null } });
  w.delivered(expired);
  expect(await w.restart().report("pi-1")).toBeNull();
});

test("budget alerts persist floor crossings and held growth without waking on polling or wake spend", async () => {
  const w = await workspace();
  let host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  w.budget({ remaining: 39 });
  const low = await host.report("pi-1");
  expect(low?.supervisor).toMatchObject({ watcher: "budget", rule: "budget-floor", evidence: {
    remaining: 39, settled: 10, held: 0, floor: 40, dailySpend: { "2026-11-08": 10 },
  } });
  w.delivered(low);
  expect(await host.report("pi-1")).toBeNull();
  host = w.restart();
  w.budget({ remaining: 38, settledEstimate: 11 });
  expect(await host.report("pi-1")).toBeNull();
  w.budget({ heldUnverified: 5, settledEstimate: 12 });
  const growing = await host.report("pi-1");
  expect(growing?.supervisor).toMatchObject({ rule: "held-growing-faster", evidence: {
    settled: 12, held: 5, settledDelta: 1, heldDelta: 5,
  } });
  // Persist the undelivered edge too: the budget no longer changes after restart.
  host = w.restart();
  expect((await host.report("pi-1"))?.id).toBe(growing?.id);
  w.delivered(growing);
  host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  w.budget({ remaining: 60 });
  expect(await host.report("pi-1")).toBeNull();
  w.budget({ remaining: 30 });
  const again = await host.report("pi-1");
  expect(again?.supervisor?.rule).toBe("budget-floor");
  expect(again?.id).not.toBe(low?.id);
});

test("stall wakes once per stuck measurement or zero-scoring digest across restart", async () => {
  const w = await workspace();
  await w.write("status", { event: "evaluating", at: "2026-11-08T11:00:00Z",
    phase: "screening", task: "task-1", sourceDigest: "abc" });
  let host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  w.time("2026-11-08T12:31:00Z");
  const stuck = await host.report("pi-1");
  expect(stuck?.supervisor).toMatchObject({ watcher: "stall", rule: "evaluating-timeout", evidence: {
    task: "task-1", minutes: 91, candidateDigest: "abc",
  } });
  w.delivered(stuck);
  w.time("2026-11-08T12:32:00Z");
  expect(await host.report("pi-1")).toBeNull();
  host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  await w.write("status", { event: "measured" });
  const row = { id: "rev-1", screening: [{ score: 0 }] };
  await w.write("campaign", { revisions: { abc: row } });
  expect(await host.report("pi-1")).toBeNull();
  row.screening.push({ score: 0 });
  await w.write("campaign", { revisions: { abc: row } });
  const zeros = await host.report("pi-1");
  expect(zeros?.supervisor).toMatchObject({ watcher: "stall", rule: "consecutive-zero-scores",
    evidence: { candidateDigest: "abc", consecutiveZeros: 2 } });
  w.delivered(zeros);
  host = w.restart();
  expect(await host.report("pi-1")).toBeNull();
  await w.write("campaign", { revisions: { abc: row, def: row } });
  const changed = await host.report("pi-1");
  expect(changed?.supervisor?.evidence.candidateDigest).toBe("def");
  w.delivered(changed);
  expect(await host.report("pi-1")).toBeNull();
});
