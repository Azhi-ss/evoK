import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_TASK } from "./opt-loop";
import { createHash } from "node:crypto";
import { assertScoredRelayLog, CommandOptExecutor, hostRunId, renderExecutorCommand, tokenCap, writeRunArtifacts, type OptRunRequest, type OptTask } from "./opt-executor";

const TASK: OptTask = {
  id: "002",
  path: "tasks1/002-bigwig-h3k27ac-igg-peak-audit",
  split: "held-out",
  network: "devii-004-int",
  tokenW: 2_383_647,
};

function request(dir: string): OptRunRequest {
  return {
    task: TASK,
    seed: 1,
    arm: "candidate",
    configPath: join(dir, "config.json"),
    runDir: join(dir, "run"),
    attestDir: join(dir, "attest"),
    model: "deepseek-v4-1-flash-261017",
    tokenCap: tokenCap(TASK),
    relayLogRoot: join(dir, "relay"),
  };
}

describe("pluggable executor command", () => {
  test("fills the driver template and keeps the key out of argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-cmd-"));
    const script = join(dir, "driver.mjs");
    writeFileSync(script, `
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
mkdirSync(run, { recursive: true });
writeFileSync(run + "/argv.json", JSON.stringify(args));
writeFileSync(run + "/base-url.txt", process.env.BASE_URL ?? "");
writeFileSync(run + "/result.json", JSON.stringify({
  reward: 1, tokens: 999, wall_s: 2, timed_out: false, score_status: "scored"
}));
const plant = spawnSync("python3", ["-c", \`
import sys
sys.path.insert(0, sys.argv[1])
import plant
plant.plant_request(sys.argv[2], sys.argv[3], "system", usage={"prompt_tokens": 3, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}})
\`, process.env.RELAY_DIR, process.env.RELAY_LOG, process.env.RUN_ID], { encoding: "utf8" });
if (plant.status !== 0) throw new Error(plant.stderr || plant.stdout || "plant failed");
`);
    const executor = new CommandOptExecutor({
      command: [
        process.execPath, script,
        "--task", "{taskPath}",
        "--seed", "{seed}",
        "--run-dir", "{runDir}",
        "--model", "{model}",
        "--config", "{config}",
        "--network", "{network}",
        "--token-cap", "{tokenCap}",
        "--attest-dir", "{attestDir}",
      ],
      env: {
        ...process.env,
        BASE_URL: "https://example.test/v1",
        API_KEY: "sk-secret",
        HARNESS_ATTEST_KEY_FILE: join(dir, "attest.key"),
        RELAY_DIR: fileURLToPath(new URL("../../relay", import.meta.url)),
        RELAY_LOG: join(dir, "relay", "ab".repeat(16), "relay.jsonl"),
        RUN_ID: "ab".repeat(16),
      },
    });
    const observation = await executor.run({ ...request(dir), runId: "ab".repeat(16) });
    const argv = JSON.parse(readFileSync(join(dir, "run", "argv.json"), "utf8")) as string[];
    expect(argv).toContain("tasks1/002-bigwig-h3k27ac-igg-peak-audit");
    expect(argv).toContain("devii-004-int");
    expect(argv).toContain("deepseek-v4-1-flash-261017");
    expect(argv).toContain(join(dir, "config.json"));
    expect(argv).toContain(String(tokenCap(TASK)));
    expect(argv.join(" ")).not.toContain("sk-secret");
    expect(argv.join(" ")).not.toContain("attest.key");
    expect(argv.join(" ")).not.toContain("HARNESS_ATTEST_KEY_FILE");
    expect(readFileSync(join(dir, "run", "base-url.txt"), "utf8")).toBe("https://example.test/v1");
    expect(observation.reward).toBe(1);
    expect(observation.tokens).toBe(4);
  });

  test("a scored run with no relay log or run id is usage_missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-usage-missing-"));
    const script = join(dir, "driver.mjs");
    writeFileSync(script, `
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
mkdirSync(run, { recursive: true });
writeFileSync(run + "/result.json", JSON.stringify({
  reward: 1, tokens: 0, wall_s: 1, timed_out: false, score_status: "scored"
}));
`);
    const executor = new CommandOptExecutor({
      command: [
        process.execPath, script,
        "--task", "{taskPath}",
        "--seed", "{seed}",
        "--run-dir", "{runDir}",
        "--model", "{model}",
        "--config", "{config}",
        "--network", "{network}",
        "--token-cap", "{tokenCap}",
        "--attest-dir", "{attestDir}",
      ],
      env: process.env,
    });
    const missingLog = await executor.run({ ...request(dir), runId: "ab".repeat(16) });
    expect(missingLog.scoreStatus).toBe("unscored");
    expect(missingLog.unscoredReason).toBe("usage_missing");
    expect(missingLog.tokens).toBe(0);
    expect(missingLog.reward).toBeNull();
    const missingId = await executor.run({ ...request(dir), runDir: join(dir, "run-2") });
    expect(missingId.scoreStatus).toBe("unscored");
    expect(missingId.unscoredReason).toBe("usage_missing");
    expect(missingId.tokens).toBe(0);
  });

  test("a marker placeholder is refused before spawn", () => {
    expect(() => renderExecutorCommand(
      ["python3", "--task", "{task}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}", "--marker", "{marker}"],
      request("/tmp"),
      "driver.py",
    )).toThrow(/marker/);
  });

  test("a missing driver placeholder fails before spawn", async () => {
    let spawned = false;
    expect(() => renderExecutorCommand(
      ["{driver}", "--task", "{task}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}"],
      request("/tmp"),
    )).toThrow(/HARNESS_OPT_DRIVER/);
    const executor = new CommandOptExecutor({
      command: ["{driver}", "--task", "{task}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}"],
      env: {},
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    });
    await expect(executor.run(request("/tmp"))).rejects.toThrow(/HARNESS_OPT_DRIVER/);
    expect(spawned).toBe(false);
  });

  test("i014 is rendered on devii-004-int", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-i014-"));
    const argv = renderExecutorCommand(
      ["python3", "--task", "{taskPath}", "--run-dir", "{runDir}", "--network", "{network}", "--attest-dir", "{attestDir}"],
      { ...request(dir), task: DEV_TASK, tokenCap: tokenCap(DEV_TASK) },
    );
    expect(DEV_TASK.network).toBe("devii-004-int");
    expect(argv).toContain("devii-004-int");
    expect(argv).not.toContain("open");
    expect(argv).not.toContain("shared");
    expect(argv).not.toContain("gateway-only");
  });
});

