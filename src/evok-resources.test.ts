import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { discoverEvokResources, EvokResourceError } from "./evok-resources";

const BUNDLED_SKILL_NAMES = new Set(["mission-intake", "experiment", "evidence", "method-improvement", "pitfalls", "policy", "recovery", "search"]);

function nonBundled(resources: Awaited<ReturnType<typeof discoverEvokResources>>) {
  return resources.skills.filter((entry) => !BUNDLED_SKILL_NAMES.has(entry.skill.name));
}

function isBundledReadRoot(path: string): boolean {
  return path.includes(join("evok", "intake", "mission-intake"))
    || path.includes(join("evok", "experiment", "experiment"))
    || path.includes(join("evok", "evidence", "evidence"))
    || path.includes(join("evok", "policy", "policy"))
    || path.includes(join("evok", "search", "search"))
    || path.includes(join("evok", "method-improvement", "method-improvement"))
    || path.includes(join("evok", "recovery", "recovery"))
    || path.includes(join("evok", "pitfalls", "pitfalls"));
}

interface Layout {
  home: string;
  project: string;
}

async function layout(): Promise<Layout> {
  const home = await mkdtemp(join(tmpdir(), "evok-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-project-"));
  await mkdir(join(home, ".evok", "skills"), { recursive: true });
  await mkdir(join(home, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".evok", "skills"), { recursive: true });
  await mkdir(join(project, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".agents", "skills"), { recursive: true });
  return { home, project };
}

function skill(description: string, name?: string): string {
  return `---\nname: ${name ?? "unused"}\ndescription: ${description}\n---\n# body\n`;
}

async function writeSkill(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

describe("discoverEvokResources (ET-SKILL-NS / #152) — same Pi root", () => {
  test("discovers project .pi, project .agents, and user Pi skills; not .evok/skills", async () => {
    const { home, project } = await layout();
    await writeSkill(join(home, ".pi", "skills", "u", "SKILL.md"), skill("user skill", "u"));
    await writeSkill(join(project, ".pi", "skills", "p", "SKILL.md"), skill("project pi skill", "p"));
    await writeSkill(join(project, ".agents", "skills", "s", "SKILL.md"), skill("shared skill", "s"));

    await writeSkill(join(project, "agents", "skills", "plain", "SKILL.md"), skill("plain agents is excluded", "plain"));
    await writeSkill(join(project, ".evok", "skills", "ghost", "SKILL.md"), skill("PARALLEL-EVOK-ROOT-MARKER", "ghost"));
    await writeSkill(join(home, ".agents", "skills", "g", "SKILL.md"), skill("global shared skills are excluded", "g"));

    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const names = nonBundled(resources).map((s) => s.skill.name).sort();
    expect(names).toEqual(["p", "s", "u"]);
    expect(resources.skills.some((s) => s.skill.name === "mission-intake")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "experiment")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "evidence")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "policy")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "search")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "method-improvement")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "recovery")).toBe(true);
    expect(resources.skills.some((s) => s.skill.name === "pitfalls")).toBe(true);
    expect(names).not.toContain("ghost");
    expect(names).not.toContain("plain");
    await cleanup(home, project);
  });

  test("missing directories still sync bundled skills into the Pi root", async () => {
    const home = await mkdtemp(join(tmpdir(), "evok-home-"));
    const project = await mkdtemp(join(tmpdir(), "evok-project-"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.skills.map((s) => s.skill.name).sort()).toEqual(["evidence", "experiment", "method-improvement", "mission-intake", "pitfalls", "policy", "recovery", "search"]);
    expect(resources.systemPrompt).toBeUndefined();
    expect(resources.appendSystemPrompt).toBeUndefined();
    expect(resources.skills.find((s) => s.skill.name === "mission-intake")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "intake", "mission-intake", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "experiment")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "experiment", "experiment", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "evidence")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "evidence", "evidence", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "policy")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "policy", "policy", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "search")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "search", "search", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "method-improvement")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "method-improvement", "method-improvement", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "recovery")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "recovery", "recovery", "SKILL.md"),
    );
    expect(resources.skills.find((s) => s.skill.name === "pitfalls")?.skill.filePath).toBe(
      join(project, ".pi", "skills", "evok", "pitfalls", "pitfalls", "SKILL.md"),
    );
    expect([...resources.readRoots].sort()).toEqual([
      join(project, ".pi", "skills", "evok", "evidence", "evidence"),
      join(project, ".pi", "skills", "evok", "experiment", "experiment"),
      join(project, ".pi", "skills", "evok", "intake", "mission-intake"),
      join(project, ".pi", "skills", "evok", "method-improvement", "method-improvement"),
      join(project, ".pi", "skills", "evok", "policy", "policy"),
      join(project, ".pi", "skills", "evok", "pitfalls", "pitfalls"),
      join(project, ".pi", "skills", "evok", "recovery", "recovery"),
      join(project, ".pi", "skills", "evok", "search", "search"),
    ].sort());
    await cleanup(home, project);
  });
});

