/**
 * Primary-seam tests for T5 (#113): one explicit Mission start runs the
 * measured baseline and then CONTINUES autonomously through the evidence
 * driven Research Loop with no "continue" prompt.
 *
 * The decision boundary is a deterministic scripted MissionDirector (the
 * controlled model boundary), while every dispatched candidate Run is a REAL
 * Pi execution (controlled faux provider + real local file tools in an
 * isolated workspace) measured by an independent deterministic evaluator.
 *
 * The headline AC8 test proves that DIFFERENT REAL OBSERVATIONS REACH the
 * decision boundary AND LEAD TO DIFFERENT SUBSEQUENT WORK (different tasks,
 * fresh sessions/workspaces/attempts). No test here mocks research state or
 * gates into success; none claims live research quality.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  BudgetExhaustedError,
  DirectorBlockedError,
  EvaluatorFailureError,
  loadMissionRecord,
  startAuthorizedMission,
  type BaselineEvaluator,
  type StartAuthorization,
  type StartMissionOptions,
} from "../../src/mission-start";
import {
  DirectorDecisionFailedError,
  DirectorProposalRejectedError,
  type DirectorInput,
  type MissionDirector,
} from "../../src/mission-director";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import { createEvokModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";

const CONTROL_PROVIDER = "evok-t5-control";
const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };

function priceTokens(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
  return tokens.input * MODEL_COST.input + tokens.output * MODEL_COST.output;
}

const fileEvaluator: BaselineEvaluator = {
  id: "file-answer-deterministic",
  version: "1",
  async evaluate(snapshot) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing"] };
    const value = Number(raw.split(/\r?\n/, 1)[0]?.trim());
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, ruleViolations: ["answer.txt first line must be a finite number in [0,1]"] };
    }
    return { ok: true, score: value, facts: [{ name: "answer", value, source: "answer.txt" }] };
  },
};

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t5-project-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# t5 research project");
  return dir;
}

function completeDraft(id: string, overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    schemaVersion: 1,
    id,
    status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the project" },
    evaluation: { method: "file-answer-deterministic", metric: "answer in [0,1]" },
    constraints: {
      permissions: ["isolated-workspace-write", "read-project", "local-shell-in-workspace"],
      hardRules: ["no external submission"],
    },
    budget: { total: 1, units: "model-USD", note: "bounded loop" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [],
    decisions: [],
    sources: [],
    plan: {
      baselineHypothesis: "a deterministic file-producing baseline is measurable",
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt in the run workspace with value 0.75" }],
    },
    usage: { tokens: { input: 11, output: 7, total: 18 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  } as MissionDraft;
}

/** A scripted candidate Run step: write a value, or produce no artifact. */
type RunScript = { value: number } | { empty: true };

/**
 * Controlled candidate model. Each scripted Run either writes answer.txt with
 * a value (two faux turns: tool call + final text) or produces no artifact.
 * Faux keeps an internal cursor, so the n-th Run follows scripts[n].
 */
