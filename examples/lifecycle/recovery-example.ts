/**
 * Small runnable local lifecycle example for evoK T6 (#114, AC7).
 *
 * One script, no paid model calls, no network: it drives the REAL evoK
 * operations end to end with a deterministic FAUX model so the whole lifecycle
 * is reproducible offline:
 *
 *   1. skill/reference reading — the intake Run reads the project's
 *      MISSION.md reference through the real read tool;
 *   2. natural-language intake — the model saves a reviewable Mission draft
 *      via the trusted evok_record_draft tool (it cannot start work itself);
 *   3. explicit start — "/start" (NL shortcut) authorizes ONE bounded start;
 *   4. real baseline execution — the candidate Run writes answer.txt in an
 *      isolated workspace;
 *   5. evidence-dependent follow-up — the read-only Mission Director reacts
 *      to the REAL independent measurement and proposes the next Experiment;
 *   6. persistence — every result/usage/decision is durable under
 *      <project>/.evok/missions/<id>/;
 *   7. stop/reopen — the process is interrupted after the baseline is
 *      confirmed, `--reopen` lists the unfinished Mission with progress, stop
 *      reason, and remaining budget;
 *   8. continue — an explicit "/resume" reconstructs from durable records
 *      (no intake repeat, no budget restore), reuses the confirmed baseline,
 *      and continues without per-iteration prompts.
 *
 * The evaluator is a REPRODUCIBLE INDEPENDENT evaluator: it parses the frozen
 * snapshot's answer.txt itself. The model never supplies a score; a planted
 * score file is ignored (there is no score input in the contract).
 *
 * Run:
 *   bun run examples/lifecycle/recovery-example.ts [<project-dir>]
 *   bun run examples/lifecycle/recovery-example.ts <project-dir> --reopen
 *
 * With no <project-dir> a fresh temp project is used for the full lifecycle.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEvokModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";
import { runIntakeTurn } from "../../src/mission-intake";
import {
  resumeAuthorizedMission,
  startAuthorizedMission,
  type BaselineEvaluator,
} from "../../src/mission-start";
import { listUnfinishedMissions } from "../../src/mission-resume";
import type { DirectorInput, MissionDirector } from "../../src/mission-director";
import type { SessionModelResolver } from "../../src/evok-model";

const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };
const EVAL_ID = "example-independent-answer";

const evaluator: BaselineEvaluator = {
  id: EVAL_ID,
  version: "1",
  async evaluate(snapshot) {
    // Independent measurement: parse the immutable snapshot, never the model.
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing from the snapshot"] };
    const value = Number(raw.split(/\r?\n/, 1)[0]?.trim());
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, ruleViolations: ["answer.txt first line must be a finite number in [0,1]"] };
    }
    return { ok: true, score: value, facts: [{ name: "answer", value, source: "answer.txt" }] };
  },
};

async function seedProject(project: string): Promise<string> {
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, ".evok"), { recursive: true });
  // The research reference the intake Run is expected to actually read.
  await writeFile(
    join(project, "MISSION.md"),
    "# Example research reference\n\n"
      + "Goal: raise the independent `answer` metric toward 0.9 without writing a score.\n"
      + "Artifact: answer.txt with one number in [0,1] on its first line.\n"
      + "Only the evaluator measures the result; candidates must not self-report a score.\n",
  );
  await writeFile(
    join(project, ".evok", "evaluation.json"),
    JSON.stringify({ id: EVAL_ID, version: "1", artifact: "answer.txt", metric: "answer", min: 0, max: 1 }, null, 2),
  );
  await writeFile(project.endsWith("/") ? project + "README.md" : join(project, "README.md"), "# lifecycle example project");
  return project;
}

/** Register a faux provider that serves a cursor of scripted responses. */
async function fauxResolver(project: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const name = `evok-example-${Math.random().toString(36).slice(2, 8)}`;
  const faux = fauxProvider({ provider: name, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 400 });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${name}/deterministic`;
  const resolver: SessionModelResolver = await createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel(r: string) { return r === ref ? { provider: name, model: "deterministic", id: ref } : undefined; },
      defaultModel() { return { provider: name, model: "deterministic", id: ref }; },
    },
  });
  const resources = await discoverEvokResources({ projectRoot: project });
  return { resolver, resources };
}

const price = (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) =>
  tokens.input * MODEL_COST.input + tokens.output * MODEL_COST.output;

function log(header: string, body: string): void {
  console.log(`\n── ${header} ${"─".repeat(Math.max(0, 64 - header.length))}`);
  console.log(body.trim());
}

async function intake(project: string): Promise<{ id: string }> {
  // The intake Run first READS the project reference (real read tool), then
  // calls the trusted draft tool with every settled field.
  const responses = [
    fauxAssistantMessage(fauxToolCall("read", { path: join(project, "MISSION.md") }), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("evok_record_draft", {
        objective: "raise the measured answer toward 0.9 without cheating",
        successCriteria: ["a real answer.txt artifact measured by the independent evaluator"],
        data: { description: "local synthetic data shipped with the example project" },
        evaluation: { method: EVAL_ID, metric: "answer in [0,1]" },
        constraints: {
          permissions: ["read-project", "isolated-workspace-write"],
          hardRules: ["no network", "no external submission", "never self-report a score"],
        },
        budget: { total: 2, units: "model-USD", note: "offline reproducible example" },
        outputs: ["answer.txt"],
        stopConditions: ["budget exhausted", "user interruption"],
        plan: {
          baselineHypothesis: "a deterministic file-producing baseline is independently measurable",
          tasks: [{ taskId: "baseline", objective: "materialize answer.txt with value 0.4" }],
        },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I reviewed MISSION.md and saved a reviewable Mission draft; nothing was started."),
  ];
  const { resolver, resources } = await fauxResolver(project, responses);
  const result = await runIntakeTurn({
    resolver,
    resources,
    projectRoot: project,
    message: "I want to beat the answer metric on this project",
    workspaceRoot: join(tmpdir(), `evok-example-intake-${Date.now()}`),
    tools: {},
  });
  if (!result.draft) throw new Error("intake did not save a draft");
  log("intake (natural language → reviewable draft, nothing dispatched)", [
    `mission id: ${result.draft.id}`,
    `read the project reference and saved .evok/missions/${result.draft.id}/draft.json`,
    `objective: ${result.draft.objective}`,
    `budget: ${result.draft.budget.total} ${result.draft.budget.units} · outputs: ${result.draft.outputs.join(",")}`,
  ].join("\n"));
  return { id: result.draft.id };
}

/** Evidence-driven director: proposes toward 0.9 until evidence is conclusive. */
function director(): MissionDirector {
  return {
    id: "example-director",
    async decide(input: DirectorInput) {
      const last = input.observations[input.observations.length - 1]!;
      const stop = {
        proposal: { stateVersion: input.stateVersion, action: "stop" as const, rationale: "two measured observations gathered for the example", stopReason: "example complete" },
        sessionId: `director-${Math.random().toString(36).slice(2)}`,
        usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (input.observations.length >= 2) return stop;
      return {
        proposal: {
          stateVersion: input.stateVersion,
          action: "change-direction",
          rationale: `the independent evaluator measured ${last.score ?? "a rule failure"}; change approach toward the 0.9 target`,
          task: { objective: "materialize answer.txt with value 0.9 using a changed approach", expectedOutputs: ["answer.txt"] },
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
  const argv = process.argv.slice(2);
  const reopen = argv.includes("--reopen");
  const given = argv.find((a) => !a.startsWith("--"));
  const project = given ?? await mkdtemp(join(tmpdir(), "evok-example-project-"));
  await seedProject(project);

  if (reopen) {
    const view = await listUnfinishedMissions(project);
    log("reopen: unfinished Missions (nothing is resumed by listing)",
      view.missions.map((m) =>
        `${m.id} · ${m.status} · ${m.resumable ? "resumable" : "not resumable"}\n`
        + `  progress: baseline ${m.hasBaseline ? "measured" : "not measured"} · ${m.experiments} experiment(s) · ${m.negativeEvidence} negative evidence\n`
        + `  budget: ${m.consumedBudget.toFixed(6)} / ${m.totalBudget} ${m.units} consumed · ${m.remainingBudget.toFixed(6)} remaining\n`
        + `  stop/blocker: ${m.stopReason ?? "(none)"}`).join("\n") || "(no Missions)");
    return;
  }

  // ── 1–2 intake ──────────────────────────────────────────────────────────
  const { id } = await intake(project);

  // ── 3–5 explicit start → real baseline → evidence follow-up, interrupted
  // AFTER the baseline is confirmed (a separate stop before the follow-up).
  const startResponses = [
    fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "0.4\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("baseline materialized answer.txt = 0.4"),
    // follow-up candidate Run (used after resume when the loop continues)
    fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "0.9\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("changed approach produced answer.txt = 0.9"),
  ];
  const { resolver, resources } = await fauxResolver(project, startResponses);
  // Stop the controller right after the baseline measurement: the abort lands
  // on the next decision, producing a durable "interrupted" Mission with a
  // confirmed baseline — the realistic stop/reopen point.
  const controller = new AbortController();
  let interrupted = false;
  const start = await startAuthorizedMission({
    projectRoot: project,
    missionId: id,
    authorization: { requested: true, token: "/start", missionSelector: "displayed" },
    resolver, resources, evaluator,
    budgetUnits: "model-USD", reserveCost: 0.0001, priceModelCost: () => price,
    director: {
      id: "example-director-stop",
      async decide(input: DirectorInput) {
        if (input.observations.length >= 1 && !interrupted) {
          interrupted = true;
          setTimeout(() => controller.abort(new Error("operator stop after baseline confirmation")), 1);
          await new Promise((r) => setTimeout(r, 30));
          const error = new Error("aborted"); error.name = "AbortError"; throw error;
        }
        return director().decide(input);
      },
    },
    maxExperiments: 3,
    signal: controller.signal,
  }).catch((error: unknown) => {
    if ((error as Error).name !== "AbortError") throw error;
    return undefined;
  });
  log("start → real baseline → stop after confirmation (durable interruption)",
    start
      ? `completed without interruption: ${start.status}`
      : "baseline measured and persisted; the follow-up decision was cancelled by the operator stop");

  // ── 7 reopen ─────────────────────────────────────────────────────────────
  const view = await listUnfinishedMissions(project);
  const m = view.missions.find((x) => x.id === id)!;
  log("reopen lists progress, stop reason, and REMAINING budget (no resume yet)", [
    `${m.id} · ${m.status} · resumable=${m.resumable}`,
    `baseline measured=${m.hasBaseline} · experiments=${m.experiments} · negative evidence=${m.negativeEvidence}`,
    `budget ${m.consumedBudget.toFixed(6)} / ${m.totalBudget} ${m.units} consumed · ${m.remainingBudget.toFixed(6)} remaining`,
    `stop: ${m.stopReason}`,
  ].join("\n"));

  // ── 8 explicit resume: reconstruct from durable records and continue ─────
  const resumeResponses = [
    fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "0.9\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("resumed continuation produced answer.txt = 0.9"),
  ];
  const resumed = await fauxResolver(project, resumeResponses);
  const outcome = await resumeAuthorizedMission({
    projectRoot: project,
    missionId: id,
    authorization: { requested: true, token: `/resume ${id}`, missionSelector: "displayed" },
    resolver: resumed.resolver, resources: resumed.resources, evaluator,
    budgetUnits: "model-USD", reserveCost: 0.0001, priceModelCost: () => price,
    director: director(), maxExperiments: 3,
  });
  log("resume: adopted confirmed baseline, no intake repeat, continued with remaining budget", [
    `adopted: ${outcome.reconciliation.adoptedRunIds.join(", ") || "(none)"}`,
    `re-measured from snapshots: ${outcome.reconciliation.remeasuredRunIds.join(", ") || "(none)"}`,
    `abandoned unconfirmed intents: ${outcome.reconciliation.abandonedIntents.map((a) => a.runId).join(", ") || "(none)"}`,
    `experiments: ${outcome.experiments.map((e) => `${e.runId}=${e.evaluation?.score ?? (e.ok ? "ok" : "negative")}`).join(", ")}`,
    `final status: ${outcome.status} · budget remaining: ${outcome.budget.remaining.toFixed(6)} ${outcome.budget.units}`,
    `durable state: ${join(project, ".evok", "missions", id, "mission.json")}`,
  ].join("\n"));
}

void main().catch((error: unknown) => {
  console.error("example failed:", (error as Error).message);
  process.exitCode = 1;
});
