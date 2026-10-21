import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../cli";
import { writeHostAttestation } from "./attestation";
import {
  claimNonce,
  CONTROL_CONFIG_SHA,
  CONTROL_CONFIG_TEXT,
  DEV_TASK,
  HELD_OUT_TASKS,
  OPT_MODEL,
  runOptLoop,
  runOptOnce,
  stubOptRoles,
  type OptLoopOptions,
  type OptRoles,
} from "./opt-loop";
import { assertRoleSpawn, hostWriteSession, roleWrite, type RoleSpawnConfig } from "./role-spawn";
import { renderExecutorCommand, tokenCap, writeRunArtifacts, type OptExecutor, type OptRunRequest, type RunArtifactTiming } from "./opt-executor";

interface Fixture {
  readonly root: string;
  readonly out: string;
  readonly attestRoot: string;
  readonly keyFile: string;
  readonly harnessPath: string;
  readonly key: Buffer;
  readonly controlConfig: string;
  readonly controlAttest: string;
  readonly controlTrace: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "opt-loop-"));
  const keyFile = join(root, "attest.key");
  const key = Buffer.alloc(32, 9);
  writeFileSync(keyFile, key);
  chmodSync(keyFile, 0o600);
  const harnessPath = join(root, "harness.mjs");
  writeFileSync(harnessPath, "/* host harness */\n");
  const out = join(root, "out");
  const attestRoot = join(root, "attest");
  mkdirSync(attestRoot, { recursive: true });
  const controlConfig = join(root, "control.json");
  writeFileSync(controlConfig, CONTROL_CONFIG_TEXT);
  const control = attestControl(root, key, harnessPath, controlConfig);
  return {
    root,
    out,
    attestRoot,
    keyFile,
    harnessPath,
    key,
    controlConfig,
    controlAttest: control.attestDir,
    controlTrace: control.tracePath,
  };
}

function hostOpts(fx: Fixture): Pick<OptLoopOptions, "out" | "attestRoot" | "attestKeyFile" | "harnessPath" | "controlAttests" | "controlConfigPath"> {
  return {
    out: fx.out,
    attestRoot: fx.attestRoot,
    attestKeyFile: fx.keyFile,
    harnessPath: fx.harnessPath,
    controlAttests: [fx.controlAttest],
    controlConfigPath: fx.controlConfig,
  };
}

function attestControl(root: string, key: Buffer, harnessPath: string, controlConfig: string): { readonly attestDir: string; readonly tracePath: string } {
  const runDir = join(root, "control-run");
  const attestDir = join(root, "control-attest");
  const request: OptRunRequest = {
    task: DEV_TASK,
    seed: 0,
    arm: "control",
    configPath: controlConfig,
    runDir,
    attestDir,
    harnessPath,
    model: OPT_MODEL,
    tokenCap: tokenCap(DEV_TASK),
  };
  const base = 1_700_000_000;
  writeRunArtifacts(request, {
    reward: 1,
    tokens: 10,
    wallS: 1,
    timedOut: false,
    tWrite: base,
    tEnd: base + 1,
    assistantTs: [],
  }, { key, harnessPath });
  return { attestDir, tracePath: join(runDir, "trace.jsonl") };
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

function observation(request: OptRunRequest, fields: { readonly reward: number; readonly tokens: number; readonly wallS: number; readonly timedOut: boolean }) {
  return {
    reward: fields.reward,
    scoreStatus: "scored" as const,
    tokens: fields.tokens,
    wallS: fields.wallS,
    timedOut: fields.timedOut,
    tracePath: join(request.runDir, "trace.jsonl"),
    outputsDir: join(request.runDir, "outputs"),
    batchLogPath: join(request.runDir, "batch.log"),
  };
}

function fakeExecutor(fx: Fixture): { readonly calls: OptRunRequest[]; readonly executor: OptExecutor } {
  const calls: OptRunRequest[] = [];
  return {
    calls,
    executor: {
      name: "fake",
      async run(request) {
        calls.push(request);
        const reward = request.seed === 2 && request.runDir.includes("/round1/") ? 0 : 1;
        const script = timing(request, reward);
        writeRunArtifacts(request, script, { key: fx.key, harnessPath: fx.harnessPath });
        return observation(request, { reward, tokens: script.tokens, wallS: script.wallS, timedOut: script.timedOut });
      },
    },
  };
}

function rejectingRoles(fx: Fixture): OptRoles & { readonly reviews: number } {
  const roles = stubOptRoles(fx.key);
  let reviews = 0;
  return {
    gap: (input) => roles.gap(input),
    innovate: (input) => roles.innovate(input),
    review: async (input) => {
      reviews += 1;
      hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "still idle" })}\n`, fx.key);
      return { session: { jsonl: "ignored\n" }, accept: false, reason: "still idle" };
    },
    get reviews() { return reviews; },
  };
}

function plantRelayRead(log: string, runId: string, files: readonly string[]): void {
  const script = fileURLToPath(new URL("../../relay/harness_relay.py", import.meta.url));
  const proc = spawnSync("python3", [script, "plant-read", "--log", log, "--run-id", runId, ...files.flatMap((file) => ["--file", file])], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "plant-read failed").trim());
}

/** Test-only wrapper. The production stub does not plant relay reads. */
function citingRoles(key: Buffer): OptRoles {
  const stub = stubOptRoles(key);
  return {
    async gap(input) {
      const turn = await stub.gap(input);
      const files = [
        ...input.traces.map((hint) => hint.file),
        ...(input.previousReviewSession ? [input.previousReviewSession] : []),
      ];
      if (files.length > 0) {
        plantRelayRead(join(input.sessionPath, "..", "..", "relay", "gap-finder.jsonl"), randomBytes(16).toString("hex"), files);
      }
      return turn;
    },
    innovate: (input) => stub.innovate(input),
    review: (input) => stub.review(input),
  };
}

function perfectRead(file: string, text: string): string {
  const call = {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: file } }], timestamp: 0 },
  };
  const result = {
    type: "message",
    message: { role: "toolResult", toolCallId: "c0", toolName: "read", isError: false, content: [{ type: "text", text }], timestamp: 0 },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`;
}

