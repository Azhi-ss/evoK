/**
 * ET-M1-SKILL / #140 — Skills directory + progressive-disclosure routing shell.
 *
 * Seams: routeSkills / defaultContextPointers / discloseSkill /
 * listSkillsDirectory / parseSkillsCommand / skillWritebackStatus.
 * Skills routing is not Mission authorize / continue / repair / stop.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillRoot } from "../evok-resources";
import {
  SKILL_CATEGORIES,
  SKILL_WRITEBACK_STATUS,
  SkillWritebackNotOpenedError,
  defaultContextPointers,
  discloseSkill,
  formatSkillsDirectory,
  listSkillsDirectory,
  parseSkillsCommand,
  proposeSkillWriteback,
  routeSkills,
  skillWritebackStatus,
  type SkillRoutingInput,
} from "./skills-routing";

function skill(partial: Partial<SkillRoutingInput> & Pick<SkillRoutingInput, "name" | "filePath">): SkillRoutingInput {
  return {
    description: partial.description ?? `${partial.name} skill`,
    baseDir: partial.baseDir ?? join("/tmp", partial.name),
    ...partial,
  };
}

describe("eight-category Skills directory scaffold", () => {
  test("the eight category ids are the engineering-owned W1 scaffold", () => {
    expect(SKILL_CATEGORIES).toEqual([
      "intake",
      "experiment",
      "evidence",
      "method-improvement",
      "search",
      "recovery",
      "pitfalls",
      "policy",
    ]);
  });

  test("bundled directory lists all eight categories even when empty of SKILL.md", async () => {
    const view = await listSkillsDirectory({ projectRoot: await mkdtemp(join(tmpdir(), "evok-skill-empty-")) });
    expect(view.categories.map((entry) => entry.id)).toEqual([...SKILL_CATEGORIES]);
    expect(view.categories).toHaveLength(8);
    expect(view.writeback).toBe(SKILL_WRITEBACK_STATUS);
    await rm(view.projectRoot, { recursive: true, force: true });
  });

  test("each bundled category directory is discoverable on disk", async () => {
    const root = bundledSkillRoot();
    for (const id of SKILL_CATEGORIES) {
      const stat = await readFile(join(root, id, ".keep"), "utf8").catch(() => "");
      expect({ id, keep: typeof stat }).toEqual({ id, keep: "string" });
    }
  });
});

describe("three lifecycle states — orthogonal to disclosure", () => {
  test("candidate / accepted / demoted are expressible; default context is accepted L0 only", () => {
    const routed = routeSkills([
      skill({ name: "keep", filePath: "/tmp/keep/SKILL.md", state: "accepted", description: "accepted short" }),
      skill({ name: "try", filePath: "/tmp/try/SKILL.md", state: "candidate", description: "candidate must stay out" }),
      skill({ name: "drop", filePath: "/tmp/drop/SKILL.md", state: "demoted", description: "demoted must stay out" }),
    ]);
    expect(routed.map((entry) => [entry.name, entry.state, entry.disclosure])).toEqual([
      ["keep", "accepted", "l0-pointer"],
      ["try", "candidate", "l0-pointer"],
      ["drop", "demoted", "l0-pointer"],
    ]);
    const pointers = defaultContextPointers(routed);
    expect(pointers.map((entry) => entry.name)).toEqual(["keep"]);
    expect(pointers[0]?.description).toBe("accepted short");
    expect(JSON.stringify(pointers)).not.toContain("candidate must stay out");
    expect(JSON.stringify(pointers)).not.toContain("demoted must stay out");
  });

  test("unspecified state is accepted so ADR-0006 discovery still loads L0 metadata", () => {
    const routed = routeSkills([skill({ name: "legacy", filePath: "/tmp/legacy/SKILL.md" })]);
    expect(routed[0]?.state).toBe("accepted");
    expect(defaultContextPointers(routed)).toHaveLength(1);
  });

  test("bundled mission-intake is accepted and mapped to intake", () => {
    const routed = routeSkills([
      skill({
        name: "mission-intake",
        filePath: join(bundledSkillRoot(), "mission-intake", "SKILL.md"),
        description: "draft a bounded evoK Mission",
      }),
    ]);
    expect(routed[0]?.state).toBe("accepted");
    expect(routed[0]?.category).toBe("intake");
  });
});

describe("L0 → on-trigger read-full disclosure", () => {
  test("L0 pointer is name+description+location and never the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evok-skill-l0-"));
    const filePath = join(dir, "SKILL.md");
    await writeFile(filePath, "---\nname: body-probe\ndescription: short pointer\nstate: accepted\n---\nSECRET-SKILL-BODY-L1\n");
    const routed = routeSkills([skill({ name: "body-probe", description: "short pointer", filePath, baseDir: dir })]);
    const pointer = defaultContextPointers(routed)[0];
    expect(pointer).toEqual({
      name: "body-probe",
      description: "short pointer",
      filePath,
      baseDir: dir,
      state: "accepted",
      disclosure: "l0-pointer",
    });
    expect(JSON.stringify(pointer)).not.toContain("SECRET-SKILL-BODY-L1");
    await rm(dir, { recursive: true, force: true });
  });

  test("on-trigger disclose reads the full SKILL.md (L1) and can list L2 resources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evok-skill-l1-"));
    const filePath = join(dir, "SKILL.md");
    await mkdir(join(dir, "references"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(filePath, "---\nname: method\ndescription: method skill\nstate: accepted\n---\nSECRET-SKILL-BODY-L1\n");
    await writeFile(join(dir, "references", "guide.md"), "L2-REF");
    await writeFile(join(dir, "scripts", "helper.sh"), "echo l2");
    const routed = routeSkills([skill({ name: "method", description: "method skill", filePath, baseDir: dir })])[0]!;

    const l1 = await discloseSkill(routed, "l1-body");
    expect(l1.disclosure).toBe("l1-body");
    expect(l1.body).toContain("SECRET-SKILL-BODY-L1");
    expect(l1.body).toContain("method skill");

    const l2 = await discloseSkill(routed, "l2-resources");
    expect(l2.disclosure).toBe("l2-resources");
    expect(l2.resources?.some((path) => path.endsWith(join("references", "guide.md")))).toBe(true);
    expect(l2.resources?.some((path) => path.endsWith(join("scripts", "helper.sh")))).toBe(true);
    expect(JSON.stringify(l2)).not.toContain("L2-REF");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("writeback isolation — read-only shell", () => {
  test("writeback is explicitly not opened", () => {
    expect(skillWritebackStatus()).toBe("writeback not opened — read-only shell");
    expect(SKILL_WRITEBACK_STATUS).toBe("writeback not opened — read-only shell");
    expect(() => proposeSkillWriteback({ names: ["keep"] })).toThrow(SkillWritebackNotOpenedError);
    expect(() => proposeSkillWriteback({ names: ["keep", "try"] })).toThrow(/writeback not opened/);
  });
});

describe("Skills routing is not a second control plane", () => {
  test("parseSkillsCommand recognizes /skills and does not intercept Pi or Mission slashes", () => {
    expect(parseSkillsCommand("/skills")).toEqual({ verb: "status" });
    expect(parseSkillsCommand("/skills status")).toEqual({ verb: "status" });
    expect(parseSkillsCommand("--skills")).toEqual({ verb: "status" });
    expect(parseSkillsCommand("/model")).toBeUndefined();
    expect(parseSkillsCommand("/new")).toBeUndefined();
    expect(parseSkillsCommand("/research")).toBeUndefined();
    expect(parseSkillsCommand("/research continue")).toBeUndefined();
    expect(parseSkillsCommand("/start")).toBeUndefined();
    expect(parseSkillsCommand("/resume")).toBeUndefined();
    expect(parseSkillsCommand("please list skills in chat")).toBeUndefined();
  });

  test("directory format is operator-readable and denies chat-as-authority", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-skill-fmt-"));
    const view = await listSkillsDirectory({
      projectRoot: project,
      skills: [
        skill({ name: "mission-intake", description: "draft a Mission", filePath: "/bundled/mission-intake/SKILL.md", state: "accepted", category: "intake" }),
        skill({ name: "try-search", description: "candidate search tip", filePath: "/tmp/try/SKILL.md", state: "candidate", category: "search" }),
      ],
    });
    const text = formatSkillsDirectory(view);
    expect(text).toMatch(/8 categor/);
    expect(text).toContain("intake");
    expect(text).toContain("mission-intake");
    expect(text).toContain("accepted");
    expect(text).toContain("try-search");
    expect(text).toContain("candidate");
    expect(text).toContain(SKILL_WRITEBACK_STATUS);
    expect(text).toMatch(/not a second control plane/i);
    expect(text).toMatch(/chat transcript is not authority/i);
    await rm(project, { recursive: true, force: true });
  });
});
