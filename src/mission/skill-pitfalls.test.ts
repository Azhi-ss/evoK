/**
 * ET-SKILL-PIT / #166 — thin bundled `pitfalls` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang.
 * The body is instruction only: reusable, answer-agnostic failure
 * signatures as guidance. It is not a rejection library, not an
 * auto-refuse blacklist, and not start / continue / submit
 * authorization. Admission, Budget, hang, T48, and Broker predicates
 * stay in evidence/.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePromptOverlay } from "../cli/prompt-mode";
import { BudgetLedger } from "../evidence/budget-gate";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { T48MappedCatalog } from "../evidence/hypothesis-ledger";
import { runKillTestHang } from "../evidence/kill-test-hang";
import { evaluateMethodAdmission } from "../evidence/method-admission";
import { EvidenceMemory } from "./research-loop";
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

const PITFALLS_SKILL = join(bundledSkillRoot(), "pitfalls", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-pit-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-pit-project-"));
  return { home, project };
}

describe("bundled pitfalls skill tags (ET-SKILL-PIT / #166)", () => {
  test("lands in the packaging source with owner|namespace evok, category pitfalls, and state", async () => {
    const text = await readFile(PITFALLS_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "pitfalls",
      description: "placeholder",
      filePath: PITFALLS_SKILL,
    });
    expect(text).toMatch(/^name:\s*pitfalls\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("pitfalls");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-PIT / #166)", () => {
  test("syncs into the Pi root evok/pitfalls/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "pitfalls", "pitfalls")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "pitfalls", "pitfalls", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*pitfalls/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "pitfalls");
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
      const listed = view.skills.find((entry) => entry.name === "pitfalls");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("pitfalls");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("pitfalls");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("pitfalls");
      expect(directory).toMatch(/\[pitfalls\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);
      expect(directory).not.toMatch(/not authorization to start, continue, or submit/i);
      expect(directory).not.toMatch(/Goodhart/i);
      expect(directory).not.toMatch(/rejection library|auto-refuse|blacklist/i);
      expect(directory).not.toMatch(/inconclusive is not pass|inconclusive ≠ pass/i);
      expect(directory).not.toMatch(/Elite.{0,20}(as )?Promotion/i);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/pitfalls \[pitfalls\]/);
      expect(overlay).not.toMatch(/Goodhart/i);
      expect(overlay).not.toMatch(/rejection library|auto-refuse|blacklist/i);
      expect(overlay).not.toMatch(/inconclusive is not pass|inconclusive ≠ pass/i);
      expect(overlay).not.toMatch(/Elite.{0,20}(as )?Promotion/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill pitfalls loads L1 and does not authorize (ET-SKILL-PIT / #166)", () => {
  test("parseSkillDiscloseCommand accepts the pitfalls name", () => {
    expect(parseSkillDiscloseCommand("/skill pitfalls")).toEqual({ name: "pitfalls" });
  });

  test("/skill loads L1 body: four-line template, reusable failure signatures, not a rejection library", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "pitfalls");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "pitfalls");
      const l1 = await discloseSkill(routed!, "l1-body");
      expect(l1.disclosure).toBe("l1-body");
      expect(l1.body).toMatch(/does not authorize|not authorization/i);
      expect(l1.body).toMatch(/start/i);
      expect(l1.body).toMatch(/continue/i);
      expect(l1.body).toMatch(/submit/i);
      expect(l1.body).toMatch(/[Ww]hen to use|[Uu]se this skill when/i);
      expect(l1.body).toMatch(/[Ww]hen forbidden|[Dd]o not use this skill to/i);
      expect(l1.body).toMatch(/not authorization|≠ authorization/i);
      expect(l1.body).toMatch(/Admission/i);
      expect(l1.body).toMatch(/Budget/i);
      expect(l1.body).toMatch(/failure signature/i);
      expect(l1.body).toMatch(/answer-agnostic|answer agnostic/i);
      expect(l1.body).toMatch(/Goodhart/i);
      expect(l1.body).toMatch(/holdout/i);
      expect(l1.body).toMatch(/inconclusive/i);
      expect(l1.body).toMatch(/Elite/i);
      expect(l1.body).toMatch(/Promotion/i);
      expect(l1.body).toMatch(/not a rejection library|≠ rejection library|not an? auto-refuse|≠ auto-refuse/i);
      expect(l1.body).toMatch(/not (a |an )?(hard-coded )?blacklist|≠ blacklist|docs only|instruction only/i);
      expect(l1.body).toMatch(/does not relax|predicates/i);
      expect(l1.body).not.toMatch(/auto-refuse this Candidate|automatically refuse|must refuse when this signature matches/i);
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

describe("shipping pitfalls does not hard-code refuse or relax gates (ET-SKILL-PIT / #166)", () => {
  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "pitfalls",
      description: "thin pitfalls",
      filePath: "/tmp/pitfalls/SKILL.md",
      owner: "evok",
      category: "pitfalls",
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
      name: "pitfalls",
      description: "thin pitfalls",
      filePath: "/tmp/pitfalls/SKILL.md",
      owner: "evok",
      category: "pitfalls",
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

  test("Elite is not Admission and hang inconclusive is not pass; unmapped T48 still blocks", () => {
    const elite = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [{ kind: "official_samples", present: true, outcome: "pass" }],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
      elite: true,
      teamFanOut: true,
      score: 99,
    });
    expect(elite.admitted).toBe(false);
    expect(elite.objections.join(" ")).toMatch(/protected holdout/i);

    const validity = evaluateExperimentValidity({ hang: true, slices: [] });
    expect(validity.ok).toBe(false);
    expect(validity.hang).toBe(true);
    expect(validity.outcome).toBe("inconclusive");

    const memory = new EvidenceMemory();
    memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true });
    const catalog = T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
    const hang = runKillTestHang({
      outcome: "inconclusive",
      evidenceRefs: ["ev-kill"],
      catalog,
    });
    expect(hang.ok).toBe(false);
    expect(hang.blocksPromotion).toBe(true);
    expect(hang.objections.join(" ")).toMatch(/inconclusive/i);

    const unmapped = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog,
      artifacts: [{ artifactId: "unmapped-art" }],
    });
    expect(unmapped.ok).toBe(false);
    expect(unmapped.blocksPromotion).toBe(true);
    expect(unmapped.objections.join(" ")).toMatch(/T48|artifact/i);
  });
});