describe("optimization loop", () => {
  test("the box control file is the compact config", () => {
    expect(createHash("sha256").update(CONTROL_CONFIG_TEXT).digest("hex")).toBe(CONTROL_CONFIG_SHA);
    expect(createHash("sha256").update(`${JSON.stringify(JSON.parse(CONTROL_CONFIG_TEXT), null, 2)}\n`).digest("hex")).not.toBe(CONTROL_CONFIG_SHA);
  });

  test("one round persists sessions, the patch, and the Pi session that loaded the candidate", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const roles = rejectingRoles(fx);
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles, executor: fake.executor });
    expect(result.model).toBe(OPT_MODEL);
    expect(result.ewiThresholdSec).toBe(600);
    expect(result.skippedFinal).toBe(true);
    expect(fake.calls.map((call) => `${call.task.id}:${call.seed}:${call.model}`)).toEqual([
      "i014:0:deepseek-v4-1-flash-261017",
      "i014:1:deepseek-v4-1-flash-261017",
      "i014:2:deepseek-v4-1-flash-261017",
    ]);
    expect(roles.reviews).toBe(1);

    const manifest = JSON.parse(readFileSync(join(fx.out, "round1/sessions/manifest.json"), "utf8")) as {
      sessions: { role: string; file: string; sha256: string }[];
    };
    expect(manifest.sessions.map((item) => item.role)).toEqual(["gap-finder", "innovator", "reviewer-gate"]);
    for (const item of manifest.sessions) {
      const bytes = readFileSync(join(fx.out, item.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
    }
    const gapSession = readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain("\"role\":\"gap-finder\"");
    expect(gapSession).toContain("gap");
    expect(gapSession).not.toContain("ignored-return");
    expect(existsSync(join(fx.out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);

    const diff = readFileSync(join(fx.out, "round1/patch.diff"), "utf8");
    expect(diff).toContain('"maxSteps":25');
    expect(diff).toContain('"maxSteps": 24');
    const patchHash = createHash("sha256").update(readFileSync(join(fx.out, "round1/patch.diff"))).digest("hex");
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchHash: string;
      differsFromControl: boolean;
      patchActive: boolean;
      candidateConfigSha: string;
      runs: { seed: number; tracePath: string; hashInSystemMessage: boolean; active: boolean; attestOk: boolean }[];
    };
    expect(activation.patchHash).toBe(patchHash);
    expect(activation).not.toHaveProperty("marker");
    expect(activation.differsFromControl).toBe(true);
    expect(activation.patchActive).toBe(true);
    for (const run of activation.runs) {
      expect(run.attestOk).toBe(true);
      const line = readFileSync(run.tracePath, "utf8").split("\n")[0] ?? "";
      const start = JSON.parse(line) as { systemPrompt?: string; candidateConfigHash?: string };
      expect(start.systemPrompt).toBeUndefined();
      expect(start.candidateConfigHash).toBe(activation.candidateConfigSha);
      const session = readFileSync(join(run.tracePath, "../.pi-sessions/session.jsonl"), "utf8");
      expect(session).toContain(`candidateConfigHash: ${activation.candidateConfigSha}`);
      expect(run.hashInSystemMessage).toBe(true);
      expect(run.active).toBe(true);
    }

    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
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
    expect(readFileSync(join(fx.out, "round1/run-notes.md"), "utf8")).toContain(`patchSha: ${patchHash}`);
    const reviewInput = readFileSync(join(fx.out, "round1/review-input.json"), "utf8");
    expect(reviewInput).not.toContain("i030");
    expect(reviewInput).not.toContain("hb003");
    expect(reviewInput).not.toContain("held-out");
  });

  test("the next gap input receives the reviewer reason, and a repeated summary is not run", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    let innovateCalls = 0;
    const roles: OptRoles = {
      gap: (input) => stubOptRoles(fx.key).gap(input),
      async innovate(input) {
        innovateCalls += 1;
        writeFileSync(input.sessionPath, `${JSON.stringify({ type: "session", role: "innovator" })}\n`);
        if (input.round > 1) {
          return { session: { jsonl: "ignored\n" }, summary: "agent-loop.maxSteps=24", parts: { "agent-loop": { maxSteps: 24 } } };
        }
        return stubOptRoles(fx.key).innovate(input);
      },
      review: async (input) => {
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "still idle" })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: false, reason: "still idle" };
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 2, roles, executor: fake.executor });
    const gapInput = JSON.parse(readFileSync(join(fx.out, "round2/gap-input.json"), "utf8")) as { previousReview: { reason: string } };
    expect(gapInput.previousReview.reason).toBe("still idle");
    const gapSession = readFileSync(join(fx.out, "round2/sessions/gap-finder.jsonl"), "utf8");
    expect(gapSession).toContain("gap");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean; closed: boolean };
    expect(closure.reviewFedForward).toBe(false);
    expect(closure.closed).toBe(false);
    expect(innovateCalls).toBe(2);
    expect(fake.calls).toHaveLength(3);
    expect(existsSync(join(fx.out, "round2/sessions/reviewer-gate.jsonl"))).toBe(true);
    expect(readFileSync(join(fx.out, "round2/sessions/reviewer-gate.jsonl"), "utf8")).toContain("duplicate summary");
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("three rejected rounds skip the final block and held-out", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 3,
      roles: rejectingRoles(fx),
      executor: fake.executor,
    });
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls.every((call) => call.task.id === "i014" && call.task.network === "devii-004-int")).toBe(true);
  });

  test("the last accepted candidate is rerun alternating with control, then held out", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 3, roles: citingRoles(fx.key), executor: fake.executor });
    expect(result.accepted?.round).toBe(1);
    expect(result.finalBlock?.order).toEqual(["C0", "X0", "C1", "X1", "C2", "X2"]);
    expect(JSON.parse(readFileSync(join(fx.out, "final/order.json"), "utf8"))).toEqual({ order: ["C0", "X0", "C1", "X1", "C2", "X2"] });
    const dev = fake.calls.slice(0, 9);
    expect(dev.every((call) => call.arm === "candidate" && call.task.id === DEV_TASK.id && call.task.network === "devii-004-int")).toBe(true);
    const rendered = renderExecutorCommand(
      ["python3", "--task", "{taskPath}", "--run-dir", "{runDir}", "--network", "{network}", "--attest-dir", "{attestDir}"],
      dev[0]!,
    );
    expect(rendered).toContain("devii-004-int");
    expect(rendered).not.toContain("open");
    const finalCalls = fake.calls.slice(9, 15);
    expect(finalCalls.map((call) => `${call.arm === "control" ? "C" : "X"}${call.seed}`)).toEqual(["C0", "X0", "C1", "X1", "C2", "X2"]);
    expect(finalCalls.every((call) => !("marker" in call) && !("patchHash" in call))).toBe(true);
    const held = fake.calls.slice(15);
    expect(held.map((call) => `${call.task.id}:${call.seed}:${call.task.network}`)).toEqual(
      HELD_OUT_TASKS.flatMap((task) => [0, 1, 2].map((seed) => `${task.id}:${seed}:${task.network}`)),
    );
    expect(held.filter((call) => call.task.id === "002").every((call) => call.task.network === "devii-004-int")).toBe(true);
    expect(result.heldOut).toEqual({ calls: 9, gatewayOnly: ["002", "i030", "hb003"] });
    const heldOutFile = JSON.parse(readFileSync(join(fx.out, "heldout/metrics.json"), "utf8")) as { comparison: string };
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
    expect(controlHash).toBe(CONTROL_CONFIG_SHA);
  });

  test("a run past 6×W is unscored and stays out of the reward mean", async () => {
    const fx = fixture();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "fake",
      async run(request) {
        calls.push(request);
        const over = request.seed === 0;
        const script = timing(request, 1, over ? tokenCap(DEV_TASK) + 1 : 10);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] }, { key: fx.key, harnessPath: fx.harnessPath });
        return observation(request, { reward: 1, tokens: over ? tokenCap(DEV_TASK) + 1 : 10, wallS: 10, timedOut: false });
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, seeds: [0, 1], roles: rejectingRoles(fx), executor });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { seed: number; scoreStatus: string; unscoredReason?: string; reward: number | null }[];
      rewardMean: number;
    };
    expect(metrics.runs[0]).toMatchObject({ seed: 0, scoreStatus: "unscored", unscoredReason: "token_cap", reward: null });
    expect(metrics.runs[1]?.reward).toBe(1);
    expect(metrics.rewardMean).toBe(1);
  });

  test("execute mode refuses to start without BASE_URL or a command", async () => {
    const fx = fixture();
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "execute",
      rounds: 1,
      env: {},
      roles: stubOptRoles(fx.key),
      executorCommand: ["python3", "{driver}", "--task", "{task}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}"],
      driver: join(fx.root, "driver.py"),
    })).rejects.toThrow(/BASE_URL/);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "execute",
      rounds: 1,
      env: { BASE_URL: "https://example.test/v1" },
      roles: stubOptRoles(fx.key),
    })).rejects.toThrow(/executor command/);
  });

  test("round 1 refuses a missing, forged, or mis-bound control attestation", async () => {
    const fx = fixture();
    const roles = stubOptRoles(fx.key);
    const executor = fakeExecutor(fx).executor;
    await expect(runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, controlAttests: [], roles, executor })).rejects.toThrow(/control attestation/);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      controlAttests: [join(fx.root, "missing-attest")],
      roles,
      executor,
    })).rejects.toThrow(/control attestation/);
    const raw = readFileSync(join(fx.controlAttest, "attestation.json"), "utf8");
    writeFileSync(join(fx.controlAttest, "attestation.json"), raw.replace("\"hmacSha256\": \"", "\"hmacSha256\": \"00"));
    await expect(runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles, executor })).rejects.toThrow(/hmac/);
    expect(existsSync(join(fx.out, "round1/sessions/gap-finder.jsonl"))).toBe(false);
    expect(existsSync(join(fx.out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);

    const pretty = join(fx.root, "pretty-control.json");
    writeFileSync(pretty, `${JSON.stringify(JSON.parse(CONTROL_CONFIG_TEXT), null, 2)}\n`);
    const prettyRun = join(fx.root, "pretty-run");
    const prettyAttest = join(fx.root, "pretty-attest");
    writeRunArtifacts({
      task: DEV_TASK,
      seed: 0,
      arm: "control",
      configPath: pretty,
      runDir: prettyRun,
      attestDir: prettyAttest,
      harnessPath: fx.harnessPath,
      model: OPT_MODEL,
      tokenCap: tokenCap(DEV_TASK),
    }, { reward: 1, tokens: 10, wallS: 1, timedOut: false, tWrite: 1_700_000_000, tEnd: 1_700_000_001, assistantTs: [] }, { key: fx.key, harnessPath: fx.harnessPath });
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      controlAttests: [prettyAttest],
      roles,
      executor,
    })).rejects.toThrow(/config/);
  });

  test("a path mentioned in the gap text is not a read of the trace", async () => {
    const fx = fixture();
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      executor: fakeExecutor(fx).executor,
      roles: {
        ...stubOptRoles(fx.key),
        async gap(input) {
          const file = input.traces[0]?.file ?? "";
          const text = readFileSync(file, "utf8");
          writeFileSync(input.sessionPath, `${JSON.stringify({ type: "message", role: "assistant", text: `cited ${file}:1` })}\n`);
          return {
            session: { jsonl: perfectRead(file, text) },
            citations: [`${file}:1`],
            knob: "agent-loop.maxSteps",
            failureClass: "idle-loop",
            summary: "early write then idle",
          };
        },
        async review(input) {
          writeFileSync(input.sessionPath, "{\"type\":\"message\",\"text\":\"accept\"}\n");
          return { session: { jsonl: perfectRead(input.sessionPath, "nope") }, accept: true, reason: "accept" };
        },
      },
    });
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { gapCitedTrace: boolean };
    expect(readFileSync(join(fx.out, "round1/sessions/gap-finder.jsonl"), "utf8")).toContain(`${fx.controlTrace}:1`);
    expect(closure.gapCitedTrace).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("feed-forward reads the reviewer session and ignores the loop's gap input", async () => {
    const fx = fixture();
    const roles: OptRoles = {
      async gap(input) {
        if (input.round === 1) return stubOptRoles(fx.key).gap(input);
        const file = input.previousReviewSession ?? "";
        const real = readFileSync(file, "utf8");
        const reason = input.previousReview?.reason ?? "";
        writeFileSync(input.sessionPath, perfectRead(file, reason));
        return {
          session: { jsonl: perfectRead(file, real) },
          citations: [],
          knob: "agent-loop.maxSteps",
          failureClass: "idle-loop",
          summary: "early write then idle",
        };
      },
      innovate: (input) => stubOptRoles(fx.key).innovate(input),
      async review(input) {
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "still idle" })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: false, reason: "still idle" };
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 2, roles, executor: fakeExecutor(fx).executor });
    const gapInput = JSON.parse(readFileSync(join(fx.out, "round2/gap-input.json"), "utf8")) as { previousReview: { reason: string } };
    expect(gapInput.previousReview.reason).toBe("still idle");
    expect(readFileSync(join(fx.out, "round2/sessions/gap-finder.jsonl"), "utf8")).toContain("still idle");
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as { reviewFedForward: boolean };
    expect(closure.reviewFedForward).toBe(false);
  });

  test("a forged read appended to the role session does not cite or feed forward", async () => {
    const fx = fixture();
    const roles: OptRoles = {
      async gap(input) {
        const target = input.round === 1 ? input.traces[0]?.file ?? "" : input.previousReviewSession ?? "";
        const forged = perfectRead(target, readFileSync(target, "utf8"));
        expect(roleWrite(input.spawn, input.sessionPath, forged)).toBe(false);
        expect(existsSync(input.sessionPath)).toBe(false);
        writeFileSync(input.sessionPath, forged);
        return {
          session: { jsonl: forged },
          citations: [`${target}:1`],
          knob: "agent-loop.maxSteps",
          failureClass: "idle-loop",
          summary: "early write then idle",
        };
      },
      innovate: (input) => stubOptRoles(fx.key).innovate(input),
      async review(input) {
        expect(roleWrite(input.spawn, input.sessionPath, "forged\n")).toBe(false);
        hostWriteSession(input.spawn, `${JSON.stringify({ type: "session", role: "reviewer-gate" })}\n${JSON.stringify({ type: "message", text: "accept" })}\n`, fx.key);
        return { session: { jsonl: "ignored\n" }, accept: true, reason: "accept" };
      },
    };
    const result = await runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 2,
      roles,
      executor: fakeExecutor(fx).executor,
    });
    for (const role of ["gap-finder", "reviewer-gate"] as const) {
      const spawn = JSON.parse(readFileSync(join(fx.out, `round1/sessions/${role}.spawn.json`), "utf8")) as RoleSpawnConfig;
      expect(spawn.tools).toEqual(["read"]);
      expect(spawn.tools).not.toContain("write");
      expect(spawn.tools).not.toContain("edit");
      expect(spawn.tools).not.toContain("bash");
      expect(resolve(spawn.sessionPath).startsWith(`${resolve(spawn.cwd)}/`)).toBe(false);
      expect(spawn.allowedPaths.some((allowed) => resolve(spawn.sessionPath).startsWith(`${resolve(allowed)}/`))).toBe(false);
      expect(resolve(spawn.ledgerPath).startsWith(`${resolve(spawn.cwd)}/`)).toBe(false);
    }
    const closure = JSON.parse(readFileSync(join(fx.out, "round1/closure.json"), "utf8")) as {
      gapCitedTrace: boolean;
      reviewFedForward: boolean;
    };
    expect(closure.gapCitedTrace).toBe(false);
    expect(closure.reviewFedForward).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
  });

  test("an executor that echoes request fields cannot activate or be accepted", async () => {
    const fx = fixture();
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
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: stubOptRoles(fx.key), executor });
    expect(calls[0]).not.toHaveProperty("marker");
    expect(calls[0]).not.toHaveProperty("patchHash");
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchActive: boolean;
      runs: { hashInSystemMessage: boolean; attestOk: boolean; active: boolean }[];
    };
    expect(activation.runs.every((run) => run.attestOk === false && run.hashInSystemMessage === false && run.active === false)).toBe(true);
    expect(activation.patchActive).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.rounds[0]?.accepted).toBe(false);
    expect(result.skippedFinal).toBe(true);
    expect(result.finalBlock).toBeNull();
    expect(result.heldOut).toBeNull();
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(calls).toHaveLength(3);
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs.every((run) => run.scoreStatus === "unscored" && run.unscoredReason === "attest_mismatch" && run.reward === null)).toBe(true);
  });

  test("a forged Pi session and a stdout attestation path cannot activate", async () => {
    const fx = fixture();
    const calls: OptRunRequest[] = [];
    const executor: OptExecutor = {
      name: "sessforge",
      async run(request) {
        calls.push(request);
        const script = timing(request, 1, 10);
        writeRunArtifacts(request, { ...script, timedOut: false, tEnd: script.tWrite + 0.5, assistantTs: [] });
        const side = join(fx.root, "side-attest", `${request.seed}`);
        const resultPath = join(request.runDir, "result.json");
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as { attestation?: string };
        result.attestation = join(side, "attestation.json");
        writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
        writeHostAttestation({
          attestDir: side,
          runDir: request.runDir,
          key: fx.key,
          harnessPath: fx.harnessPath,
          configPath: request.configPath,
          reward: 1,
          meta: {
            task: request.task.path,
            seed: request.seed,
            arm: request.arm,
            score_status: "scored",
            tokens: 10,
            exit: 0,
            runDir: request.runDir,
            runId: request.runId ?? "side-run",
            runPath: request.runDir,
            at: "2026-10-21T00:00:00+09:00",
          },
        });
        writeFileSync(join(request.runDir, "attestation.json"), readFileSync(join(side, "attestation.json")));
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    const result = await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, roles: stubOptRoles(fx.key), executor });
    const session = readFileSync(join(calls[0]?.runDir ?? "", ".pi-sessions/session.jsonl"), "utf8");
    const candidate = createHash("sha256").update(readFileSync(calls[0]?.configPath ?? "")).digest("hex");
    expect(session).toContain(`candidateConfigHash: ${candidate}`);
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as {
      patchActive: boolean;
      runs: { attestOk: boolean; active: boolean }[];
    };
    expect(activation.runs.every((run) => run.attestOk === false && run.active === false)).toBe(true);
    expect(activation.patchActive).toBe(false);
    expect(result.accepted).toBeNull();
    expect(result.skippedFinal).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(existsSync(join(fx.attestRoot, "round1", "i014", "seed0", "candidate", "attestation.json"))).toBe(false);
  });

  test("a second loop into the same out is rejected before the executor runs", async () => {
    const fx = fixture();
    const fake = fakeExecutor(fx);
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, seeds: [0], roles: rejectingRoles(fx), executor: fake.executor });
    const calls = fake.calls.length;
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      seeds: [0],
      roles: rejectingRoles(fx),
      executor: fake.executor,
    })).rejects.toThrow(/run dir already exists/);
    expect(fake.calls).toHaveLength(calls);
  });

  test("a used nonce is rejected", () => {
    const fx = fixture();
    const nonce = "ab".repeat(16);
    expect(claimNonce(fx.attestRoot, nonce)).toBe(nonce);
    expect(() => claimNonce(fx.attestRoot, nonce)).toThrow(/nonce already used/);
  });

  test("a control attestation with a mismatched run path is not scored", async () => {
    const fx = fixture();
    const runDir = join(fx.root, "control-run");
    writeHostAttestation({
      attestDir: fx.controlAttest,
      runDir,
      key: fx.key,
      harnessPath: fx.harnessPath,
      configPath: fx.controlConfig,
      reward: 1,
      meta: {
        task: DEV_TASK.path,
        seed: 0,
        arm: "control",
        score_status: "scored",
        tokens: 10,
        exit: 0,
        runDir,
        runId: "cd".repeat(16),
        runPath: join(fx.root, "not-the-run"),
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const fake = fakeExecutor(fx);
    await expect(runOptLoop({
      ...hostOpts(fx),
      mode: "dry-run",
      rounds: 1,
      seeds: [0],
      roles: rejectingRoles(fx),
      executor: fake.executor,
    })).rejects.toThrow(/runPath/);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(fx.out, "round1/metrics.json"))).toBe(false);
  });

  test("a symlink in outputs before start does not launch the executor", async () => {
    const fx = fixture();
    const runDir = join(fx.out, "round1", "runs", "i014", "seed0", "candidate");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(fx.harnessPath, join(runDir, "outputs"));
    const fake = fakeExecutor(fx);
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, seeds: [0], roles: rejectingRoles(fx), executor: fake.executor });
    expect(fake.calls).toHaveLength(0);
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs[0]).toMatchObject({ scoreStatus: "unscored", unscoredReason: "prerun_layout", reward: null });
  });

  test("a result.json run id that is not the host id is unscored", async () => {
    const fx = fixture();
    const executor: OptExecutor = {
      name: "swap-id",
      async run(request) {
        writeRunArtifacts(request, {
          reward: 1,
          tokens: 10,
          wallS: 1,
          timedOut: false,
          tWrite: 1_700_000_000,
          tEnd: 1_700_000_001,
          assistantTs: [],
        }, { key: fx.key, harnessPath: fx.harnessPath });
        const file = join(request.runDir, "result.json");
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { runId?: string };
        parsed.runId = "ff".repeat(16);
        writeFileSync(file, `${JSON.stringify(parsed)}\n`);
        return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
      },
    };
    await runOptLoop({ ...hostOpts(fx), mode: "dry-run", rounds: 1, seeds: [0], roles: rejectingRoles(fx), executor });
    const metrics = JSON.parse(readFileSync(join(fx.out, "round1/metrics.json"), "utf8")) as {
      runs: { scoreStatus: string; unscoredReason?: string; reward: number | null }[];
    };
    expect(metrics.runs[0]).toMatchObject({ scoreStatus: "unscored", unscoredReason: "result_runid_mismatch", reward: null });
  });
});

