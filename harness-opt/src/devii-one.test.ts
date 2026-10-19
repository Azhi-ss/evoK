import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SECRET = "sk-test-RED-KEY-99";
const FILE_SECRET = "UNIQUE_TEST_SECRET_do_not_print";

describe("devii_one dry plan", () => {
  test("prints bwrap argv, mounts tests only for the checker, and redacts the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "devii-one-"));
    const task = join(dir, "task");
    const tests = join(dir, "tests");
    mkdirSync(join(task, "environment"), { recursive: true });
    mkdirSync(tests);
    writeFileSync(join(task, "instruction.md"), "public instruction\n");
    writeFileSync(join(tests, "secret.txt"), FILE_SECRET);
    const config = join(dir, "config.json");
    const memory = join(dir, "memory.jsonl");
    writeFileSync(config, `${JSON.stringify({ parts: { "agent-loop": { maxSteps: 3 } } })}\n`);
    writeFileSync(memory, `${JSON.stringify({ text: "tool errors repeat", scope: "all" })}\n`);
    const runRoot = join(dir, "runs");
    const result = spawnSync("python3", [
      join(here, "../scripts/devii_one.py"),
      "--task-id", "tasks2/i006",
      "--task-dir", task,
      "--seed", "0",
      "--arm", "treatment",
      "--config", config,
      "--memory", memory,
      "--run-root", runRoot,
      "--harness", join(dir, "harness"),
      "--tests", tests,
      "--dry",
    ], {
      encoding: "utf8",
      env: { ...process.env, API_KEY: SECRET, BOHR_ACCESS_KEY: SECRET },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toContain(FILE_SECRET);
    expect(result.stderr).not.toContain(SECRET);
    const plan = JSON.parse(result.stdout) as {
      dry: boolean;
      runDir: string;
      agentArgv: string[];
      agentEnv: Record<string, string>;
      checkerArgv: string[];
      checkerEnv: Record<string, string>;
    };
    expect(plan.dry).toBe(true);
    expect(plan.runDir).toBe(join(runRoot, "tasks2/i006", "0", "treatment"));
    expect(plan.agentArgv[0]).toBe("bwrap");
    expect(plan.checkerArgv[0]).toBe("bwrap");
    expect(plan.agentArgv).not.toContain(tests);
    expect(plan.agentArgv).not.toContain("/tests");
    expect(plan.checkerArgv).toContain(tests);
    expect(plan.checkerArgv).toContain("/tests");
    expect(plan.agentArgv).toContain("--ro-bind");
    expect(plan.agentArgv).toContain(config);
    expect(plan.agentArgv).toContain("/opt/candidate-config.json");
    expect(plan.agentArgv).toContain(memory);
    expect(plan.agentArgv).toContain("/opt/memory.jsonl");
    const agentSeparator = plan.agentArgv.indexOf("--");
    expect(plan.agentArgv.indexOf(config)).toBeLessThan(agentSeparator);
    expect(plan.agentArgv.indexOf(tests)).toBe(-1);
    expect(plan.checkerArgv.indexOf(tests)).toBeLessThan(plan.checkerArgv.indexOf("--"));
    expect(plan.checkerArgv).toContain("/app/outputs");
    expect(plan.checkerArgv).toContain("/logs/verifier");
    expect(plan.checkerArgv).toContain("/root/code");
    expect(plan.agentArgv).not.toContain("/app/outputs");
    expect(plan.agentEnv.HARNESS_CANDIDATE_CONFIG).toBe("/opt/candidate-config.json");
    expect(plan.agentEnv.HARNESS_MEMORY_PATH).toBe("/opt/memory.jsonl");
    expect(plan.agentEnv.API_KEY).toBe("[REDACTED]");
    expect(plan.agentArgv.join("\n")).not.toContain("HARNESS_TIMEOUT_SECONDS");
    expect(plan.checkerEnv.API_KEY).toBeUndefined();
    expect(plan.agentArgv).toContain("/opt/harness/run.sh");
  });
});
