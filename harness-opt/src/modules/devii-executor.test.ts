import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHarnessCommand } from "../session";
import { createExecutor } from "./executor";
import { DeviiExecutor } from "./devii-executor";

const SECRET = "sk-test-RED-KEY-99";

function fakeScript(dir: string, body: string): string {
  const file = join(dir, "fake_runner.py");
  writeFileSync(file, body);
  return file;
}

const task = { id: "dev-1", split: "dev" as const, path: "tasks/dev-1.md" };

describe("devii executor", () => {
  test("sums assistant usage, reads reward.txt, and redacts the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devii-exec-"));
    const script = fakeScript(dir, `
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
def get(flag):
    return args[args.index(flag) + 1]
run = Path(get("--run-root")) / get("--task-id") / get("--seed") / get("--arm")
(run / "verifier").mkdir(parents=True)
(run / "verifier" / "reward.txt").write_text("1\\n")
key = os.environ.get("API_KEY", "")
lines = [
    {"type": "tool_call", "tool": "read", "args": {"path": key}},
    {"type": "tool_result", "tool": "read", "isError": False},
    {"type": "assistant_message", "usage": {"input": 59004, "output": 51481, "cacheRead": 326912, "cacheWrite": 0}},
]
(run / "trace.jsonl").write_text("".join(json.dumps(line) + "\\n" for line in lines))
print(key)
`);
    const executor = new DeviiExecutor({
      scriptPath: script,
      runRoot: join(dir, "runs"),
      harnessHome: join(dir, "harness"),
      taskRoot: dir,
      seed: 0,
      arm: "control",
      env: { ...process.env, API_KEY: SECRET },
    });
    mkdirSync(join(dir, "harness"));
    const trace = await executor.run(task, join(dir, "config.json"));
    expect(trace.reward).toBe(1);
    expect(trace.failed).toBe(false);
    expect(trace.tokens).toBe(437397);
    expect(trace.usage).toEqual({ input: 59004, output: 51481, cacheRead: 326912, cacheWrite: 0 });
    expect(trace.steps).toEqual([{ id: "s1", tool: "read", args: { path: "[REDACTED]" }, ok: true }]);
    expect(trace.labels).toEqual([]);
    expect(trace.executor).toBe("devii");
    expect(JSON.stringify(trace)).not.toContain(SECRET);
  });

  test("cacheWrite stays on the usage record and is left out of the token sum", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devii-cache-"));
    const script = fakeScript(dir, `
import json, sys
from pathlib import Path
args = sys.argv[1:]
def get(flag):
    return args[args.index(flag) + 1]
run = Path(get("--run-root")) / get("--task-id") / get("--seed") / get("--arm")
(run / "verifier").mkdir(parents=True)
(run / "verifier" / "reward.txt").write_text("0\\n")
(run / "trace.jsonl").write_text(json.dumps({
    "type": "assistant_message",
    "usage": {"input": 59004, "output": 51481, "cacheRead": 326912, "cacheWrite": 10},
}) + "\\n")
`);
    const executor = new DeviiExecutor({
      scriptPath: script,
      runRoot: join(dir, "runs"),
      harnessHome: dir,
      seed: 1,
      arm: "treatment",
      env: process.env,
    });
    const trace = await executor.run(task, join(dir, "config.json"));
    expect(trace.reward).toBe(0);
    expect(trace.failed).toBe(false);
    expect(trace.tokens).toBe(437397);
    expect(trace.usage.cacheWrite).toBe(10);
  });

  test("a missing reward fails closed and a timeout is labeled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devii-miss-"));
    const missing = fakeScript(dir, `
import sys
from pathlib import Path
args = sys.argv[1:]
def get(flag):
    return args[args.index(flag) + 1]
run = Path(get("--run-root")) / get("--task-id") / get("--seed") / get("--arm")
run.mkdir(parents=True)
print("no reward")
`);
    const executor = new DeviiExecutor({
      scriptPath: missing,
      runRoot: join(dir, "runs"),
      harnessHome: dir,
      env: process.env,
    });
    const trace = await executor.run(task, join(dir, "config.json"));
    expect(trace.failed).toBe(true);
    expect(trace.reward).toBe(0);
    expect(trace.labels).toEqual(["format-invalid"]);

    const timeout = fakeScript(dir, `
import json, sys
from pathlib import Path
args = sys.argv[1:]
def get(flag):
    return args[args.index(flag) + 1]
run = Path(get("--run-root")) / get("--task-id") / get("--seed") / get("--arm")
run.mkdir(parents=True, exist_ok=True)
(run / "trace.jsonl").write_text(json.dumps({"type": "timeout_abort"}) + "\\n")
`);
    const timed = new DeviiExecutor({
      scriptPath: timeout,
      runRoot: join(dir, "runs-timeout"),
      harnessHome: dir,
      env: process.env,
    });
    const again = await timed.run(task, join(dir, "config.json"));
    expect(again.failed).toBe(true);
    expect(again.labels).toEqual(["timeout"]);
  });

  test("held-out is refused and bohr still throws", async () => {
    const executor = new DeviiExecutor({ runRoot: "/tmp", harnessHome: "/tmp", env: process.env });
    await expect(executor.run({ id: "h", split: "held-out", path: "h.md" }, "config.json")).rejects.toThrow(/held-out/);
    await expect(createExecutor("bohr").run(task, "config.json")).rejects.toThrow(/bohr sandbox/);
    expect(createExecutor("devii").name).toBe("devii");
    await expect(createExecutor("devii").run(task, "config.json")).rejects.toThrow(/not available/);
  });

  test("start selects the devii executor and fails closed without a harness home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devii-start-"));
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
      "--executor", "devii",
    ], { cwd: dir, sampleBridge: true });
    expect(started.ok).toBe(false);
    expect(started.text).toContain("not available");
  });
});
