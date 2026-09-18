/**
 * W1 Skills directory + progressive-disclosure routing shell (ET-M1-SKILL / #140).
 *
 * Routing belongs to mission/. It is not Mission authorize / continue / repair /
 * stop, not a second control plane, and not an Admission / regression gate
 * (those stay ET-M1-EXP on the broker). Chat is not authority.
 *
 * Disclosure layers (orthogonal to lifecycle):
 *   L0 pointer  — name + description + location (default context)
 *   L1 body     — on-trigger read of SKILL.md
 *   L2 resources — on-demand scripts/ / references/ paths
 *
 * Lifecycle states (orthogonal to disclosure): candidate / accepted / demoted.
 * Default context loads only accepted short descriptions. Unspecified state is
 * accepted so ADR-0006 discovery still injects L0 metadata; explicit candidate
 * or demoted stay out. File-body writeback is not opened — read-only shell.
 * Promoting a candidate to accepted requires evidence Admission (ET-M1-EXP).
 */
import { readFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MethodAdmissionDecision } from "../evidence/method-admission";
import type { DiscoveredSkill } from "../evok-resources";

export const SKILL_CATEGORIES = [
  "intake",
  "experiment",
  "evidence",
  "method-improvement",
  "search",
  "recovery",
  "pitfalls",
  "policy",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export type SkillLifecycleState = "candidate" | "accepted" | "demoted";

export type SkillDisclosureLayer = "l0-pointer" | "l1-body" | "l2-resources";

export const SKILL_WRITEBACK_STATUS = "writeback not opened — read-only shell" as const;

export interface SkillAdmissionRecord {
  readonly outcome: "pass";
  readonly evidenceDigest?: string;
  readonly protocolVersion?: string;
}

const CATEGORY_SET = new Set<string>(SKILL_CATEGORIES);
const STATE_SET = new Set<string>(["candidate", "accepted", "demoted"]);
const BUNDLED_CATEGORY: Readonly<Record<string, SkillCategory>> = {
  "mission-intake": "intake",
};

export interface SkillRoutingInput {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir?: string;
  readonly state?: SkillLifecycleState;
  readonly category?: SkillCategory;
}

export interface RoutedSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir?: string;
  readonly state: SkillLifecycleState;
  readonly category?: SkillCategory;
  readonly disclosure: SkillDisclosureLayer;
  readonly admission?: SkillAdmissionRecord;
}

export interface SkillPointer extends RoutedSkill {
  readonly disclosure: "l0-pointer";
}

export interface DisclosedSkill extends RoutedSkill {
  readonly body?: string;
  readonly resources?: readonly string[];
}

export type SkillsVerb = "status";

export interface SkillsCommand {
  readonly verb: SkillsVerb;
}

export interface SkillsCategoryListing {
  readonly id: SkillCategory;
  readonly skillCount: number;
}

export interface SkillsDirectoryView {
  readonly projectRoot: string;
  readonly categories: readonly SkillsCategoryListing[];
  readonly skills: readonly RoutedSkill[];
  readonly defaultContext: readonly SkillPointer[];
  readonly writeback: typeof SKILL_WRITEBACK_STATUS;
}

export class SkillWritebackNotOpenedError extends Error {
  readonly kind = "skill-writeback-not-opened" as const;
  constructor(message = SKILL_WRITEBACK_STATUS) {
    super(message);
    this.name = "SkillWritebackNotOpenedError";
  }
}

export class SkillAdmissionRefusedError extends Error {
  readonly kind = "skill-admission-refused" as const;
  constructor(message = "Admission refused; skill cannot become accepted") {
    super(message);
    this.name = "SkillAdmissionRefusedError";
  }
}

export interface SkillAdmissionAttempt {
  readonly skill: RoutedSkill;
  readonly admitted: boolean;
  readonly hang: boolean;
  readonly objections: readonly string[];
}

function isCategory(value: unknown): value is SkillCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

function isState(value: unknown): value is SkillLifecycleState {
  return typeof value === "string" && STATE_SET.has(value);
}

function categoryFromPath(filePath: string): SkillCategory | undefined {
  const parts = filePath.split(/[\\/]/);
  const skillsAt = parts.lastIndexOf("skills");
  if (skillsAt >= 0) {
    const after = parts[skillsAt + 1];
    if (isCategory(after)) return after;
  }
  return undefined;
}

