import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flag, hasFlag } from "./args";
import { runEmpty } from "./empty-run";
import { runOptLoop, runOptOnce } from "./modules/opt-loop";
import { CommandOptExecutor, type OptTask } from "./modules/opt-executor";
import type { OptRoleName } from "./modules/role-spawn";
import { dispatchHarnessCommand, formatCommandResult, runClosedLoopDemo, type CommandResult } from "./session";

const USAGE = [
  "usage: harness-opt <empty|run|start|step|status|gate|stop|demo|optimize|optimize-one> [--out dir]",
  "  empty                 fixture round; held-out is written to sealed/heldout-score.json",
  "  run --dev <dir>       one real round over that task bank; thresholds are required",
  "  start                 required unless files exist: --min-delta --tts-baseline --held-out-floor --token-budget --max-local-runs --max-wall-s --max-submits --heldout-score",
  "  step|status|gate|stop  continue the run in --out (default <cwd>/.harness-opt)",
  "  demo                  one closed loop on the sample trace; prints per-stage status",
  "  optimize --dry-run --attest-root <dir> --attest-key-file <file> --harness <file> --control-attest <dir> --task <id> --task-path <path> --network devii-004-int --token-w <n> --round0-trace <path> --round0-sha <sha>",
  "                        one loop; task and round-0 path/sha are required and have no default",
  "  optimize --execute --pi-bin <path> --attest-root <dir> --attest-key-file <file> --harness <file> --control-attest <dir> [--executor-cmd '<json argv>'] [--stop-before-run] [--role-max-tokens <role>=<n>] --task <id> --task-path <path> --network devii-004-int --token-w <n> --round0-trace <path> --round0-sha <sha>",
  "                        needs BASE_URL; --pi-bin launches the existing pi-subagents roles through the relay; without --pi-bin execute fails; --stop-before-run writes the closure and stops before once/docker",
  "  optimize-one --attest-root <dir> --attest-key-file <file> --harness <file> --config <file> --control-config <file> --knob <name> --executor-cmd '<json argv>' --task <id> --task-path <path> --network devii-004-int --token-w <n>",
  "                        one candidate seed to prove activation; task flags are required",
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
  const stopBeforeRun = hasFlag(argv, "--stop-before-run");
  if (stopBeforeRun && !execute) {
    process.stderr.write("optimize --stop-before-run needs --execute\n");
    return 1;
  }
  const roleCaps = roleMaxTokensFlag(argv);
  if (roleCaps instanceof Error) {
    process.stderr.write(`${roleCaps.message}\n`);
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
    if (raw) {
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
  }
  const driver = flag(argv, "--driver");
  const piBin = flag(argv, "--pi-bin");
  const attestRoot = flag(argv, "--attest-root");
  const attestKeyFile = flag(argv, "--attest-key-file") ?? process.env.HARNESS_ATTEST_KEY_FILE;
  const harnessPath = flag(argv, "--harness");
  const controlConfigPath = flag(argv, "--control-config");
  const controlAttests = repeatFlag(argv, "--control-attest");
  if (!attestRoot || !attestKeyFile || !harnessPath) {
    process.stderr.write("optimize needs --attest-root, --attest-key-file (or HARNESS_ATTEST_KEY_FILE), and --harness\n");
    return 1;
  }
  let task: OptTask;
  let round0: { readonly path: string; readonly sha: string };
  try {
    task = taskFromFlags(argv, "optimize");
    round0 = round0FromFlags(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const result = await runOptLoop({
      out,
      mode: dry ? "dry-run" : "execute",
      attestRoot,
      attestKeyFile,
      harnessPath,
      controlAttests,
      task,
      round0TracePath: round0.path,
      round0TraceSha: round0.sha,
      ...(controlConfigPath ? { controlConfigPath } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      ...(ewiThresholdSec !== undefined ? { ewiThresholdSec } : {}),
      ...(executorCommand ? { executorCommand } : {}),
      ...(driver ? { driver } : {}),
      ...(execute && piBin ? { piBin } : {}),
      ...(stopBeforeRun ? { stopBeforeRun: true } : {}),
      ...(Object.keys(roleCaps).length > 0 ? { roleMaxTokens: roleCaps } : {}),
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
  const attestRoot = flag(argv, "--attest-root");
  const attestKeyFile = flag(argv, "--attest-key-file") ?? process.env.HARNESS_ATTEST_KEY_FILE;
  const harnessPath = flag(argv, "--harness");
  if (!configPath || !controlConfigPath || !knob || !rawCommand || !attestRoot || !attestKeyFile || !harnessPath) {
    process.stderr.write("optimize-one needs --config, --control-config, --knob, --executor-cmd, --attest-root, --attest-key-file, and --harness\n");
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
    task = taskFromFlags(argv, "optimize-one");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const out = flag(argv, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-once-"));
  const driver = flag(argv, "--driver");
  try {
    const result = await runOptOnce({
      out,
      attestRoot,
      attestKeyFile,
      harnessPath,
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

function taskFromFlags(argv: readonly string[], command: string): OptTask {
  const missing = ["--task", "--task-path", "--network", "--token-w"].filter((name) => flag(argv, name) === undefined);
  if (missing.length > 0) throw new Error(`${command} needs ${missing.join(", ")}`);
  const id = flag(argv, "--task") ?? "";
  const path = flag(argv, "--task-path") ?? "";
  const network = flag(argv, "--network") ?? "";
  if (id.trim() === "" || path.trim() === "") throw new Error(`${command} needs --task and --task-path`);
  if (network !== "devii-004-int") throw new Error(`${command} --network must be devii-004-int`);
  const tokenW = Number(flag(argv, "--token-w"));
  if (!Number.isFinite(tokenW) || tokenW <= 0) throw new Error(`${command} --token-w must be a positive number`);
  return { id, path, split: "dev", network, tokenW };
}

function round0FromFlags(argv: readonly string[]): { readonly path: string; readonly sha: string } {
  const missing = ["--round0-trace", "--round0-sha"].filter((name) => flag(argv, name) === undefined);
  if (missing.length > 0) throw new Error(`optimize needs ${missing.join(", ")}`);
  const path = flag(argv, "--round0-trace") ?? "";
  const sha = flag(argv, "--round0-sha") ?? "";
  if (path.trim() === "") throw new Error("optimize needs --round0-trace");
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("optimize --round0-sha must be 64 hex characters");
  return { path, sha };
}

function seedFlag(argv: readonly string[]): number | Error {
  const raw = flag(argv, "--seed");
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return new Error("optimize-one --seed must be a non-negative integer");
  return value;
}

const ROLE_CAP_NAMES = ["gap-finder", "innovator", "critic", "ranker", "reviewer-gate"] as const;

function roleMaxTokensFlag(argv: readonly string[]): Partial<Record<OptRoleName, number>> | Error {
  const caps: Partial<Record<OptRoleName, number>> = {};
  for (const raw of repeatFlag(argv, "--role-max-tokens")) {
    const match = /^([a-z-]+)=(\d+)$/.exec(raw);
    if (!match?.[1] || !match[2]) return new Error("optimize --role-max-tokens must be role=tokens");
    if (!(ROLE_CAP_NAMES as readonly string[]).includes(match[1])) {
      return new Error("optimize --role-max-tokens role must be gap-finder, innovator, critic, ranker, or reviewer-gate");
    }
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value <= 0) return new Error("optimize --role-max-tokens must be a positive integer");
    caps[match[1] as OptRoleName] = value;
  }
  return caps;
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
