/**
 * Stage 1 (#254): one Mission-owned Run preparation produces the immutable
 * `PreparedRun` every later stage depends on. These tests pin what preparation
 * IS — the authorization checks, the lock, the reservation, the frozen plan and
 * the B1 authorization snapshot — not how the controller executes afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveMissionDraft, type MissionDraft } from "./mission-draft";
import type { PiAgentRuntime } from "../pi-agent-runtime";
import {
  BudgetExhaustedError,
  MissionControllerConflictError,
  MissionStartRejectedError,
  loadMissionRecord,
  runMissionController,
  type BaselineEvaluator,
  type StartAuthorization,
  type StartMissionOptions,
} from "./mission-start";
import { prepareAuthorizedStart, prepareResumeRun } from "./run-preparation";
import type { EvokResources } from "../evok-resources";

const evaluator: BaselineEvaluator = {
  id: "deterministic",
  version: "1",
  evaluate: () => ({ ok: true, score: 0 }),
};

const auth: StartAuthorization = { requested: true, token: "/start", missionSelector: "displayed", source: "user" };

function draftFor(id: string, over: Partial<MissionDraft> = {}): MissionDraft {
  return {
    schemaVersion: 1,
    id,
    status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the project" },
    evaluation: { method: "file-answer-deterministic", metric: "answer in [0,1]" },
    constraints: { permissions: ["isolated-workspace-write", "read-project"], hardRules: ["no external submission"] },
    budget: { total: 1, units: "model-USD", note: "bounded loop" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [],
    decisions: [],
    sources: [],
    plan: {
      baselineHypothesis: "a deterministic file-producing baseline is measurable",
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt in the run workspace with value 0.4" }],
    },
    usage: { tokens: { input: 11, output: 7, total: 18 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...over,
  } as MissionDraft;
}

/** The durable shape a resume starts from (fields the snapshot derives from). */
function missionRecordFixture(id: string): Record<string, unknown> {
  const draft = draftFor(id);
  return {
    schemaVersion: 1,
    id,
    status: "interrupted",
    objective: draft.objective,
    contract: { objective: draft.objective, expectedOutputs: draft.outputs, evaluationMethod: draft.evaluation.method, hardRules: [] },
    budget: { total: 1, units: "model-USD", consumed: 0.001, remaining: 0.999 },
    reserved: 0,
    usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
    runs: {},
    history: [],
    tasks: draft.plan.tasks.map((task) => ({ ...task, source: "intake" })),
    permissions: ["isolated-workspace-write", "read-project"],
    stopConditions: draft.stopConditions,
    modelTier: "default",
    researchMemoryMode: "real",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

const projects: string[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWith(draft: MissionDraft): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "evok-prep-"));
  projects.push(project);
  await saveMissionDraft(project, draft);
  return project;
}

function optionsFor(project: string, draft: MissionDraft, over: Partial<StartMissionOptions> = {}): StartMissionOptions {
  return {
    projectRoot: project,
    missionId: draft.id,
    authorization: auth,
    resolver: (() => {
      throw new Error("preparation never resolves a model");
    }) as unknown as StartMissionOptions["resolver"],
    resources: { readRoots: [], skillFiles: [] } as unknown as EvokResources,
    evaluator,
    budgetUnits: "model-USD",
    reserveCost: 0.1,
    ...over,
  };
}

function lockFile(project: string, missionId: string): string {
  return join(project, ".evok", "missions", missionId, "controller.lock");
}