/**
 * Lifecycle + category for one skill. Explicit fields win; then path; then
 * the bundled pin for mission-intake; unspecified state stays accepted.
 */
export function routeOne(input: SkillRoutingInput): RoutedSkill {
  const category = input.category
    ?? categoryFromPath(input.filePath)
    ?? BUNDLED_CATEGORY[input.name];
  const state = input.state ?? "accepted";
  return {
    name: input.name,
    description: input.description,
    filePath: input.filePath,
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
    state,
    ...(category ? { category } : {}),
    disclosure: "l0-pointer",
  };
}

export function routeSkills(skills: readonly SkillRoutingInput[]): RoutedSkill[] {
  return skills.map(routeOne);
}

export function defaultContextPointers(skills: readonly RoutedSkill[]): SkillPointer[] {
  return skills
    .filter((entry) => entry.state === "accepted")
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      filePath: entry.filePath,
      ...(entry.baseDir ? { baseDir: entry.baseDir } : {}),
      state: "accepted" as const,
      ...(entry.category ? { category: entry.category } : {}),
      disclosure: "l0-pointer" as const,
    }));
}

export function acceptedSkillFiles(skills: readonly SkillRoutingInput[]): string[] {
  return defaultContextPointers(routeSkills(skills)).map((entry) => entry.filePath);
}

/** Sync overlay for the runtime default-context filter (one read per skill). */
export function acceptedSkillFilesFromDiscovered(skills: readonly DiscoveredSkill[]): string[] {
  return acceptedSkillFiles(skills.map((entry) => {
    const input = routingInputsFromDiscovered([entry])[0]!;
    try {
      return overlayFrontmatter(readFileSync(entry.skill.filePath, "utf8"), input);
    } catch {
      return input;
    }
  }));
}

export function routingInputsFromDiscovered(skills: readonly DiscoveredSkill[]): SkillRoutingInput[] {
  return skills.map((entry) => ({
    name: entry.skill.name,
    description: entry.skill.description,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
  }));
}

/**
 * Overlay frontmatter `state` / `category` when present. Unknown keys are
 * ignored; SDK parsing remains the skill parser (ADR-0006).
 */
export function overlayFrontmatter(text: string, input: SkillRoutingInput): SkillRoutingInput {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return input;
  let state = input.state;
  let category = input.category;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    const keyed = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line);
    if (!keyed) continue;
    const key = keyed[1];
    const value = keyed[2].trim().replace(/^["']|["']$/g, "");
    if (key === "state" && isState(value)) state = value;
    if (key === "category" && isCategory(value)) category = value;
  }
  return { ...input, ...(state ? { state } : {}), ...(category ? { category } : {}) };
}

async function overlayFromDisk(input: SkillRoutingInput): Promise<SkillRoutingInput> {
  try {
    const text = await readFile(input.filePath, "utf8");
    return overlayFrontmatter(text, input);
  } catch {
    return input;
  }
}

export async function routeDiscoveredSkills(skills: readonly DiscoveredSkill[]): Promise<RoutedSkill[]> {
  const inputs = routingInputsFromDiscovered(skills);
  const overlaid = await Promise.all(inputs.map(overlayFromDisk));
  return routeSkills(overlaid);
}

export async function discloseSkill(
  skill: RoutedSkill,
  layer: SkillDisclosureLayer,
): Promise<DisclosedSkill> {
  if (layer === "l0-pointer") {
    return { ...skill, disclosure: "l0-pointer" };
  }
  if (layer === "l1-body") {
    const body = await readFile(skill.filePath, "utf8");
    return { ...skill, disclosure: "l1-body", body };
  }
  const root = skill.baseDir ?? dirname(skill.filePath);
  const resources: string[] = [];
  for (const folder of ["references", "scripts"]) {
    const dir = join(root, folder);
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isFile()) continue;
      resources.push(join(dir, entry.name));
    }
  }
  resources.sort();
  return { ...skill, disclosure: "l2-resources", resources: Object.freeze(resources) };
}

export function skillWritebackStatus(): typeof SKILL_WRITEBACK_STATUS {
  return SKILL_WRITEBACK_STATUS;
}

export function proposeSkillWriteback(_request: { readonly name: string }): never {
  throw new SkillWritebackNotOpenedError(SKILL_WRITEBACK_STATUS);
}