describe("discoverEvokResources (#110) — prompt precedence", () => {
  test("SYSTEM.md selects project content before user fallback", async () => {
    const { home, project } = await layout();
    await writeFile(join(home, ".evok", "SYSTEM.md"), "user system");
    await writeFile(join(project, ".evok", "SYSTEM.md"), "project system");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.systemPrompt).toBe("project system");
    expect(resources.systemPromptPath).toBe(join(project, ".evok", "SYSTEM.md"));
    await cleanup(home, project);
  });

  test("SYSTEM.md falls back to user when the project copy is absent", async () => {
    const { home, project } = await layout();
    await writeFile(join(home, ".evok", "SYSTEM.md"), "user system");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.systemPrompt).toBe("user system");
    expect(resources.systemPromptPath).toBe(join(home, ".evok", "SYSTEM.md"));
    await cleanup(home, project);
  });

  test("APPEND_SYSTEM.md picks project before user and never stacks both copies", async () => {
    const { home, project } = await layout();
    await writeFile(join(home, ".evok", "APPEND_SYSTEM.md"), "user append");
    await writeFile(join(project, ".evok", "APPEND_SYSTEM.md"), "project append");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.appendSystemPrompt).toBe("project append");
    expect(resources.appendSystemPromptPaths).toEqual([join(project, ".evok", "APPEND_SYSTEM.md")]);
    await rm(join(project, ".evok", "APPEND_SYSTEM.md"));
    const userOnly = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(userOnly.appendSystemPrompt).toBe("user append");
    expect(userOnly.appendSystemPromptPaths).toEqual([join(home, ".evok", "APPEND_SYSTEM.md")]);
    await cleanup(home, project);
  });
});

