import { pathToFileURL } from "node:url";
import { flag } from "../src/args";
import { Lineage } from "../src/lineage";
import { getSelector } from "../src/modules/selector";

/** Read a lineage directory and print the chosen parent as JSON. */
export function selectParent(root: string, selectorId = "greedy") {
  const lineage = new Lineage(root);
  return getSelector(selectorId).pick(lineage).toJSON();
}

function main(argv: readonly string[]): number {
  const root = flag(argv, "--root");
  if (!root) {
    process.stderr.write("usage: bun bin/select.ts --root <lineage-dir> [--selector greedy]\n");
    return 1;
  }
  try {
    process.stdout.write(`${JSON.stringify(selectParent(root, flag(argv, "--selector") ?? "greedy"))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
