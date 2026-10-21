import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli";
import { DEV_TASK, HELD_OUT_TASKS, OPT_MODEL, runOptLoop, stubOptRoles, type OptRoles } from "./opt-loop";
import { tokenCap, writeRunArtifacts, type OptExecutor, type OptRunRequest, type RunArtifactTiming } from "./opt-executor";

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "opt-loop-"));
}

function timing(request: OptRunRequest, reward: number, tokens = 100): RunArtifactTiming {
  const base = 1_700_000_000;
  const ewi = request.task.id === "i014" && request.arm === "candidate" && request.seed === 1 && request.runDir.includes("/round1/");
  return {
    reward,
    tokens,
    wallS: ewi ? 5409 : 30,
    timedOut: ewi,
    tWrite: base,
    tEnd: base + (ewi ? 5386.8 : 0.5),
    assistantTs: ewi ? [base + 178.1] : [],
  };
}

function fakeExecutor(): { readonly calls: OptRunRequest[]; readonly executor: OptExecutor } {
  const calls: OptRunRequest[] = [];
  return {
    calls,
    executor: {
      name: "fake",
      async run(request) {
        calls.push(request);
        const reward = request.seed === 2 && request.runDir.includes("/round1/") ? 0 : 1;
        const script = timing(request, reward);
        writeRunArtifacts(request, script);
        return {
          reward,
          scoreStatus: "scored" as const,
          tokens: script.tokens,
          wallS: script.wallS,
          timedOut: script.timedOut,
          tracePath: join(request.runDir, "trace.jsonl"),
          outputsDir: join(request.runDir, "outputs"),
          batchLogPath: join(request.runDir, "batch.log"),
        };
      },
    },
  };
}

function rejectingRoles(): OptRoles & { readonly reviews: number } {
  const roles = stubOptRoles();
  let reviews = 0;
  return {
    gap: (input) => roles.gap(input),
    innovate: (input) => roles.innovate(input),
    review: async (input) => {
      reviews += 1;
      return { session: { jsonl: `{"type":"session","role":"reviewer-gate"}\n{"type":"message","text":"still idle"}\n` }, accept: false, reason: "still idle" };
    },
    get reviews() { return reviews; },
  };
}

