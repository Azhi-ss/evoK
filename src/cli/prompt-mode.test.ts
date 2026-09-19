/**
 * ET-PROMPT-MODE / #150 — Explore / Intake / Mission three-mode prompts.
 *
 * Seams: resolvePromptMode / formatPromptModeBanner / assemblePromptOverlay /
 * createEvokPromptModeExtension. Overlay is not a second control plane:
 * start / continue / submit still go through Mission gates.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillRoot } from "../evok-resources";
import { saveMissionDraft } from "../mission/mission-draft";
import {
  assemblePromptOverlay,
  createEvokPromptModeExtension,
  formatPromptModeBanner,
  resolvePromptMode,
} from "./prompt-mode";

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-prompt-mode-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# research project");
  return dir;
}

async function writeActiveMission(project: string, id = "m-abc123def456"): Promise<void> {
  await mkdir(join(project, ".evok", "missions", id), { recursive: true });
  await writeFile(join(project, ".evok", "missions", id, "mission.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    status: "running",
    objective: "beat NDCG on the holdout",
    contract: {
      objective: "beat NDCG on the holdout",
      expectedOutputs: ["report"],
      evaluationMethod: "ndcg",
      hardRules: ["no leakage"],
    },
    permissions: ["read-project"],
    stopConditions: ["budget exhausted", "human stop"],
    budget: { total: 2, units: "model-USD", consumed: 0.4, remaining: 1.6 },
    reserved: 0,
    usage: { intake: { tokens: {}, cost: { total: 0, units: "model-USD" } }, runs: [] },
    runs: {},
    baselineRunId: `${id}:baseline:1`,
    baseline: {
      runId: `${id}:baseline:1`,
      evaluation: { ok: true, score: 0.41 },
      evidenceRefs: ["snap:1"],
      measuredAt: "2026-09-19T03:00:00.000Z",
    },
    history: [],
    createdAt: "2026-09-19T03:00:00.000Z",
    updatedAt: "2026-09-19T03:05:00.000Z",
  }));
}

describe("three-mode resolution (ET-PROMPT-MODE / #150)", () => {
  test("no active Mission and not intake → Explore; UI banner is mode=explore", async () => {
    const project = await tempProject();
    try {
      const mode = await resolvePromptMode({ projectRoot: project });
      expect(mode).toBe("explore");
      expect(formatPromptModeBanner(mode)).toBe("mode=explore");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("explicit intake or an unstarted draft → Intake; UI banner is mode=intake", async () => {
    const project = await tempProject();
    try {
      expect(await resolvePromptMode({ projectRoot: project, intakeActive: true })).toBe("intake");
      expect(formatPromptModeBanner("intake")).toBe("mode=intake");

      await saveMissionDraft(project, { id: "m-deadbeef0001", objective: "draft a bounded Mission" });
      expect(await resolvePromptMode({ projectRoot: project })).toBe("intake");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("reviewed/active Mission → Mission; UI banner is mode=mission", async () => {
    const project = await tempProject();
    try {
      await writeActiveMission(project);
      const mode = await resolvePromptMode({ projectRoot: project });
      expect(mode).toBe("mission");
      expect(formatPromptModeBanner(mode)).toBe("mode=mission");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("explicit intake wins over an already-active Mission", async () => {
    const project = await tempProject();
    try {
      await writeActiveMission(project);
      expect(await resolvePromptMode({ projectRoot: project, intakeActive: true })).toBe("intake");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("overlay assembly (ET-PROMPT-MODE / #150)", () => {
  test("Explore keeps Pi default: optional footnote only, no Mission wording", async () => {
    const project = await tempProject();
    try {
      const overlay = await assemblePromptOverlay({ mode: "explore", projectRoot: project });
      expect(overlay).toMatch(/evoK `--project`/);
      expect(overlay).not.toMatch(/mission-intake/);
      expect(overlay).not.toMatch(/Research Objective/);
      expect(overlay).not.toMatch(/do not submit/i);
      expect(overlay).not.toMatch(/baseline/i);
      expect(overlay).not.toMatch(/beat NDCG on the holdout/);
      expect(overlay).not.toMatch(/L0 evoK skills/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("Intake overlay loads mission-intake L1, draft constraints, and draft≠authorization", async () => {
    const project = await tempProject();
    try {
      const overlay = await assemblePromptOverlay({ mode: "intake", projectRoot: project });
      const intakeL1 = await readFile(join(bundledSkillRoot(), "mission-intake", "SKILL.md"), "utf8");
      expect(overlay).toContain(intakeL1);
      expect(overlay).toMatch(/draft is not authorization|draft ≠ authorization|draft!=authorization/i);
      expect(overlay).toMatch(/Research Objective/);
      expect(overlay).toMatch(/success criteria/i);
      expect(overlay).toMatch(/stop conditions/i);
      expect(overlay).toMatch(/initial plan/i);
      expect(overlay).not.toMatch(/do not submit/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("Mission overlay carries objective, constraints, budget, stop, no-submit, baseline, and L0 skills", async () => {
    const project = await tempProject();
    try {
      await writeActiveMission(project);
      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toContain("beat NDCG on the holdout");
      expect(overlay).toMatch(/no leakage/);
      expect(overlay).toMatch(/1\.6|2 model-USD|budget/i);
      expect(overlay).toMatch(/budget exhausted|human stop|stop/i);
      expect(overlay).toMatch(/do not submit/i);
      expect(overlay).toContain("m-abc123def456:baseline:1");
      expect(overlay).toMatch(/L0 evoK skills/i);
      expect(overlay).toMatch(/mission-intake/);
      expect(overlay).toMatch(/experiment/);
      expect(overlay).toMatch(/evidence \[evidence\]/);
      expect(overlay).toMatch(/policy \[policy\]/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("Mission overlay injects only accepted + evoK-tagged L0; ordinary Pi skills stay out", async () => {
    const project = await tempProject();
    try {
      await writeActiveMission(project);
      await mkdir(join(project, ".pi", "skills", "personal"), { recursive: true });
      await writeFile(
        join(project, ".pi", "skills", "personal", "SKILL.md"),
        "---\nname: personal\ndescription: PERSONAL-PI-SKILL-MARKER\n---\nPI-BODY\n",
      );
      await mkdir(join(project, ".pi", "skills", "evok", "search", "try"), { recursive: true });
      await writeFile(
        join(project, ".pi", "skills", "evok", "search", "try", "SKILL.md"),
        "---\nname: try\ndescription: candidate must stay out\nowner: evok\ncategory: search\nstate: candidate\n---\nCANDIDATE-BODY\n",
      );
      const overlay = await assemblePromptOverlay({ mode: "mission", projectRoot: project });
      expect(overlay).toMatch(/mission-intake/);
      expect(overlay).not.toContain("PERSONAL-PI-SKILL-MARKER");
      expect(overlay).not.toContain("candidate must stay out");
      expect(overlay).not.toContain("CANDIDATE-BODY");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("prompt-mode extension (visible UI + overlay hook)", () => {
  test("session_start paints mode= in the status bar and before_agent_start appends overlay to Pi default", async () => {
    const project = await tempProject();
    try {
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      const handlers: Record<string, Function> = {};
      const factory = createEvokPromptModeExtension({ projectRoot: project });
      factory({
        on(event: string, handler: Function) {
          handlers[event] = handler;
        },
      } as never);
      const ctx = {
        ui: {
          setStatus(key: string, text: string | undefined) {
            statuses.push({ key, text });
          },
        },
      };
      await handlers.session_start?.({}, ctx);
      expect(statuses.at(-1)).toEqual({ key: "evok-mode", text: "mode=explore" });

      const result = await handlers.before_agent_start?.(
        { type: "before_agent_start", prompt: "hello", systemPrompt: "PI-DEFAULT-PROMPT" },
        ctx,
      );
      expect(result?.systemPrompt).toMatch(/^PI-DEFAULT-PROMPT/);
      expect(result?.systemPrompt).toMatch(/evoK `--project`/);
      expect(result?.systemPrompt).not.toMatch(/do not submit/i);
      expect(statuses.at(-1)).toEqual({ key: "evok-mode", text: "mode=explore" });

      await writeActiveMission(project);
      const missioned = await handlers.before_agent_start?.(
        { type: "before_agent_start", prompt: "hello", systemPrompt: "PI-DEFAULT-PROMPT" },
        ctx,
      );
      expect(missioned?.systemPrompt).toMatch(/^PI-DEFAULT-PROMPT/);
      expect(missioned?.systemPrompt).toContain("beat NDCG on the holdout");
      expect(missioned?.systemPrompt).toMatch(/do not submit/i);
      expect(statuses.at(-1)).toEqual({ key: "evok-mode", text: "mode=mission" });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
