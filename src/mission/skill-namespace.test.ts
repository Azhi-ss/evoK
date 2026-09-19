/**
 * ET-SKILL-NS / #152 — same-root Pi skills + evoK tag filtering + /skill L1.
 *
 * Seams: isEvokTagged / overlayFrontmatter / defaultContextPointers /
 * listSkillsDirectory / discoverEvokResources / syncBundledSkillsIntoPiRoot /
 * parseSkillDiscloseCommand. Discovery authority is the Pi skills root;
 * evoK lists filter by owner|namespace + category + state. A Skill body
 * is not authorization to start, continue, or submit.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvokResources, syncBundledSkillsIntoPiRoot } from "../evok-resources";
import {
  defaultContextPointers,
  discloseSkill,
  formatDisclosedSkill,
  formatSkillsDirectory,
  isEvokTagged,
  listSkillsDirectory,
  overlayFrontmatter,
  parseSkillDiscloseCommand,
  routeOne,
  routeSkills,
  type SkillRoutingInput,
} from "./skills-routing";

function skill(partial: Partial<SkillRoutingInput> & Pick<SkillRoutingInput, "name" | "filePath">): SkillRoutingInput {
  return {
    description: partial.description ?? `${partial.name} skill`,
    baseDir: partial.baseDir ?? join("/tmp", partial.name),
    ...partial,
  };
}

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-ns-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-ns-project-"));
  await mkdir(join(home, ".evok", "skills"), { recursive: true });
  await mkdir(join(home, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".agents", "skills"), { recursive: true });
  return { home, project };
}

async function writeSkill(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
  await mkdir(path.replace(/\/SKILL\.md$/, ""), { recursive: true });
  await writeFile(path, body);
}

describe("evoK skill tags (ET-SKILL-NS / #152)", () => {
  test("owner: evok or namespace: evok marks an evoK skill; untagged is ordinary Pi", () => {
    expect(isEvokTagged({ owner: "evok" })).toBe(true);
    expect(isEvokTagged({ namespace: "evok" })).toBe(true);
    expect(isEvokTagged({ owner: "evok", namespace: "other" })).toBe(true);
    expect(isEvokTagged({})).toBe(false);
    expect(isEvokTagged({ owner: "pi" })).toBe(false);
    expect(isEvokTagged({ namespace: "personal" })).toBe(false);
  });

  test("overlayFrontmatter reads owner / namespace / category / state", () => {
    const input = skill({ name: "keep", filePath: "/tmp/keep/SKILL.md" });
    const overlaid = overlayFrontmatter(
      "---\nname: keep\ndescription: short\nowner: evok\nnamespace: evok\ncategory: policy\nstate: candidate\n---\nbody\n",
      input,
    );
    expect(overlaid.owner).toBe("evok");
    expect(overlaid.namespace).toBe("evok");
    expect(overlaid.category).toBe("policy");
    expect(overlaid.state).toBe("candidate");
    expect(isEvokTagged(overlaid)).toBe(true);
  });

  test("skills/evok/<category>/ is the same Pi root and supplies category", () => {
    const routed = routeOne(skill({
      name: "policy-tip",
      filePath: "/proj/.pi/skills/evok/policy/policy-tip/SKILL.md",
      owner: "evok",
    }));
    expect(routed.category).toBe("policy");
    expect(isEvokTagged(routed)).toBe(true);
  });
});

describe("default context and /skills list only evoK-tagged (ET-SKILL-NS / #152)", () => {
  test("Mission/Intake default inject is accepted + evoK-tagged L0 only", () => {
    const routed = routeSkills([
      skill({
        name: "keep",
        filePath: "/pi/skills/evok/intake/keep/SKILL.md",
        description: "accepted short",
        owner: "evok",
        state: "accepted",
        category: "intake",
      }),
      skill({
        name: "try",
        filePath: "/pi/skills/evok/search/try/SKILL.md",
        description: "candidate must stay out",
        owner: "evok",
        state: "candidate",
        category: "search",
      }),
      skill({
        name: "personal",
        filePath: "/pi/skills/personal/SKILL.md",
        description: "ordinary Pi skill stays out of evoK L0",
      }),
    ]);
    const pointers = defaultContextPointers(routed);
    expect(pointers.map((entry) => entry.name)).toEqual(["keep"]);
    expect(JSON.stringify(pointers)).not.toContain("ordinary Pi skill");
    expect(JSON.stringify(pointers)).not.toContain("candidate must stay out");
  });

  test("/skills directory lists only evoK-tagged skills", async () => {
    const view = await listSkillsDirectory({
      projectRoot: "/tmp/proj",
      skills: [
        skill({
          name: "mission-intake",
          description: "draft a Mission",
          filePath: "/pi/skills/evok/intake/mission-intake/SKILL.md",
          owner: "evok",
          state: "accepted",
          category: "intake",
        }),
        skill({
          name: "personal",
          description: "PERSONAL-PI-SKILL",
          filePath: "/pi/skills/personal/SKILL.md",
        }),
      ],
    });
    expect(view.skills.map((entry) => entry.name)).toEqual(["mission-intake"]);
    const text = formatSkillsDirectory(view);
    expect(text).toContain("mission-intake");
    expect(text).not.toContain("PERSONAL-PI-SKILL");
    expect(text).toMatch(/same Pi root|tag filter|evoK-tagged/i);
  });
});

describe("same-root Pi scan + bundled sync (ET-SKILL-NS / #152)", () => {
  test("discovers project .pi/skills and does not treat .evok/skills as a parallel root", async () => {
    const { home, project } = await layout();
    await writeSkill(
      join(project, ".pi", "skills", "evok", "search", "keep", "SKILL.md"),
      "---\nname: keep\ndescription: tagged keep\nowner: evok\ncategory: search\nstate: accepted\n---\nKEEP-BODY\n",
    );
    await writeSkill(
      join(project, ".evok", "skills", "ghost", "SKILL.md"),
      "---\nname: ghost\ndescription: PARALLEL-EVOK-ROOT-MARKER\nowner: evok\ncategory: search\nstate: accepted\n---\nGHOST-BODY\n",
    );
    await writeSkill(
      join(project, ".pi", "skills", "personal", "SKILL.md"),
      "---\nname: personal\ndescription: PERSONAL-PI-SKILL-MARKER\n---\nPI-BODY\n",
    );
    const resources = await discoverEvokResources({
      projectRoot: project,
      userRoot: join(home, ".evok"),
    });
    const names = resources.skills.map((entry) => entry.skill.name);
    expect(names).toContain("keep");
    expect(names).toContain("personal");
    expect(names).not.toContain("ghost");
    expect(JSON.stringify(resources.skills.map((entry) => entry.skill.filePath))).not.toContain(join(".evok", "skills"));
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test("bundled resources/skills sync or link into the Pi root with evoK tags", async () => {
    const { home, project } = await layout();
    const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
    expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "intake", "mission-intake")))).toBe(true);
    const dest = join(project, ".pi", "skills", "evok", "intake", "mission-intake", "SKILL.md");
    const text = await readFile(dest, "utf8");
    expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
    expect(text).toMatch(/category:\s*intake/);
    expect(text).toMatch(/state:\s*accepted/);
    const resources = await discoverEvokResources({
      projectRoot: project,
      userRoot: join(home, ".evok"),
    });
    const intake = resources.skills.find((entry) => entry.skill.name === "mission-intake");
    expect(intake).toBeDefined();
    expect(intake!.skill.filePath).toBe(dest);
    expect(intake!.scope).not.toBe("bundled");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test("optional skills/evok/<category>/ under the same Pi root is discovered then tag-filtered", async () => {
    const { home, project } = await layout();
    await writeSkill(
      join(project, ".pi", "skills", "evok", "policy", "gate-talk", "SKILL.md"),
      "---\nname: gate-talk\ndescription: policy pointer\nnamespace: evok\ncategory: policy\nstate: accepted\n---\nPOLICY-L1\n",
    );
    const resources = await discoverEvokResources({
      projectRoot: project,
      userRoot: join(home, ".evok"),
    });
    const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
    expect(view.skills.map((entry) => entry.name)).toContain("gate-talk");
    expect(view.skills.find((entry) => entry.name === "gate-talk")?.category).toBe("policy");
    expect(view.defaultContext.map((entry) => entry.name)).toContain("gate-talk");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
});

describe("/skill L1 from the evoK-tagged catalog (ET-SKILL-NS / #152)", () => {
  test("parseSkillDiscloseCommand stays a dedicated L1 verb", () => {
    expect(parseSkillDiscloseCommand("/skill gate-talk")).toEqual({ name: "gate-talk" });
    expect(parseSkillDiscloseCommand("/skills")).toBeUndefined();
  });

  test("L1 disclose of an evoK-tagged skill is not start/continue/submit authorization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evok-ns-l1-"));
    const filePath = join(dir, "SKILL.md");
    await writeFile(
      filePath,
      "---\nname: keep\ndescription: short\nowner: evok\ncategory: policy\nstate: accepted\n---\nSECRET-SKILL-BODY-L1\n",
    );
    const routed = routeSkills([skill({
      name: "keep",
      description: "short",
      filePath,
      baseDir: dir,
      owner: "evok",
      category: "policy",
      state: "accepted",
    })])[0]!;
    const l0 = defaultContextPointers([routed])[0];
    expect(JSON.stringify(l0)).not.toContain("SECRET-SKILL-BODY-L1");
    const l1 = await discloseSkill(routed, "l1-body");
    expect(l1.body).toContain("SECRET-SKILL-BODY-L1");
    const text = formatDisclosedSkill(l1);
    expect(text).toContain("SECRET-SKILL-BODY-L1");
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    await rm(dir, { recursive: true, force: true });
  });
});
