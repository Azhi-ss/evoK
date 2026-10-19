import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SandboxBoundary } from "../../src/execution/security-boundary";
import { flag, hasFlag } from "../src/args";
import { listTraceFiles } from "../src/traces";

/**
 * Host eval command for the typed gate and the submit gate.
 *
 * Held-out is readable only with `--gate`, and only `harnessopt_submit_gate`
 * is supposed to pass that flag. Agent tool lists do not include bash, so
 * a child cannot invoke this binary itself.
 *
 * `workflows/round.js` does not call this binary. `resolveRoundWorkflow`
 * only registers `bun bin/eval.ts --cand <id> --split dev` as a host command.
 * Dev scores still fail closed: they come from executor traces under
 * `traces/<cand>/`, never from `fixtureScore` or `tokens` on the candidate.
 *
 * TODO(harness-opt/design/2026-10-18-pi-subagents-setup.md §7): whether a
 * bare workflow script may splice `args` into `gate.command` is unverified.
 * The named-resource string is built in `resolveRoundWorkflow` instead.
 */

export type EvalSplit = "dev" | "dev_small" | "dev_full" | "heldout";

export interface EvalResult {
  readonly ok: boolean;
  readonly scores: readonly number[];
  readonly split: EvalSplit;
  readonly tokens: number;
}

const SPLITS = new Set<EvalSplit>(["dev", "dev_small", "dev_full", "heldout"]);

export function runEval(options: {
  readonly root: string;
  readonly cand: string;
  readonly split: string;
  readonly gate: boolean;
}): EvalResult {
  if (!isCandId(options.cand)) throw new Error("cand must be a single relative id");
  if (!SPLITS.has(options.split as EvalSplit)) throw new Error(`unknown split: ${options.split}`);
  const split = options.split as EvalSplit;
  if (split === "heldout" && !options.gate) {
    throw new Error("held-out is only readable from harnessopt_submit_gate (--gate)");
  }
  const boundary = new SandboxBoundary({
    root: options.root,
    network: "none",
    allowBash: false,
    allowedTools: ["read"],
  });
  if (split === "heldout") {
    const scorePath = boundary.assertPath("sealed/heldout-score.json", "read");
    const body = JSON.parse(readFileSync(scorePath, "utf8")) as { score?: unknown; tokens?: unknown };
    const score = body.score;
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("held-out score file has no numeric score");
    return { ok: true, scores: [score], split, tokens: typeof body.tokens === "number" ? body.tokens : 0 };
  }
  return readTraceScores(boundary, options.cand, split);
}

function readTraceScores(
  boundary: SandboxBoundary,
  cand: string,
  split: EvalSplit,
): EvalResult {
  let files: readonly string[];
  try {
    const traceDir = boundary.assertPath(`traces/${cand}`, "read");
    files = listTraceFiles(traceDir);
  } catch {
    throw new Error(`dev score requires executor traces for ${cand}`);
  }
  if (files.length === 0) throw new Error(`dev score requires executor traces for ${cand}`);
  const scores: number[] = [];
  let tokens = 0;
  for (const rel of files) {
    const tracePath = boundary.assertPath(`traces/${cand}/${rel}`, "read");
    let body: { reward?: unknown; tokens?: unknown };
    try {
      body = JSON.parse(readFileSync(tracePath, "utf8")) as { reward?: unknown; tokens?: unknown };
    } catch {
      throw new Error(`dev score requires executor traces for ${cand}`);
    }
    const reward = body.reward;
    if (typeof reward !== "number" || !Number.isFinite(reward) || reward < 0 || reward > 1) {
      throw new Error(`dev score requires executor traces for ${cand}`);
    }
    if (typeof body.tokens !== "number" || !Number.isFinite(body.tokens) || body.tokens < 0) {
      throw new Error(`dev score requires executor traces for ${cand}`);
    }
    scores.push(reward);
    tokens += body.tokens;
  }
  return { ok: true, scores, split, tokens };
}

function isCandId(cand: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(cand);
}

function main(argv: readonly string[]): number {
  const cand = flag(argv, "--cand");
  const split = flag(argv, "--split") ?? "dev";
  const root = flag(argv, "--root") ?? process.cwd();
  if (!cand) {
    process.stderr.write("usage: bun bin/eval.ts --cand <id> --split dev|dev_small|dev_full|heldout [--gate] [--root dir]\n");
    return 1;
  }
  try {
    const result = runEval({ root, cand, split, gate: hasFlag(argv, "--gate") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
