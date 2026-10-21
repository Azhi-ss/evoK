import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flag, hasFlag } from "./args";
import { runEmpty } from "./empty-run";
import { runOptLoop } from "./modules/opt-loop";
import { dispatchHarnessCommand, formatCommandResult, runClosedLoopDemo, type CommandResult } from "./session";

const USAGE = [
  "usage: harness-opt <empty|run|start|step|status|gate|stop|demo|optimize> [--out dir]",
  "  empty                 fixture round; held-out is written to sealed/heldout-score.json",
  "  run --dev <dir>       one real round over that task bank; thresholds are required",
  "  start                 required unless files exist: --min-delta --tts-baseline --held-out-floor --token-budget --max-local-runs --max-wall-s --max-submits --heldout-score",
  "  step|status|gate|stop  continue the run in --out (default <cwd>/.harness-opt)",
  "  demo                  one closed loop on the sample trace; prints per-stage status",
  "  optimize --dry-run    i014 loop with stub roles and no model call",
  "  optimize --execute --executor-cmd '<json argv>'   one run per placeholder command; needs BASE_URL",
].join("\n");

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "empty") return emptyCommand(rest);
  if (command === "demo") return demoCommand(rest);
  if (command === "optimize") return optimizeCommand(rest);
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
  try {
    const result = await runOptLoop({
      out,
      mode: dry ? "dry-run" : "execute",
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
