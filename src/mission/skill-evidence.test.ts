/**
 * ET-SKILL-EVID / #156 — thin bundled `evidence` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang. The body is not start /
 * continue / submit authorization and does not relax gates. Admission,
 * Budget, hang, and T48 predicates stay in evidence/.
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

const EVIDENCE_SKILL = join(bundledSkillRoot(), "evidence", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-evid-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-evid-project-"));
  return { home, project };
}

describe("bundled evidence skill tags (ET-SKILL-EVID / #156)", () => {
  test("lands in the packaging source with owner|namespace evok, category evidence, and state", async () => {
    const text = await readFile(EVIDENCE_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "evidence",
      description: "placeholder",
      filePath: EVIDENCE_SKILL,
    });
    expect(text).toMatch(/^name:\s*evidence\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("evidence");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-EVID / #156)", () => {
  test("syncs into the Pi root evok/evidence/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "evidence", "evidence")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "evidence", "evidence", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*evidence/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "evidence");
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
      const listed = view.skills.find((entry) => entry.name === "evidence");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("evidence");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("evidence");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("evidence");
      expect(directory).toMatch(/\[evidence\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);
      expect(directory).not.toMatch(/File Blueprint/i);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/evidence \[evidence\]/);
      expect(overlay).not.toMatch(/File Blueprint/i);
      expect(overlay).not.toMatch(/Negative Evidence/i);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill evidence loads L1 and does not authorize (ET-SKILL-EVID / #156)", () => {
  test("parseSkillDiscloseCommand accepts the evidence name", () => {
    expect(parseSkillDiscloseCommand("/skill evidence")).toEqual({ name: "evidence" });
  });

  test("/skill loads L1 body and declares it is not start/continue/submit authorization", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "evidence");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "evidence");
      const l1 = await discloseSkill(routed!, "l1-body");
      expect(l1.disclosure).toBe("l1-body");
      expect(l1.body).toMatch(/does not authorize|not authorization/i);
      expect(l1.body).toMatch(/start/i);
      expect(l1.body).toMatch(/continue/i);
      expect(l1.body).toMatch(/submit/i);
      expect(l1.body).toMatch(/effective.{0,40}not optimality|not optimality/i);
      expect(l1.body).toMatch(/inconclusive.{0,20}not pass/i);
      expect(l1.body).toMatch(/holdout/i);
      expect(l1.body).toMatch(/lineage/i);
      expect(l1.body).toMatch(/does not relax/i);
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

describe("shipping evidence does not relax Admission, Budget, hang, or T48 (ET-SKILL-EVID / #156)", () => {
  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "evidence",
      description: "thin evidence",
      filePath: "/tmp/evidence/SKILL.md",
      owner: "evok",
      category: "evidence",
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
      name: "evidence",
      description: "thin evidence",
      filePath: "/tmp/evidence/SKILL.md",
      owner: "evok",
      category: "evidence",
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
