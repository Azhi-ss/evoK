import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli";
import { DEV_TASK, HELD_OUT_TASKS, OPT_MODEL, runOptLoop, runOptOnce, stubOptRoles, type OptRoles } from "./opt-loop";
import { tokenCap, writeRunArtifacts, type OptExecutor, type OptRunRequest, type RunArtifactTiming } from "./opt-executor";

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "opt-loop-"));
}

function givenControl(dir: string): string[] {
  const file = join(dir, "control-trace.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "run_start", source: "control" })}\n`);
  return [file];
}

function flattenParts(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(out, flattenParts(child as Record<string, unknown>, path));
    } else {
      out[path] = child;
    }
  }
  return out;
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
  test("one round persists sessions, the patch, and the Pi session that loaded the candidate", async () => {
    const out = outDir();
    const fake = fakeExecutor();
    const roles = rejectingRoles();
    const traces = givenControl(out);
    const result = await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      controlTraces: traces,
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
    const gapSession = readFileSync(join(out, "round1/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain('"name":"read"');
    expect(gapSession).toContain(traces[0]);
    expect(existsSync(join(out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);

    const diff = readFileSync(join(out, "round1/patch.diff"), "utf8");
    expect(diff).toContain('"maxSteps": 25');
    expect(diff).toContain('"maxSteps": 24');
    const patchHash = createHash("sha256").update(readFileSync(join(out, "round1/patch.diff"))).digest("hex");
    const activation = JSON.parse(readFileSync(join(out, "round1/activation.json"), "utf8")) as {
      patchHash: string;
      differsFromControl: boolean;
      patchActive: boolean;
      candidateConfigSha: string;
      runs: { seed: number; tracePath: string; hashInSystemMessage: boolean; active: boolean }[];
    };
    expect(activation.patchHash).toBe(patchHash);
    expect(activation).not.toHaveProperty("marker");
    expect(activation.differsFromControl).toBe(true);
    expect(activation.patchActive).toBe(true);
    for (const run of activation.runs) {
      const line = readFileSync(run.tracePath, "utf8").split("\n")[0] ?? "";
      const start = JSON.parse(line) as { systemPrompt?: string; candidateConfigHash?: string };
      expect(start.systemPrompt).toBeUndefined();
      expect(start.candidateConfigHash).toBe(activation.candidateConfigSha);
      const session = readFileSync(join(run.tracePath, "../.pi-sessions/session.jsonl"), "utf8");
      expect(session).toContain(`candidateConfigHash: ${activation.candidateConfigSha}`);
      expect(run.hashInSystemMessage).toBe(true);
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
    await runOptLoop({ out, mode: "dry-run", rounds: 2, controlTraces: givenControl(out), roles, executor: fake.executor });
    const gapInput = JSON.parse(readFileSync(join(out, "round2/gap-input.json"), "utf8")) as {
      previousReview: { reason: string };
    };
    expect(gapInput.previousReview.reason).toBe("still idle");
    const gapSession = readFileSync(join(out, "round2/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain(join(out, "round1/sessions/reviewer-gate.jsonl"));
    expect(gapSession).toContain('"name":"read"');
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
      controlTraces: givenControl(out),
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
      controlTraces: givenControl(out),
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
    expect(finalCalls.every((call) => !("marker" in call) && !("patchHash" in call))).toBe(true);
    const held = fake.calls.slice(15);
    expect(held.map((call) => `${call.task.id}:${call.seed}:${call.task.network}`)).toEqual(
      HELD_OUT_TASKS.flatMap((task) => [0, 1, 2].map((seed) => `${task.id}:${seed}:${task.network}`)),
    );
    expect(held.filter((call) => call.task.id === "002").every((call) => call.task.network === "gateway-only")).toBe(true);
    expect(result.heldOut).toEqual({ calls: 9, gatewayOnly: ["002"] });
    const heldOutFile = JSON.parse(readFileSync(join(out, "heldout/metrics.json"), "utf8")) as { comparison: string };
    expect(heldOutFile.comparison).toBe("control-not-run");
    const candidateConfig = finalCalls[1]?.configPath ?? "";
    const controlConfig = finalCalls[0]?.configPath ?? "";
    const candidateHash = createHash("sha256").update(readFileSync(candidateConfig)).digest("hex");
    const controlHash = createHash("sha256").update(readFileSync(controlConfig)).digest("hex");
    const candidateSession = readFileSync(join(finalCalls[1]?.runDir ?? "", ".pi-sessions/session.jsonl"), "utf8");
    const controlSession = readFileSync(join(finalCalls[0]?.runDir ?? "", ".pi-sessions/session.jsonl"), "utf8");
    expect(candidateSession).toContain(`candidateConfigHash: ${candidateHash}`);
    expect(controlSession).toContain(`candidateConfigHash: ${controlHash}`);
    expect(candidateSession).not.toContain(`candidateConfigHash: ${controlHash}`);
    expect(readFileSync(join(finalCalls[1]?.runDir ?? "", "trace.jsonl"), "utf8")).not.toContain("systemPrompt");
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
      controlTraces: givenControl(out),
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
    const trace = givenControl(out);
    await expect(runOptLoop({
      out,
      mode: "execute",
      rounds: 1,
      controlTraces: trace,
      env: {},
      roles: stubOptRoles(),
      executorCommand: ["python3", "{driver}", "--task", "{task}", "--run-dir", "{runDir}"],
      driver: join(out, "driver.py"),
    })).rejects.toThrow(/BASE_URL/);
    await expect(runOptLoop({
      out: outDir(),
      mode: "execute",
      rounds: 1,
      controlTraces: trace,
      env: { BASE_URL: "https://example.test/v1" },
      roles: stubOptRoles(),
    })).rejects.toThrow(/executor command/);
  });

  test("round 1 refuses to invent a prior trace", async () => {
    const out = outDir();
    await expect(runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      controlTraces: [],
      roles: stubOptRoles(),
      executor: fakeExecutor().executor,
    })).rejects.toThrow(/control trace/);
    await expect(runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      controlTraces: [join(out, "missing-control.jsonl")],
      roles: stubOptRoles(),
      executor: fakeExecutor().executor,
    })).rejects.toThrow(/control trace is missing/);
    expect(existsSync(join(out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);
  });

  test("a path mentioned in the gap text is not a read of the trace", async () => {
    const out = outDir();
    const traces = givenControl(out);
    const file = traces[0] ?? "";
    await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      controlTraces: traces,
      executor: fakeExecutor().executor,
      roles: {
        ...stubOptRoles(),
        async gap() {
          return {
            session: { jsonl: `${JSON.stringify({ type: "message", role: "assistant", text: `cited ${file}:1` })}\n` },
            citations: [`${file}:1`],
            knob: "agent-loop.maxSteps",
            failureClass: "idle-loop",
            summary: "early write then idle",
          };
        },
        async review() {
          return { session: { jsonl: "{\"type\":\"message\",\"text\":\"no\"}\n" }, accept: false, reason: "no" };
        },
      },
    });
    const closure = JSON.parse(readFileSync(join(out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(readFileSync(join(out, "round1/sessions/gap-finder.jsonl"), "utf8")).toContain(`${file}:1`);
    expect(closure.gapCitedTrace).toBe(false);
  });

  test("feed-forward reads the reviewer session and ignores the loop's gap input", async () => {
    const out = outDir();
    const roles: OptRoles = {
      async gap(input) {
        if (input.round === 1) return stubOptRoles().gap(input);
        const reason = input.previousReview?.reason ?? "";
        return {
          session: { jsonl: `${JSON.stringify({ type: "message", role: "assistant", text: `echo ${reason}` })}\n` },
          citations: [],
          knob: "agent-loop.maxSteps",
          failureClass: "idle-loop",
          summary: "early write then idle",
        };
      },
      innovate: (input) => stubOptRoles().innovate(input),
      async review() {
        return { session: { jsonl: "{\"type\":\"message\",\"text\":\"still idle\"}\n" }, accept: false, reason: "still idle" };
      },
    };
    await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 2,
      controlTraces: givenControl(out),
      roles,
      executor: fakeExecutor().executor,
    });
    const gapInput = JSON.parse(readFileSync(join(out, "round2/gap-input.json"), "utf8")) as { previousReview: { reason: string } };
    expect(gapInput.previousReview.reason).toBe("still idle");
    expect(readFileSync(join(out, "round2/sessions/gap-finder.jsonl"), "utf8")).toContain("still idle");
    const closure = JSON.parse(readFileSync(join(out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean };
    expect(closure.reviewFedForward).toBe(false);
  });

  test("an executor that echoes request fields cannot activate or be accepted", async () => {
    const out = outDir();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "echo",
      async run(request) {
        calls.push(request);
        const bytes = readFileSync(request.configPath);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const config = JSON.parse(bytes.toString()) as { parts?: Record<string, unknown> };
        const echoed = {
          config: request.configPath,
          model: request.model,
          arm: request.arm,
          seed: request.seed,
          task: request.task.id,
          tokenCap: request.tokenCap,
        };
        mkdirSync(join(request.runDir, "outputs"), { recursive: true });
        const answer = join(request.runDir, "outputs", "answer.txt");
        writeFileSync(answer, "echo\n");
        const base = 1_700_000_000;
        utimesSync(answer, base, base);
        writeFileSync(join(request.runDir, "trace.jsonl"), `${JSON.stringify({
          type: "run_start",
          systemPrompt: JSON.stringify(echoed),
          candidateConfigHash: hash,
          effective: flattenParts(config.parts ?? {}),
        })}\n`);
        writeFileSync(join(request.runDir, "batch.log"), `${new Date((base + 1) * 1000).toISOString()} run 1 done\n`);
        mkdirSync(join(request.runDir, "verifier"), { recursive: true });
        writeFileSync(join(request.runDir, "verifier", "reward.txt"), "1\n");
        mkdirSync(join(request.runDir, ".pi-sessions"), { recursive: true });
        writeFileSync(join(request.runDir, ".pi-sessions/session.jsonl"), `${JSON.stringify({
          type: "message",
          message: { role: "system", content: JSON.stringify(echoed), timestamp: 0 },
        })}\n`);
        writeFileSync(join(request.runDir, "result.json"), `${JSON.stringify({
          reward: 1, tokens: 10, wall_s: 1, timed_out: false, score_status: "scored",
        })}\n`);
        return {
          reward: 1,
          scoreStatus: "scored" as const,
          tokens: 10,
          wallS: 1,
          timedOut: false,
          tracePath: join(request.runDir, "trace.jsonl"),
          outputsDir: join(request.runDir, "outputs"),
          batchLogPath: join(request.runDir, "batch.log"),
        };
      },
    };
    const result = await runOptLoop({
      out,
      mode: "dry-run",
      rounds: 1,
      controlTraces: givenControl(out),
      roles: stubOptRoles(),
      executor,
    });
    expect(calls[0]).not.toHaveProperty("marker");
    expect(calls[0]).not.toHaveProperty("patchHash");
    const activation = JSON.parse(readFileSync(join(out, "round1/activation.json"), "utf8")) as {
      patchActive: boolean;
      runs: { hashInSystemMessage: boolean; candidateConfigHash: string | null }[];
    };
    expect(activation.runs.every((run) => run.candidateConfigHash !== null && run.hashInSystemMessage === false)).toBe(true);
    expect(activation.patchActive).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.rounds[0]?.accepted).toBe(false);
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(existsSync(join(out, "final/order.json"))).toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe("optimize command", () => {
  test("dry-run finishes a round without a model process", async () => {
    const out = outDir();
    const trace = givenControl(out)[0] ?? "";
    const code = await main(["optimize", "--out", out, "--dry-run", "--rounds", "1", "--control-trace", trace]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "round1/sessions/gap-finder.jsonl"))).toBe(true);
    expect(existsSync(join(out, "round1/patch.diff"))).toBe(true);
    const activation = JSON.parse(readFileSync(join(out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
    expect(activation.patchActive).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "final/order.json"), "utf8"))).toEqual({
      order: ["C0", "X0", "C1", "X1", "C2", "X2"],
    });
  });

  test("dry-run without a control trace does not write a stub baseline", async () => {
    const out = outDir();
    const code = await main(["optimize", "--out", out, "--dry-run", "--rounds", "1"]);
    expect(code).toBe(1);
    expect(existsSync(join(out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);
  });
});

describe("optimize-one command", () => {
  test("one honest candidate run can be active, and an echoing command cannot", async () => {
    const out = outDir();
    const control = join(out, "control.json");
    const candidate = join(out, "candidate.json");
    writeFileSync(control, `${JSON.stringify({ parts: { "agent-loop": { maxSteps: 25 } } })}\n`);
    writeFileSync(candidate, `${JSON.stringify({ parts: { "agent-loop": { maxSteps: 24 } } })}\n`);
    const honest = join(out, "honest.mjs");
    writeFileSync(honest, `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const bytes = readFileSync(get("--config"));
const hash = createHash("sha256").update(bytes).digest("hex");
const parts = JSON.parse(bytes.toString()).parts ?? {};
const effective = {};
for (const [part, value] of Object.entries(parts)) {
  for (const [leaf, item] of Object.entries(value)) effective[part + "." + leaf] = item;
}
mkdirSync(join(run, "outputs"), { recursive: true });
const answer = join(run, "outputs", "answer.txt");
writeFileSync(answer, "ok\\n");
utimesSync(answer, 1700000000, 1700000000);
writeFileSync(join(run, "trace.jsonl"), JSON.stringify({ type: "run_start", candidateConfigHash: hash, effective }) + "\\n");
writeFileSync(join(run, "batch.log"), "2026-10-21T00:00:01.000Z run 1 done\\n");
mkdirSync(join(run, "verifier"), { recursive: true });
writeFileSync(join(run, "verifier", "reward.txt"), "1\\n");
mkdirSync(join(run, ".pi-sessions"), { recursive: true });
const preamble = "\\n\\n### Loaded candidate config\\ncandidateConfigHash: " + hash + "\\n";
writeFileSync(join(run, ".pi-sessions", "session.jsonl"), JSON.stringify({
  type: "message",
  message: { role: "system", content: "", sections: { preamble }, timestamp: 0 },
}) + "\\n");
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored" }) + "\\n");
`);
    const previous = process.env.BASE_URL;
    process.env.BASE_URL = "http://127.0.0.1:9";
    try {
      const code = await main([
        "optimize-one",
        "--out", out,
        "--config", candidate,
        "--control-config", control,
        "--knob", "agent-loop.maxSteps",
        "--seed", "0",
        "--executor-cmd", JSON.stringify([process.execPath, honest, "--task", "{taskPath}", "--seed", "{seed}", "--arm", "{arm}", "--config", "{config}", "--run-dir", "{runDir}", "--model", "{model}"]),
      ]);
      expect(code).toBe(0);
      const saved = JSON.parse(readFileSync(join(out, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(true);
      expect(existsSync(join(out, "final/order.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }

    const echoOut = outDir();
    const echoScript = join(echoOut, "echo.mjs");
    writeFileSync(echoScript, `
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const echoed = args.join(" ");
mkdirSync(join(run, "outputs"), { recursive: true });
const answer = join(run, "outputs", "answer.txt");
writeFileSync(answer, "echo\\n");
utimesSync(answer, 1700000000, 1700000000);
writeFileSync(join(run, "trace.jsonl"), JSON.stringify({ type: "run_start", systemPrompt: echoed, candidateConfigHash: echoed, effective: {} }) + "\\n");
writeFileSync(join(run, "batch.log"), "2026-10-21T00:00:01.000Z run 1 done\\n");
mkdirSync(join(run, "verifier"), { recursive: true });
writeFileSync(join(run, "verifier", "reward.txt"), "1\\n");
mkdirSync(join(run, ".pi-sessions"), { recursive: true });
writeFileSync(join(run, ".pi-sessions", "session.jsonl"), JSON.stringify({
  type: "message",
  message: { role: "system", content: echoed, timestamp: 0 },
}) + "\\n");
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored" }) + "\\n");
`);
    writeFileSync(join(echoOut, "control.json"), readFileSync(control));
    writeFileSync(join(echoOut, "candidate.json"), readFileSync(candidate));
    process.env.BASE_URL = "http://127.0.0.1:9";
    try {
      const code = await main([
        "optimize-one",
        "--out", echoOut,
        "--config", join(echoOut, "candidate.json"),
        "--control-config", join(echoOut, "control.json"),
        "--knob", "agent-loop.maxSteps",
        "--executor-cmd", JSON.stringify([process.execPath, echoScript, "--task", "{taskPath}", "--config", "{config}", "--run-dir", "{runDir}", "--model", "{model}"]),
      ]);
      expect(code).toBe(1);
      const saved = JSON.parse(readFileSync(join(echoOut, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });

  test("the direct once helper does not run the final block", async () => {
    const out = outDir();
    const control = join(out, "control.json");
    const candidate = join(out, "candidate.json");
    writeFileSync(control, `${JSON.stringify({ parts: { "agent-loop": { maxSteps: 25 } } })}\n`);
    writeFileSync(candidate, `${JSON.stringify({ parts: { "agent-loop": { maxSteps: 24 } } })}\n`);
    const result = await runOptOnce({
      out,
      configPath: candidate,
      controlConfigPath: control,
      knob: "agent-loop.maxSteps",
      seed: 0,
      executor: {
        name: "honest",
        async run(request) {
          writeRunArtifacts(request, {
            reward: 1,
            tokens: 10,
            wallS: 1,
            timedOut: false,
            tWrite: 1_700_000_000,
            tEnd: 1_700_000_001,
            assistantTs: [],
          });
          return {
            reward: 1,
            scoreStatus: "scored",
            tokens: 10,
            wallS: 1,
            timedOut: false,
            tracePath: join(request.runDir, "trace.jsonl"),
            outputsDir: join(request.runDir, "outputs"),
            batchLogPath: join(request.runDir, "batch.log"),
          };
        },
      },
    });
    expect(result.patchActive).toBe(true);
    expect(existsSync(join(out, "final/order.json"))).toBe(false);
    expect(existsSync(join(out, "round1"))).toBe(false);
  });
});