describe("optimize command", () => {
  test("dry-run finishes a round without a model process", async () => {
    const fx = fixture();
    const code = await main([
      "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
      "--attest-root", fx.attestRoot,
      "--attest-key-file", fx.keyFile,
      "--harness", fx.harnessPath,
      "--control-config", fx.controlConfig,
      "--control-attest", fx.controlAttest,
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(fx.out, "round1/sessions/gap-finder.jsonl"))).toBe(true);
    expect(existsSync(join(fx.out, "round1/patch.diff"))).toBe(true);
    const activation = JSON.parse(readFileSync(join(fx.out, "round1/activation.json"), "utf8")) as { patchActive: boolean };
    expect(activation.patchActive).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    const loop = JSON.parse(readFileSync(join(fx.out, "loop-result.json"), "utf8")) as { skippedFinal: boolean };
    expect(loop.skippedFinal).toBe(true);
  });

  test("dry-run without a control attestation does not write a stub baseline", async () => {
    const fx = fixture();
    const code = await main([
      "optimize", "--out", fx.out, "--dry-run", "--rounds", "1",
      "--attest-root", fx.attestRoot,
      "--attest-key-file", fx.keyFile,
      "--harness", fx.harnessPath,
    ]);
    expect(code).toBe(1);
    expect(existsSync(join(fx.out, "baseline/i014/seed0/trace.jsonl"))).toBe(false);
  });
});

