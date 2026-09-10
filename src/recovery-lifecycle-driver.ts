/**
 * Separate-process recovery driver for T6 (#114). Spawned as its OWN bun
 * process by tests/integration/mission-resume.test.ts; never imported by the
 * library. It wires a controlled faux model + scripted director to the REAL
 * start/resume operations and interrupts at a durable boundary.
 *
 * Usage:
 *   bun src/recovery-lifecycle-driver.ts <project> <mode> [boundary]
 *     mode=start   run a fresh start; kill/self-abort at `boundary`
 *                  (before-confirmation | after-confirmation | none)
 *     mode=resume  resume the single Mission in the project and continue
 *     mode=list    print the reopen listing as JSON
 *
 * Boundaries are observed from the onPersistedEvent seam (durable events),
 * not fixed timers, so the interruption is deterministic.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEvokModelResolver } from "./evok-model";
import { discoverEvokResources } from "./evok-resources";
import { saveMissionDraft, type MissionDraft } from "./mission-draft";
import {
  resumeAuthorizedMission,
  startAuthorizedMission,
  type BaselineEvaluator,
  type StartAuthorization,
  type ResumeAuthorization,
} from "./mission-start";
import type { DirectorInput, MissionDirector } from "./mission-director";
import { listUnfinishedMissions } from "./mission-resume";

const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };
const MISSION_ID = "m-t6lifecycle";

const evaluator: BaselineEvaluator = {
  id: "lifecycle-file-answer",
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

function priceTokens(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
  return tokens.input * MODEL_COST.input + tokens.output * MODEL_COST.output;
}

function completeDraft(): MissionDraft {
  return {
    schemaVersion: 1,
    id: MISSION_ID,
    status: "draft",
    objective: "raise the measured answer toward 0.9 without cheating",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the lifecycle project" },
    evaluation: { method: "lifecycle-file-answer", metric: "answer in [0,1]" },
    constraints: {
      permissions: ["isolated-workspace-write", "read-project", "local-shell-in-workspace"],
      hardRules: ["no external submission"],
    },
    budget: { total: 2, units: "model-USD", note: "lifecycle demo envelope" },
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
  };
}

/**
 * Scripted candidate responses. Each candidate Run writes the next value in
 * `values` then gives a final turn; a Run whose value is null writes nothing.
 */
async function buildResolver(project: string, values: readonly (number | null)[]) {
  const providerName = `evok-t6-lifecycle-${Math.random().toString(36).slice(2, 8)}`;
  const faux = fauxProvider({ provider: providerName, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 400 });
  faux.setResponses(
    values.flatMap((value) =>
      value === null
        ? [fauxAssistantMessage("I considered it but produced no artifact")]
        : [
            fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: `${value}\n` }), { stopReason: "toolUse" }),
            fauxAssistantMessage(`experiment materialized answer.txt = ${value}`),
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
  return { resolver, resources };
}

/**
 * Push to 0.9 after baseline. The SECOND decision (after the follow-up is
 * confirmed) normally stops; when an interrupt controller is supplied it is
 * the "interrupt after confirmation" boundary — the decision call itself is
 * cancelled after the confirmed Experiment is durable.
 */
