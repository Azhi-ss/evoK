/**
 * Primary-seam lifecycle tests for M1-T4 (#213): scientific and operational
 * Run outcomes keep their meaning across the authorized Mission lifecycle.
 *
 * Every scenario goes through the real controller (`startAuthorizedMission` →
 * dispatch → immutable snapshot → independent evaluation → derived Research
 * Memory) with a controlled runtime boundary and a deterministic evaluator.
 * An OOM, a timeout, an invalid measurement, a valid negative outcome and a
 * useful replication are therefore exercised without touching the existing
 * Experiment Validity gates.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadMissionRecord,
  startAuthorizedMission,
  summarizeMission,
  type BaselineEvaluator,
  type StartAuthorization,
  type StartMissionOptions,
} from "../../src/mission-start";
import type { DirectorInput, MissionDirector } from "../../src/mission-director";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import type { EvokResources } from "../../src/evok-resources";
import type { PiAgentRuntime } from "../../src/pi-agent-runtime";
import { OPERATIONAL_PITFALL_CARD_SCHEMA, RESEARCH_MEMORY_FINDING_CARD_SCHEMA } from "../../src/evidence/research-memory";
import { loadResearchMemorySnapshot } from "../../src/execution/research-memory-provider";

/** One scripted candidate Run: materialize a value, or fail operationally. */
type Step = { readonly value: number } | { readonly fail: string } | { readonly empty: true };

const fileEvaluator: BaselineEvaluator = {
  id: "file-answer-deterministic",
  version: "1",
  async evaluate(snapshot) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing"] };
    return { ok: true, score: Number(raw.split(/\r?\n/, 1)[0]?.trim()) };
  },
};

function completeDraft(id: string): MissionDraft {
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
  } as MissionDraft;
}

/** Controlled runtime: the n-th Run writes its scripted value or fails. */
function scriptedRuntime(steps: readonly Step[]) {
  let index = 0;
  return () => {
    const step = steps[index++] ?? { fail: "unexpected extra Run" };
    return {
      execute: async (request: { workspace: { path: string } }) => {
        await mkdir(request.workspace.path, { recursive: true });
        if ("fail" in step) throw new Error(step.fail);
        if (!("empty" in step)) await writeFile(join(request.workspace.path, "answer.txt"), `${step.value}\n`);
        return {
          sessionId: `stub-session-${index}`,
          workspace: request.workspace.path,
          events: [],
          ledger: [],
          usage: {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
          },
          stopReason: "stop",
        };
      },
    } as unknown as PiAgentRuntime;
  };
}

class ScriptedDirector implements MissionDirector {
  readonly id = "scripted-outcome-director";
  readonly inputs: DirectorInput[] = [];
  constructor(private readonly script: (input: DirectorInput) => unknown) {}
  async decide(input: DirectorInput) {
    this.inputs.push(structuredClone(input));
    return { proposal: this.script(input) as never, sessionId: `director-${this.inputs.length}`, usage: ZERO_USAGE };
  }
}

const ZERO_USAGE = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const auth: StartAuthorization = { requested: true, token: "/start", missionSelector: "displayed" };
const projectDirs: string[] = [];