describe("scored relay log", () => {
  test("a scored run without relayLogRoot fails before checker copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-no-relay-"));
    const bare = request(dir);
    const { relayLogRoot: _ignored, ...missing } = bare;
    expect(() => assertScoredRelayLog(undefined)).toThrow(/relayLogRoot/);
    expect(() => assertScoredRelayLog("")).toThrow(/relayLogRoot/);
    expect(() => writeRunArtifacts(missing, {
      reward: 1,
      tokens: 1,
      wallS: 1,
      timedOut: false,
      tWrite: 1,
      tEnd: 2,
      assistantTs: [],
    })).toThrow(/relayLogRoot/);
    writeFileSync(join(dir, "config.json"), "{}\n");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(join(dir, "run", "result.json"), `${JSON.stringify({ reward: 1, tokens: 1, wall_s: 1, timed_out: false, score_status: "scored" })}\n`);
    const executor = new CommandOptExecutor({
      command: ["python3", "--task", "{taskPath}", "--run-dir", "{runDir}", "--attest-dir", "{attestDir}"],
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    await expect(executor.run(missing)).rejects.toThrow(/relayLogRoot/);
  });
});

describe("host run id", () => {
  test("is 16 random bytes and not a hash of the run directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-run-id-"));
    const first = hostRunId();
    const second = hostRunId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(createHash("sha256").update(dir).digest("hex"));
  });
});

describe("executor command source", () => {
  test("does not bake box paths into the loop", () => {
    const sources = ["opt-executor.ts", "opt-loop.ts", "ewi.ts", "activation.ts", "attestation.ts", "role-spawn.ts", "../cli.ts"].map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");
    expect(sources).not.toContain("/workspace/harness-opt-runs");
    expect(sources).not.toContain("/workspace/contest-data");
    expect(sources).not.toContain("pi-bio-harness@sha256");
    expect(sources).not.toContain("newapi.ai-modeling.top");
    expect(sources).not.toContain("/home/box");
  });
});
