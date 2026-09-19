/**
 * ET-OPS-START (#168): copyable evaluation template + start hard-gate
 * inventory. Public seams only — does not dispatch a Mission and does not
 * relax Admission / Budget / hang / T48 / Broker predicates.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeFileMetricContract } from "../local-file-evaluator";
import { draftReadyForReview } from "./mission-intake";
import { loadMissionDraft, MISSION_DRAFT_SCHEMA_VERSION } from "./mission-draft";
import {
  DEMO_START_RELATIVE_PATH,
  EVALUATION_TEMPLATE_RELATIVE_PATH,
  formatStartHardGateReport,
  inspectStartHardGates,
} from "./start-hard-gates";

describe("copyable evaluation.json template (ET-OPS-START)", () => {
  test("documented template fields match the Mission file-metric contract", async () => {
    const raw = await readFile(join(process.cwd(), EVALUATION_TEMPLATE_RELATIVE_PATH), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contract = normalizeFileMetricContract(parsed);
    expect(contract.id).toBe("file-metric");
    expect(contract.version).toBe("1");
    expect(contract.artifact).toBe("answer.txt");
    expect(contract.metric).toBe("answer");
    expect(contract.min).toBe(0);
    expect(contract.max).toBe(1);
    expect(contract.artifact.includes("..")).toBe(false);
    expect(contract.artifact.startsWith("/")).toBe(false);
  });
});

describe("inspectStartHardGates (ET-OPS-START)", () => {
  test("refuses a relative project path and lists every remaining start gate", async () => {
    const report = await inspectStartHardGates({
      projectRoot: "examples/demo-start",
      authorization: { requested: true, token: "/start", missionSelector: "displayed" },
    });
    expect(report.ready).toBe(false);
    expect(report.blocking.map((gate) => gate.id)).toContain("project-absolute");
    const printed = formatStartHardGateReport(report);
    expect(printed).toMatch(/nothing dispatched/i);
    expect(printed).toMatch(/absolute path/i);
  });

  test("an empty project lists evaluation, reviewed draft, and model-auth together", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-start-gates-"));
    try {
      const report = await inspectStartHardGates({
        projectRoot: project,
        authorization: { requested: true, token: "/start", missionSelector: "displayed" },
        modelProbe: async () => ({ ok: false, error: "Pi model/auth is not configured" }),
      });
      expect(report.ready).toBe(false);
      const ids = report.blocking.map((gate) => gate.id);
      expect(ids).toEqual(expect.arrayContaining([
        "evaluation-contract",
        "reviewed-draft",
        "model-auth",
      ]));
      expect(report.inForce.map((gate) => gate.id)).toEqual(expect.arrayContaining([
        "admission",
        "budget-gate",
        "hang",
        "t48",
        "external-submission",
      ]));
      expect(report.inForce.every((gate) => gate.status === "in-force")).toBe(true);
      const printed = formatStartHardGateReport(report);
      expect(printed).toMatch(/remaining hard gates/i);
      expect(printed).toMatch(/nothing dispatched/i);
      expect(printed).not.toMatch(/baseline-complete|start succeeded|ready to submit/i);
      expect(printed).toMatch(/Admission/);
      expect(printed).toMatch(/Budget Gate/);
      expect(printed).toMatch(/hang/);
      expect(printed).toMatch(/T48/);
      expect(printed).toMatch(/External Submission|Broker/);
      expect(printed).toContain(project);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("a start-ready project still lists in-force gates and does not invent a green pass", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-start-ready-"));
    try {
      await seedStartReadyProject(project);
      const report = await inspectStartHardGates({
        projectRoot: project,
        missionId: "demo-start",
        authorization: { requested: true, token: "/start", missionSelector: "displayed" },
        modelProbe: async () => ({ ok: true }),
      });
      expect(report.ready).toBe(true);
      expect(report.blocking).toEqual([]);
      expect(report.passed.map((gate) => gate.id)).toEqual(expect.arrayContaining([
        "project-absolute",
        "evaluation-contract",
        "reviewed-draft",
        "explicit-authorization",
        "enforceable-budget",
        "supported-permissions",
        "model-auth",
      ]));
      expect(report.inForce.map((gate) => gate.id)).toEqual(expect.arrayContaining([
        "admission",
        "budget-gate",
        "hang",
        "t48",
        "external-submission",
      ]));
      const printed = formatStartHardGateReport(report);
      expect(printed).toMatch(/still in force/i);
      expect(printed).toMatch(/not a pass|does not invent green|not downgraded/i);
      expect(printed).not.toMatch(/true submit authorized|#40 Progressive stays on|Admission passed/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("demo start scaffold (ET-OPS-START)", () => {
  test("examples/demo-start ships a copyable evaluation contract and a reviewable draft", async () => {
    const demo = join(process.cwd(), DEMO_START_RELATIVE_PATH);
    const template = JSON.parse(await readFile(join(process.cwd(), EVALUATION_TEMPLATE_RELATIVE_PATH), "utf8"));
    const shipped = JSON.parse(await readFile(join(demo, ".evok", "evaluation.json"), "utf8"));
    expect(normalizeFileMetricContract(shipped)).toEqual(normalizeFileMetricContract(template));
    const draft = await loadMissionDraft(demo, "demo-start");
    expect(draftReadyForReview(draft)).toBe(true);
    expect(draft.budget.units).toBe("model-USD");
    for (const permission of draft.constraints.permissions ?? []) {
      expect(permission).not.toMatch(/submi|external|network|internet|credential|deploy|publish/i);
    }
  });

  test("demo README documents absolute-path operation for --project / evaluation / workspace", async () => {
    const readme = await readFile(join(process.cwd(), DEMO_START_RELATIVE_PATH, "README.md"), "utf8");
    expect(readme).toMatch(/--project/);
    expect(readme).toMatch(/absolute/i);
    expect(readme).toMatch(/evaluation\.json/);
    expect(readme).toMatch(/--start --baseline-only/);
    expect(readme).toMatch(/templates\/evaluation\.json/);
    expect(readme).toMatch(/isolated/i);
  });
});

async function seedStartReadyProject(project: string): Promise<void> {
  const template = JSON.parse(await readFile(join(process.cwd(), EVALUATION_TEMPLATE_RELATIVE_PATH), "utf8"));
  await mkdir(join(project, ".evok", "missions", "demo-start"), { recursive: true });
  await writeFile(join(project, ".evok", "evaluation.json"), JSON.stringify(template, null, 2));
  await writeFile(join(project, ".evok", "missions", "demo-start", "draft.json"), JSON.stringify({
    schemaVersion: MISSION_DRAFT_SCHEMA_VERSION,
    id: "demo-start",
    status: "draft",
    objective: "Raise the independent answer metric toward 0.9 without self-reporting a score.",
    successCriteria: ["answer.txt first line is a finite number in [0,1] measured by the independent evaluator"],
    data: { description: "local synthetic demo files shipped with examples/demo-start" },
    evaluation: { method: "file-metric", metric: "answer" },
    constraints: {
      permissions: ["read-project", "isolated-workspace-write"],
      hardRules: ["no network", "no external submission", "never self-report a score"],
    },
    budget: { total: 1, units: "model-USD", note: "demo envelope; live spend still requires Pi auth" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption", "baseline measured"],
    unresolvedPrerequisites: [],
    decisions: [],
    sources: [],
    plan: {
      baselineHypothesis: "a deterministic file-producing baseline is independently measurable",
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt with value 0.4" }],
    },
    usage: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0, units: "model-USD" } },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  }, null, 2));
}