describe("optimization loop", () => {
  test("one round persists sessions, the patch, and a marker the next run actually loaded", async () => {
    const out = outDir();
    const fake = fakeExecutor();
    const roles = rejectingRoles();
    const result = await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      roles,
      executor: fake.executor,
    });
    expect(result.model).toBe(OPT_MODEL);
    expect(result.ewiThresholdSec).toBe(600);
    expect(result.skippedFinal).toBe(true);
    expect(fake.calls.map((call) => `${call.task.id}:${call.seed}:${call.model}`)).toEqual([
      "i014:0:deepseek-v4-1-flash-261017",
      "i014:1:deepseek-v4-1-flash-261017",
      "i014:2:deepseek-v4-1-flash-261017",
    ]);
    expect(roles.reviews).toBe(1);

    const manifest = JSON.parse(readFileSync(join(out, "round1/sessions/manifest.json"), "utf8")) as {
      sessions: { role: string; file: string; sha256: string }[];
    };
    expect(manifest.sessions.map((item) => item.role)).toEqual(["gap-finder", "innovator", "reviewer-gate"]);
    for (const item of manifest.sessions) {
      const bytes = readFileSync(join(out, item.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
    }
    expect(readFileSync(join(out, "round1/sessions/gap-finder.jsonl"), "utf8")).toContain("baseline/i014/seed0/trace.jsonl:1");

    const diff = readFileSync(join(out, "round1/patch.diff"), "utf8");
    expect(diff).toContain('"maxSteps": 25');
    expect(diff).toContain('"maxSteps": 24');
    const patchHash = createHash("sha256").update(readFileSync(join(out, "round1/patch.diff"))).digest("hex");
    const activation = JSON.parse(readFileSync(join(out, "round1/activation.json"), "utf8")) as {
      patchHash: string;
      marker: string;
      differsFromControl: boolean;
      patchActive: boolean;
      runs: { seed: number; tracePath: string; active: boolean }[];
    };
    expect(activation.patchHash).toBe(patchHash);
    expect(activation.marker).toBe(`harness-opt-patch:${patchHash}`);
    expect(activation.differsFromControl).toBe(true);
    expect(activation.patchActive).toBe(true);
    for (const run of activation.runs) {
      const line = readFileSync(run.tracePath, "utf8").split("\n")[0] ?? "";
      const start = JSON.parse(line) as { systemPrompt?: string; candidateConfigHash?: string };
      expect(start.systemPrompt).toContain(activation.marker);
      expect(run.active).toBe(true);
    }

    const metrics = JSON.parse(readFileSync(join(out, "round1/metrics.json"), "utf8")) as {
      ewiThresholdSec: number;
      runs: { seed: number; reward: number | null; ewi: boolean }[];
      ewiRuns: { seed: number; reward: number | null }[];
      rewardMean: number;
      withoutEwi: { count: number; rewardMean: number };
    };
    expect(metrics.ewiThresholdSec).toBe(600);
    expect(metrics.ewiRuns.map((run) => run.seed)).toEqual([1]);
    expect(metrics.ewiRuns[0]?.reward).toBe(1);
    expect(metrics.runs.map((run) => run.reward)).toEqual([1, 1, 0]);
    expect(metrics.rewardMean).toBeCloseTo(2 / 3);
    expect(metrics.withoutEwi).toEqual({ count: 2, rewardMean: 0.5, timedOut: 0 });
    expect(readFileSync(join(out, "round1/run-notes.md"), "utf8")).toContain(`patchSha: ${patchHash}`);
    const reviewInput = readFileSync(join(out, "round1/review-input.json"), "utf8");
    expect(reviewInput).not.toContain("i030");
    expect(reviewInput).not.toContain("hb003");
    expect(reviewInput).not.toContain("held-out");
  });

  test("the next gap input receives the reviewer reason, and a repeated summary is not run", async () => {
    const out = outDir();
    const fake = fakeExecutor();
    let innovateCalls = 0;
    const roles: OptRoles = {
      gap: (input) => stubOptRoles().gap(input),
      async innovate(input) {
        innovateCalls += 1;
        if (input.round > 1) {
          return {
            session: { jsonl: `{"type":"session","role":"innovator"}\n{"type":"message","text":"same"}\n` },
            summary: "agent-loop.maxSteps=24",
            parts: { "agent-loop": { maxSteps: 24 } },
          };
        }
        return stubOptRoles().innovate(input);
      },
      review: async () => ({
        session: { jsonl: `{"type":"session","role":"reviewer-gate"}\n{"type":"message","text":"still idle"}\n` },
        accept: false,
        reason: "still idle",
      }),
    };
    await runOptLoop({ out, mode: "dry-run", rounds: 2, roles, executor: fake.executor });
    const gapInput = JSON.parse(readFileSync(join(out, "round2/gap-input.json"), "utf8")) as {
      previousReview: { reason: string };
    };
    expect(gapInput.previousReview.reason).toBe("still idle");
    const closure = JSON.parse(readFileSync(join(out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean; closed: boolean };
    expect(closure.reviewFedForward).toBe(true);
    expect(closure.closed).toBe(true);
    expect(innovateCalls).toBe(2);
    expect(fake.calls).toHaveLength(3);
    expect(existsSync(join(out, "round2/sessions/reviewer-gate.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "round2/sessions/reviewer-gate.jsonl"), "utf8")).toContain("duplicate summary");
    expect(existsSync(join(out, "final/order.json"))).toBe(false);
  });

  test("three rejected rounds skip the final block and held-out", async () => {
    const out = outDir();
    const fake = fakeExecutor();
    const result = await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 3,
      roles: rejectingRoles(),
      executor: fake.executor,
    });
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls.every((call) => call.task.id === "i014")).toBe(true);
  });

  test("the last accepted candidate is rerun alternating with control, then held out", async () => {
    const out = outDir();
    const fake = fakeExecutor();
    const result = await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 3,
      roles: stubOptRoles(),
      executor: fake.executor,
    });
    expect(result.accepted?.round).toBe(1);
    expect(result.finalBlock?.order).toEqual(["C0", "X0", "C1", "X1", "C2", "X2"]);
    expect(JSON.parse(readFileSync(join(out, "final/order.json"), "utf8"))).toEqual({ order: ["C0", "X0", "C1", "X1", "C2", "X2"] });
    const dev = fake.calls.slice(0, 9);
    expect(dev.every((call) => call.arm === "candidate" && call.task.id === DEV_TASK.id)).toBe(true);
    const finalCalls = fake.calls.slice(9, 15);
    expect(finalCalls.map((call) => `${call.arm === "control" ? "C" : "X"}${call.seed}`)).toEqual(["C0", "X0", "C1", "X1", "C2", "X2"]);
    const marker = result.accepted?.marker ?? "";
    expect(finalCalls.filter((call) => call.arm === "candidate").every((call) => call.marker === marker)).toBe(true);
    expect(finalCalls.filter((call) => call.arm === "control").every((call) => call.marker === "")).toBe(true);
    const held = fake.calls.slice(15);
    expect(held.map((call) => `${call.task.id}:${call.seed}:${call.task.network}`)).toEqual(
      HELD_OUT_TASKS.flatMap((task) => [0, 1, 2].map((seed) => `${task.id}:${seed}:${task.network}`)),
    );
    expect(held.filter((call) => call.task.id === "002").every((call) => call.task.network === "gateway-only")).toBe(true);
    expect(result.heldOut).toEqual({ calls: 9, gatewayOnly: ["002"] });
    const heldOutFile = JSON.parse(readFileSync(join(out, "heldout/metrics.json"), "utf8")) as { comparison: string };
    expect(heldOutFile.comparison).toBe("control-not-run");
    const controlTrace = readFileSync(finalCalls[0]?.runDir + "/trace.jsonl", "utf8");
    const candidateTrace = readFileSync(finalCalls[1]?.runDir + "/trace.jsonl", "utf8");
    expect(candidateTrace).toContain(marker);
    expect(controlTrace).not.toContain(marker);
  });

  test("a run past 6×W is unscored and stays out of the reward mean", async () => {
    const out = outDir();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "fake",
      async run(request) {
        calls.push(request);
        const over = request.seed === 0;
        const script = timing(request, 1, over ? tokenCap(DEV_TASK) + 1 : 10);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] });
        return {
          reward: 1,
          scoreStatus: "scored" as const,
          tokens: over ? tokenCap(DEV_TASK) + 1 : 10,
          wallS: 10,
          timedOut: false,
          tracePath: join(request.runDir, "trace.jsonl"),
          outputsDir: join(request.runDir, "outputs"),
          batchLogPath: join(request.runDir, "batch.log"),
        };
      },
    };
    await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      seeds: [0, 1],
      roles: rejectingRoles(),
      executor,
    });
    const metrics = JSON.parse(readFileSync(join(out, "round1/metrics.json"), "utf8")) as {
      runs: { seed: number; scoreStatus: string; unscoredReason?: string; reward: number | null }[];
      rewardMean: number;
    };
    expect(metrics.runs[0]).toMatchObject({ seed: 0, scoreStatus: "unscored", unscoredReason: "token_cap_exceeded", reward: null });
    expect(metrics.runs[1]?.reward).toBe(1);
    expect(metrics.rewardMean).toBe(1);
  });

  test("execute mode refuses to start without BASE_URL or a command", async () => {
    const out = outDir();
    await expect(runOptLoop({
      out,
      mode: "execute",
      rounds: 1,
      env: {},
      roles: stubOptRoles(),
      executorCommand: ["python3", "{driver}", "--task", "{task}", "--run-dir", "{runDir}"],
      driver: join(out, "driver.py"),
    })).rejects.toThrow(/BASE_URL/);
    await expect(runOptLoop({
      out: outDir(),
      mode: "execute",
      rounds: 1,
      env: { BASE_URL: "https://example.test/v1" },
      roles: stubOptRoles(),
    })).rejects.toThrow(/executor command/);
  });
});

describe("optimize command", () => {
  test("dry-run finishes a round without a model process", async () => {
    const out = outDir();
    const code = await main(["optimize", "--out", out, "--dry-run", "--rounds", "1"]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "round1/sessions/gap-finder.jsonl"))).toBe(true);
    expect(existsSync(join(out, "round1/patch.diff"))).toBe(true);
    const activation = JSON.parse(readFileSync(join(out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
    expect(activation.patchActive).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "final/order.json"), "utf8"))).toEqual({
      order: ["C0", "X0", "C1", "X1", "C2", "X2"],
    });
  });
});
