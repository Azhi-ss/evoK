import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli";
import { createExecutor } from "./modules/executor";
import { PlaygroundTaskSource } from "./modules/probe";
import { createMemoryBus } from "./pi/delegate";
import { SUBAGENT_DELEGATION_CANCEL_EVENT, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_UPDATE_EVENT } from "pi-subagents/delegation";
import { readStageReport, reviewRoundE2E } from "./reports";
import { dispatchHarnessCommand, runClosedLoopDemo } from "./session";
import { readTokensSpent } from "./thresholds";

function out(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-loop-"));
}

describe("closed loop", () => {
  test("one sample-bridge round writes every stage report and an e2e review", async () => {
    const dir = out();
    const result = await runClosedLoopDemo(dir);
    expect(result.ok).toBe(true);
    expect(result.e2eOk).toBe(true);
    expect(result.text).toContain("executor sample-trace");
    expect(result.text).toContain("bridge none");
    expect(result.text).toContain("bridge sample");
    expect(result.text).toContain("best base");
    expect(result.failed).toContain("playground-submit-dry-run");
    expect(result.failed).toContain("held-out");
    expect(result.failed).toContain("tts");
    expect(result.failed).not.toContain("model");
    expect(result.panel.some((line) => line.startsWith("round 1"))).toBe(true);
    expect(result.panel.some((line) => line.startsWith("playground-submit-dry-run FAIL"))).toBe(true);
    expect(result.panel.some((line) => line.includes("手填"))).toBe(true);
    expect(result.panel.some((line) => line.startsWith("tts FAIL") && line.includes("not-run"))).toBe(true);
    for (const stage of ["select", "gap", "propose", "run", "review", "backprop", "gate", "e2e"]) {
      const report = readStageReport(dir, 1, stage);
      expect(report?.explanation.length).toBeGreaterThan(0);
      expect(report?.output).toBeDefined();
    }
    const trace = JSON.parse(readFileSync(join(dir, "traces", "dev-1.json"), "utf8")) as {
      steps: { tool: string; ok: boolean; error?: string }[];
      executor: string;
    };
    expect(trace.executor).toBe("sample-trace");
    expect(trace.steps.map((step) => step.tool)).toEqual(["read", "bash", "write"]);
    expect(trace.steps[1]?.ok).toBe(false);
    expect(trace.steps[1]?.error).toContain("assertion failed");
    expect(readFileSync(join(dir, "gaps.json"), "utf8")).toContain("tool-misuse");
    expect(readFileSync(join(dir, "patch.json"), "utf8")).toContain("require a write");
    const usage = readTokensSpent(dir);
    expect(usage.ok).toBe(true);
    if (usage.ok) expect(usage.tokensSpent).toBeGreaterThan(0);
    const gate = JSON.parse(readFileSync(join(dir, "state", "gate.jsonl"), "utf8")) as { heldout: number | null };
    expect(gate.heldout).toBeNull();
    expect(readFileSync(join(dir, "state", "lineage.jsonl"), "utf8")).not.toContain("heldout");
    const review = readStageReport(dir, 1, "review");
    expect(review?.output).toMatchObject({ accept: false });
    writeFileSync(join(dir, "reports", "round-1", "gap.json"), "{}\n");
    const emptied = reviewRoundE2E(dir, 1);
    expect(emptied.ok).toBe(false);
    expect(emptied.findings.find((item) => item.stage === "gap")?.ok).toBe(false);
    mkdirSync(join(dir, "evidence_pack"), { recursive: true });
    writeFileSync(join(dir, "evidence_pack", "pack.json"), "{}\n");
    const packed = reviewRoundE2E(dir, 1);
    expect(packed.findings.find((item) => item.stage === "evidence_pack")?.ok).toBe(false);
  });

  test("start names each missing threshold and a stopped session refuses step", async () => {
    const dir = out();
    const missing = await dispatchHarnessCommand(["start", "--out", dir, "--min-delta", "0.1"], { cwd: dir });
    expect(missing.ok).toBe(false);
    expect(missing.missing.join(" ")).toContain("ttsBaseline");
    expect(missing.missing.join(" ")).toContain("tokenBudget");
    expect(missing.text).toContain("missing");
    const demo = await runClosedLoopDemo(dir);
    expect(demo.ok).toBe(true);
    const stopped = await dispatchHarnessCommand(["stop", "--out", dir], { cwd: dir });
    expect(stopped.ok).toBe(true);
    expect(stopped.panel.some((line) => line.startsWith("phase stop"))).toBe(true);
    const again = await dispatchHarnessCommand(["step", "--out", dir], { cwd: dir });
    expect(again.ok).toBe(false);
    expect(again.text).toContain("stopped");
  });

  test("bohr and playground task list fail closed, and a silent bus times out", async () => {
    await expect(createExecutor("bohr").run({ id: "dev-1", split: "dev", path: "tasks/dev-1.md" }, "candidates/base/config.json"))
      .rejects.toThrow(/bohr sandbox/);
    await expect(new PlaygroundTaskSource().list()).rejects.toThrow(/playground CLI is not installed/);
    const dir = out();
    const started = await dispatchHarnessCommand([
      "start", "--out", dir,
      "--min-delta", "0.1",
      "--tts-baseline", "0.5",
      "--held-out-floor", "0.4",
      "--token-budget", "100000",
      "--max-local-runs", "20",
      "--max-wall-s", "3600",
      "--max-submits", "1",
      "--heldout-score", "0.55",
      "--executor", "bohr",
    ], { cwd: dir, sampleBridge: true });
    expect(started.ok).toBe(false);
    expect(started.text).toContain("bohr");
    const playground = await dispatchHarnessCommand([
      "start", "--out", `${dir}-pg`,
      "--min-delta", "0.1",
      "--tts-baseline", "0.5",
      "--held-out-floor", "0.4",
      "--token-budget", "100000",
      "--max-local-runs", "20",
      "--max-wall-s", "3600",
      "--max-submits", "1",
      "--heldout-score", "0.55",
      "--task-source", "playground",
    ], { cwd: dir, sampleBridge: true });
    expect(playground.ok).toBe(false);
    expect(playground.text).toContain("playground CLI is not installed");
    const quiet = out();
    const ready = await dispatchHarnessCommand([
      "start", "--out", quiet,
      "--min-delta", "0.1",
      "--tts-baseline", "0.5",
      "--held-out-floor", "0.4",
      "--token-budget", "100000",
      "--max-local-runs", "20",
      "--max-wall-s", "3600",
      "--max-submits", "1",
      "--heldout-score", "0.55",
    ], { cwd: quiet, sampleBridge: true });
    expect(ready.ok).toBe(true);
    const bus = createMemoryBus();
    const cancels: unknown[] = [];
    bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => cancels.push(data));
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as { requestId: string; ownerRunId: string; nodeId: string };
      bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        usage: { input: 2000, output: 251, cacheRead: 0, cacheWrite: 0, turns: 1 },
      });
    });
    const timed = await dispatchHarnessCommand(["step", "--out", quiet], {
      cwd: quiet,
      events: bus,
      sampleBridge: false,
      timeoutMs: 30,
      graceMs: 0,
    });
    expect(timed.ok).toBe(false);
    expect(timed.text).toContain("timed out");
    expect(timed.text).toContain("bridge none");
    expect(timed.text).not.toContain("bridge pi-subagents");
    expect(cancels).toHaveLength(1);
    expect(Object.keys(cancels[0] as object).sort()).toEqual(["nodeId", "ownerRunId", "requestId"]);
    const usage = readTokensSpent(quiet);
    expect(usage.ok).toBe(true);
    if (usage.ok) expect(usage.tokensSpent).toBeGreaterThanOrEqual(40 + 2251);
  });

  test("step keeps the task source chosen at start", async () => {
    const dir = out();
    const started = await dispatchHarnessCommand([
      "start", "--out", dir,
      "--min-delta", "0.1",
      "--tts-baseline", "0.5",
      "--held-out-floor", "0.4",
      "--token-budget", "100000",
      "--max-local-runs", "20",
      "--max-wall-s", "3600",
      "--max-submits", "1",
      "--heldout-score", "0.55",
      "--task-source", "local",
    ], { cwd: dir, sampleBridge: true });
    expect(started.ok).toBe(true);
    expect(started.text).toContain("bridge none");
    const sessionFile = join(dir, "state", "session.json");
    const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as { taskSource: string };
    saved.taskSource = "playground";
    writeFileSync(sessionFile, `${JSON.stringify(saved)}\n`);
    const stepped = await dispatchHarnessCommand(["step", "--out", dir], { cwd: dir, sampleBridge: true, graceMs: 0 });
    expect(stepped.ok).toBe(false);
    expect(stepped.text).toContain("playground CLI is not installed");
  });

  test("cli demo completes and run without thresholds names minDelta", async () => {
    const dir = out();
    expect(await main(["demo", "--out", dir])).toBe(0);
    expect(readStageReport(dir, 1, "e2e")).toMatchObject({ output: { ok: true } });
    const fresh = out();
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const tasks = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/tasks");
      expect(await main(["run", "--dev", tasks, "--out", fresh])).toBe(1);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toContain("minDelta");
    expect(readTokensSpent(fresh).ok).toBe(false);
  });
});
