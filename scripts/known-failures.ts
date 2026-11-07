#!/usr/bin/env bun
/**
 * Known host-failure gate.
 *
 * This suite has a fixed set of failures that come from the host/SDK environment
 * (symlinked temp dirs, a missing `python` shim, the plugin barrel), not from the
 * code under review. `docs/agents/known-failures.txt` records the accepted set, so
 * "no failure outside the accepted set" is either proven or refused instead of
 * being eyeballed from a 280KB log with an ad-hoc grep/sed/diff.
 *
 * The accepted set is a UNION across hosts: a host may reproduce fewer of them,
 * never a name outside the set. That is why `--check` ignores a failure that no
 * longer reproduces (informational) and fails only on a new one.
 *
 *   bun run test:known-failures            # run the suite, print the current set
 *   bun run test:known-failures:check      # exit 1 if a failure is outside the accepted union
 *   bun scripts/known-failures.ts --update # merge this host's failures into the union
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "docs", "agents", "known-failures.txt");

/** Bun prints one `(fail) <name> [<ms>]` line per failure (twice in the summary). */
export function failuresFrom(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    // Column 0 only: an indented `(fail)` belongs to captured test output, not
    // to the runner's own result list.
    const match = /^\(fail\) (.+?)(?: \[[0-9.]+ms\])?\r?$/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

/**
 * The gate's whole judgement, kept pure: a name outside the accepted union is a
 * failure; a union name this host did not reproduce is informational.
 */
export function classifyFailures(current: ReadonlySet<string>, accepted: ReadonlySet<string>): {
  readonly added: readonly string[];
  readonly absent: readonly string[];
} {
  return {
    added: [...current].filter((name) => !accepted.has(name)).sort(),
    absent: [...accepted].filter((name) => !current.has(name)).sort(),
  };
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
    // Union, never replace: shrinking the accepted set is a reviewed manual
    // edit, so one host can never drop another host's accepted failures.
    const previous = await readBaseline().catch(() => new Set<string>());
    const merged = [...new Set([...previous, ...sorted])].sort();
    const body = [
      "# Accepted host/SDK failures for `bun test --rerun-all-tests`, as a UNION across hosts.",
      "# `--update` merges this host's failures in; removing a name is a reviewed manual edit.",
      "# A NEW failure is never added to make a gate pass. See docs/agents/known-failures.md.",
      "",
      ...merged,
      "",
    ].join("\n");
    await writeFile(BASELINE, body, "utf8");
    process.stdout.write(`known-failures: ${merged.length} accepted (${merged.length - previous.size} new), wrote ${BASELINE}\n`);
    return 0;
  }

  const baseline = await readBaseline();
  const { added, absent } = classifyFailures(current, baseline);
  const absentNote = `${absent.length} accepted failure(s) did not reproduce on this host`;
  process.stdout.write(`known-failures: ${sorted.length} current, ${baseline.size} accepted\n`);
  if (mode !== "--check") {
    // `--print` is informational: reading the current set is not a gate.
    for (const name of sorted) process.stdout.write(`  ${name}\n`);
    if (absent.length > 0) process.stdout.write(`  ${absentNote} (the union stays)\n`);
    return 0;
  }
  // A host reproducing FEWER failures is normal and not a gate failure; only a
  // name outside the accepted union is.
  if (added.length === 0) {
    if (absent.length > 0) process.stdout.write(`  ${absentNote} (informational)\n`);
    return 0;
  }
  for (const name of added) process.stdout.write(`  NEW failure (outside the accepted union): ${name}\n`);
  process.stdout.write(`  ${absentNote}\n`);
  return 1;
}

if (import.meta.main) process.exit(await main());
