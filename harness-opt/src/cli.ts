import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runEmpty } from "./empty-run";
import { loadTaskBank } from "./modules/probe";

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command !== "empty" && command !== "run") {
    process.stderr.write("usage: harness-opt empty|run [--out dir] [--dev dir] [--model id]\n");
    return 1;
  }
  const out = flag(rest, "--out") ?? mkdtempSync(join(tmpdir(), "harness-opt-"));
  const modelId = flag(rest, "--model");
  const bank = command === "run" ? loadBank(rest) : null;
  if (bank === "missing") return 1;
  const result = runEmpty({
    out,
    ...(modelId ? { modelId } : {}),
    ...(bank ? { devTasks: bank.dev, heldOutTasks: bank.heldOut.readForEvidenceGate() } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    out,
    phases: result.phases,
    visits: result.visits,
    accepted: result.accepted,
    stoppedReason: result.stoppedReason,
    submitted: result.receipt?.submitted ?? false,
  }, null, 2)}\n`);
  return 0;
}

function loadBank(argv: readonly string[]) {
  const dev = flag(argv, "--dev");
  if (!dev) {
    process.stderr.write("harness-opt run requires --dev <task-bank>\n");
    return "missing" as const;
  }
  const bank = loadTaskBank(dev);
  if (bank.dev.length === 0) {
    process.stderr.write("task bank has no dev tasks\n");
    return "missing" as const;
  }
  return bank;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
