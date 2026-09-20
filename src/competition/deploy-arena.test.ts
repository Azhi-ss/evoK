/**
 * ET-DEPLOY-ORCH / #182 — DeployArena thick orchestration.
 *
 * Seams: runDeployArenaGraph / aggregateDeployArenaMetrics /
 * assembleDeployArenaSubmission / createPlaygroundContestSubmitSeam.
 *
 * Confirmed by the approved unfreeze wave + DeployArena control seam:
 * task/service graph, multi-machine / multi-GPU workers, local metric
 * aggregation, COI into contest-arm auto-submit. Not a commercial OS.
 * Not a second control plane. Gate predicates are not loosened.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_GATE_THRESHOLD,
  DEPLOY_ARENA_COMPETITION_ID,
  DEPLOY_ARENA_SMOKE_GRAPH,
  aggregateDeployArenaMetrics,
  assembleDeployArenaSubmission,
  createPlaygroundContestSubmitSeam,
  playgroundSubmitArgv,
  playgroundTaskDownloadArgv,
  runDeployArenaGraph,
} from "./deploy-arena";

describe("DeployArena multi-worker task graph", () => {
  test("smoke path runs capability tasks on two machine/GPU workers", async () => {
    const result = await runDeployArenaGraph({
      graph: DEPLOY_ARENA_SMOKE_GRAPH,
    });

    expect(result.ok).toBe(true);
    expect(result.workers.map((worker) => ({
      id: worker.id,
      machine: worker.machine,
      gpu: worker.gpu,
    }))).toEqual([
      { id: "w0", machine: "host-a", gpu: "cuda:0" },
      { id: "w1", machine: "host-b", gpu: "cuda:1" },
    ]);
    expect(new Set(result.observations.map((row) => row.workerId))).toEqual(new Set(["w0", "w1"]));
    expect(result.observations.filter((row) => row.subject === "aime26")).toHaveLength(2);
    expect(result.observations.filter((row) => row.subject === "gpqa-diamond")).toHaveLength(2);
    expect(result.tasks.every((task) => task.status === "completed")).toBe(true);
  });

  test("unknown worker or cyclic graph fails closed", async () => {
    await expect(runDeployArenaGraph({
      graph: {
        workers: [{ id: "w0", machine: "host-a", gpu: "cuda:0" }],
        tasks: [
          { id: "aime", kind: "capability", workerId: "missing", subject: "aime26", service: "capability" },
        ],
      },
    })).rejects.toThrow(/unknown worker/i);

    await expect(runDeployArenaGraph({
      graph: {
        workers: [{ id: "w0", machine: "host-a", gpu: "cuda:0" }],
        tasks: [
          { id: "a", kind: "capability", workerId: "w0", subject: "aime26", dependsOn: ["b"] },
          { id: "b", kind: "capability", workerId: "w0", subject: "gpqa-diamond", dependsOn: ["a"] },
        ],
      },
    })).rejects.toThrow(/cycle/i);
  });
});

describe("DeployArena local metric aggregation", () => {
  test("aggregates capability scores across workers and applies the 95 gate", () => {
    const aggregation = aggregateDeployArenaMetrics([
      { taskId: "aime-w0", workerId: "w0", subject: "aime26", score: 96, samples: 10 },
      { taskId: "aime-w1", workerId: "w1", subject: "aime26", score: 98, samples: 10 },
      { taskId: "gpqa-w0", workerId: "w0", subject: "gpqa-diamond", score: 97, samples: 8 },
      { taskId: "gpqa-w1", workerId: "w1", subject: "gpqa-diamond", score: 95, samples: 8 },
    ]);

    expect(CAPABILITY_GATE_THRESHOLD).toBe(95);
    expect(aggregation.subjects).toEqual([
      { subject: "aime26", mean: 97, min: 96, max: 98, workers: 2, samples: 20 },
      { subject: "gpqa-diamond", mean: 96, min: 95, max: 97, workers: 2, samples: 16 },
    ]);
    expect(aggregation.capability).toEqual({
      aime26: 97,
      gpqaDiamond: 96,
      passed: true,
      threshold: 95,
    });
  });

  test("capability gate fails closed when either subject is not above 95", () => {
    const aggregation = aggregateDeployArenaMetrics([
      { taskId: "aime-w0", workerId: "w0", subject: "aime26", score: 96, samples: 4 },
      { taskId: "gpqa-w0", workerId: "w0", subject: "gpqa-diamond", score: 95, samples: 4 },
    ]);
    expect(aggregation.capability.passed).toBe(false);
    expect(aggregation.capability.aime26).toBe(96);
    expect(aggregation.capability.gpqaDiamond).toBe(95);
  });
});

describe("DeployArena COI submission.json", () => {
  test("assembles image/command/env and refuses a missing image", () => {
    expect(assembleDeployArenaSubmission({
      image: "registry.example/serving:v1",
      command: "python -m serve",
      env: { CONCURRENCY: "8" },
    })).toEqual({
      image: "registry.example/serving:v1",
      command: "python -m serve",
      env: { CONCURRENCY: "8" },
    });
    expect(() => assembleDeployArenaSubmission({
      image: "   ",
      command: "python -m serve",
    })).toThrow(/image/i);
  });

  test("documents Bohrium playground download/submit argv for the user env", () => {
    expect(playgroundTaskDownloadArgv({
      challengeId: "llm-challenge-arena-v1",
      outDir: "/tmp/deploy-arena-brief",
    })).toEqual([
      "playground", "task", "download",
      "--challenge-id", "llm-challenge-arena-v1",
      "--out", "/tmp/deploy-arena-brief",
    ]);
    expect(playgroundSubmitArgv({
      challengeId: "llm-challenge-arena-v1",
      outputsDir: "/tmp/deploy-arena-out",
      trace: "/tmp/deploy-arena.trace",
    })).toEqual([
      "playground", "submit",
      "--challenge-id", "llm-challenge-arena-v1",
      "--outputs", "/tmp/deploy-arena-out",
      "--trace", "/tmp/deploy-arena.trace",
    ]);
  });

  test("playground live submit fails closed without credentials", async () => {
    const calls: string[][] = [];
    const seam = createPlaygroundContestSubmitSeam({
      challengeId: "llm-challenge-arena-v1",
      outputsDir: "/tmp/deploy-arena-out",
      trace: "/tmp/deploy-arena.trace",
      credentials: { playground: false, bohr: false },
      exec: async (argv) => {
        calls.push([...argv]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const result = await seam({
      live: true,
      decision: {
        ok: true,
        submitted: false,
        outcome: "refused",
        reason: "gates-green",
        gates: [],
        refusedGates: [],
      },
    });
    expect(result.status).toBe("FAILED");
    expect(result.response).toMatchObject({ reason: "credentials-missing" });
    expect(calls).toEqual([]);
  });
});
