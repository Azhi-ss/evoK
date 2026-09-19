/**
 * ET-SKILL-EXP / #154 — thin bundled `experiment` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize. The body is not start / continue / submit
 * authorization. Admission and Budget predicates stay in evidence/.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePromptOverlay } from "../cli/prompt-mode";
import { BudgetLedger } from "../evidence/budget-gate";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { bundledSkillRoot, discoverEvokResources, syncBundledSkillsIntoPiRoot } from "../evok-resources";
import {
  attemptSkillAccepted,
  defaultContextPointers,
  discloseSkill,
  formatDisclosedSkill,
  formatSkillsDirectory,
  isEvokCatalogSkill,
  isEvokTagged,
  listSkillsDirectory,
  overlayFrontmatter,
  parseSkillDiscloseCommand,
  routeSkills,
} from "./skills-routing";

const EXPERIMENT_SKILL = join(bundledSkillRoot(), "experiment", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-exp-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-exp-project-"));
  return { home, project };
}

describe("bundled experiment skill tags (ET-SKILL-EXP / #154)", () => {
  test("lands in the packaging source with owner|namespace evok, category experiment, and state", async () => {
    const text = await readFile(EXPERIMENT_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "experiment",
      description: "placeholder",
      filePath: EXPERIMENT_SKILL,
    });
    expect(text).toMatch(/^name:\s*experiment\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("experiment");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-EXP / #154)", () => {
  test("syncs into the Pi root evok/experiment/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "experiment", "experiment")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "experiment", "experiment", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*experiment/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "experiment");
      expect(found).toBeDefined();
      expect(found!.skill.filePath).toBe(dest);
      expect(found!.scope).not.toBe("bundled");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test("accepted L0 is visible on /skills and in the Mission overlay, not as L1 body", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const listed = view.skills.find((entry) => entry.name === "experiment");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("experiment");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("experiment");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("experiment");
      expect(directory).toMatch(/\[experiment\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/experiment/);
      expect(overlay).not.toMatch(/Task Contract design is not a Run/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill experiment loads L1 and does not authorize (ET-SKILL-EXP / #154)", () => {
  test("parseSkillDiscloseCommand accepts the experiment name", () => {
    expect(parseSkillDiscloseCommand("/skill experiment")).toEqual({ name: "experiment" });
  });

  test("/skill loads L1 body and declares it is not start/continue/submit authorization", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "experiment");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "experiment");
      const l1 = await discloseSkill(routed!, "l1-body");
      expect(l1.disclosure).toBe("l1-body");
      expect(l1.body).toMatch(/does not authorize|not authorization/i);
      expect(l1.body).toMatch(/start/i);
      expect(l1.body).toMatch(/continue/i);
      expect(l1.body).toMatch(/submit/i);
      expect(JSON.stringify(l0)).not.toContain(l1.body!.trim());
      const printed = formatDisclosedSkill(l1);
      expect(printed).toMatch(/not authorization to start, continue, or submit/i);
      expect(printed).toContain(l1.body!.replace(/\s+$/, ""));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("shipping experiment does not relax Admission or Budget (ET-SKILL-EXP / #154)", () => {
  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "experiment",
      description: "thin experiment",
      filePath: "/tmp/experiment/SKILL.md",
      owner: "evok",
      category: "experiment",
      state: "candidate",
    }]);
    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [
          { kind: "official_samples", present: true, outcome: "pass" },
          { kind: "adversarial_labeled", present: true, outcome: "pass" },
        ],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
    });
    const attempt = attemptSkillAccepted(candidate!, admission);
    expect(admission.admitted).toBe(false);
    expect(attempt.admitted).toBe(false);
    expect(attempt.skill.state).toBe("candidate");
    expect(attempt.objections.join(" ")).toMatch(/protected holdout/i);
    expect(defaultContextPointers([attempt.skill])).toEqual([]);
  });

  test("unreserved Budget still refuses writeback even when Admission would pass", () => {
    const [candidate] = routeSkills([{
      name: "experiment",
      description: "thin experiment",
      filePath: "/tmp/experiment/SKILL.md",
      owner: "evok",
      category: "experiment",
      state: "candidate",
    }]);
    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        slices: [
          { kind: "official_samples", present: true, outcome: "pass" },
          { kind: "adversarial_labeled", present: true, outcome: "pass" },
          { kind: "protected_holdout", present: true, outcome: "pass" },
        ],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
    });
    expect(admission.admitted).toBe(true);
    const budget = new BudgetLedger({ total: 1, units: "model-USD" }).authorize("writeback");
    const attempt = attemptSkillAccepted(candidate!, admission, budget);
    expect(attempt.admitted).toBe(false);
    expect(attempt.skill.state).toBe("candidate");
    expect(attempt.objections.join(" ")).toMatch(/unreserved|no reserve/i);
  });
});
