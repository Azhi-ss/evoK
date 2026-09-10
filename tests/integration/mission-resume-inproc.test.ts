/**
 * In-process lifecycle tests for resumeAuthorizedMission (#114):
 * fresh-Run retry after an abandoned intent, stale-lock reclamation, explicit
 * authorization, and non-resumable/terminal-state refusal. The cross-process
 * interruption boundaries live in mission-resume.test.ts (subprocesses).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  MissionControllerConflictError,
  MissionResumeRejectedError,
  ReconciliationBlockedError,
  resumeAuthorizedMission,
  type BaselineEvaluator,
  type ResumeAuthorization,
} from "../../src/mission-start";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import { createEvokModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";
import type { DirectorInput, MissionDirector } from "../../src/mission-director";

const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };
const EVAL_ID = "inproc-answer";
const evaluator: BaselineEvaluator = {
  id: EVAL_ID,
  version: "1",
  async evaluate(snapshot) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing"] };
    const value = Number(raw.split(/\r?\n/, 1)[0]?.trim());
    if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false, ruleViolations: ["bad answer"] };
    return { ok: true, score: value };
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function draft(id: string): MissionDraft {
  return {
    schemaVersion: 1, id, status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured independently"],
    data: { description: "local synthetic data" },
    evaluation: { method: EVAL_ID, metric: "answer in [0,1]" },
    constraints: { permissions: ["read-project", "isolated-workspace-write"], hardRules: ["no external submission"] },
    budget: { total: 2, units: "model-USD" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [], decisions: [], sources: [],
    plan: { baselineHypothesis: "file baseline", tasks: [{ taskId: "baseline", objective: "materialize answer.txt = 0.4" }] },
    usage: { tokens: { input: 1, output: 1, total: 2 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

async function projectWith(id: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t6-inproc-"));
  dirs.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# project");
  await saveMissionDraft(dir, draft(id));
  return dir;
}

async function harness(project: string, values: readonly (number | null)[]) {
  const name = `evok-t6-inproc-${Math.random().toString(36).slice(2, 8)}`;
  const faux = fauxProvider({ provider: name, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 400 });
  faux.setResponses(values.flatMap((v) => v === null
    ? [fauxAssistantMessage("no artifact")]
    : [
        fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: `${v}\n` }), { stopReason: "toolUse" }),
        fauxAssistantMessage(`answer=${v}`),
      ]));
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const ref = `${name}/deterministic`;
  const resolver = await createEvokModelResolver({
    modelRuntime: runtime,
    catalog: {
      findModel(r: string) { return r === ref ? { provider: name, model: "deterministic", id: ref } : undefined; },
      defaultModel() { return { provider: name, model: "deterministic", id: ref }; },
    },
  });
  const resources = await discoverEvokResources({ projectRoot: project });
  return { resolver, resources };
}

const zero = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function director(): MissionDirector {
  return {
    id: "d",
    async decide(input: DirectorInput) {
      if (input.observations.length === 0) {
        // No confirmed baseline (it was lost with the interrupted process):
        // establish one now as the first recovered Experiment.
        return {
          proposal: {
            stateVersion: input.stateVersion, action: "change-direction",
            rationale: "no confirmed baseline survived; establish the measurable artifact",
            task: { objective: "materialize answer.txt with value 0.4", expectedOutputs: ["answer.txt"] },
            expectedCost: 0.001,
          },
          sessionId: `s-${Math.random()}`, usage: zero,
        };
      }
      const last = input.observations[input.observations.length - 1]!;
      if (input.observations.length >= 2) {
        return { proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "two observations", stopReason: "done" }, sessionId: `s-${Math.random()}`, usage: zero };
      }
      return {
        proposal: {
          stateVersion: input.stateVersion,
          action: last.ok ? "change-direction" : "retry",
          rationale: "continue toward 0.9",
          task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        },
        sessionId: `s-${Math.random()}`, usage: zero,
      };
    },
  };
}

const resumeAuth = (token = "/resume"): ResumeAuthorization => ({ requested: true, token, missionSelector: "displayed" });
const price = (t: { input: number; output: number }) => t.input * MODEL_COST.input + t.output * MODEL_COST.output;

/** Hand-write a durable interrupted record matching one aborted experiment. */
async function writeInterruptedRecord(project: string, id: string, record: Record<string, unknown>): Promise<void> {
  const dir = join(project, ".evok", "missions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "mission.json"), JSON.stringify(record, null, 2));
}

describe("resumeAuthorizedMission (#114 AC2/AC3/AC4/AC5)", () => {
  test("explicit authorization is required: a question or model source cannot resume", async () => {
    const project = await projectWith("m-t6-auth");
    const { resolver, resources } = await harness(project, []);
    const question = await resumeAuthorizedMission({
      projectRoot: project, missionId: "m-t6-auth",
      authorization: { requested: true, token: "can we continue later?", missionSelector: "displayed" },
      resolver, resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(question).toBeInstanceOf(MissionResumeRejectedError);

    const modelSourced = await resumeAuthorizedMission({
      projectRoot: project, missionId: "m-t6-auth",
      authorization: { requested: true, token: "/resume", missionSelector: "displayed", source: "model" },
      resolver, resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(modelSourced).toBeInstanceOf(MissionResumeRejectedError);
  });

  test("a budget-exhausted Mission is not resumable (no silent budget restore)", async () => {
    const project = await projectWith("m-t6-exhaust");
    const id = "m-t6-exhaust";
    await writeInterruptedRecord(project, id, {
      schemaVersion: 1, id, status: "budget-exhausted", objective: draft(id).objective,
      contract: { objective: draft(id).objective, expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, hardRules: [] },
      budget: { total: 2, units: "model-USD", consumed: 2, remaining: 0 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
      stopReason: "budget exhausted",
    });
    const { resolver, resources } = await harness(project, []);
    const error = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth(),
      resolver, resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(MissionResumeRejectedError);
    expect((error as Error).message).toMatch(/not resumable|budget/);
  });

  test("a stale lock from a dead process is reclaimed; a live lock keeps fencing", async () => {
    const project = await projectWith("m-t6-stale");
    const id = "m-t6-stale";
    await writeInterruptedRecord(project, id, {
      schemaVersion: 1, id, status: "interrupted", objective: draft(id).objective,
      contract: { objective: draft(id).objective, expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, hardRules: ["no external submission"] },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      permissions: ["read-project", "isolated-workspace-write"], modelTier: "default",
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
      stopReason: "user interruption",
    });
    // stale lock: a pid that cannot exist
    await writeFile(join(project, ".evok", "missions", id, "controller.lock"), JSON.stringify({ pid: 999999 }));
    const { resolver, resources } = await harness(project, [0.4, 0.9]);
    // No confirmed baseline: reconcile leaves an empty observation set; the
    // director proposes a change-direction experiment and the loop measures it.
    const outcome = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth(),
      resolver, resources, evaluator, director: director(),
      reserveCost: 0.0001, priceModelCost: () => price, maxExperiments: 2,
    });
    expect(["director-stopped", "iteration-limit"]).toContain(outcome.status);

    // now a LIVE lock must fence a second resume
    const live = await projectWith("m-t6-live");
    const id2 = "m-t6-live";
    await writeInterruptedRecord(live, id2, {
      schemaVersion: 1, id: id2, status: "interrupted", objective: draft(id2).objective,
      contract: { objective: draft(id2).objective, expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, hardRules: [] },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
    });
    await writeFile(join(live, ".evok", "missions", id2, "controller.lock"), JSON.stringify({ pid: process.pid }));
    const h2 = await harness(live, []);
    const blocked = await resumeAuthorizedMission({
      projectRoot: live, missionId: id2, authorization: resumeAuth(),
      resolver: h2.resolver, resources: h2.resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(blocked).toBeInstanceOf(MissionControllerConflictError);
  });

  test("a re-saved draft cannot widen permissions or reroute the model tier on resume", async () => {
    const project = await projectWith("m-t6-widen");
    const id = "m-t6-widen";
    await writeInterruptedRecord(project, id, {
      schemaVersion: 1, id, status: "interrupted", objective: draft(id).objective,
      contract: { objective: draft(id).objective, expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, hardRules: ["no external submission"] },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      permissions: ["read-project", "isolated-workspace-write"], stopConditions: ["budget exhausted"], modelTier: "default",
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
    });
    // widen permissions via a re-saved draft
    const widened: MissionDraft = { ...draft(id), constraints: { permissions: ["read-project", "isolated-workspace-write", "local-shell-in-workspace"], hardRules: ["no external submission"] } };
    await saveMissionDraft(project, widened);
    const { resolver, resources } = await harness(project, []);
    const error = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth(),
      resolver, resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(MissionResumeRejectedError);
    expect((error as Error).message).toMatch(/permission|authority/);

    // a tier reroute is also rejected (separate record so the permission check does not fire first)
    const tierProject = await projectWith("m-t6-tier");
    const tierId = "m-t6-tier";
    await writeInterruptedRecord(tierProject, tierId, {
      schemaVersion: 1, id: tierId, status: "interrupted", objective: draft(tierId).objective,
      contract: { objective: draft(tierId).objective, expectedOutputs: ["answer.txt"], evaluationMethod: EVAL_ID, hardRules: ["no external submission"] },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      permissions: ["read-project", "isolated-workspace-write"], stopConditions: ["budget exhausted"], modelTier: "fast",
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
    });
    const { resolver: r2, resources: res2 } = await harness(tierProject, []);
    const rerouted = await resumeAuthorizedMission({
      projectRoot: tierProject, missionId: tierId, authorization: resumeAuth(),
      resolver: r2, resources: res2, evaluator, director: director(), tier: "deep",
    }).catch((e) => e as Error);
    expect(rerouted).toBeInstanceOf(MissionResumeRejectedError);
    expect((rerouted as Error).message).toMatch(/tier/);
  });

  test("a damaged record blocks recovery visibly and is not overwritten", async () => {
    const project = await projectWith("m-t6-damaged");
    const id = "m-t6-damaged";
    const dir = join(project, ".evok", "missions", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mission.json"), "{ broken");
    const { resolver, resources } = await harness(project, []);
    const error = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth(),
      resolver, resources, evaluator, director: director(),
    }).catch((e) => e as Error);
    expect(error instanceof ReconciliationBlockedError || (error as Error).name === "MissionRecordCorruptionError").toBe(true);
    expect((await readFile(join(dir, "mission.json"), "utf8")).startsWith("{ broken")).toBe(true);
  });
});
