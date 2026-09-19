/**
 * evoK research resource discovery (#110, T2; ADR-0006; ET-SKILL-NS / #152).
 *
 * Skills discovery authority is the **Pi native skills root** (same tree Pi
 * scans), then evoK lists filter by frontmatter tags. The parallel
 * `.evok/skills` root is no longer a discovery authority.
 *
 *   <project>/.pi/skills/        project Pi skills root (optional evok/<category>/)
 *   <project>/.agents/skills/    explicitly shared skills (Pi + evoK)
 *   <piAgentDir>/skills/         user Pi skills (default sibling of ~/.evok → ~/.pi)
 *
 * SYSTEM.md / APPEND_SYSTEM.md still live under `.evok/` (prompts, not skills).
 * Bundled `<pkg>/resources/skills/` is the packaging source: startup syncs or
 * links it into the project Pi root with evoK tags. Runtime authority is the
 * Pi root, not a second parallel bundled root.
 *
 * The SDK does all YAML/Markdown skill parsing. There is no second parser.
 * Resource discovery does not grant additional tool, network, or filesystem
 * authority. A Skill body is not authorization to start, continue, or submit.
 */
import { lstat, readFile, readdir, realpath, symlink, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";

/**
 * Root of the evoK-owned skills shipped with the package (#111):
 * <pkg>/resources/skills. Packaged as ordinary files next to src/, read in
 * place like every other approved skill root. Test/dev layouts resolve it
 * from this module's URL (src/ -> ../resources); an installed layout ships
 * the same directory alongside the transpiled modules (dist/ -> ../resources).
 */
export function bundledSkillRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "resources", "skills");
}

/** Trusted-side configuration error: never confused with a model/run failure. */
export class EvokResourceError extends Error {
  readonly kind = "evok-resource-error" as const;
  constructor(message: string) {
    super(message);
    this.name = "EvokResourceError";
  }
}

export type EvokSkillScope = "project" | "project-shared" | "user" | "bundled";

export interface EvokSkillSource {
  readonly dir: string;
  readonly scope: EvokSkillScope;
}

export interface DiscoveredSkill {
  /** Skill as parsed by the SDK (metadata only; bodies are never read here). */
  readonly skill: Skill;
  readonly scope: EvokSkillScope;
}

export interface EvokResources {
  /** Resolved evoK user resource root (SDK agentDir for the session loader). */
  readonly userRoot: string;
  /** Resolved research project root. */
  readonly projectRoot: string;
  /** Base system prompt content (project SYSTEM before user fallback). */
  readonly systemPrompt?: string;
  readonly systemPromptPath?: string;
  /** Exactly one append prompt or none; the two APPEND copies are not stacked. */
  readonly appendSystemPrompt?: string;
  readonly appendSystemPromptPaths: readonly string[];
  /** Winning skills in discovery order; metadata-only (name/description/location). */
  readonly skills: readonly DiscoveredSkill[];
  /** SDK diagnostics (invalid skills, collisions) plus evok discovery notes. */
  readonly diagnostics: readonly ResourceDiagnostic[];
  /** Approved read-only roots for Runs: winning skill directories only. */
  readonly readRoots: readonly string[];
}

export interface DiscoverEvokResourcesOptions {
  /** Selected research project (real path; NOT the Run workspace). */
  readonly projectRoot: string;
  /** evoK user resource root (normally ~/.evok). Used for SYSTEM/APPEND. */
  readonly userRoot?: string;
  /**
   * Pi user agent dir whose `skills/` is part of the same-root scan
   * (normally ~/.pi). Defaults to the `.pi` sibling of `userRoot`.
   */
  readonly piAgentDir?: string;
}

export interface BundledSkillSyncResult {
  readonly destinations: readonly string[];
}

