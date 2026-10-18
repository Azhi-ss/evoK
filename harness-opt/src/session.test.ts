import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli";
import { createExecutor } from "./modules/executor";
import { PlaygroundTaskSource } from "./modules/probe";
import { createMemoryBus } from "./pi/delegate";
import { readStageReport } from "./reports";
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
    expect(result.text).toContain("bridge sample");
    expect(result.failed).toContain("playground-submit-dry-run");
    expect(result.failed).not.toContain("model");
    expect(result.panel.some((line) => line.startsWith("round 1"))).toBe(true);
    expect(result.panel.some((line) => line.startsWith("playground-submit-dry-run FAIL"))).toBe(true);
    expect(result.panel.some((line) => line.includes("not-run"))).toBe(true);
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
    const gate = JSON.parse(readFileSync(join(dir, "state", "gate.jsonl"), "utf8")) as { heldout: number };
    expect(gate.heldout).toBe(0.55);
    expect(readFileSync(join(dir, "state", "lineage.jsonl"), "utf8")).not.toContain("heldout");
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
    const timed = await dispatchHarnessCommand(["step", "--out", quiet], {
      cwd: quiet,
      events: createMemoryBus(),
      sampleBridge: false,
      timeoutMs: 30,
    });
    expect(timed.ok).toBe(false);
    expect(timed.text).toContain("timed out");
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
