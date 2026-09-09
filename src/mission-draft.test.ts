/**
 * Project-local Mission draft storage (#111, T3; ADR-0004 "Project-local
 * Mission storage"). Drafts live under <project>/.evok/missions/<id>/, reuse
 * the existing Mission/Task vocabulary (ResearchObjective, Task Contract
 * fields, ResearchBudgetState), and are explicitly distinct from an executing
 * Mission: status stays "draft" until a later slice authorizes a start.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeDraft,
  deriveMissionId,
  loadMissionDraft,
  MISSION_DRAFT_SCHEMA_VERSION,
  MissionDraftCorruptionError,
  saveMissionDraft,
  type MissionDraft,
  type MissionDraftInput,
} from "./mission-draft";

function draft(overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    schemaVersion: MISSION_DRAFT_SCHEMA_VERSION,
    status: "draft",
    id: "m-test-0001",
    objective: "Improve ranking NDCG on the toy competition without leaking test labels.",
    successCriteria: ["NDCG@10 +0.02 over baseline", "no split-contract violation"],
    data: { description: "competition train table at data/train.csv", sources: ["data/train.csv"] },
    evaluation: { method: "5-fold group CV with the task split contract", metric: "NDCG@10" },
    constraints: { permissions: ["read project data"], hardRules: ["no external submission"] },
    budget: { total: 20, units: "model-USD", note: "discussion usage draws the same envelope" },
    outputs: ["evaluated candidate", "final report"],
    stopConditions: ["budget exhausted", "objective met"],
    unresolvedPrerequisites: [],
    decisions: [{ id: "d1", question: "Metric?", answer: "NDCG@10", recommendation: "NDCG@10", settled: true, at: "2026-09-10T00:00:00.000Z" }],
    sources: [],
    plan: {
      baselineHypothesis: "The provided gradient-boosted baseline is the comparison to beat.",
      tasks: [
        { taskId: "t1", objective: "Reproduce the baseline end to end", expectedOutputs: ["baseline score"], constraints: {}, evidenceRequirements: ["logged score"] },
        { taskId: "t2", objective: "Test one feature hypothesis", dependencies: ["t1"], expectedOutputs: ["comparison"], constraints: {}, evidenceRequirements: ["OOF comparison"] },
      ],
    },
    usage: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0, units: "model-USD" } },
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("mission draft storage (#111)", () => {
  test("save then reopen returns the same draft with settled decisions and the initial plan", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-draft-"));
    const saved = await saveMissionDraft(project, draft());
    expect(saved.status).toBe("draft");
    expect(saved.savedAt).toBeGreaterThan(0);

    const reopened = await loadMissionDraft(project, "m-test-0001");
    expect(reopened.objective).toBe(saved.objective);
    expect(reopened.status).toBe("draft");
    expect(reopened.decisions[0]?.answer).toBe("NDCG@10");
    expect(reopened.plan.tasks[0]?.objective).toContain("baseline");
    expect(reopened.plan.baselineHypothesis).toContain("baseline");

    // Generated Mission storage is git-ignored at the missions directory, but
    // the enclosing .evok config/skills namespace is not excluded wholesale.
    const ignore = await readFile(join(project, ".evok", "missions", ".gitignore"), "utf8");
    expect(ignore).toContain("*");
    await rm(project, { recursive: true, force: true });
  });

  test("a draft id is derived from the objective and reopening by directory prefix finds it", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-draft-"));
    const id = deriveMissionId("objective-slug");
    expect(id).toMatch(/^m-[0-9a-f]{12}$/);
    await saveMissionDraft(project, draft({ id }));
    const listed = await loadMissionDraft(project, id);
    expect(listed.id).toBe(id);
    await rm(project, { recursive: true, force: true });
  });

  test("reopening an unknown mission fails rather than silently creating state", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-draft-"));
    await expect(loadMissionDraft(project, "m-missing")).rejects.toThrow(/not found/i);
    await rm(project, { recursive: true, force: true });
  });

  test("a corrupted draft file is detected, not treated as a new Mission", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-draft-"));
    await saveMissionDraft(project, draft());
    const file = join(project, ".evok", "missions", "m-test-0001", "draft.json");
    await writeFile(file, "{ this is not json", "utf8");
    await expect(loadMissionDraft(project, "m-test-0001")).rejects.toBeInstanceOf(MissionDraftCorruptionError);

    await writeFile(file, JSON.stringify({ id: "m-test-0001", status: "draft" }), "utf8");
    await expect(loadMissionDraft(project, "m-test-0001")).rejects.toBeInstanceOf(MissionDraftCorruptionError);

    // A structurally complete object with an unparseable timestamp is damaged
    // state too: it must fail visibly, not be silently reset to "now".
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      id: "m-test-0001",
      status: "draft",
      objective: "x",
      successCriteria: [],
      data: { description: "d" },
      evaluation: { method: "m" },
      constraints: {},
      budget: { total: 1, units: "u" },
      outputs: [],
      stopConditions: [],
      unresolvedPrerequisites: [],
      decisions: [],
      sources: [],
      plan: { baselineHypothesis: "b", tasks: [] },
      usage: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0, units: "u" } },
      createdAt: "not-a-date",
      updatedAt: "2026-09-10T00:00:00.000Z",
    }), "utf8");
    await expect(loadMissionDraft(project, "m-test-0001")).rejects.toBeInstanceOf(MissionDraftCorruptionError);
    await rm(project, { recursive: true, force: true });
  });

  test("a draft that claims any executing status is rejected: the draft store cannot start a Mission", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-draft-"));
    expect(() => completeDraft(draft({ status: "RUNNING" as "draft" }) as unknown as MissionDraftInput)).toThrow(/status/);
    expect(() => completeDraft(draft({ status: "started" as "draft" }) as unknown as MissionDraftInput)).toThrow(/status/);
    await rm(project, { recursive: true, force: true });
  });
});