const SKILL_FILE = "SKILL.md";
const BUNDLED_CATEGORY: Readonly<Record<string, string>> = {
  "mission-intake": "intake",
};

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Enumerate SKILL.md files under one approved root using the SDK scanner's
 * containment rules: a directory containing SKILL.md is itself the skill and
 * is not recursed into; hidden entries and node_modules are skipped; symlinked
 * entries are never followed (a symlink must not widen discovery beyond the
 * approved namespace). Directories are enumerated depth-first in lexical
 * order so the overall file list is deterministic.
 *
 * ponytail: unlike the SDK scanner this does not apply .gitignore/.ignore —
 * explicit evoK namespaces (.evok/.agents) are versioned config, not build
 * output; reintroduce ignore filtering if ignored skill roots become real.
 */
async function enumerateSkillFiles(root: string, diagnostics: ResourceDiagnostic[]): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const rootFile = entries.find((entry) => entry.name === SKILL_FILE);
    if (rootFile) {
      const full = join(dir, rootFile.name);
      if (rootFile.isSymbolicLink() || !rootFile.isFile()) {
        diagnostics.push({ type: "warning", message: "skill SKILL.md must be a regular file; symlink skipped", path: full });
      } else {
        found.push(full);
      }
      return; // skill root: do not descend into reference material
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const real = await realpath(full);
          if (within(bundledSkillRoot(), real)) {
            await walk(full);
            continue;
          }
        } catch {
          // broken symlink: same as an unapproved link
        }
        diagnostics.push({ type: "warning", message: "symlink inside an approved skill source is not followed", path: full });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }

  // Existence is checked with lstat so a missing/non-directory root is a no-op
  // (a fresh project simply has no resources), not a run failure.
  try {
    const stat = await lstat(root);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(root);
  } catch {
    // root does not exist
  }
  return found;
}

/**
 * Select a prompt file only if it is a regular, non-symlink file directly in
 * the approved namespace. A symlink must not inject out-of-tree content into
 * the system prompt (ADR-0006 containment).
 */
async function regularPromptFile(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function readPrompt(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new EvokResourceError(`unreadable prompt file ${path}: ${(error as Error).message}`);
  }
}

