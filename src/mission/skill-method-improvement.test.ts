/**
 * ET-SKILL-RSI / #162 — thin bundled `method-improvement` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang / MethodWritebackSession.
 * The body is not start / continue / submit authorization. Method
 * Improvement stays in-Mission, validation-gated (version → verify →
 * enable → rollbackable record), and is not automatic Promotion.
 * Elite is not an Admission key. Admission, Budget, hang, and T48
 * predicates stay in evidence/.
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
import { evaluateMethodAdmission, MethodWritebackSession } from "../evidence/method-admission";
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

const METHOD_IMPROVEMENT_SKILL = join(bundledSkillRoot(), "method-improvement", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-rsi-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-rsi-project-"));
  return { home, project };
}

describe("bundled method-improvement skill tags (ET-SKILL-RSI / #162)", () => {
  test("lands in the packaging source with owner|namespace evok, category method-improvement, and state", async () => {
    const text = await readFile(METHOD_IMPROVEMENT_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "method-improvement",
      description: "placeholder",
      filePath: METHOD_IMPROVEMENT_SKILL,
    });
    expect(text).toMatch(/^name:\s*method-improvement\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("method-improvement");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-RSI / #162)", () => {
  test("syncs into the Pi root evok/method-improvement/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "method-improvement", "method-improvement")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "method-improvement", "method-improvement", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*method-improvement/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "method-improvement");
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
      const listed = view.skills.find((entry) => entry.name === "method-improvement");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("method-improvement");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("method-improvement");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("method-improvement");
      expect(directory).toMatch(/\[method-improvement\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);
      expect(directory).not.toMatch(/not authorization to start, continue, or submit/i);
      expect(directory).not.toMatch(/verify command/i);
      expect(directory).not.toMatch(/enable record/i);
      expect(directory).not.toMatch(/auto-promote|automatic promotion/i);
      expect(directory).not.toMatch(/Elite.{0,20}Admission/i);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/method-improvement \[method-improvement\]/);
      expect(overlay).not.toMatch(/verify command/i);
      expect(overlay).not.toMatch(/enable record/i);
      expect(overlay).not.toMatch(/auto-promote|automatic promotion/i);
      expect(overlay).not.toMatch(/Elite.{0,20}Admission/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill method-improvement loads L1 and does not authorize (ET-SKILL-RSI / #162)", () => {
  test("parseSkillDiscloseCommand accepts the method-improvement name", () => {
    expect(parseSkillDiscloseCommand("/skill method-improvement")).toEqual({ name: "method-improvement" });
  });

  test("/skill loads L1 body: four-line template, validation-gated versioning, not auto-promote, not authorization", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "method-improvement");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "method-improvement");
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
      expect(l1.body).toMatch(/version( id)?/i);
      expect(l1.body).toMatch(/verify command/i);
      expect(l1.body).toMatch(/adversarial/i);
      expect(l1.body).toMatch(/enable record/i);
      expect(l1.body).toMatch(/rollback/i);
      expect(l1.body).toMatch(/not automatic promotion|≠ automatic promotion|not auto-promote|≠ auto-promote/i);
      expect(l1.body).toMatch(/Elite.{0,40}not.{0,20}Admission|Elite.{0,20}≠.{0,20}Admission/i);
      expect(l1.body).toMatch(/in-Mission|inside (the |one |the same )?Mission/i);
      expect(l1.body).toMatch(/does not relax|predicates/i);
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

describe("shipping method-improvement does not auto-promote or relax gates (ET-SKILL-RSI / #162)", () => {
  test("Elite is not an Admission key and writeback stays propose → verify → admit / rollback", () => {
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

    const session = new MethodWritebackSession();
    const proposed = session.propose({
      sliceId: "skill:method-improvement",
      kind: "skill",
      targetName: "method-improvement",
    });
    expect(proposed.phase).toBe("propose");
    expect(proposed.admitted).toBe(false);
    const failed = session.regress("fail");
    expect(failed.phase).toBe("rolled_back");
    expect(failed.admitted).toBe(false);
  });

  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "method-improvement",
      description: "thin method-improvement",
      filePath: "/tmp/method-improvement/SKILL.md",
      owner: "evok",
      category: "method-improvement",
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
      name: "method-improvement",
      description: "thin method-improvement",
      filePath: "/tmp/method-improvement/SKILL.md",
      owner: "evok",
      category: "method-improvement",
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

  test("hang inconclusive is not pass and unmapped T48 artifacts still block", () => {
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
