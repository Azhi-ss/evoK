/**
 * ET-SKILL-REC / #164 — thin bundled `recovery` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang / continueResearch /
 * recoverResearchStatus / resumeAuthorizedMission.
 * The body is instruction only: program pointers to existing continue /
 * repair / hang paths. It is not start / continue / submit authorization
 * and not a second control plane. Admission, Budget, hang, and T48
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

const RECOVERY_SKILL = join(bundledSkillRoot(), "recovery", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-rec-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-rec-project-"));
  return { home, project };
}

describe("bundled recovery skill tags (ET-SKILL-REC / #164)", () => {
  test("lands in the packaging source with owner|namespace evok, category recovery, and state", async () => {
    const text = await readFile(RECOVERY_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "recovery",
      description: "placeholder",
      filePath: RECOVERY_SKILL,
    });
    expect(text).toMatch(/^name:\s*recovery\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("recovery");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-REC / #164)", () => {
  test("syncs into the Pi root evok/recovery/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "recovery", "recovery")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "recovery", "recovery", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*recovery/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "recovery");
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
      const listed = view.skills.find((entry) => entry.name === "recovery");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("recovery");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("recovery");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("recovery");
      expect(directory).toMatch(/\[recovery\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);
      expect(directory).not.toMatch(/not authorization to start, continue, or submit/i);
      expect(directory).not.toMatch(/continueResearch/);
      expect(directory).not.toMatch(/recoverResearchStatus/);
      expect(directory).not.toMatch(/runKillTestHang/);
      expect(directory).not.toMatch(/resumeAuthorizedMission/);
      expect(directory).not.toMatch(/MISSION_REPAIRED/);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/recovery \[recovery\]/);
      expect(overlay).not.toMatch(/continueResearch/);
      expect(overlay).not.toMatch(/recoverResearchStatus/);
      expect(overlay).not.toMatch(/runKillTestHang/);
      expect(overlay).not.toMatch(/resumeAuthorizedMission/);
      expect(overlay).not.toMatch(/MISSION_REPAIRED/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill recovery loads L1 and does not authorize (ET-SKILL-REC / #164)", () => {
  test("parseSkillDiscloseCommand accepts the recovery name", () => {
    expect(parseSkillDiscloseCommand("/skill recovery")).toEqual({ name: "recovery" });
  });

  test("/skill loads L1 body: four-line template, existing continue/repair/hang pointers, not a second control plane", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "recovery");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "recovery");
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
      expect(l1.body).toMatch(/continueResearch/);
      expect(l1.body).toMatch(/\/research continue/);
      expect(l1.body).toMatch(/research-entry\.ts/);
      expect(l1.body).toMatch(/MISSION_REPAIRED/);
      expect(l1.body).toMatch(/\/research repair/);
      expect(l1.body).toMatch(/reserved/i);
      expect(l1.body).toMatch(/resumeAuthorizedMission|reconcileInterruptedMission/);
      expect(l1.body).toMatch(/\/mission-resume/);
      expect(l1.body).toMatch(/mission-resume\.ts/);
      expect(l1.body).toMatch(/runKillTestHang/);
      expect(l1.body).toMatch(/kill-test-hang\.ts/);
      expect(l1.body).toMatch(/recoverResearchStatus/);
      expect(l1.body).toMatch(/not a second control plane|≠ second control plane/i);
      expect(l1.body).toMatch(/does not (add|invent) (a )?new hang predicate|no new hang predicate/i);
      expect(l1.body).toMatch(/does not relax|predicates/i);
      expect(l1.body).toMatch(/chat (transcript )?is not authority/i);
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

describe("shipping recovery does not open a second control plane or relax gates (ET-SKILL-REC / #164)", () => {
  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "recovery",
      description: "thin recovery",
      filePath: "/tmp/recovery/SKILL.md",
      owner: "evok",
      category: "recovery",
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
      name: "recovery",
      description: "thin recovery",
      filePath: "/tmp/recovery/SKILL.md",
      owner: "evok",
      category: "recovery",
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
