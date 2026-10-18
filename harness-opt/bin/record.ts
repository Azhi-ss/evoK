import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flag } from "../src/args";
import { Lineage } from "../src/lineage";

/** Append one lineage event. The log is `lineage.jsonl` inside `root`. */
export function recordEvent(root: string, kind: string, fields: Record<string, unknown> = {}): void {
  new Lineage(root).log(kind, fields);
}

/** Write `run_state.json` beside the lineage log. */
export function writeRunState(root: string, state: unknown): string {
  mkdirSync(root, { recursive: true });
  const target = join(root, "run_state.json");
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
  return target;
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