/**
 * Promote a Skill to accepted only when evidence Admission passed.
 * Missing holdout, validity hang, or any non-pass stays out of default context.
 * File-body writeback remains not opened; this is the lifecycle slice.
 */
export function attemptSkillAccepted(
  skill: RoutedSkill,
  admission: MethodAdmissionDecision,
): SkillAdmissionAttempt {
  if (!admission.ok || !admission.admitted || admission.hang || admission.outcome !== "pass") {
    return {
      skill,
      admitted: false,
      hang: admission.hang,
      objections: Object.freeze([...admission.objections]),
    };
  }
  return {
    skill: {
      ...skill,
      state: "accepted",
      admission: {
        outcome: "pass",
        ...(admission.evidenceDigest === undefined ? {} : { evidenceDigest: admission.evidenceDigest }),
        ...(admission.protocolVersion === undefined ? {} : { protocolVersion: admission.protocolVersion }),
      },
    },
    admitted: true,
    hang: false,
    objections: Object.freeze([]),
  };
}

/** Rollback path: accepted → demoted leaves default context. */
export function demoteSkill(skill: RoutedSkill): RoutedSkill {
  const { admission: _admission, ...rest } = skill;
  return { ...rest, state: "demoted" };
}

/**
 * `/skills` is an evoK product command. Pi native slashes (`/model`, `/new`)
 * and Mission `/research` `/start` `/resume` stay on their own seams.
 */
export function parseSkillsCommand(text: string): SkillsCommand | undefined {
  const trimmed = text.trim();
  const match = /^(?:\/skills|--skills)(?:\s+(status))?\s*$/i.exec(trimmed);
  if (!match) return undefined;
  return { verb: "status" };
}

export async function listSkillsDirectory(options: {
  readonly projectRoot: string;
  readonly skills?: readonly SkillRoutingInput[];
  readonly discovered?: readonly DiscoveredSkill[];
}): Promise<SkillsDirectoryView> {
  const fromInputs = options.skills ?? [];
  const fromDiscovered = options.discovered
    ? await routeDiscoveredSkills(options.discovered)
    : [];
  const routed = fromInputs.length > 0 ? routeSkills(fromInputs) : fromDiscovered;
  const counts = new Map<SkillCategory, number>(SKILL_CATEGORIES.map((id) => [id, 0]));
  for (const entry of routed) {
    if (entry.category) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return {
    projectRoot: options.projectRoot,
    categories: SKILL_CATEGORIES.map((id) => ({ id, skillCount: counts.get(id) ?? 0 })),
    skills: Object.freeze([...routed]),
    defaultContext: Object.freeze(defaultContextPointers(routed)),
    writeback: SKILL_WRITEBACK_STATUS,
  };
}

export function formatSkillsDirectory(view: SkillsDirectoryView): string {
  const lines = [
    `-- skills directory · 8 categories · ${view.writeback}`,
    "   Skills routing is not a second control plane; /research stays Mission authority",
    "   chat transcript is not authority",
    "   disclosure: L0 pointer (default) → on-trigger L1 SKILL.md → L2 scripts/references",
    "   lifecycle (orthogonal): candidate | accepted | demoted",
    "   accepted promotion requires Admission (official samples + adversarial-labeled + protected holdout); missing holdout refuses",
    "   categories:",
  ];
  for (const category of view.categories) {
    lines.push(`     - ${category.id} (${category.skillCount} skill${category.skillCount === 1 ? "" : "s"})`);
  }
  lines.push("   default context (accepted L0 only):");
  if (view.defaultContext.length === 0) {
    lines.push("     (none)");
  } else {
    for (const pointer of view.defaultContext) {
      const cat = pointer.category ? ` [${pointer.category}]` : "";
      lines.push(`     - ${pointer.name}${cat}: ${pointer.description}`);
    }
  }
  const held = view.skills.filter((entry) => entry.state !== "accepted");
  lines.push("   held out of default context:");
  if (held.length === 0) {
    lines.push("     (none)");
  } else {
    for (const entry of held) {
      const cat = entry.category ? ` ${entry.category}` : "";
      lines.push(`     - ${entry.name} [${entry.state}]${cat}`);
    }
  }
  lines.push(`   writeback: ${view.writeback}`);
  return `${lines.join("\n")}\n`;
}

