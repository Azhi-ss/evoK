import { pathToFileURL } from "node:url";
import { flag } from "../src/args";
import { writeContained } from "../src/containment";
import { Lineage } from "../src/lineage";

/** Append one lineage event. The log is `lineage.jsonl` inside `root`. */
export function recordEvent(root: string, kind: string, fields: Record<string, unknown> = {}): void {
  new Lineage(root).log(kind, fields);
}

/** Write `run_state.json` beside the lineage log. */
export function writeRunState(root: string, state: unknown): string {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  try {
    return writeContained(root, "run_state.json", body);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    try {
      new Lineage(root).log("contract", { role: "orchestrator", tool: "write", path: "run_state.json", err });
    } catch {
      // The write stays refused when the contract line itself cannot be stored.
    }
    throw error instanceof Error ? error : new Error(err);
  }
}

function main(argv: readonly string[]): number {
  const root = flag(argv, "--root");
  const kind = flag(argv, "--kind");
  if (!root || !kind) {
    process.stderr.write("usage: bun bin/record.ts --root <lineage-dir> --kind <event> [--json '{...}']\n");
    return 1;
  }
  const raw = flag(argv, "--json");
  let fields: Record<string, unknown> = {};
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.stderr.write("--json must be an object\n");
      return 1;
    }
    fields = parsed as Record<string, unknown>;
  }
  recordEvent(root, kind, fields);
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