describe("optimize-one command", () => {
  test("one honest candidate run can be active, and an echoing command cannot", async () => {
    const fx = fixture();
    const candidate = join(fx.root, "candidate.json");
    writeFileSync(candidate, "{\"parts\":{\"agent-loop\":{\"maxSteps\":24}}}\n");
    const honest = join(fx.root, "honest.mjs");
    const attestModule = new URL("./attestation.ts", import.meta.url).href;
    writeFileSync(honest, `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeHostAttestation } from ${JSON.stringify(attestModule)};
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const config = get("--config");
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "argv.json"), JSON.stringify(args));
const bytes = readFileSync(config);
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
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored", runId: get("--run-id") }) + "\\n");
writeHostAttestation({
  attestDir: get("--attest-dir"),
  runDir: run,
  key: readFileSync(process.env.HARNESS_ATTEST_KEY_FILE),
  harnessPath: get("--harness"),
  configPath: config,
  reward: 1,
  meta: { task: get("--task"), seed: Number(get("--seed")), arm: get("--arm"), score_status: "scored", tokens: 4, exit: 0, runDir: run, runId: get("--run-id"), nonce: get("--nonce"), runPath: run, at: "2026-10-21T00:00:00+09:00" },
});
console.log(JSON.stringify({ attestation: "/tmp/not-read/attestation.json" }));
`);
    const previous = process.env.BASE_URL;
    const previousKey = process.env.HARNESS_ATTEST_KEY_FILE;
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_ATTEST_KEY_FILE = fx.keyFile;
    const command = [
      process.execPath, honest,
      "--task", "{taskPath}",
      "--seed", "{seed}",
      "--arm", "{arm}",
      "--config", "{config}",
      "--run-dir", "{runDir}",
      "--attest-dir", "{attestDir}",
      "--harness", "{harness}",
      "--model", "{model}",
      "--network", "{network}",
      "--token-cap", "{tokenCap}",
      "--run-id", "{runId}",
      "--nonce", "{nonce}",
    ];
    try {
      const code = await main([
        "optimize-one",
        "--out", fx.out,
        "--attest-root", fx.attestRoot,
        "--attest-key-file", fx.keyFile,
        "--harness", fx.harnessPath,
        "--config", candidate,
        "--control-config", fx.controlConfig,
        "--knob", "agent-loop.maxSteps",
        "--seed", "0",
        "--executor-cmd", JSON.stringify(command),
      ]);
      expect(code).toBe(0);
      const saved = JSON.parse(readFileSync(join(fx.out, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(true);
      expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
      const argv = JSON.parse(readFileSync(join(fx.out, "once/i014/seed0/candidate/argv.json"), "utf8")) as string[];
      expect(argv).toContain("devii-004-int");
      expect(argv).not.toContain("open");
      expect(argv).not.toContain("shared");
      expect(argv.join(" ")).not.toContain(fx.keyFile);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
      if (previousKey === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previousKey;
    }

    const echoFx = fixture();
    const echoScript = join(echoFx.root, "echo.mjs");
    writeFileSync(echoScript, `
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
const bytes = readFileSync(get("--config"));
const hash = createHash("sha256").update(bytes).digest("hex");
mkdirSync(join(run, "outputs"), { recursive: true });
const answer = join(run, "outputs", "answer.txt");
writeFileSync(answer, "echo\\n");
utimesSync(answer, 1700000000, 1700000000);
writeFileSync(join(run, "trace.jsonl"), JSON.stringify({ type: "run_start", candidateConfigHash: hash, effective: { "agent-loop.maxSteps": 24 } }) + "\\n");
writeFileSync(join(run, "batch.log"), "2026-10-21T00:00:01.000Z run 1 done\\n");
mkdirSync(join(run, "verifier"), { recursive: true });
writeFileSync(join(run, "verifier", "reward.txt"), "1\\n");
mkdirSync(join(run, ".pi-sessions"), { recursive: true });
const preamble = "\\n\\n### Loaded candidate config\\ncandidateConfigHash: " + hash + "\\n";
writeFileSync(join(run, ".pi-sessions", "session.jsonl"), JSON.stringify({
  type: "message",
  message: { role: "system", content: "", sections: { preamble }, timestamp: 0 },
}) + "\\n");
writeFileSync(join(run, "attestation.json"), "{\\"hmacSha256\\":\\"00\\"}\\n");
writeFileSync(join(run, "result.json"), JSON.stringify({ reward: 1, tokens: 4, wall_s: 1, timed_out: false, score_status: "scored", attestation: join(run, "attestation.json") }) + "\\n");
console.log(JSON.stringify({ attestation: join(run, "attestation.json") }));
`);
    writeFileSync(join(echoFx.root, "candidate.json"), readFileSync(candidate));
    process.env.BASE_URL = "http://127.0.0.1:9";
    process.env.HARNESS_ATTEST_KEY_FILE = echoFx.keyFile;
    try {
      const code = await main([
        "optimize-one",
        "--out", echoFx.out,
        "--attest-root", echoFx.attestRoot,
        "--attest-key-file", echoFx.keyFile,
        "--harness", echoFx.harnessPath,
        "--config", join(echoFx.root, "candidate.json"),
        "--control-config", echoFx.controlConfig,
        "--knob", "agent-loop.maxSteps",
        "--executor-cmd", JSON.stringify([process.execPath, echoScript, "--task", "{taskPath}", "--config", "{config}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}", "--harness", "{harness}", "--model", "{model}", "--network", "{network}"]),
      ]);
      expect(code).toBe(1);
      const saved = JSON.parse(readFileSync(join(echoFx.out, "once/activation.json"), "utf8")) as { patchActive: boolean };
      expect(saved.patchActive).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
      if (previousKey === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previousKey;
    }
  });

  test("the direct once helper does not run the final block", async () => {
    const fx = fixture();
    const candidate = join(fx.root, "candidate.json");
    writeFileSync(candidate, "{\"parts\":{\"agent-loop\":{\"maxSteps\":24}}}\n");
    const result = await runOptOnce({
      out: fx.out,
      attestRoot: fx.attestRoot,
      attestKeyFile: fx.keyFile,
      harnessPath: fx.harnessPath,
      configPath: candidate,
      controlConfigPath: fx.controlConfig,
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
          }, { key: fx.key, harnessPath: fx.harnessPath });
          return observation(request, { reward: 1, tokens: 10, wallS: 1, timedOut: false });
        },
      },
    });
    expect(result.patchActive).toBe(true);
    expect(existsSync(join(fx.out, "final/order.json"))).toBe(false);
    expect(existsSync(join(fx.out, "round1"))).toBe(false);
  });
});
