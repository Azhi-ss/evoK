/**
 * CPU unit & Mission-controller integration tests for the Auto-Research Arena
 * (`Auto-Research-Arena/auto-research-arena`, arXiv:2610.35866) adapter.
 *
 * Uses exact task rules and published reference/candidate numbers from the
 * official `params` track (`reference = 50,332,176`, `cand-0002 = 37,749,264`,
 * `cand-0083 = 15,151,312`) without requiring a GPU or external LLM API.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRunOutcome } from "../evidence/run-outcome";
import { discoverEvokResources } from "../evok-resources";
import { recordRetainedState, type MissionDirector } from "../mission/mission-director";
import { startAuthorizedMission } from "../mission/mission-start";
import { inspectStartHardGates } from "../mission/start-hard-gates";
import type { AgentRuntimeResult, PiAgentRuntime } from "../pi-agent-runtime";
import {
  createProjectBaselineEvaluator,
  loadProjectEvaluationContract,
} from "../project-evaluator";
import {
  AUTO_RESEARCH_ARENA_ID,
  autoArenaRankKey,
  checkAutoArenaCandidateSource,
  compareAutoArenaRankKeys,
  computeAutoArenaRelativeImprovement,
  createAutoArenaEvaluator,
  evaluateAutoArenaAdmissibility,
  stageAutoArenaMissionProject,
  validateAutoArenaContext,
  validateAutoArenaTask,
  type AutoArenaCommandRunner,
  type AutoArenaContext,
  type AutoArenaTask,
} from "./auto-research-arena";
import * as competitionPacked from "./index";

const OFFICIAL_PARAMS_TASK: AutoArenaTask = validateAutoArenaTask({
  task_id: "params",
  version: 1,
  title: "Parameter count at validation BPB < 1.05",
  substrate: {
    id: "karpathy-autoresearch-v1",
    mutable: ["train.py"],
    immutable: ["prepare.py", "pyproject.toml", "uv.lock"],
    gpu_work_witness: "Parameter counts:",
    frozen_regions: [
      {
        file: "train.py",
        region: "GPU-work witness after model allocation",
        anchor: "print(\"Parameter counts:\")",
        reason: "Preserve witness.",
      },
      {
        file: "train.py",
        region: "Canonical reporting call and its arguments",
        anchor: "report_efficiency_metrics(",
        reason: "Preserve official reporter.",
      },
      {
        file: "train.py",
        region: "FLOPs probe invocation, inputs and returned value",
        anchor: "flops_per_token_measured = measure_flops_dispatch(",
        reason: "Preserve FLOPs probe.",
      },
    ],
    known_constraints: ["train.py must not read the validation split."],
  },
  launch: {
    train_seconds: 600,
    gpus_per_launch: 1,
    accelerator: "NVIDIA_A100_80GB",
    seed: 42,
    timeout_seconds: 1800,
  },
  budget: {
    max_launches: 100,
    includes_failures: true,
    includes_reference_launch: true,
    charging_rule: "gpu-work-witness",
  },
  metrics: {
    val_bpb: { type: "number", unit: "bits/byte", deterministic: false },
    num_params_total: { type: "integer", unit: "parameters", deterministic: true },
    flops_per_token_measured: { type: "integer", unit: "FLOPs/token", deterministic: true },
    peak_vram_bytes: { type: "integer", unit: "bytes", deterministic: false },
    training_data_tokens_available: { type: "integer", unit: "tokens", deterministic: true },
    total_tokens: { type: "integer", unit: "tokens", deterministic: false },
  },
  objective: {
    comparison_mode: "gated",
    target: { metric: "num_params_total", direction: "minimize" },
    quality_gate: { metric: "val_bpb", operator: "<", value: 1.05 },
    tiebreaks: [{ metric: "total_tokens", direction: "minimize" }],
    constraints: [
      { metric: "flops_per_token_measured", operator: "<=", value: 239078400 },
      { metric: "peak_vram_bytes", operator: "<=", value: 47198976512 },
      { metric: "training_data_tokens_available", operator: "==", value: 631241817 },
    ],
  },
});

const OFFICIAL_REFERENCE_METRICS = {
  val_bpb: 1.0467453604577728,
  num_params_total: 50332176,
  flops_per_token_measured: 239078400,
  peak_vram_bytes: 47198976512,
  training_data_tokens_available: 631241817,
  total_tokens: 394788864,
} as const;

const SEED_TRAIN_PY = [
  "# seed reference train.py",
  "N_LAYER = 12",
  "print(\"Parameter counts:\")",
  "flops_per_token_measured = measure_flops_dispatch(model, batch)",
  "report_efficiency_metrics(model, tokenizer, steps, tps, total_tokens, sec, flops_measured=flops_per_token_measured, harness=None)",
].join("\n");

const REFERENCE_CODE: Readonly<Record<string, string>> = {
  "train.py": SEED_TRAIN_PY,
  "prepare.py": "# immutable prepare.py\n",
  "pyproject.toml": "[project]\nname = \"autoresearch\"\n",
  "uv.lock": "version = 1\n",
};

function makeCandidatePy(tag: string): string {
  return SEED_TRAIN_PY.replace("N_LAYER = 12", `N_LAYER = 8 # ${tag}`);
}

function makeContext(root: string): AutoArenaContext {
  return validateAutoArenaContext({
    version: 5,
    api_version: 1,
    run_dir: join(root, "run"),
    workspace: join(root, "run", "workspace"),
    task_dir: join(root, "task"),
    runner_root: root,
    session_id: "session-evok-test",
    task: OFFICIAL_PARAMS_TASK,
    reference_result: {
      candidate_id: "reference",
      launch_uuid: "ref-uuid-1",
      status: "ok",
      metrics: OFFICIAL_REFERENCE_METRICS,
    },
    evaluate: ["autoarena-runner", "evaluate"],
    experiment_status: ["autoarena-runner", "experiment-status"],
    status: ["autoarena-runner", "status"],
    finish: ["autoarena-runner", "finish"],
  });
}

describe("Auto-Research Arena adapter (`src/competition/auto-research-arena.ts`)", () => {
  test("mirrors official AutoArena admissibility, rank_key, and relative_improvement on published `params` numbers", () => {
    const refVerdict = evaluateAutoArenaAdmissibility(OFFICIAL_PARAMS_TASK, OFFICIAL_REFERENCE_METRICS);
    expect(refVerdict.admissible).toBe(true);
    expect(computeAutoArenaRelativeImprovement(OFFICIAL_PARAMS_TASK, OFFICIAL_REFERENCE_METRICS, OFFICIAL_REFERENCE_METRICS)).toBe(0);

    // Official `sequential-search--params` best (`cand-0083`: 15,151,312 params, rel_improvement = 0.6989736346785405)
    const winnerMetrics = {
      val_bpb: 1.0498872080561927,
      num_params_total: 15151312,
      flops_per_token_measured: 76024832,
      peak_vram_bytes: 18500000000,
      training_data_tokens_available: 631241817,
      total_tokens: 601358336,
    };
    expect(evaluateAutoArenaAdmissibility(OFFICIAL_PARAMS_TASK, winnerMetrics).admissible).toBe(true);
    const rel = computeAutoArenaRelativeImprovement(OFFICIAL_PARAMS_TASK, winnerMetrics, OFFICIAL_REFERENCE_METRICS)!;
    expect(rel).toBeCloseTo(0.6989736346785405, 12);

    const winnerKey = autoArenaRankKey(OFFICIAL_PARAMS_TASK, winnerMetrics)!;
    const refKey = autoArenaRankKey(OFFICIAL_PARAMS_TASK, OFFICIAL_REFERENCE_METRICS)!;
    expect(compareAutoArenaRankKeys(winnerKey, refKey)).toBeLessThan(0);

    // Strict `< 1.05` boundary: `val_bpb = 1.05` is inadmissible
    const boundaryFail = evaluateAutoArenaAdmissibility(OFFICIAL_PARAMS_TASK, {
      ...winnerMetrics,
      val_bpb: 1.05,
    });
    expect(boundaryFail.admissible).toBe(false);
    expect(boundaryFail.clause).toBe("gate:val_bpb");

    // Ceiling breach (`flops_per_token_measured > 239078400`) and zero-target floor
    expect(
      evaluateAutoArenaAdmissibility(OFFICIAL_PARAMS_TASK, { ...winnerMetrics, flops_per_token_measured: 239078401 }).clause,
    ).toBe("ceiling[0]:flops_per_token_measured");
    expect(
      evaluateAutoArenaAdmissibility(OFFICIAL_PARAMS_TASK, { ...winnerMetrics, num_params_total: 0 }).clause,
    ).toBe("validity_floor:num_params_total:non_positive");
  });

  test("rejects tampered immutable files and deleted frozen-region anchors before spending a launch", () => {
    expect(checkAutoArenaCandidateSource(OFFICIAL_PARAMS_TASK, { "train.py": makeCandidatePy("ok") }, REFERENCE_CODE)).toEqual([]);

    const tamperedPrepare = checkAutoArenaCandidateSource(
      OFFICIAL_PARAMS_TASK,
      { "train.py": makeCandidatePy("ok"), "prepare.py": "# hacked evaluator\n" },
      REFERENCE_CODE,
    );
    expect(tamperedPrepare.some((msg) => msg.includes("immutable substrate file prepare.py"))).toBe(true);

    const missingAnchor = checkAutoArenaCandidateSource(
      OFFICIAL_PARAMS_TASK,
      { "train.py": "# dropped report_efficiency_metrics\nprint(\"Parameter counts:\")\n" },
      REFERENCE_CODE,
    );
    expect(missingAnchor.some((msg) => msg.includes("Canonical reporting call"))).toBe(true);
  });

  test("distinguishes operational crash/OOM from scientific quality-gate refutation and reuses reference without extra launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "evok-autoarena-unit-"));
    try {
      const context = makeContext(root);
      const calls: string[][] = [];
      let nextResponse: Record<string, unknown> = { status: "crash", charged: true };
      const runner: AutoArenaCommandRunner = async ({ command }) => {
        calls.push([...command]);
        if (command[1] === "experiment-status") {
          return { exitCode: 0, stdout: JSON.stringify({ status: "not_found" }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify(nextResponse), stderr: "" };
      };

      const evaluator = createAutoArenaEvaluator({
        context,
        task: OFFICIAL_PARAMS_TASK,
        referenceCode: REFERENCE_CODE,
        projectRoot: join(root, "project"),
        commandRunner: runner,
      });

      const dummyCtx = {
        missionId: "autoarena-params",
        runId: "baseline-1",
        snapshotDigest: "d0",
        contract: { objective: "minimize params", expectedOutputs: ["train.py"], evaluationMethod: AUTO_RESEARCH_ARENA_ID, hardRules: [] },
      };

      // 1) Unmodified seed `train.py` reuses reference_result with 0 external calls
      const baselineMeasurement = await evaluator.evaluate({ "train.py": SEED_TRAIN_PY }, dummyCtx);
      expect(calls.length).toBe(0);
      expect(baselineMeasurement.ok).toBe(true);
      expect(baselineMeasurement.score).toBe(0);

      // 2) Operational GPU crash/OOM -> operational failure (`scientificNegativeEvidence === false`)
      nextResponse = { status: "crash", charged: true, launch_seq: 2 };
      const crashed = await evaluator.evaluate({ "train.py": makeCandidatePy("oom") }, { ...dummyCtx, runId: "exp-oom" });
      expect(crashed.ok).toBe(false);
      expect(crashed.score).toBeUndefined();
      expect(classifyRunOutcome(crashed)).toMatchObject({
        state: "operational",
        scientificNegativeEvidence: false,
      });

      // 3) Measured quality-gate breach (`val_bpb = 1.09 >= 1.05`) -> scientific Negative Evidence (`true`)
      nextResponse = {
        status: "ok",
        charged: true,
        launch_seq: 3,
        metrics: { ...OFFICIAL_REFERENCE_METRICS, num_params_total: 12000000, val_bpb: 1.09 },
      };
      const refuted = await evaluator.evaluate({ "train.py": makeCandidatePy("overcompressed") }, { ...dummyCtx, runId: "exp-refuted" });
      expect(refuted.ok).toBe(false);
      expect(classifyRunOutcome(refuted)).toMatchObject({
        state: "negative",
        scientificNegativeEvidence: true,
      });

      // 4) Admissible improvement updates `BEST_CANDIDATE_train.py` and refuses duplicate charged source
      const improvedCode = makeCandidatePy("tie-kv");
      nextResponse = {
        status: "ok",
        charged: true,
        launch_seq: 4,
        metrics: { ...OFFICIAL_REFERENCE_METRICS, num_params_total: 37749264, val_bpb: 1.005669 },
      };
      const improved = await evaluator.evaluate({ "train.py": improvedCode }, { ...dummyCtx, runId: "exp-win" });
      expect(improved.ok).toBe(true);
      expect(improved.score).toBeCloseTo((50332176 - 37749264) / 50332176, 12);
      const savedBest = await readFile(join(root, "project", "BEST_CANDIDATE_train.py"), "utf8");
      expect(savedBest).toBe(improvedCode);

      const duplicate = await evaluator.evaluate({ "train.py": improvedCode }, { ...dummyCtx, runId: "exp-dup" });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.ruleViolations?.[0]).toMatch(/identical source/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stages a start-ready evoK Mission project and drives `startAuthorizedMission` end-to-end", async () => {
    const root = await mkdtemp(join(tmpdir(), "evok-autoarena-e2e-"));
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const taskDir = join(root, "task");
      await mkdir(join(taskDir, "code"), { recursive: true });
      await writeFile(join(taskDir, "task.json"), JSON.stringify(OFFICIAL_PARAMS_TASK, null, 2), "utf8");
      for (const [name, content] of Object.entries(REFERENCE_CODE)) {
        await writeFile(join(taskDir, "code", name), content, "utf8");
      }
      const contextPath = join(root, "context.json");
      const context = makeContext(root);
      await writeFile(contextPath, JSON.stringify(context, null, 2), "utf8");

      const staged = await stageAutoArenaMissionProject({ contextPath, modelBudgetUsd: 10 });
      const contractLoaded = await loadProjectEvaluationContract(staged.projectRoot);
      expect(contractLoaded.kind).toBe("auto-research-arena");

      const gates = await inspectStartHardGates({
        projectRoot: staged.projectRoot,
        missionId: staged.missionId,
        authorization: { requested: true, token: "/start", missionSelector: "displayed" },
        modelProbe: async () => ({ ok: true }),
      });
      expect(gates.ready).toBe(true);
      expect(gates.blocking).toEqual([]);

      // Drive the real evoK Mission controller: baseline (seed reference -> score 0)
      // -> 1 experiment (37,749,264 params -> score +0.25) -> Director stop.
      const candidateV1 = makeCandidatePy("shared-kv-37m");
      let attemptCount = 0;
      const fakeRuntimeFactory = (): PiAgentRuntime => ({
        async execute(req: Parameters<PiAgentRuntime["execute"]>[0]): Promise<AgentRuntimeResult> {
          attemptCount += 1;
          const wsPath = req.workspace!.path;
          const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
          await mk(wsPath, { recursive: true });
          await wf(
            join(wsPath, "train.py"),
            attemptCount === 1 ? SEED_TRAIN_PY : candidateV1,
            "utf8",
          );
          return {
            sessionId: `sess-${attemptCount}`,
            workspace: wsPath,
            events: [],
            ledger: [],
            stopReason: "end_turn",
            text: "materialized train.py",
            model: { provider: "test", model: "test-model", id: "test/test-model" },
            usage: {
              tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
              cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
            },
            receipt: {} as never,
          };
        },
      } as unknown as PiAgentRuntime);

      let decisionCount = 0;
      const director: MissionDirector = {
        id: "test-director",
        async decide(input) {
          decisionCount += 1;
          if (input.observations.length === 1) {
            return {
              sessionId: `dir-sess-${decisionCount}`,
              proposal: {
                stateVersion: input.stateVersion,
                action: "change-direction",
                rationale: "Reduce layers/parameters while staying under val_bpb < 1.05",
                task: {
                  objective: "Test 37.7M parameter architecture in train.py",
                  expectedOutputs: ["train.py"],
                },
                expectedCost: 0.05,
                basedOn: [input.observations[0]!.runId],
              },
              usage: {
                tokens: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, total: 80 },
                cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
              },
            };
          }
          return {
            sessionId: `dir-sess-${decisionCount}`,
            proposal: {
              stateVersion: input.stateVersion,
              action: "stop",
              rationale: "Admissible 25% parameter reduction verified on independent evaluator",
              stopReason: "pilot target reached",
              basedOn: input.observations.map((o) => o.runId),
            },
            usage: {
              tokens: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 },
              cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
            },
          };
        },
      };

      const evaluator = createAutoArenaEvaluator({
        context,
        task: OFFICIAL_PARAMS_TASK,
        referenceCode: REFERENCE_CODE,
        projectRoot: staged.projectRoot,
        commandRunner: async ({ command }) => {
          if (command[1] === "experiment-status") {
            return { exitCode: 0, stdout: JSON.stringify({ status: "not_found" }), stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              status: "ok",
              charged: true,
              launch_seq: 2,
              metrics: { ...OFFICIAL_REFERENCE_METRICS, num_params_total: 37749264, val_bpb: 1.005669 },
            }),
            stderr: "",
          };
        },
      });

      const outcome = await startAuthorizedMission({
        projectRoot: staged.projectRoot,
        missionId: staged.missionId,
        authorization: { requested: true, token: "/start", missionSelector: "displayed" },
        resolver: {
          async resolve() {
            return {
              tier: "default",
              model: { provider: "test", model: "test-model", id: "test/test-model" },
              modelId: {} as never,
            };
          },
          async preflight() {
            return { ok: true as const };
          },
        } as never,
        resources: await discoverEvokResources({ projectRoot: staged.projectRoot }),
        evaluator,
        runtimeFactory: fakeRuntimeFactory,
        director,
        reserveCost: 0.05,
        maxExperiments: 3,
      });

      expect(outcome.status).toBe("director-stopped");
      expect(outcome.experiments.length).toBe(1);
      const retained = recordRetainedState(outcome.record!);
      expect(retained.scoreboard.length).toBe(2);
      expect(retained.currentBest?.kind).toBe("experiment");
      expect(retained.currentBest?.score).toBeCloseTo(0.25, 4);

      // `createProjectBaselineEvaluator` also loads from `.evok/evaluation.json`
      const loadedEvaluator = await createProjectBaselineEvaluator(staged.projectRoot);
      expect(loadedEvaluator.id).toBe(AUTO_RESEARCH_ARENA_ID);
      expect(competitionPacked.createAutoArenaEvaluator).toBe(createAutoArenaEvaluator);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
