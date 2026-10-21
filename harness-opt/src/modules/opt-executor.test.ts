import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandOptExecutor, renderExecutorCommand, tokenCap, type OptRunRequest, type OptTask } from "./opt-executor";

const TASK: OptTask = {
  id: "002",
  path: "tasks1/002-bigwig-h3k27ac-igg-peak-audit",
  split: "held-out",
  network: "gateway-only",
  tokenW: 2_383_647,
};

function request(dir: string): OptRunRequest {
  return {
    task: TASK,
    seed: 1,
    arm: "candidate",
    configPath: join(dir, "config.json"),
    runDir: join(dir, "run"),
    model: "deepseek-v4-1-flash-261017",
    tokenCap: tokenCap(TASK),
  };
}

describe("pluggable executor command", () => {
  test("fills the driver template and keeps the key out of argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-cmd-"));
    const script = join(dir, "driver.mjs");
    writeFileSync(script, `
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
const run = get("--run-dir");
mkdirSync(run, { recursive: true });
writeFileSync(run + "/argv.json", JSON.stringify(args));
writeFileSync(run + "/base-url.txt", process.env.BASE_URL ?? "");
writeFileSync(run + "/result.json", JSON.stringify({
  reward: 1, tokens: 4, wall_s: 2, timed_out: false, score_status: "scored"
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
      ],
      env: { ...process.env, BASE_URL: "https://example.test/v1", API_KEY: "sk-secret" },
    });
    const observation = await executor.run(request(dir));
    const argv = JSON.parse(readFileSync(join(dir, "run", "argv.json"), "utf8")) as string[];
    expect(argv).toContain("tasks1/002-bigwig-h3k27ac-igg-peak-audit");
    expect(argv).toContain("gateway-only");
    expect(argv).toContain("deepseek-v4-1-flash-261017");
    expect(argv).toContain(join(dir, "config.json"));
    expect(argv).toContain(String(tokenCap(TASK)));
    expect(argv.join(" ")).not.toContain("sk-secret");
    expect(readFileSync(join(dir, "run", "base-url.txt"), "utf8")).toBe("https://example.test/v1");
    expect(observation.reward).toBe(1);
    expect(observation.tokens).toBe(4);
  });

  test("a marker placeholder is refused before spawn", () => {
    expect(() => renderExecutorCommand(
      ["python3", "--task", "{task}", "--run-dir", "{runDir}", "--marker", "{marker}"],
      request("/tmp"),
      "driver.py",
    )).toThrow(/marker/);
  });

  test("a missing driver placeholder fails before spawn", async () => {
    let spawned = false;
    expect(() => renderExecutorCommand(["{driver}", "--task", "{task}", "--run-dir", "{runDir}"], request("/tmp"))).toThrow(/HARNESS_OPT_DRIVER/);
    const executor = new CommandOptExecutor({
      command: ["{driver}", "--task", "{task}", "--run-dir", "{runDir}"],
      env: {},
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    });
    await expect(executor.run(request("/tmp"))).rejects.toThrow(/HARNESS_OPT_DRIVER/);
    expect(spawned).toBe(false);
  });
});

describe("executor command source", () => {
  test("does not bake box paths into the loop", () => {
    const sources = ["opt-executor.ts", "opt-loop.ts", "ewi.ts", "activation.ts", "../cli.ts"].map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");
    expect(sources).not.toContain("/workspace/harness-opt-runs");
    expect(sources).not.toContain("/workspace/contest-data");
    expect(sources).not.toContain("pi-bio-harness@sha256");
    expect(sources).not.toContain("newapi.ai-modeling.top");
  });
});
