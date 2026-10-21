import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flag, hasFlag } from "./args";
import { runEmpty } from "./empty-run";
import { DEV_TASK, runOptLoop, runOptOnce } from "./modules/opt-loop";
import { CommandOptExecutor, type OptTask } from "./modules/opt-executor";
import { dispatchHarnessCommand, formatCommandResult, runClosedLoopDemo, type CommandResult } from "./session";

const USAGE = [
  "usage: harness-opt <empty|run|start|step|status|gate|stop|demo|optimize|optimize-one> [--out dir]",
  "  empty                 fixture round; held-out is written to sealed/heldout-score.json",
  "  run --dev <dir>       one real round over that task bank; thresholds are required",
  "  start                 required unless files exist: --min-delta --tts-baseline --held-out-floor --token-budget --max-local-runs --max-wall-s --max-submits --heldout-score",
  "  step|status|gate|stop  continue the run in --out (default <cwd>/.harness-opt)",
  "  demo                  one closed loop on the sample trace; prints per-stage status",
  "  optimize --dry-run --control-trace <file>   i014 loop with stub roles and no model call",
  "  optimize --execute --control-trace <file> --executor-cmd '<json argv>'   needs BASE_URL",
  "  optimize-one --config <file> --control-config <file> --knob <name> --executor-cmd '<json argv>'",
  "                        one candidate seed to prove activation; not the final comparison",
].join("\n");

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "empty") return emptyCommand(rest);
  if (command === "demo") return demoCommand(rest);
  if (command === "optimize") return optimizeCommand(rest);
  if (command === "optimize-one") return optimizeOneCommand(rest);
  if (command === "run") return runCommand(rest);
  if (command === "start" || command === "step" || command === "status" || command === "gate" || command === "stop") {
    const commandResult = await dispatchHarnessCommand([command, ...rest], { cwd: process.cwd() });
    writeResult(commandResult);
    return commandResult.ok ? 0 : 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

async function emptyCommand(argv: readonly string[]): Promise<number> {
  const out = flag(argv, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-"));
  const modelId = flag(argv, "--model");
  const result = await runEmpty({
    out,
    ...(modelId ? { modelId } : {}),
  });
  process.stdout.write(`${JSON.stringify({ out, ...result }, null, 2)}\n`);
  return 0;
}

async function demoCommand(argv: readonly string[]): Promise<number> {
  const out = flag(argv, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-demo-"));
  const commandResult = await runClosedLoopDemo(out, { cwd: process.cwd() });
  writeResult(commandResult);
  return commandResult.ok ? 0 : 1;
}

async function optimizeCommand(argv: readonly string[]): Promise<number> {
  const dry = hasFlag(argv, "--dry-run");
  const execute = hasFlag(argv, "--execute");
  if (!dry && !execute) {
    process.stderr.write("optimize needs --dry-run or --execute\n");
    return 1;
  }
  if (dry && execute) {
    process.stderr.write("optimize received both --dry-run and --execute\n");
    return 1;
  }
  const out = flag(argv, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-opt-"));
  const rounds = numberFlag(argv, "--rounds");
  const ewiThresholdSec = numberFlag(argv, "--ewi-threshold");
  if (rounds instanceof Error || ewiThresholdSec instanceof Error) {
    process.stderr.write(`${rounds instanceof Error ? rounds.message : ewiThresholdSec instanceof Error ? ewiThresholdSec.message : ""}\n`);
    return 1;
  }
  let executorCommand: readonly string[] | undefined;
  if (execute) {
    const raw = flag(argv, "--executor-cmd");
    if (!raw) {
      process.stderr.write("optimize --execute needs --executor-cmd as a JSON argv\n");
      return 1;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        process.stderr.write("optimize --executor-cmd must be a JSON array of strings\n");
        return 1;
      }
      executorCommand = parsed as string[];
    } catch {
      process.stderr.write("optimize --executor-cmd must be a JSON array of strings\n");
      return 1;
    }
  }
  const driver = flag(argv, "--driver");
  const controlTraces = repeatFlag(argv, "--control-trace");
  try {
    const result = await runOptLoop({
      out,
      mode: dry ? "dry-run" : "execute",
      controlTraces,
      ...(rounds !== undefined ? { rounds } : {}),
      ...(ewiThresholdSec !== undefined ? { ewiThresholdSec } : {}),
      ...(executorCommand ? { executorCommand } : {}),
      ...(driver ? { driver } : {}),
    });
    process.stdout.write(`${JSON.stringify({ out, ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function optimizeOneCommand(argv: readonly string[]): Promise<number> {
  if (!process.env.BASE_URL) {
    process.stderr.write("optimize-one needs BASE_URL\n");
    return 1;
  }
  const configPath = flag(argv, "--config");
  const controlConfigPath = flag(argv, "--control-config");
  const knob = flag(argv, "--knob");
  const rawCommand = flag(argv, "--executor-cmd");
  if (!configPath || !controlConfigPath || !knob || !rawCommand) {
    process.stderr.write("optimize-one needs --config, --control-config, --knob, and --executor-cmd\n");
    return 1;
  }
  let executorCommand: string[];
  try {
    const parsed = JSON.parse(rawCommand) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      process.stderr.write("optimize-one --executor-cmd must be a JSON array of strings\n");
      return 1;
    }
    executorCommand = parsed as string[];
  } catch {
    process.stderr.write("optimize-one --executor-cmd must be a JSON array of strings\n");
    return 1;
  }
  const seed = seedFlag(argv);
  if (seed instanceof Error) {
    process.stderr.write(`${seed.message}\n`);
    return 1;
  }
  let task: OptTask;
  try {
    task = taskFromFlags(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const out = flag(argv, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-once-"));
  const driver = flag(argv, "--driver");
  try {
    const result = await runOptOnce({
      out,
      configPath,
      controlConfigPath,
      knob,
      seed,
      task,
      executor: new CommandOptExecutor({
        command: executorCommand,
        ...(driver ? { driver } : {}),
      }),
    });
    process.stdout.write(`${JSON.stringify({ out, ...result }, null, 2)}\n`);
    return result.patchActive ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function taskFromFlags(argv: readonly string[]): OptTask {
  const id = flag(argv, "--task") ?? DEV_TASK.id;
  const path = flag(argv, "--task-path") ?? DEV_TASK.path;
  const network = flag(argv, "--network") ?? DEV_TASK.network;
  if (network !== "gateway-only" && network !== "shared") {
    throw new Error("optimize-one --network must be gateway-only or shared");
  }
  const rawWeight = flag(argv, "--token-w");
  const tokenW = rawWeight === undefined ? (id === DEV_TASK.id ? DEV_TASK.tokenW : Number.NaN) : Number(rawWeight);
  if (!Number.isFinite(tokenW) || tokenW <= 0) throw new Error("optimize-one --token-w must be a positive number");
  return { id, path, split: "dev", network, tokenW };
}

function seedFlag(argv: readonly string[]): number | Error {
  const raw = flag(argv, "--seed");
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return new Error("optimize-one --seed must be a non-negative integer");
  return value;
}

function repeatFlag(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    values.push(value);
  }
  return values;
}

function numberFlag(argv: readonly string[], name: string): number | undefined | Error {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (name === "--rounds" && !Number.isInteger(value)) || value <= 0) {
    return new Error(`optimize ${name} must be a positive ${name === "--rounds" ? "integer" : "number"}`);
  }
  return value;
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const dev = flag(argv, "--dev");
  if (!dev) {
    process.stderr.write("harness-opt run requires --dev <task-bank>\n");
    return 1;
  }
  const started = await dispatchHarnessCommand(["start", ...argv], { cwd: process.cwd() });
  writeResult(started);
  if (!started.ok) return 1;
  const stepped = await dispatchHarnessCommand(["step", "--out", started.root], { cwd: process.cwd() });
  writeResult(stepped);
  return stepped.ok ? 0 : 1;
}

function writeResult(commandResult: CommandResult): void {
  process.stdout.write(`${formatCommandResult(commandResult)}\n`);
  if (commandResult.panel.length > 0) process.stdout.write(`${commandResult.panel.join("\n")}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