afterEach(async () => {
  await Promise.all(projectDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One bounded propose-then-stop decision script over the measured history. */
function proposeThenStop(
  taskObjective: (input: DirectorInput) => string,
  constraints?: Readonly<Record<string, string | number | boolean>>,
) {
  return (input: DirectorInput) => {
    const last = input.observations[input.observations.length - 1];
    if (input.observations.length > 1 || last === undefined) {
      return { stateVersion: input.stateVersion, action: "stop", rationale: "one bounded Experiment is enough", stopReason: "bounded lifecycle scenario complete" };
    }
    return {
      stateVersion: input.stateVersion,
      action: "investigate",
      rationale: `act on the last observation (${last.runId})`,
      task: { objective: taskObjective(input), expectedOutputs: ["answer.txt"], ...(constraints ? { constraints } : {}) },
      expectedCost: 0.0001,
      basedOn: [last.runId],
    };
  };
}

async function runLifecycle(args: {
  id: string;
  steps: readonly Step[];
  script: (input: DirectorInput) => unknown;
  evaluator?: BaselineEvaluator;
  maxExperiments?: number;
}): Promise<{
  project: string;
  record: Awaited<ReturnType<typeof loadMissionRecord>>;
  director: ScriptedDirector;
  snapshot: Awaited<ReturnType<typeof loadResearchMemorySnapshot>>;
}> {
  const project = await mkdtemp(join(tmpdir(), "evok-outcomes-"));
  projectDirs.push(project);
  const draft = await saveMissionDraft(project, completeDraft(args.id));
  const director = new ScriptedDirector(args.script);
  const options: StartMissionOptions = {
    projectRoot: project,
    missionId: draft.id,
    authorization: auth,
    resolver: (() => {
      throw new Error("the scripted runtime never resolves a model");
    }) as unknown as StartMissionOptions["resolver"],
    resources: { readRoots: [], skillFiles: [] } as unknown as EvokResources,
    evaluator: args.evaluator ?? fileEvaluator,
    budgetUnits: "model-USD",
    reserveCost: 0.0001,
    director,
    runtimeFactory: scriptedRuntime(args.steps),
    ...(args.maxExperiments !== undefined ? { maxExperiments: args.maxExperiments } : {}),
  };
  await startAuthorizedMission(options);
  const record = await loadMissionRecord(project, draft.id);
  const snapshot = await loadResearchMemorySnapshot(join(project, ".evok", "missions", draft.id, "memory"));
  return { project, record, director, snapshot };
}

function operationalError(record: Awaited<ReturnType<typeof loadMissionRecord>>, runId: string): string | undefined {
  return record.runs[runId]?.error;
}

describe("scientific and operational outcomes across the Mission lifecycle (#213)", () => {
  test("an OOM Run keeps its Run Outcome and becomes an Operational Pitfall, never Negative Evidence", async () => {
    const oom = "CUDA error: out of memory while allocating 2.5 GiB on the visible device";
    const { record, director, snapshot } = await runLifecycle({
      id: "m-oom",
      steps: [{ value: 0.4 }, { fail: oom }],
      script: proposeThenStop(() => "push the measured answer toward 0.9", { batch: 64, device: "single 24GB GPU" }),
    });

    // The Run Outcome is preserved verbatim and the Run is not marked measured.
    const expRun = record.experiments![0]!;
    expect(record.runs[expRun.runId]?.status).toBe("failed");
    expect(operationalError(record, expRun.runId)).toBe(oom);
    expect(expRun.ok).toBe(false);
    expect(expRun.negativeEvidence).toBeUndefined();
    expect(summarizeMission(record).negativeEvidence).toBe(0);

    // The Director sees an operational failure with its kind, not a refutation.
    const afterOom = director.inputs.at(-2)!;
    const observation = afterOom.observations.find((o) => o.runId === expRun.runId)!;
    expect(observation).toMatchObject({ ok: false, outcome: "operational", failure: "out-of-memory" });
    expect(observation.negativeEvidence).toBeUndefined();
    expect(observation.error).toBe(oom);

    // The persisting projection shows the same distinction and a Pitfall.
    const card = snapshot!.cards.find((entry) => entry.cardId === `finding:${expRun.runId}`)!;
    expect(card).toMatchObject({ schema: RESEARCH_MEMORY_FINDING_CARD_SCHEMA, outcome: "operational", failure: "out-of-memory" });
    expect(card.summary).toContain("not scientific negative evidence");
    const pitfall = snapshot!.cards.find((entry) => entry.cardId === `pitfall:run:${expRun.runId}`)!;
    expect(pitfall).toMatchObject({ schema: OPERATIONAL_PITFALL_CARD_SCHEMA, failure: "out-of-memory" });
    // The declared Task configuration that reproduced the failure travels with
    // the Pitfall, so a later Run can avoid the same operational mistake.
    expect(pitfall.kind === "pitfall" && pitfall.conditions).toEqual([
      "failure:out-of-memory",
      "configuration:batch=64; device=single 24GB GPU",
      `observed:${oom}`,
    ]);
  });

  test("a timeout keeps its Run Outcome and never refutes the tested approach", async () => {
    const timeout = "Run timed out after 900000ms; the workspace was disposed";
    const { record, director, snapshot } = await runLifecycle({
      id: "m-timeout",
      steps: [{ value: 0.4 }, { fail: timeout }],
      script: proposeThenStop(() => "retry the approach with a smaller batch"),
    });

    const expRun = record.experiments![0]!;
    expect(record.runs[expRun.runId]?.status).toBe("failed");
    expect(operationalError(record, expRun.runId)).toBe(timeout);
    expect(expRun.negativeEvidence).toBeUndefined();

    const observation = director.inputs.at(-2)!.observations.find((o) => o.runId === expRun.runId)!;
    expect(observation).toMatchObject({ outcome: "operational", failure: "timeout" });
    expect(observation.negativeEvidence).toBeUndefined();

    const pitfall = snapshot!.cards.find((entry) => entry.cardId === `pitfall:run:${expRun.runId}`)!;
    expect(pitfall).toMatchObject({ schema: OPERATIONAL_PITFALL_CARD_SCHEMA, failure: "timeout" });
  });

  test("an invalid measurement is operational and creates no Negative Evidence", async () => {
    const invalidEvaluator: BaselineEvaluator = {
      id: "file-answer-deterministic",
      version: "1",
      async evaluate(snapshot, context) {
        if (context.runId.includes(":exp:")) return { ok: false }; // nothing measured
        return fileEvaluator.evaluate(snapshot, context);
      },
    };
    const { record, snapshot } = await runLifecycle({
      id: "m-invalid",
      steps: [{ value: 0.4 }, { value: 0.6 }],
      script: proposeThenStop(() => "push the measured answer toward 0.9"),
      evaluator: invalidEvaluator,
    });

    const expRun = record.experiments![0]!;
    expect(record.runs[expRun.runId]?.status).toBe("measured");
    expect(expRun.ok).toBe(false);
    expect(expRun.negativeEvidence).toBeUndefined();
    expect(summarizeMission(record).negativeEvidence).toBe(0);

    const card = snapshot!.cards.find((entry) => entry.cardId === `finding:${expRun.runId}`)!;
    expect(card).toMatchObject({ outcome: "operational", failure: "invalid-measurement" });
  });

  test("a valid negative outcome stays authoritative scientific Negative Evidence", async () => {
    const { record, director, snapshot } = await runLifecycle({
      id: "m-negative",
      steps: [{ value: 0.4 }, { empty: true }],
      // A measured rule failure instead of a dispatch failure: the evaluator
      // runs against the real snapshot and rejects it.
      script: proposeThenStop(() => "push the measured answer toward 0.9"),
      evaluator: {
        id: "file-answer-deterministic",
        version: "1",
        async evaluate(snapshot, context) {
          if (context.runId.includes(":exp:")) return { ok: false, ruleViolations: ["answer.txt is missing"] };
          return fileEvaluator.evaluate(snapshot, context);
        },
      },
    });

    const expRun = record.experiments![0]!;
    expect(expRun.ok).toBe(false);
    expect(expRun.negativeEvidence).toBe(true);
    expect(summarizeMission(record).negativeEvidence).toBe(1);

    const observation = director.inputs.at(-2)!.observations.find((o) => o.runId === expRun.runId)!;
    expect(observation).toMatchObject({ outcome: "negative", negativeEvidence: true });
    expect(observation.failure).toBeUndefined();

    const card = snapshot!.cards.find((entry) => entry.cardId === `finding:${expRun.runId}`)!;
    expect(card).toMatchObject({ outcome: "negative", lifecycle: "contested" });
    expect(snapshot!.cards.some((entry) => entry.cardId === `pitfall:run:${expRun.runId}`)).toBe(false);
  });

  test("a repeated Experiment proposal keeps replication value instead of being rejected or vetoed", async () => {
    const replicationObjective = "materialize answer.txt with value 0.3";
    const { record, snapshot } = await runLifecycle({
      id: "m-replication",
      steps: [{ value: 0.4 }, { value: 0.3 }, { value: 0.35 }],
      maxExperiments: 3,
      script: (input) => {
        const last = input.observations[input.observations.length - 1]!;
        if (input.observations.length === 1) {
          return {
            stateVersion: input.stateVersion,
            action: "investigate",
            rationale: "try the next approach",
            task: { objective: replicationObjective, expectedOutputs: ["answer.txt"] },
            expectedCost: 0.0001,
            basedOn: [last.runId],
          };
        }
        if (input.observations.length === 2) {
          // The SAME Experiment objective again: seed replication, declared as
          // a bounded next action rather than refused as a duplicate.
          return {
            stateVersion: input.stateVersion,
            action: "retry",
            rationale: "replicate the same approach to check seed/score variance",
            task: { objective: replicationObjective, expectedOutputs: ["answer.txt"] },
            expectedCost: 0.0001,
            basedOn: [last.runId],
          };
        }
        return { stateVersion: input.stateVersion, action: "stop", rationale: "replication measured", stopReason: "replication measured" };
      },
    });

    // Both Runs happened: no automatic duplicate rejection, no Memory veto.
    expect(record.experiments).toHaveLength(2);
    expect(record.experiments!.map((entry) => entry.ok)).toEqual([true, true]);
    expect(record.status).toBe("director-stopped");

    const [first, repeat] = record.experiments!;
    const repeatCard = snapshot!.cards.find((entry) => entry.cardId === `finding:${repeat!.runId}`)!;
    expect(repeatCard).toMatchObject({
      outcome: "positive",
      replication: { objective: replicationObjective, priorRunIds: [first!.runId], priorOutcomes: ["positive"], advisory: true },
    });
    expect(repeatCard.applicability).toEqual([`task:${repeat!.taskId}`]);
  });
});