describe("discoverEvokResources (#110) — collisions and invalid skills", () => {
  test("same-named skills resolve project .pi before project .agents before user Pi, with collision diagnostics", async () => {
    const { home, project } = await layout();
    await writeSkill(join(home, ".pi", "skills", "dup", "SKILL.md"), skill("user duplicate", "dup"));
    await writeSkill(join(project, ".agents", "skills", "dup", "SKILL.md"), skill("shared duplicate", "dup"));
    await writeSkill(join(project, ".pi", "skills", "dup", "SKILL.md"), skill("project duplicate", "dup"));

    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(nonBundled(resources)).toHaveLength(1);
    expect(nonBundled(resources)[0].skill.filePath).toBe(join(project, ".pi", "skills", "dup", "SKILL.md"));
    const collisions = resources.diagnostics.filter((d) => d.type === "collision");
    expect(collisions).toHaveLength(2);
    expect(collisions[0].collision?.winnerPath).toContain(join(".pi", "skills"));
    await cleanup(home, project);
  });

  test("project .agents wins over the user Pi copy", async () => {
    const { home, project } = await layout();
    await writeSkill(join(home, ".pi", "skills", "dup", "SKILL.md"), skill("user duplicate", "dup"));
    await writeSkill(join(project, ".agents", "skills", "dup", "SKILL.md"), skill("shared duplicate", "dup"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(nonBundled(resources)[0].skill.filePath).toBe(join(project, ".agents", "skills", "dup", "SKILL.md"));
    expect(resources.diagnostics.some((d) => d.type === "collision")).toBe(true);
    await cleanup(home, project);
  });

  test("a skill without a description is not silently accepted: excluded with a visible diagnostic", async () => {
    const { home, project } = await layout();
    await writeSkill(join(project, ".pi", "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description\n");
    await writeSkill(join(project, ".pi", "skills", "good", "SKILL.md"), skill("good skill", "good"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(nonBundled(resources).map((s) => s.skill.name)).toEqual(["good"]);
    expect(resources.diagnostics.some((d) => /description/i.test(d.message))).toBe(true);
    expect(resources.diagnostics.some((d) => d.path?.includes(join("bad", "SKILL.md")))).toBe(true);
    await cleanup(home, project);
  });

  test("a name with invalid characters is surfaced with a visible warning", async () => {
    const { home, project } = await layout();
    await writeSkill(join(project, ".pi", "skills", "UPPER", "SKILL.md"), skill("uppercase name is invalid", "UPPER"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.diagnostics.some((d) => /invalid characters/i.test(d.message))).toBe(true);
    await cleanup(home, project);
  });
});

describe("discoverEvokResources (#110) — scope, read roots, and symlinks", () => {
  test("skills carry user/project scope metadata", async () => {
    const { home, project } = await layout();
    await writeSkill(join(home, ".pi", "skills", "u", "SKILL.md"), skill("u", "u"));
    await writeSkill(join(project, ".pi", "skills", "p", "SKILL.md"), skill("p", "p"));
    await writeSkill(join(project, ".agents", "skills", "s", "SKILL.md"), skill("s", "s"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const scopeByName = Object.fromEntries(nonBundled(resources).map((entry) => [entry.skill.name, entry.scope]));
    expect(scopeByName).toEqual({ u: "user", p: "project", s: "project-shared" });
    await cleanup(home, project);
  });

  test("readRoots cover only the winning skill directories (one per baseDir), not the whole home", async () => {
    const { home, project } = await layout();
    await writeSkill(join(home, ".pi", "skills", "u", "SKILL.md"), skill("u", "u"));
    await writeSkill(join(project, ".pi", "skills", "p", "SKILL.md"), skill("p", "p"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const extra = resources.readRoots.filter((r) => !isBundledReadRoot(r)).sort();
    expect(extra).toEqual(
      [join(home, ".pi", "skills", "u"), join(project, ".pi", "skills", "p")].sort(),
    );
    expect(resources.readRoots.some((r) => resolve(r) === resolve(homedir()))).toBe(false);
    await cleanup(home, project);
  });

  test("symlinked skill directories are never followed, even when the target is valid", async () => {
    const { home, project } = await layout();
    const outside = await mkdtemp(join(tmpdir(), "evok-outside-"));
    await writeSkill(join(outside, "escaped", "SKILL.md"), skill("escaped target", "escaped"));
    await symlink(join(outside, "escaped"), join(project, ".pi", "skills", "escaped"), "dir");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.skills.map((s) => s.skill.name)).not.toContain("escaped");
    expect(resources.readRoots.some((r) => r.startsWith(outside))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "escaped", "SKILL.md"))).toBe(true);
    await cleanup(home, project, outside);
  });
  test("a symlinked SYSTEM.md cannot inject out-of-tree prompt content", async () => {
    const { home, project } = await layout();
    const outside = await mkdtemp(join(tmpdir(), "evok-outside-prompt-"));
    await writeFile(join(outside, "SYSTEM.md"), "OUT-OF-TREE-SYSTEM-MARKER");
    await symlink(join(outside, "SYSTEM.md"), join(project, ".evok", "SYSTEM.md"));
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    expect(resources.systemPrompt).toBeUndefined();
    expect(resources.systemPromptPath).toBeUndefined();
    await cleanup(home, project, outside);
  });
});

describe("discoverEvokResources (#111 / #152) — bundled sync into Pi root", () => {
  test("the shipped mission-intake skill is synced into the Pi root with English metadata", async () => {
    const { home, project } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const intake = resources.skills.find((s) => s.skill.name === "mission-intake");
    const dest = join(project, ".pi", "skills", "evok", "intake", "mission-intake", "SKILL.md");
    expect(intake).toBeDefined();
    expect(intake!.scope).toBe("project");
    expect(intake!.skill.description.toLowerCase()).toContain("mission");
    expect(intake!.skill.filePath).toBe(dest);
    expect(resources.readRoots).toContain(join(project, ".pi", "skills", "evok", "intake", "mission-intake"));
    await cleanup(home, project);
  });

  test("a project Pi-root mission-intake override wins over the bundled sync (first-wins)", async () => {
    const { home, project } = await layout();
    await writeSkill(
      join(project, ".pi", "skills", "evok", "intake", "mission-intake", "SKILL.md"),
      skill("PROJECT-OVERRIDE-MARKER", "mission-intake"),
    );
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const intake = resources.skills.filter((s) => s.skill.name === "mission-intake");
    expect(intake).toHaveLength(1);
    expect(intake[0].scope).toBe("project");
    expect(intake[0].skill.description).toContain("PROJECT-OVERRIDE-MARKER");
    await cleanup(home, project);
  });
});

describe("discoverEvokResources (#110) — input validation", () => {
  test("refuses to treat the real user home as the evok user root", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-project-"));
    await expect(discoverEvokResources({ projectRoot: project, userRoot: homedir() })).rejects.toBeInstanceOf(EvokResourceError);
    await rm(project, { recursive: true, force: true });
  });

  test("the project root must be absolute", async () => {
    await expect(discoverEvokResources({ projectRoot: "relative/path", userRoot: "/tmp/u" })).rejects.toBeInstanceOf(EvokResourceError);
  });
});
