#!/usr/bin/env bun
/**
 * Mechanical dependency enforcement (PRD §5; #253/#254 Stage 1).
 *
 * ADR-0007 assigns logical ownership, but nothing in the code stopped one layer
 * importing another. The PRD's hard rules are checked here, on import
 * statements, and the check is wired into `bun run check` so the structure
 * cannot rot between tickets:
 *
 *   1. harness never imports mission, and never imports an evaluator;
 *   2. memory has no write path into Mission history (no `src/mission/` import);
 *   3. a capability never imports the research-object layer (charter, program,
 *      hypothesis, experiment) — S1's forced direction.
 *
 * Rule 1 is enforced from the moment `src/harness/` exists (Stage 3), so the
 * extraction cannot land with a reversed edge. Rules 2 and 3 are green at the
 * review base and must stay green.
 *
 * Usage: `bun scripts/import-boundaries.ts` (exit 1 on a violation, naming the
 * file, the specifier and the rule).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

export interface SourceFile {
  /** Repo-relative POSIX path, e.g. `src/memory/store.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface BoundaryRule {
  readonly id: string;
  readonly rule: string;
  /** Layer prefixes this rule constrains. */
  readonly from: readonly string[];
  /** Forbidden target prefixes (files or directories). */
  readonly forbid: readonly string[];
  /** Also forbid importing anything that looks like an evaluator. */
  readonly forbidEvaluators?: boolean;
}

/**
 * The research-object layer (S1, PRD §2.1). A capability importing any of these
 * would let an evaluator or a memory store read research intent, so the
 * direction is forced: objects import capabilities, never the reverse. Missing
 * files are not an error — the rule is ready before the module lands.
 */
export const RESEARCH_OBJECTS: readonly string[] = [
  "src/mission/research-charter.ts",
  "src/mission/research-program.ts",
  "src/mission/research-hypothesis.ts",
  "src/mission/research-experiment.ts",
];

/** The capability layer (PRD §5 "may depend on" read in the other direction). */
export const CAPABILITIES: readonly string[] = [
  "src/harness/",
  "src/memory/",
  "src/execution/",
  "src/evidence/",
  "src/search/",
  "src/competition/",
  "src/delegation/",
];

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    id: "harness-never-imports-mission",
    rule: "harness never imports mission or an evaluator (PRD §5)",
    from: ["src/harness/"],
    forbid: ["src/mission/"],
    forbidEvaluators: true,
  },
  {
    id: "memory-no-mission-write-path",
    rule: "memory has no write path into Mission history (PRD §5)",
    from: ["src/memory/"],
    forbid: ["src/mission/"],
  },
  {
    id: "capability-never-imports-research-object",
    rule: "a capability never imports the research-object layer (S1, forced direction)",
    from: CAPABILITIES.filter((layer) => layer !== "src/memory/" && layer !== "src/harness/"),
    // A research object, or the `src/mission` barrel that re-exports it: naming
    // the barrel must not be a way round the rule.
    forbid: [...RESEARCH_OBJECTS, "src/mission", "src/mission/index.ts"],
  },
];

export interface Violation {
  readonly path: string;
  readonly specifier: string;
  readonly resolved: string;
  readonly rule: string;
}

/** Every module specifier one file imports or re-exports. */
export function specifiersOf(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+"([^"]+)"/g, // import … from "x" / export … from "x"
    /\bimport\s+"([^"]+)"/g, // side-effect import "x"
    /\bimport\(\s*"([^"]+)"\s*\)/g, // dynamic import("x")
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/**
 * The repo-relative path a relative specifier denotes, extension-agnostic
 * (`./schema` and `./schema.ts` are the same edge). A directory specifier
 * (`../mission`) stays a directory path: the rules match it too, so a reversed
 * edge cannot hide behind a barrel import.
 */
export function resolveSpecifier(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return normalize(join(dirname(fromPath), specifier)).replaceAll("\\", "/");
}

const bare = (path: string): string => path.replace(/\.tsx?$/, "");

/**
 * A target ending in `/` covers that whole directory; any other target is one
 * module, matched exactly (so forbidding the `src/mission` barrel does not
 * forbid every module under it).
 */
function isForbidden(target: string, resolved: string): boolean {
  const t = bare(target);
  const r = bare(resolved);
  if (t.endsWith("/")) return r === t.slice(0, -1) || r.startsWith(t);
  return r === t;
}

/**
 * Flat `src/*.ts` shims re-export a packed module (ADR-0013), so importing one
 * is the same dependency edge as importing the module it re-exports. Without
 * this, a reversed edge hides behind `../mission-start`. Only files that really
 * are pure re-exports (`export * from "./pack/name"`) count as shims.
 */
export function flatShimsOf(files: readonly SourceFile[]): ReadonlyMap<string, string> {
  const shims = new Map<string, string>();
  for (const file of files) {
    const flat = /^src\/([^/]+)\.ts$/.exec(file.path);
    if (flat === null) continue;
    const reexport = /^\s*(?:\/\*\*[\s\S]*?\*\/\s*)?export \* from "\.\/([^"/]+)\/([^"]+)";\s*$/.exec(file.text);
    if (reexport !== null && reexport[2] === flat[1]) shims.set(`src/${flat[1]}`, `src/${reexport[1]}/${reexport[2]}.ts`);
  }
  return shims;
}

/** True when an import of `resolved` is an import of a forbidden target. */
function forbidden(targets: readonly string[], resolved: string): boolean {
  return targets.some((target) => isForbidden(target, resolved));
}

function isEvaluator(resolved: string): boolean {
  return /evaluat/i.test(resolved) && resolved.startsWith("src/");
}

/** Pure judgement: which (file, specifier) pairs break which rule. */
export function findViolations(
  files: readonly SourceFile[],
  rules: readonly BoundaryRule[] = BOUNDARY_RULES,
  shims: ReadonlyMap<string, string> = flatShimsOf(files),
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const rule of rules) {
      if (!rule.from.some((layer) => file.path.startsWith(layer))) continue;
      for (const specifier of specifiersOf(file.text)) {
        const resolved = resolveSpecifier(file.path, specifier);
        if (resolved === undefined) continue;
        // A flat shim import is judged as the packed module it re-exports.
        const packed = shims.get(bare(resolved)) ?? resolved;
        if (!forbidden(rule.forbid, packed) && !(rule.forbidEvaluators === true && isEvaluator(packed))) continue;
        violations.push({ path: file.path, specifier, resolved: packed, rule: rule.id });
      }
    }
  }
  return violations;
}

/** Every non-test TypeScript module under `root/prefix`, repo-relative. */
export async function collectSources(root: string, prefix = "src"): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ path, text: await readFile(join(dir, entry.name), "utf8") });
      }
    }
  };
  await walk(join(root, prefix), prefix);
  return out;
}

async function main(): Promise<number> {
  const files = await collectSources(join(import.meta.dir, ".."));
  const violations = findViolations(files);
  if (violations.length === 0) {
    process.stdout.write(`import-boundaries: ${files.length} modules, ${BOUNDARY_RULES.length} rules, no violations\n`);
    return 0;
  }
  for (const violation of violations) {
    process.stdout.write(`  ${violation.rule}: ${violation.path} imports "${violation.specifier}" (${violation.resolved})\n`);
  }
  process.stdout.write(`import-boundaries: ${violations.length} violation(s); a reversed dependency is refused\n`);
  return 1;
}

if (import.meta.main) process.exit(await main());