function frontmatterField(text: string, key: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const keyed = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(rawLine.trim());
    if (!keyed) continue;
    if (keyed[1] === key) return keyed[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/**
 * Packaging source → Pi root. Runtime discovery then scans the Pi root.
 * Existing dest SKILL.md wins (no overwrite). Prefers a symlink into the
 * bundled tree; copies SKILL.md when a link cannot be created.
 */
export async function syncBundledSkillsIntoPiRoot(options: {
  readonly projectRoot: string;
}): Promise<BundledSkillSyncResult> {
  if (!isAbsolute(options.projectRoot)) {
    throw new EvokResourceError(`research project root must be an absolute path: ${options.projectRoot}`);
  }
  const projectRoot = resolve(options.projectRoot);
  const destinations: string[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  const files = await enumerateSkillFiles(bundledSkillRoot(), diagnostics);
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const name = frontmatterField(text, "name");
    if (!name) continue;
    const category = frontmatterField(text, "category") ?? BUNDLED_CATEGORY[name];
    if (!category) continue;
    const destDir = join(projectRoot, ".pi", "skills", "evok", category, name);
    destinations.push(destDir);
    const destFile = join(destDir, SKILL_FILE);
    try {
      const stat = await lstat(destFile);
      if (stat.isFile() || stat.isSymbolicLink()) continue;
    } catch {
      // dest missing: place the bundled skill
    }
    const srcDir = dirname(file);
    await mkdir(dirname(destDir), { recursive: true });
    try {
      await symlink(srcDir, destDir);
    } catch {
      await mkdir(destDir, { recursive: true });
      await writeFile(destFile, text);
    }
  }
  return { destinations: Object.freeze(destinations) };
}

/**
 * Discover prompts from `.evok` and skills from the Pi native root.
 * Syncs bundled packaging skills into the project Pi root first.
 */
export async function discoverEvokResources(options: DiscoverEvokResourcesOptions): Promise<EvokResources> {
  if (!isAbsolute(options.projectRoot)) {
    throw new EvokResourceError(`research project root must be an absolute path: ${options.projectRoot}`);
  }
  const projectRoot = resolve(options.projectRoot);
  const userRoot = resolve(options.userRoot ?? join(homedir(), ".evok"));
  const piAgentDir = resolve(options.piAgentDir ?? join(dirname(userRoot), ".pi"));

  // Trusted-side guard against accidentally pointing the user namespace at the
  // real home, which would discover the whole home as a skill root.
  if (resolve(userRoot) === resolve(homedir())) {
    throw new EvokResourceError("evok user resource root must be a .evok directory, not the user home");
  }

  await syncBundledSkillsIntoPiRoot({ projectRoot });

  const projectEvok = join(projectRoot, ".evok");
  const sources: EvokSkillSource[] = [
    { dir: join(projectRoot, ".pi", "skills"), scope: "project" },
    { dir: join(projectRoot, ".agents", "skills"), scope: "project-shared" },
    { dir: join(piAgentDir, "skills"), scope: "user" },
  ];

  const diagnostics: ResourceDiagnostic[] = [];
  const orderedFiles: string[] = [];
  const scopeByFile = new Map<string, EvokSkillScope>();
  for (const source of sources) {
    const files = await enumerateSkillFiles(source.dir, diagnostics);
    for (const file of files) {
      orderedFiles.push(file);
      scopeByFile.set(file, source.scope);
    }
  }

  // The SDK parses frontmatter/Markdown, validates, dedupes first-wins in the
  // given order, and emits collision + invalid-skill diagnostics. includeDefaults
  // is false: only our enumerated, approved files are parsed.
  const result = loadSkills({ cwd: projectRoot, agentDir: userRoot, skillPaths: orderedFiles, includeDefaults: false });
  diagnostics.push(...result.diagnostics);

  const scopeByReal = new Map<string, EvokSkillScope>();
  for (const file of orderedFiles) {
    const scope = scopeByFile.get(file);
    if (!scope) continue;
    try {
      scopeByReal.set(await realpath(file), scope);
    } catch {
      // keep the lexical mapping only
    }
  }

  const skills: DiscoveredSkill[] = result.skills.map((skill) => ({
    skill,
    // Every parsed file was enumerated from one of the approved sources; an
    // unknown one is discovery drift and fails closed rather than mislabeling.
    // A bundled sync link may surface as the dest path or the real packaged file.
    scope: scopeByFile.get(skill.filePath)
      ?? scopeByReal.get(skill.filePath)
      ?? (() => { throw new EvokResourceError(`skill parsed from an unapproved source: ${skill.filePath}`); })(),
  }));

  // Each winning skill's own directory is an in-place read-only root (its
  // SKILL.md and relative references). Dedupe by real lexical path; never grant
  // a parent such as the home directory.
  const readRoots = [...new Set(skills.map((entry) => entry.skill.baseDir))]
    .filter((dir) => within(userRoot, dir) || within(projectRoot, dir) || within(piAgentDir, dir) || within(bundledSkillRoot(), dir))
    .sort();

  const [systemPromptPath, appendPath] = await Promise.all([
    regularPromptFile(join(projectEvok, "SYSTEM.md")).then((p) => p ?? regularPromptFile(join(userRoot, "SYSTEM.md"))),
    regularPromptFile(join(projectEvok, "APPEND_SYSTEM.md")).then((p) => p ?? regularPromptFile(join(userRoot, "APPEND_SYSTEM.md"))),
  ]);

  const [systemPrompt, appendSystemPrompt] = await Promise.all([
    readPrompt(systemPromptPath),
    readPrompt(appendPath),
  ]);

  return {
    userRoot,
    projectRoot,
    systemPrompt,
    ...(systemPromptPath ? { systemPromptPath } : {}),
    appendSystemPrompt,
    appendSystemPromptPaths: appendSystemPrompt !== undefined && appendPath ? [appendPath] : [],
    skills,
    diagnostics,
    readRoots,
  };
}
