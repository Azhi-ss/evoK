import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addUsage, EMPTY_USAGE, usageTokens, type UsageParts } from "../pi/usage";
import type { TaskRef } from "../types";
import { ExecutorUnavailable, type ExecutionTrace, type HarnessExecutor, type TraceStep } from "./executor";

export interface DeviiExecutorOptions {
  readonly python?: string;
  readonly scriptPath?: string;
  readonly runRoot?: string;
  readonly harnessHome?: string;
  readonly taskRoot?: string;
  readonly seed?: number;
  readonly arm?: string;
  readonly memoryPath?: string;
  readonly testsDir?: string;
  readonly modelName?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const defaultScript = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/devii_one.py");

function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const secret of [env.API_KEY, env.BOHR_ACCESS_KEY]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function runDirectory(root: string, taskId: string, seed: string, arm: string): string {
  if (taskId.trim() === "" || taskId.includes("..") || taskId.startsWith("/") || taskId.includes("\\")) {
    throw new Error(`unsafe task id: ${taskId}`);
  }
  return join(root, taskId, seed, arm);
}

interface TraceLine {
  readonly type?: string;
  readonly tool?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly result?: unknown;
  readonly usage?: Partial<UsageParts>;
}

function stepsFromTrace(lines: readonly TraceLine[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.type !== "tool_call" || typeof line.tool !== "string") continue;
    let result: TraceLine | undefined;
    for (let later = index + 1; later < lines.length; later += 1) {
      const candidate = lines[later];
      if (candidate?.type === "tool_call") break;
      if (candidate?.type === "tool_result" && candidate.tool === line.tool) {
        result = candidate;
        break;
      }
    }
    const failed = result?.isError === true;
    steps.push({
      id: `s${steps.length + 1}`,
      tool: line.tool,
      args: line.args && typeof line.args === "object" ? line.args : {},
      ok: !failed,
      ...(failed ? { error: typeof result?.result === "string" ? result.result : "tool error" } : {}),
    });
  }
  return steps;
}

function readTrace(file: string, env: NodeJS.ProcessEnv): { readonly lines: TraceLine[]; readonly usage: UsageParts } {
  if (!existsSync(file)) return { lines: [], usage: EMPTY_USAGE };
  const lines: TraceLine[] = [];
  let usage = EMPTY_USAGE;
  for (const raw of redact(readFileSync(file, "utf8"), env).split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceLine;
      lines.push(parsed);
      if (parsed.type === "assistant_message") usage = addUsage(usage, parsed.usage);
    } catch {
      /* a truncated trace line does not invent tokens */
    }
  }
  return { lines, usage };
}

function labelsFor(failed: boolean, lines: readonly TraceLine[]): string[] {
  if (!failed) return [];
  if (lines.some((line) => line.type === "timeout_abort")) return ["timeout"];
  return ["format-invalid"];
}

/**
 * One dev-II task through scripts/devii_one.py.
 * Reward comes from reward.txt. Tokens are the sum of assistant_message usage.
 */
export class DeviiExecutor implements HarnessExecutor {
  readonly name = "devii";

  constructor(private readonly options: DeviiExecutorOptions = {}) {}

  async run(task: TaskRef, configPath: string): Promise<ExecutionTrace> {
    if (task.split !== "dev") throw new Error("devii executor refuses held-out tasks");
    const env = this.options.env ?? process.env;
    const runRoot = this.options.runRoot ?? env.HARNESS_OPT_RUN_ROOT ?? "";
    const harnessHome = this.options.harnessHome ?? env.HARNESS_OPT_HARNESS_HOME ?? "";
    if (!runRoot || !harnessHome) {
      throw new ExecutorUnavailable(this.name, "HARNESS_OPT_RUN_ROOT and HARNESS_OPT_HARNESS_HOME are required");
    }
    const script = this.options.scriptPath ?? defaultScript;
    if (!existsSync(script)) throw new ExecutorUnavailable(this.name, `runner script is missing: ${script}`);
    const seed = String(this.options.seed ?? env.HARNESS_OPT_SEED ?? "0");
    const arm = this.options.arm ?? env.HARNESS_OPT_ARM ?? "default";
    const taskRoot = this.options.taskRoot ?? env.HARNESS_OPT_TASK_ROOT ?? "";
    const taskPath = taskRoot ? join(taskRoot, task.path) : task.path;
    const taskDir = taskPath.endsWith("instruction.md") ? dirname(taskPath) : taskPath;
    const memoryPath = this.options.memoryPath ?? env.HARNESS_MEMORY_PATH;
    const testsDir = this.options.testsDir ?? env.HARNESS_OPT_TESTS_DIR;
    const args = [
      script,
      "--task-id", task.id,
      "--task-dir", taskDir,
      "--seed", seed,
      "--arm", arm,
      "--config", configPath,
      "--run-root", runRoot,
      "--harness", harnessHome,
      "--model-name", this.options.modelName ?? "deepseek-v4.1-flash",
    ];
    if (memoryPath) args.push("--memory", memoryPath);
    if (testsDir) args.push("--tests", testsDir);
    const child = spawnSync(this.options.python ?? "python3", args, {
      encoding: "utf8",
      env: { ...env },
    });
    const runDir = runDirectory(runRoot, task.id, seed, arm);
    if (child.error) {
      throw new ExecutorUnavailable(this.name, redact(child.error.message, env));
    }
    const rewardPath = join(runDir, "verifier", "reward.txt");
    const traced = readTrace(join(runDir, "trace.jsonl"), env);
    if (!existsSync(rewardPath)) {
      return {
        taskId: task.id,
        steps: stepsFromTrace(traced.lines),
        reward: 0,
        tokens: usageTokens(traced.usage),
        usage: traced.usage,
        failed: true,
        labels: labelsFor(true, traced.lines),
        executor: this.name,
      };
    }
    const raw = readFileSync(rewardPath, "utf8").trim();
    const reward = Number(raw);
    const usable = raw !== "" && Number.isFinite(reward) && reward >= 0 && reward <= 1;
    if (!usable) {
      return {
        taskId: task.id,
        steps: stepsFromTrace(traced.lines),
        reward: 0,
        tokens: usageTokens(traced.usage),
        usage: traced.usage,
        failed: true,
        labels: ["format-invalid"],
        executor: this.name,
      };
    }
    return {
      taskId: task.id,
      steps: stepsFromTrace(traced.lines),
      reward,
      tokens: usageTokens(traced.usage),
      usage: traced.usage,
      failed: false,
      labels: [],
      executor: this.name,
    };
  }
}
