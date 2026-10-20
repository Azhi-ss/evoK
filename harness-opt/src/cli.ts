import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flag } from "./args";
import { runEmpty } from "./empty-run";
import { dispatchHarnessCommand, formatCommandResult, runClosedLoopDemo, type CommandResult } from "./session";

const USAGE = [
  "usage: harness-opt <empty|run|start|step|status|gate|stop|demo> [--out dir]",
  "  empty                 fixture round; held-out is written to sealed/heldout-score.json",
  "  run --dev <dir>       one real round over that task bank; thresholds are required",
  "  start                 required unless files exist: --min-delta --tts-baseline --held-out-floor --token-budget --max-local-runs --max-wall-s --max-submits --heldout-score",
  "  step|status|gate|stop  continue the run in --out (default <cwd>/.harness-opt)",
  "  demo                  one closed loop on the sample trace; prints per-stage status",
].join("\n");

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "empty") return emptyCommand(rest);
  if (command === "demo") return demoCommand(rest);
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