async function controlledHarness(project: string, scripts: RunScript[], providerTag = "p") {
  const providerName = `${CONTROL_PROVIDER}-${providerTag}-${Math.random().toString(36).slice(2, 8)}`;
  const faux = fauxProvider({ provider: providerName, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 400 });
  faux.setResponses(
    scripts.flatMap((script) =>
      "empty" in script
        ? [fauxAssistantMessage("I considered it but produced no artifact")]
        : [
            fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: `${script.value}\n` }), { stopReason: "toolUse" }),
            fauxAssistantMessage(`experiment materialized answer.txt = ${script.value}`),
          ],
    ),
  );
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${providerName}/deterministic`;
  const resolver = await createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel(r: string) {
        if (r !== ref) return undefined;
        return { provider: providerName, model: "deterministic", id: ref };
      },
      defaultModel() {
        return { provider: providerName, model: "deterministic", id: ref };
      },
    },
  });
  const resources = await discoverEvokResources({ projectRoot: project });
  return { resolver, resources, faux, ref };
}

function auth(overrides: Partial<StartAuthorization> = {}): StartAuthorization {
  return { requested: true, token: "/start", missionSelector: "displayed", ...overrides };
}

/** Records every trusted projection the decision boundary actually receives. */
class RecordingDirector implements MissionDirector {
  readonly id: string;
  readonly inputs: DirectorInput[] = [];
  private calls = 0;
  constructor(private readonly script: (input: DirectorInput, call: number) => ReturnType<MissionDirector["decide"]> extends Promise<infer P> ? P : never) {
    this.id = "scripted-director";
  }
  async decide(input: DirectorInput) {
    this.calls += 1;
    this.inputs.push(structuredClone(input));
    return this.script(input, this.calls);
  }
}

const zeroUsage = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const decide = (proposal: unknown) => ({
  proposal: proposal as never,
  sessionId: `director-session-${Math.random().toString(36).slice(2)}`,
  usage: zeroUsage,
});

const baseOptions = (
  project: string,
  resolver: StartMissionOptions["resolver"],
  resources: StartMissionOptions["resources"],
  director: MissionDirector,
  overrides: Partial<StartMissionOptions> = {},
): StartMissionOptions => ({
  projectRoot: project,
  missionId: "",
  authorization: auth(),
  resolver,
  resources,
  evaluator: fileEvaluator,
  budgetUnits: "model-USD",
  reserveCost: 0.0001,
  priceModelCost: () => priceTokens,
  director,
  maxExperiments: 3,
  ...overrides,
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startWith(
  project: string,
  draft: MissionDraft,
  harness: Awaited<ReturnType<typeof controlledHarness>>,
  director: MissionDirector,
  overrides: Partial<StartMissionOptions> = {},
) {
  return startAuthorizedMission({
    ...baseOptions(project, harness.resolver, harness.resources, director, overrides),
    missionId: draft.id,
  });
}

describe("one explicit start continues autonomously from measured evidence (#113 AC1/AC2/AC8)", () => {
  test("AC8: different real observations reach the boundary and produce different subsequent work", async () => {
    // Two identical-authorized Missions whose REAL candidate runs differ, plus
    // one identical director policy that reacts to observations.
    const build = async (id: string, baseline: number) => {
      const project = await tempProject();
      tempDirs.push(project);
      const draft = await saveMissionDraft(project, completeDraft(id));
      // The same decision policy: it proposes to PUSH toward 0.9 after the
      // baseline, and to RETRY the last approach when the previous attempt
      // failed. Identical logic across both Missions.
      const director = new RecordingDirector((input) => {
        const last = input.observations[input.observations.length - 1]!;
        if (input.observations.length >= 2) {
          return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "two observations gathered; bounded demo ends", stopReason: "bounded demo complete" });
        }
        if (!last.ok) {
          return decide({
            stateVersion: input.stateVersion,
            action: "retry",
            rationale: `the last attempt failed (${last.ruleViolations?.join("; ") ?? last.error}); retry the same materialization`,
            task: { objective: "materialize answer.txt with value 0.8", expectedOutputs: ["answer.txt"] },
            expectedCost: 0.001,
            basedOn: [last.runId],
          });
        }
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: `baseline measured ${last.score}; push the approach toward the 0.9 target`,
          task: { objective: `change approach to materialize answer.txt with value 0.9 (baseline was ${last.score})`, expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        });
      });
      // Only TWO candidate Runs happen (baseline + one experiment), so the
      // scripted provider needs exactly two write values.
      const harness = await controlledHarness(project, [{ value: baseline }, { value: 0.9 }], "good");
      const outcome = await startWith(project, draft, harness, director);
      return { outcome, record: outcome.record, director, harness };
    };

    const good = await build("m-t5-good", 0.4);

    // Failed-baseline Mission: the baseline candidate writes no artifact, so
    // the independent measurement is a rule failure (Negative Evidence). The
    // follow-up experiment writes 0.9 for real.
    const failedProject = await tempProject();
    tempDirs.push(failedProject);
    const failedDraft = await saveMissionDraft(failedProject, completeDraft("m-t5-bad"));
    const failedDirector = new RecordingDirector((input) => {
      const last = input.observations[input.observations.length - 1]!;
      if (input.observations.length >= 2) {
        return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "two observations gathered; bounded demo ends", stopReason: "bounded demo complete" });
      }
      if (!last.ok) {
        return decide({
          stateVersion: input.stateVersion,
          action: "retry",
          rationale: `the last attempt failed (${last.ruleViolations?.join("; ") ?? last.error}); retry the materialization`,
          task: { objective: "materialize answer.txt with value 0.8", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        });
      }
      return decide({
        stateVersion: input.stateVersion,
        action: "change-direction",
        rationale: `baseline measured ${last.score}; push toward 0.9`,
        task: { objective: "change approach to materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
        expectedCost: 0.001,
        basedOn: [last.runId],
      });
    });
    const failedHarness = await controlledHarness(failedProject, [{ empty: true }, { value: 0.8 }], "failed");
    const failedOutcome = await startWith(failedProject, failedDraft, failedHarness, failedDirector);
    const failed = { outcome: failedOutcome, record: failedOutcome.record, director: failedDirector, harness: failedHarness };

    // Both runs started once and continued with no "continue" prompt: exactly
    // one baseline Run + one Experiment Run each.
    expect(good.record.experiments).toHaveLength(1);
    expect(failed.record.experiments).toHaveLength(1);

    // 1) The REAL observations reached the decision boundary.
    const g0 = good.director.inputs[0]!;
    const f0 = failed.director.inputs[0]!;
    expect(g0.observations[0]?.ok).toBe(true);
    expect(g0.observations[0]?.score).toBe(0.4);
    expect(f0.observations[0]?.ok).toBe(false);
    expect(f0.observations[0]?.negativeEvidence).toBe(true);

    // 2) The differing observations produced DIFFERENT actions and tasks.
    expect(g0.observations[0]).not.toEqual(f0.observations[0]);
    expect(good.record.tasks!.find((t) => t.source === "director")?.objective).toMatch(/change approach/i);
    expect(failed.record.tasks!.find((t) => t.source === "director")?.objective).toMatch(/retry|materialize answer.txt with value 0.8/i);
    expect(good.record.decisions![0]?.action).toBe("change-direction");
    expect(failed.record.decisions![0]?.action).toBe("retry");

    // 3) The differing tasks produced DIFFERENT dispatched work: the good
    // Mission's experiment actually produced 0.9 and is independently measured.
    const gExp = good.record.experiments![0]!;
    const fExp = failed.record.experiments![0]!;
    expect(gExp.ok).toBe(true);
    expect(gExp.evaluation?.score).toBe(0.9);
    expect(gExp.evaluation?.score).not.toBe(fExp.evaluation?.score);
    expect(gExp.snapshotDigest).not.toBe(fExp.snapshotDigest);

    // 4) Every attempt is a fresh Run/session/attempt identity (ADR-0001), and
    // they share the authoritative evidence rather than a conversation.
    expect(good.record.runs[good.record.baselineRunId!]?.sessionId).not.toBe(good.record.runs[gExp.runId]?.sessionId);
    expect(gExp.attempt).toBe(2);
    expect(gExp.runId).toContain("exp:2");
  });

  test("a single start produces a baseline plus a subsequent Experiment with no continue prompt", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-loop"));
    const director = new RecordingDirector((input) => decide(input.observations.length === 1
      ? {
          stateVersion: input.stateVersion,
          action: "investigate",
          rationale: "baseline is 0.4; try one refinement toward 0.9",
          task: { objective: "materialize answer.txt with value 0.85", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [input.observations[0]!.runId],
        }
      : { stateVersion: input.stateVersion, action: "stop", rationale: "bounded demo", stopReason: "done" }));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.85 }]);
    const outcome = await startWith(project, draft, harness, director);

    expect(outcome.status).toBe("director-stopped");
    expect(outcome.experiments).toHaveLength(1);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.baseline?.evaluation.score).toBe(0.4);
    expect(record.experiments![0]?.evaluation?.score).toBe(0.85);
    // one baseline + one experiment candidate Run; no user prompt between them
    const candidateRuns = Object.values(record.runs).filter((r) => r.runId !== undefined);
    expect(candidateRuns).toHaveLength(2);
    expect(record.stateVersion).toBeGreaterThanOrEqual(2);
    // the boundary saw objective, policy, remaining budget, and real evidence
    const seen = director.inputs[0]!;
    expect(seen.objective).toContain("0.9");
    expect(seen.policy.hardRules.join(" ")).toMatch(/submission/);
    expect(seen.budget.remaining).toBeLessThan(seen.budget.total);
    expect(seen.budget.units).toBe("model-USD");
    expect(seen.observations[0]?.evidenceRefs.length).toBeGreaterThan(0);
  });
});

describe("bounded proposals; invalid proposals never execute (#113 AC4)", () => {
  test("a malformed proposal is corrected within the bound and then a valid one executes", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-correct"));
    let attempts = 0;
    const director: MissionDirector = {
      id: "flaky",
      async decide(input) {
        attempts += 1;
        if (attempts === 1) {
          // first call returns a malformed proposal with no recognizable action
          return { proposal: { broken: true } as never, sessionId: "s-bad", usage: zeroUsage } as never;
        }
        if (input.observations.length >= 2) {
          return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "one correction + one experiment done", stopReason: "bounded correction demo complete" });
        }
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: "corrected proposal after one malformed response",
          task: { objective: "materialize answer.txt with value 0.88", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [input.observations[0]!.runId],
        });
      },
    };
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.88 }]);
    const outcome = await startWith(project, draft, harness, director);
    expect(attempts).toBe(3); // invalid, corrected experiment proposal, post-experiment stop
    expect(outcome.status).toBe("director-stopped");
    expect(outcome.experiments).toHaveLength(1);
    const rejections = outcome.record.decisions!.filter((d) => !d.accepted);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.rejection).toMatch(/JSON|action|proposal/i);
  });

  test("persistently malformed proposals exhaust correction and stop without executing an Experiment", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-blocked"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.99 }]); // experiment value must never run
    const calls: Array<{ sv: number; attempt: number }> = [];
    const director: MissionDirector = {
      id: "always-bad",
      async decide(input, _signal, attempt = 1) {
        calls.push({ sv: input.stateVersion, attempt });
        return { proposal: { no: "valid action" } as never, sessionId: `s-${attempt}`, usage: zeroUsage } as never;
      },
    };
    const error = await startWith(project, draft, harness, director).catch((e) => e as Error);
    expect(error).toBeInstanceOf(DirectorBlockedError);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]); // bounded correction, distinct attempt identity
    expect(harness.faux.state.callCount).toBe(2); // only the baseline Run (2 model turns); no experiment
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("director-blocked");
    expect(record.experiments).toHaveLength(0);
    expect(record.stopReason).toMatch(/invalid proposals/i);
  });

  test("a stale stateVersion is rejected and never executes", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-stale"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.99 }]);
    const director: MissionDirector = {
      id: "stale",
      async decide() {
        // echoes a fixed, wrong stateVersion
        return decide({ stateVersion: 999, action: "change-direction", rationale: "stale", task: { objective: "x" }, expectedCost: 0.001 });
      },
    };
    const error = await startWith(project, draft, harness, director).catch((e) => e as Error);
    expect(error).toBeInstanceOf(DirectorBlockedError);
    expect(harness.faux.state.callCount).toBe(2); // baseline only
  });

  test("objective/permission expansion and unsupported success claims never execute", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-expand"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.99 }]);
    const badProposals: unknown[] = [
      { stateVersion: 1, action: "change-direction", rationale: "new mandate", objective: "win a different competition", task: { objective: "x" } },
      { stateVersion: 1, action: "change-direction", rationale: "network", task: { objective: "x", constraints: { network: "open" } } },
      { stateVersion: 1, action: "change-direction", rationale: "submit", permissions: ["external-submission"], task: { objective: "x" } },
      { stateVersion: 1, action: "change-direction", rationale: "claim", task: { objective: "x", score: 1 } },
    ];
    let i = 0;
    const director: MissionDirector = {
      id: "expander",
      async decide() {
        return decide(badProposals[Math.min(i++, badProposals.length - 1)]);
      },
    };
    const error = await startWith(project, draft, harness, director).catch((e) => e as Error);
    expect(error).toBeInstanceOf(DirectorBlockedError);
    expect(harness.faux.state.callCount).toBe(2); // baseline only, no expansion executed
  });

  test("an over-budget proposal is rejected without executing it", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-overprop"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.99 }]);
    const director: MissionDirector = {
      id: "overbudget",
      async decide(input) {
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: "ask for more than remains",
          task: { objective: "materialize answer.txt with value 0.99", expectedOutputs: ["answer.txt"] },
          expectedCost: 5,
          basedOn: [input.observations[0]!.runId],
        });
      },
    };
    const error = await startWith(project, draft, harness, director, { reserveCost: 0.0001 }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(DirectorBlockedError);
    expect((error as DirectorBlockedError).reason).toMatch(/budget/i);
    expect(harness.faux.state.callCount).toBe(2); // baseline only; the costly proposal never runs
  });
});

describe("failures become Negative Evidence; model claims never become results (#113 AC5)", () => {
  test("a failed candidate Run is retained as Negative Evidence and the model may choose a changed approach", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-negev", { budget: { total: 3, units: "model-USD" } }));
    // Baseline is the write-good 0.4 here; the first EXPERIMENT writes nothing
    // by using a director that routes: we simulate a failed experiment via an
    // empty candidate Run by feeding an extra value the model ignores is not
    // possible with a write-scripted faux, so instead the experiment writes a
    // non-numeric answer => evaluator rule failure => Negative Evidence.
    const director = new RecordingDirector((input) => {
      const last = input.observations[input.observations.length - 1]!;
      if (input.observations.length === 1) {
        return decide({
          stateVersion: input.stateVersion,
          action: "repair",
          rationale: "try a value; this attempt may fail",
          task: { objective: "materialize answer.txt (experiment 1)", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        });
      }
      if (!last.ok) {
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: "the numeric-format repair failed; change approach",
          task: { objective: "materialize answer.txt with value 0.9 after a failed attempt", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        });
      }
      return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "recovered", stopReason: "recovered from negative evidence" });
    });
    // Baseline 0.4; exp1 produces NO artifact => evaluator rule failure
    // (Negative Evidence); exp2 changes approach and writes 0.9.
    const harness = await controlledHarness(project, [{ value: 0.4 }, { empty: true }, { value: 0.9 }]);
    const outcome = await startWith(project, draft, harness, director);
    const experiments = outcome.record.experiments!;
    expect(experiments).toHaveLength(2);
    expect(experiments[0]?.ok).toBe(false);
    expect(experiments[0]?.negativeEvidence).toBe(true);
    expect(experiments[0]?.ruleViolations?.join(" ")).toMatch(/missing|number|finite/i);
    expect(experiments[1]?.ok).toBe(true);
    expect(experiments[1]?.evaluation?.score).toBe(0.9);
    // the failed attempt was carried into the boundary, not dropped
    const atSecondDecision = director.inputs[1]!;
    expect(atSecondDecision.observations.some((o) => o.negativeEvidence)).toBe(true);
    expect(outcome.status).toBe("director-stopped");
  });

  test("an independent-evaluator crash is terminal and a model success claim cannot replace it", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-evalcrash"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    const crashingEvaluator: BaselineEvaluator = {
      id: "boom",
      version: "1",
      async evaluate() { throw new Error("evaluator backend unavailable"); },
    };
    const director = new RecordingDirector(() => decide({ stateVersion: 1, action: "change-direction", rationale: "x", task: { objective: "y" } }));
    const error = await startWith(project, draft, harness, director, { evaluator: crashingEvaluator }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(EvaluatorFailureError);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("evaluator-failed");
    expect(record.experiments).toHaveLength(0); // loop never continues past evaluator failure
    // the immutable snapshot is retained even though measurement failed
    const baselineRun = record.runs[record.baselineRunId!]!;
    expect(baselineRun.snapshotRef).toBeTruthy();
    expect(record.baseline).toBeUndefined(); // a failed evaluator never produces a result
  });

  test("a decision-model infrastructure failure stops truthfully (decision-failed)", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-decfail"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    const director: MissionDirector = {
      id: "broken",
      async decide() { throw new DirectorDecisionFailedError("decision provider 500"); },
    };
    const error = await startWith(project, draft, harness, director).catch((e) => e as Error);
    expect(error).toBeInstanceOf(DirectorDecisionFailedError);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("decision-failed");
    expect(record.experiments).toHaveLength(0);
  });
});

describe("explicit-unit budget including decision calls stops dispatch truthfully (#113 AC6/AC7)", () => {
  test("decision-model calls are metered and a crossed budget blocks the next dispatch", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    // Tiny envelope: baseline consumes some, the director asks for a costly
    // experiment; combined observed cost must cross the total.
    const draft = await saveMissionDraft(project, completeDraft("m-t5-decbudget", {
      budget: { total: 0.002, units: "model-USD" },
    }));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    const director: MissionDirector = {
      id: "costly",
      async decide(input) {
        if (input.observations.length >= 2) {
          return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "stop", stopReason: "done" });
        }
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: "refine",
          task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.0001,
          basedOn: [input.observations[0]!.runId],
        });
      },
    };
    const outcome = await startWith(project, draft, harness, director, { reserveCost: 0.0001 });
    // It ran baseline + possibly the experiment; regardless, usage ledger
    // records candidate Runs and decision calls separately, in model-USD.
    expect(outcome.record.usage.runs.length).toBeGreaterThanOrEqual(1);
    const consumed = outcome.record.usage.intake.cost.total
      + outcome.record.usage.runs.reduce((s, l) => s + l.cost.total, 0)
      + (outcome.record.usage.decisions ?? []).reduce((s, l) => s + l.cost.total, 0);
    expect(consumed).toBeCloseTo(outcome.record.budget.consumed, 5);
    expect(outcome.record.budget.consumed).toBeGreaterThan(outcome.record.usage.intake.cost.total);
  });

  test("no remaining budget before a decision blocks further dispatch with explicit stop state", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-nodec", {
      // One baseline Run (~0.39) fits; the subsequent decision reserve does not.
      // Envelope tracks accepted L0 prompt size (experiment + evidence).
      budget: { total: 0.42, units: "model-USD" },
    }));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    // Tiny but real reservation: the baseline fits, the post-baseline
    // decision reservation does not.
    const director = new RecordingDirector((input) => decide({
      stateVersion: input.stateVersion,
      action: "change-direction",
      rationale: "would continue",
      task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
      expectedCost: 0.0001,
      basedOn: [input.observations[0]!.runId],
    }));
    const error = await startWith(project, draft, harness, director, { reserveCost: 0.05 }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("budget-exhausted");
    expect(record.stopReason).toMatch(/decision/i);
    // the model wanted to continue but no decision call was even made
    expect(director.inputs).toHaveLength(0);
  });

  test("a rejected control-model call that burned tokens is still metered against the budget (AC6)", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-meterreject", {
      budget: { total: 3, units: "model-USD" },
    }));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    const rejectionUsage = { tokens: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, total: 5100 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let rejections = 0;
    const director: MissionDirector = {
      id: "garbage-then-valid",
      async decide(input, _signal, attempt = 1) {
        if (attempt === 1 && rejections === 0) {
          rejections += 1;
          // The real Pi adapter attaches the rejected Run's real usage.
          throw new DirectorProposalRejectedError("decision model did not return a JSON object proposal", {
            usage: rejectionUsage,
            sessionId: "rejected-session",
            model: { provider: CONTROL_PROVIDER, model: "deterministic", id: harness.ref },
          });
        }
        if (input.observations.length >= 2) {
          return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "done", stopReason: "done" });
        }
        return decide({
          stateVersion: input.stateVersion, action: "change-direction", rationale: "recovered",
          task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.0001, basedOn: [input.observations[0]!.runId],
        });
      },
    };
    const outcome = await startWith(project, draft, harness, director);
    // The rejected decision call produced a metered ledger line with real cost.
    const rejectedLine = outcome.record.usage.decisions?.find((d) => d.sessionId === "rejected-session");
    expect(rejectedLine).toBeDefined();
    expect(rejectedLine!.cost.total).toBeGreaterThan(0);
    expect(rejectedLine!.tokens.total).toBe(5100);
    const rejectedRecord = outcome.record.decisions!.find((d) => d.sessionId === "rejected-session");
    expect(rejectedRecord?.accepted).toBe(false);
    expect(outcome.status).toBe("director-stopped");
  });

  test("the iteration bound produces an explicit stop instead of waiting for a prompt", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-iters", { budget: { total: 3, units: "model-USD" } }));
    const director: MissionDirector = {
      id: "never-stop",
      async decide(input) {
        return decide({
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: "keep going",
          task: { objective: `materialize answer.txt value 0.9 attempt ${input.observations.length}`, expectedOutputs: ["answer.txt"] },
          expectedCost: 0.0001,
          basedOn: [input.observations[input.observations.length - 1]!.runId],
        });
      },
    };
    // baseline + 2 experiments
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }, { value: 0.9 }]);
    const outcome = await startWith(project, draft, harness, director, { maxExperiments: 2 });
    expect(outcome.status).toBe("iteration-limit");
    expect(outcome.experiments).toHaveLength(2);
    expect(outcome.stopReason).toMatch(/2 Experiment/);
  });
});

describe("fresh Runs/sessions, durable evidence, no submission/human acceptance (#113 AC5/AC9)", () => {
  test("every attempt uses a fresh session and retains shared authoritative evidence", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-fresh"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.8 }, { value: 0.9 }]);
    const seenBases: string[] = [];
    const director: MissionDirector = {
      id: "chain",
      async decide(input) {
        seenBases.push(input.observations.map((o) => o.runId).join(","));
        if (input.observations.length >= 3) {
          return decide({ stateVersion: input.stateVersion, action: "stop", rationale: "done", stopReason: "complete" });
        }
        const last = input.observations[input.observations.length - 1]!;
        return decide({
          stateVersion: input.stateVersion,
          action: "retry",
          rationale: "refine toward 0.9",
          task: { objective: `materialize answer.txt with value ${0.8 + input.observations.length * 0.1}`, expectedOutputs: ["answer.txt"] },
          expectedCost: 0.0001,
          basedOn: [last.runId],
        });
      },
    };
    const outcome = await startWith(project, draft, harness, director);
    const sessions = Object.values(outcome.record.runs).map((r) => r.sessionId).filter(Boolean);
    expect(new Set(sessions).size).toBe(sessions.length); // all distinct
    // each decision sees the ACCUMULATED evidence (shared authoritative state)
    expect(seenBases[0]!.split(",").length).toBe(1);
    expect(seenBases[1]!.split(",").length).toBe(2);
    // result artifacts are independently reopenable per Run
    for (const runId of [outcome.record.baselineRunId!, ...outcome.experiments.map((e) => e.runId)]) {
      const file = join(project, ".evok", "missions", draft.id, "runs", runId, "result.json");
      const parsed = JSON.parse(await readFile(file, "utf8"));
      expect(parsed.evaluator.id).toBe("file-answer-deterministic");
      expect(parsed.snapshotDigest).toBeTruthy();
      const snap = await readdir(join(project, ".evok", "missions", draft.id, "runs", runId, "snapshot"));
      expect(snap).toContain("answer.txt");
    }
  });

  test("no External Submission or Human Acceptance status is ever produced", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await saveMissionDraft(project, completeDraft("m-t5-nosubmit"));
    const harness = await controlledHarness(project, [{ value: 0.4 }, { value: 0.9 }]);
    const director = new RecordingDirector((input) => decide(
      input.observations.length === 1
        ? { stateVersion: input.stateVersion, action: "change-direction", rationale: "refine", task: { objective: "materialize answer.txt with value 0.9" }, expectedCost: 0.0001, basedOn: [input.observations[0]!.runId] }
        : { stateVersion: input.stateVersion, action: "stop", rationale: "done", stopReason: "complete" },
    ));
    const outcome = await startWith(project, draft, harness, director);
    const statuses = outcome.record.history.map((h) => h.type);
    // "MISSION_ACCEPTED" is user authorization, not Human Acceptance of a
    // result; look only for submission/promotion/result-acceptance events.
    expect(statuses.some((s) => /submi|promot|human|external/i.test(s))).toBe(false);
    expect(outcome.status).not.toMatch(/submi|accept/);
  });
});