describe("Mission-owned Run preparation (#254 / PRD Stage 1)", () => {
  test("refuses an ambiguous or model-authored authorization before anything durable exists", async () => {
    const draft = draftFor("prep-auth");
    const project = await projectWith(draft);

    await expect(prepareAuthorizedStart(optionsFor(project, draft, {
      authorization: { ...auth, requested: false },
    }))).rejects.toBeInstanceOf(MissionStartRejectedError);

    await expect(prepareAuthorizedStart(optionsFor(project, draft, {
      authorization: { ...auth, source: "model" },
    }))).rejects.toBeInstanceOf(MissionStartRejectedError);
  });

  test("an undeclarable permission fails closed, leaving no record and no lock", async () => {
    const draft = draftFor("prep-perm", {
      constraints: { permissions: ["isolated-workspace-write", "external-submission"], hardRules: [] },
    });
    const project = await projectWith(draft);

    await expect(prepareAuthorizedStart(optionsFor(project, draft))).rejects.toBeInstanceOf(MissionStartRejectedError);
    expect(existsSync(join(project, ".evok", "missions", draft.id, "mission.json"))).toBe(false);
    expect(existsSync(lockFile(project, draft.id))).toBe(false);
  });

  test("freezes the B1 authorization snapshot and refuses mutation of it", async () => {
    const draft = draftFor("prep-snapshot");
    const project = await projectWith(draft);

    const prepared = await prepareAuthorizedStart(optionsFor(project, draft));
    const snapshot = prepared.snapshot;

    // Scope is AUTHORIZATION: which Run is allowed under which frozen
    // conditions. Execution-environment facts belong to the harness (Stage 3).
    expect(Object.keys(snapshot).sort()).toEqual(
      ["authorizationDigest", "budget", "inputDigests", "memory", "planVersion"],
    );
    for (const forbidden of ["runtime", "model", "tools", "sandbox", "filesystem", "workspace", "image"]) {
      expect(snapshot).not.toHaveProperty(forbidden);
    }
    expect(snapshot.planVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.authorizationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.inputDigests.contract).toMatch(/^[0-9a-f]{64}$/);
    // Nothing is published yet, so preparation pins "no snapshot existed" —
    // never a digest it did not see.
    expect(snapshot.memory).toEqual({ mode: "real", published: false });

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.budget)).toBe(true);
    expect(() => {
      (snapshot as { planVersion: string }).planVersion = "tampered";
    }).toThrow();
    expect(() => {
      (snapshot.budget as { requested: number }).requested = 99;
    }).toThrow();
    expect(() => {
      (prepared as { kind: string }).kind = "resume";
    }).toThrow();

    await prepared.releaseLock();
  });

  test("acquires the Mission lock, reserves the budget, and carries the event proving preparation completed", async () => {
    const draft = draftFor("prep-reserve");
    const project = await projectWith(draft);

    const prepared = await prepareAuthorizedStart(optionsFor(project, draft, { reserveCost: 0.25 }));
    const record = await loadMissionRecord(project, draft.id);

    expect(await stat(lockFile(project, draft.id))).toBeDefined();
    // The ledger event is the durable one the unchanged flow already writes.
    expect(prepared.ledgerEvent.type).toBe("BUDGET_RESERVED");
    expect(record.history.at(-1)).toEqual(prepared.ledgerEvent);
    expect(prepared.kind).toBe("start");
    expect(prepared.missionId).toBe(draft.id);

    const reservation = prepared.snapshot.budget;
    expect(reservation).toMatchObject({
      units: "model-USD",
      requested: 0.25,
      reservedBefore: 0,
      reservedAfter: 0.25,
      total: 1,
    });
    expect(record.reserved).toBe(reservation.reservedAfter);
    expect(record.budget.remaining).toBe(reservation.remaining);
    expect(record.budget.consumed).toBe(record.usage.intake.cost.total);
    // The frozen plan is the durable one whose digest the snapshot pins.
    expect(prepared.record.tasks).toEqual(record.tasks);

    await prepared.releaseLock();
    expect(existsSync(lockFile(project, draft.id))).toBe(false);
  });

  test("same authorization input yields the same frozen digests; a changed plan does not", async () => {
    const draft = draftFor("prep-deterministic");
    const first = await prepareAuthorizedStart(optionsFor(await projectWith(draft), draft));
    const second = await prepareAuthorizedStart(optionsFor(await projectWith(draft), draftFor("prep-deterministic")));
    await first.releaseLock();
    await second.releaseLock();

    expect(second.snapshot).toEqual(first.snapshot);

    const changed = draftFor("prep-deterministic", {
      plan: {
        baselineHypothesis: "a deterministic file-producing baseline is measurable",
        tasks: [{ taskId: "baseline", objective: "materialize answer.txt with value 0.6 instead" }],
      },
    });
    const third = await prepareAuthorizedStart(optionsFor(await projectWith(changed), changed));
    await third.releaseLock();
    expect(third.snapshot.planVersion).not.toBe(first.snapshot.planVersion);
    // Consumers of a plan change are visible through the authorization digest
    // too: the same user authorization under another plan is a different Run.
    expect(third.snapshot.authorizationDigest).not.toBe(first.snapshot.authorizationDigest);
  });

  test("a reservation the Mission cannot afford stops before dispatch with a truthful record", async () => {
    const draft = draftFor("prep-broke");
    const project = await projectWith(draft);

    await expect(prepareAuthorizedStart(optionsFor(project, draft, { reserveCost: 5 }))).rejects.toBeInstanceOf(BudgetExhaustedError);

    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("budget-exhausted");
    expect(record.reserved).toBe(0);
    expect(record.history.at(-1)?.type).toBe("BUDGET_EXHAUSTED");
    expect(existsSync(lockFile(project, draft.id))).toBe(false);
    // No execution intent was dispatched by a refused preparation.
    const raw = await readFile(join(project, ".evok", "missions", draft.id, "mission.json"), "utf8");
    expect(raw).not.toContain('"status": "measured"');
  });

  test("the dispatched baseline is the frozen plan, not the re-read draft", async () => {
    const draft = draftFor("prep-frozen");
    const project = await projectWith(draft);
    const prepared = await prepareAuthorizedStart(optionsFor(project, draft));

    // Broaden the plan AFTER authorization: preparation already froze one.
    await saveMissionDraft(project, draftFor("prep-frozen", {
      plan: {
        baselineHypothesis: "a wider baseline",
        tasks: [{ taskId: "baseline", objective: "a widened objective the user never authorized" }],
      },
    }));

    let dispatched: string | undefined;
    const runtime = {
      execute: async (request: { task: { objective: string }; workspace: { path: string } }) => {
        dispatched = request.task.objective;
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(request.workspace.path, { recursive: true });
        await writeFile(join(request.workspace.path, "answer.txt"), "0.1\n");
        return {
          sessionId: "frozen-plan-session",
          workspace: request.workspace.path,
          events: [],
          ledger: [],
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
          stopReason: "stop",
        };
      },
    } as unknown as PiAgentRuntime;

    const outcome = await runMissionController({
      prepared,
      options: optionsFor(project, draft, { runtimeFactory: () => runtime }),
      mode: { kind: "start", baselineTask: prepared.record.tasks![0]!, baselineInstructions: "frozen instructions" },
    });

    expect(dispatched).toBe("materialize answer.txt in the run workspace with value 0.4");
    expect(outcome.status).toBe("baseline-complete");
  });

  test("a resume pins the published Research Memory digest recovery verified", () => {
    const prepared = prepareResumeRun({
      draft: draftFor("prep-resume"),
      options: optionsFor("/tmp/unused", draftFor("prep-resume")),
      competition: {},
      releaseLock: async () => {},
      record: {
        ...missionRecordFixture("prep-resume"),
        // What reconcileResearchMemory leaves on the record it verified.
        researchMemory: { snapshotId: "research-memory:abc", snapshotDigest: "abc", ledgerRevision: 7, cards: { finding: 1 }, omittedCards: 0 },
        history: [{ type: "MISSION_RESUMED", at: "2026-09-11T00:00:00.000Z" }],
      } as never,
    });

    expect(prepared.kind).toBe("resume");
    expect(prepared.snapshot.memory).toEqual({ mode: "real", published: true, snapshotId: "research-memory:abc", digest: "abc", ledgerRevision: 7 });
    expect(prepared.ledgerEvent.type).toBe("MISSION_RESUMED");
  });

  test("a second controller cannot prepare the same Mission concurrently", async () => {
    const draft = draftFor("prep-lock");
    const project = await projectWith(draft);

    const first = await prepareAuthorizedStart(optionsFor(project, draft));
    await expect(prepareAuthorizedStart(optionsFor(project, draft))).rejects.toBeInstanceOf(MissionControllerConflictError);
    await first.releaseLock();
    // Once the first controller released its fence, the Mission is started, so
    // preparation still refuses to reuse the accepted record.
    await expect(prepareAuthorizedStart(optionsFor(project, draft))).rejects.toBeInstanceOf(MissionStartRejectedError);
  });
});