function scriptedDirector(interruptSecondDecision?: AbortController): MissionDirector {
  return {
    id: "lifecycle-scripted-director",
    async decide(input: DirectorInput) {
      const last = input.observations[input.observations.length - 1]!;
      if (input.observations.length >= 2 && last.ok) {
        if (interruptSecondDecision && !interruptSecondDecision.signal.aborted) {
          const c = interruptSecondDecision;
          setTimeout(() => c.abort(new Error("lifecycle interrupt after confirmation")), 1);
          await new Promise((resolve) => setTimeout(resolve, 30));
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        return {
          proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "lifecycle demo gathered two observations", stopReason: "lifecycle demo complete" },
          sessionId: `director-${Math.random().toString(36).slice(2)}`,
          usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      }
      return {
        proposal: {
          stateVersion: input.stateVersion,
          action: last.ok ? "change-direction" : "retry",
          rationale: last.ok ? `baseline measured ${last.score}; push toward the 0.9 target` : "the last attempt failed; retry the materialization",
          task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
          expectedCost: 0.001,
          basedOn: [last.runId],
        },
        sessionId: `director-${Math.random().toString(36).slice(2)}`,
        usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    },
  };
}

async function main(): Promise<void> {
  const [project, mode, boundary] = process.argv.slice(2);
  if (!project || !mode) {
    console.error("usage: recovery-lifecycle-driver.ts <project> <start|resume|list> [boundary]");
    process.exitCode = 2;
    return;
  }
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, ".evok"), { recursive: true });
  await writeFile(join(project, "README.md"), "# t6 lifecycle research project");
  await writeFile(join(project, ".evok", "evaluation.json"), JSON.stringify({
    id: "lifecycle-file-answer", version: "1", artifact: "answer.txt", metric: "answer", min: 0, max: 1,
  }));
  await saveMissionDraft(project, completeDraft());

  if (mode === "list") {
    const view = await listUnfinishedMissions(project);
    console.log(JSON.stringify(view));
    return;
  }

  if (mode === "start") {
    // baseline 0.4, experiment 0.9; the interruption decides whether the
    // experiment's confirmation is ever observed.
    const { resolver, resources } = await buildResolver(project, [0.4, 0.9]);
    const startAuth: StartAuthorization = { requested: true, token: "/start", missionSelector: "displayed" };
    // Interrupt after the experiment intent is durably persisted but BEFORE
    // its snapshot/measurement confirmation; or AFTER the experiment is
    // confirmed (then self-stop so the resume has confirmed work to reuse).
    let experimentIntentSeen = false;
    let experimentConfirmed = false;
    const controller = new AbortController();
    const onPersistedEvent = (event: { type: string; detail?: Readonly<Record<string, unknown>> }) => {
      const detail = event.detail ?? {};
      if (event.type === "EXECUTION_INTENT_PERSISTED" && typeof detail.runId === "string" && detail.runId.includes(":exp:")) {
        experimentIntentSeen = true;
        if (boundary === "before-confirmation") {
          // Give the Run a brief moment to be genuinely in flight, then abort.
          setTimeout(() => controller.abort(new Error("lifecycle interrupt before confirmation")), 25);
        }
      }
      if (event.type === "EVALUATION_MEASURED" && typeof detail.runId === "string" && detail.runId.includes(":exp:")) {
        experimentConfirmed = true;
      }
    };
    try {
      const outcome = await startAuthorizedMission({
        projectRoot: project,
        missionId: MISSION_ID,
        authorization: startAuth,
        resolver,
        resources,
        evaluator,
        budgetUnits: "model-USD",
        reserveCost: 0.0001,
        priceModelCost: () => priceTokens,
        director: scriptedDirector(boundary === "after-confirmation" ? controller : undefined),
        maxExperiments: 3,
        signal: controller.signal,
        onPersistedEvent,
      });
      console.log(JSON.stringify({ ok: true, status: outcome.status, runId: outcome.runId, experimentIntentSeen, experimentConfirmed }));
    } catch (error) {
      const aborted = (error as Error).name === "AbortError" || controller.signal.aborted;
      console.log(JSON.stringify({ ok: false, aborted, error: (error as Error).message, experimentIntentSeen, experimentConfirmed }));
      if (!aborted) process.exitCode = 1;
      else process.exitCode = 130;
    }
    return;
  }

  if (mode === "resume") {
    // Resumes only continue; the next director decision (3rd observation) is
    // a stop. One experiment Run may be dispatched if reconciliation left an
    // unconfirmed intent (retry is a FRESH run), so supply one fresh value.
    const { resolver, resources } = await buildResolver(project, [0.9]);
    const resumeAuth: ResumeAuthorization = { requested: true, token: `/resume ${MISSION_ID}`, missionSelector: "displayed" };
    try {
      const outcome = await resumeAuthorizedMission({
        projectRoot: project,
        missionId: MISSION_ID,
        authorization: resumeAuth,
        resolver,
        resources,
        evaluator,
        budgetUnits: "model-USD",
        reserveCost: 0.0001,
        priceModelCost: () => priceTokens,
        director: scriptedDirector(),
        maxExperiments: 3,
      });
      console.log(JSON.stringify({
        ok: true,
        status: outcome.status,
        adopted: outcome.reconciliation.adoptedRunIds,
        remeasured: outcome.reconciliation.remeasuredRunIds,
        abandoned: outcome.reconciliation.abandonedIntents.map((a) => a.runId),
        experiments: outcome.record.experiments?.map((e) => ({ runId: e.runId, ok: e.ok, score: e.evaluation?.score })),
        budget: outcome.record.budget,
      }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: (error as Error).message }));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`unknown mode: ${mode}`);
  process.exitCode = 2;
}

void main();
