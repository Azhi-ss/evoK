#!/usr/bin/env bun
/**
 * Known host-failure gate.
 *
 * This suite has a fixed set of failures that come from the host/SDK environment
 * (symlinked temp dirs, a missing `python` shim, the plugin barrel), not from the
 * code under review. `docs/agents/known-failures.txt` records the accepted set, so
 * "the failures are identical to the baseline" is either proven or refused instead
 * of being eyeballed from a 280KB log with an ad-hoc grep/sed/diff.
 *
 *   bun run test:known-failures            # run the suite, print the current set
 *   bun run test:known-failures:check      # exit 1 unless the set matches the baseline
 *   bun scripts/known-failures.ts --update # rewrite the baseline (review the diff!)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "docs", "agents", "known-failures.txt");

/** Bun prints one `(fail) <name> [<ms>]` line per failure (twice in the summary). */
function failuresFrom(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const match = /^\(fail\) (.+?)(?: \[[0-9.]+ms\])?$/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return names;
}

async function readBaseline(): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(BASELINE, "utf8");
  } catch {
    throw new Error(`no baseline at ${BASELINE}; create one with --update and review it`);
  }
  return new Set(raw.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")));
}

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "--print";
  if (!["--print", "--check", "--update"].includes(mode)) {
    process.stderr.write(`known-failures: unknown flag ${mode}; use --print, --check or --update\n`);
    return 2;
  }
  const run = Bun.spawn(["bun", "test", "--rerun-all-tests"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const output = `${stdout}\n${stderr}`;
  const current = failuresFrom(output);
  if (!/\((?:pass|fail)\) /.test(output)) {
    // The runner itself failed before listing a single test: never read that as
    // "no failures".
    process.stderr.write(`known-failures: could not read a test result from the runner\n${output.slice(-4000)}`);
    return 2;
  }

  const sorted = [...current].sort();
  if (mode === "--update") {
    const body = [
      "# Accepted host/SDK failures for `bun test --rerun-all-tests` on the reference host.",
      "# Regenerate with `bun scripts/known-failures.ts --update` and review the diff: a NEW",
      "# failure is never added to make a gate pass. See docs/agents/known-failures.md.",
      "",
      ...sorted,
      "",
    ].join("\n");
    await writeFile(BASELINE, body, "utf8");
    process.stdout.write(`known-failures: wrote ${sorted.length} names to ${BASELINE}\n`);
    return 0;
  }

  const baseline = await readBaseline();
  const added = sorted.filter((name) => !baseline.has(name));
  const fixed = [...baseline].filter((name) => !current.has(name)).sort();
  process.stdout.write(`known-failures: ${sorted.length} current, ${baseline.size} accepted\n`);
  if (mode !== "--check") {
    // `--print` is informational: reading the current set is not a gate.
    for (const name of sorted) process.stdout.write(`  ${name}\n`);
    return 0;
  }
  if (added.length === 0 && fixed.length === 0) return 0;
  for (const name of added) process.stdout.write(`  NEW failure: ${name}\n`);
  for (const name of fixed) process.stdout.write(`  no-longer-failing (update the baseline): ${name}\n`);
  return 1;
}

process.exit(await main());
