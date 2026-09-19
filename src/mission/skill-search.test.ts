/**
 * ET-SKILL-SEA / #160 — thin bundled `search` skill body.
 *
 * Seams: bundled SKILL.md tags / syncBundledSkillsIntoPiRoot /
 * discoverEvokResources / listSkillsDirectory / defaultContextPointers /
 * discloseSkill / assemblePromptOverlay / evaluateMethodAdmission /
 * BudgetLedger.authorize / runKillTestHang / DEFAULT_SEARCH_SELECTION_ID.
 * The body is not start / continue / submit authorization. Default
 * parent selection stays `fixed_uct`. Progressive / StrongSearch stay
 * explicit opt-in. `#40` stays off. Admission, Budget, hang, and T48
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
  createDefaultSearchSelectionPort,
  createSeaHost,
  DEFAULT_SEARCH_SELECTION_ID,
} from "../search";
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

const SEARCH_SKILL = join(bundledSkillRoot(), "search", "SKILL.md");

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-sea-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-sea-project-"));
  return { home, project };
}

describe("bundled search skill tags (ET-SKILL-SEA / #160)", () => {
  test("lands in the packaging source with owner|namespace evok, category search, and state", async () => {
    const text = await readFile(SEARCH_SKILL, "utf8");
    const overlaid = overlayFrontmatter(text, {
      name: "search",
      description: "placeholder",
      filePath: SEARCH_SKILL,
    });
    expect(text).toMatch(/^name:\s*search\s*$/m);
    expect(text).toMatch(/^description:\s+\S+/m);
    expect(overlaid.owner === "evok" || overlaid.namespace === "evok").toBe(true);
    expect(overlaid.category).toBe("search");
    expect(overlaid.state).toBe("accepted");
    expect(isEvokTagged(overlaid)).toBe(true);
    expect(isEvokCatalogSkill(overlaid)).toBe(true);
    expect(text).not.toMatch(/^---\r?\n[\s\S]*\r?\n---\s*$/);
  });
});

describe("same-root discovery + L0 (ET-SKILL-SEA / #160)", () => {
  test("syncs into the Pi root evok/search/ path and is discoverable there", async () => {
    const { home, project } = await layout();
    try {
      const synced = await syncBundledSkillsIntoPiRoot({ projectRoot: project });
      expect(synced.destinations.some((path) => path.includes(join(".pi", "skills", "evok", "search", "search")))).toBe(true);
      const dest = join(project, ".pi", "skills", "evok", "search", "search", "SKILL.md");
      const text = await readFile(dest, "utf8");
      expect(text).toMatch(/owner:\s*evok|namespace:\s*evok/);
      expect(text).toMatch(/category:\s*search/);
      expect(text).toMatch(/state:\s*accepted/);

      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const found = resources.skills.find((entry) => entry.skill.name === "search");
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
      const listed = view.skills.find((entry) => entry.name === "search");
      expect(listed).toBeDefined();
      expect(listed!.state).toBe("accepted");
      expect(listed!.category).toBe("search");
      expect(view.defaultContext.map((entry) => entry.name)).toContain("search");
      const directory = formatSkillsDirectory(view);
      expect(directory).toContain("search");
      expect(directory).toMatch(/\[search\]/);
      expect(directory).not.toMatch(/does not authorize start, continue, or External Submission/i);
      expect(directory).not.toMatch(/fixed_uct/i);
      expect(directory).not.toMatch(/Progressive/i);
      expect(directory).not.toMatch(/#40/);

      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/search \[search\]/);
      expect(overlay).not.toMatch(/fixed_uct/i);
      expect(overlay).not.toMatch(/Progressive/i);
      expect(overlay).not.toMatch(/#40/);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("/skill search loads L1 and does not authorize (ET-SKILL-SEA / #160)", () => {
  test("parseSkillDiscloseCommand accepts the search name", () => {
    expect(parseSkillDiscloseCommand("/skill search")).toEqual({ name: "search" });
  });

  test("/skill loads L1 body: four-line template, fixed_uct default, opt-in only, #40 off, not authorization", async () => {
    const { home, project } = await layout();
    try {
      const resources = await discoverEvokResources({
        projectRoot: project,
        userRoot: join(home, ".evok"),
      });
      const view = await listSkillsDirectory({ projectRoot: project, discovered: resources.skills });
      const routed = view.skills.find((entry) => entry.name === "search");
      expect(routed).toBeDefined();
      const l0 = defaultContextPointers(view.skills).find((entry) => entry.name === "search");
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
      expect(l1.body).toMatch(/fixed_uct/);
      expect(l1.body).toMatch(/opt-in/i);
      expect(l1.body).toMatch(/Progressive/i);
      expect(l1.body).toMatch(/#40/);
      expect(l1.body).toMatch(/stays off|#40.{0,20}off/i);
      expect(l1.body).toMatch(/does not relax|predicates/i);
      expect(l1.body).toMatch(/selection math|programmable exploration/i);
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

describe("shipping search does not change selection default or relax gates (ET-SKILL-SEA / #160)", () => {
  test("default parent selection stays fixed_uct and #40 stays off", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(createSeaHost().defaultSelection().id).toBe("fixed_uct");
  });

  test("missing protected holdout still refuses accepted writeback", () => {
    const [candidate] = routeSkills([{
      name: "search",
      description: "thin search",
      filePath: "/tmp/search/SKILL.md",
      owner: "evok",
      category: "search",
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
      name: "search",
      description: "thin search",
      filePath: "/tmp/search/SKILL.md",
      owner: "evok",
      category: "search",
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
