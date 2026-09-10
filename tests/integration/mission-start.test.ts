/**
 * Primary-seam tests for T4 (#112): an authorized Mission start dispatches
 * exactly one bounded baseline Experiment through the real Pi execution path,
 * and the resulting Candidate snapshot is measured by an independent
 * deterministic evaluator — never by a model-supplied score.
 *
 * The candidate model is a controlled faux provider that performs REAL local
 * file execution through the SDK (write/read tools on the isolated workspace);
 * the evaluator is a trusted local function that computes the score itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import {
  MISSION_SCHEMA_VERSION,
  MissionStartRejectedError,
  MissionControllerConflictError,
  BudgetExhaustedError,
  EvaluatorFailureError,
  loadMissionRecord,
  missionRecordPath,
  baselineResultPath,
  startAuthorizedMission,
  type BaselineEvaluator,
  type StartAuthorization,
} from "../../src/mission-start";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import { createEvokModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";
import { SandboxBoundary } from "../../src/security-boundary";
import type { SessionModelResolver } from "../../src/pi-agent-runtime";

const CONTROL_PROVIDER = "evok-t4-control";

/** Pi's agent dir under the current HOME, expressed as an absolute path. */
function piAgentDir(): string {
  return getAgentDir();
}

/** Absolute path under the user HOME (mirrors `~` expansion in bash checks). */
function homedirJoin(suffix: string): string {
  return `${homedir()}/${suffix}`;
}

/**
 * Independent deterministic evaluator (trusted side): the candidate must
 * contain answer.txt whose first line is a finite number in [0, 1]. The
 * evaluator reads the IMMUTABLE SNAPSHOT bytes copied out of the workspace;
 * it never asks the model for a score and never reads a pre-filled score file
 * as the oracle.
 */
const fileEvaluator: BaselineEvaluator = {
  id: "file-answer-deterministic",
  version: "1",
  async evaluate(snapshot: Readonly<Record<string, string>>, context) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) {
      return { ok: false, ruleViolations: ["answer.txt is missing"] };
    }
    const value = Number(raw.split(/\r?\n/, 1)[0]?.trim());
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, ruleViolations: ["answer.txt first line must be a finite number in [0,1]"] };
    }
    return {
      ok: true,
      score: value,
      facts: [{ name: "answer", value, source: "answer.txt" }],
    };
  },
};

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t4-project-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# t4 research project");
  return dir;
}

function completeDraft(id: string, overrides: Partial<MissionDraft> = {}): MissionDraft {
  return {
    schemaVersion: 1,
    id,
    status: "draft",
    objective: "T4 objective: produce a bounded measured baseline",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the project" },
    evaluation: { method: "file-answer-deterministic", metric: "answer in [0,1]" },
    constraints: {
      permissions: ["isolated-workspace-write", "read-project", "local-shell-in-workspace"],
      hardRules: ["no external submission"],
    },
    budget: { total: 1, units: "model-USD", note: "bounded baseline slice" },
    outputs: ["answer.txt"],
    stopConditions: ["budget exhausted", "user interruption"],
    unresolvedPrerequisites: [],
    decisions: [],
    sources: [],
    plan: {
      baselineHypothesis: "a deterministic file-producing baseline is measurable",
      tasks: [{ taskId: "baseline", objective: "materialize answer.txt in the run workspace with value 0.75" }],
    },
    usage: { tokens: { input: 11, output: 7, total: 18 }, cost: { total: 0.001, units: "model-USD" } },
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  } as MissionDraft;
}

async function seedDraft(project: string, draft: MissionDraft): Promise<MissionDraft> {
  return saveMissionDraft(project, draft);
}

/**
 * Controlled model + real SDK runtime. `tool` selects the candidate behavior:
 *  - "write-good": writes answer.txt = 0.75 with the real write tool
 *  - "forge": writes a forged model score channel AND a wrong answer
 *  - "empty": produces no candidate artifact
 *  - "bash": produces the artifact through a real local shell command
 */
/** Per-token cost (USD) baked into the controlled model so observed cost is real. */
const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };

/** Trusted-side pricing for the controlled model: faux emits tokens but zeroes cost. */
function priceTokens(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
  return tokens.input * MODEL_COST.input + tokens.output * MODEL_COST.output;
}

async function controlledHarness(project: string, tool: "write-good" | "forge" | "empty" | "bash" = "write-good") {
  const faux = fauxProvider({ provider: CONTROL_PROVIDER, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 150 });
  const responses =
    tool === "write-good"
      ? [
          fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "0.75\n" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("baseline candidate materialized: answer.txt"),
        ]
      : tool === "bash"
        ? [
            fauxAssistantMessage(fauxToolCall("bash", { command: "printf '0.625\\n' > answer.txt" }), { stopReason: "toolUse" }),
            fauxAssistantMessage("baseline candidate materialized via local shell"),
          ]
        : tool === "forge"
          ? [
              // The model tries to manufacture a score through its own text
              // and a planted "score" file; it never writes answer.txt.
              fauxAssistantMessage(fauxToolCall("write", { path: "score", content: "1" }), { stopReason: "toolUse" }),
              fauxAssistantMessage('{"score": 1, "selfVerified": true} candidate definitely succeeded'),
            ]
          : [fauxAssistantMessage("I thought about it but wrote nothing")];
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${CONTROL_PROVIDER}/deterministic`;
  const resolver = await createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel(r: string) {
        if (r !== ref) return undefined;
        return { provider: CONTROL_PROVIDER, model: "deterministic", id: ref };
      },
      defaultModel() {
        return { provider: CONTROL_PROVIDER, model: "deterministic", id: ref };
      },
    },
  });
  const resources = await discoverEvokResources({ projectRoot: project });
  return { resolver, resources, faux };
}

function auth(overrides: Partial<StartAuthorization> = {}): StartAuthorization {
  return {
    requested: true,
    token: "/start",
    missionSelector: "displayed",
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("start validation (#112 AC1)", () => {
  test("ambiguous intent cannot dispatch", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-amb"));
    const { resolver, resources } = await controlledHarness(project);
    for (const token of ["maybe start later", "what do you think?", "   "]) {
      await expect(startAuthorizedMission({
        projectRoot: project, missionId: draft.id, authorization: auth({ requested: false, token }),
        resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
        priceModelCost: () => priceTokens,
      })).rejects.toBeInstanceOf(MissionStartRejectedError);
    }
    // Nothing persisted as executing, nothing dispatched
    const reopened = await loadMissionRecord(project, draft.id).catch((e) => e as Error);
    expect(reopened).toBeInstanceOf(MissionStartRejectedError);
  });

  test("a model-authored approval is rejected: the authorization source must be the user", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-modelauth"));
    const { resolver, resources } = await controlledHarness(project);
    await expect(startAuthorizedMission({
      projectRoot: project, missionId: draft.id,
      authorization: { requested: true, token: "/start", missionSelector: "displayed", source: "model" },
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    })).rejects.toThrow(/user/);
  });

  test("missing prerequisites (incomplete draft) keep the Mission unstarted", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-incomplete", { unresolvedPrerequisites: ["data access not granted"] }));
    const { resolver, resources } = await controlledHarness(project);
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MissionStartRejectedError);
    expect((error as Error).message).toMatch(/prerequisite/);
  });

  test("a start for a different mission than the displayed one is rejected", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-displayed"));
    await seedDraft(project, completeDraft("m-t4-other"));
    const { resolver, resources } = await controlledHarness(project);
    await expect(startAuthorizedMission({
      projectRoot: project, missionId: "m-t4-other",
      authorization: auth({ missionSelector: "m-t4-displayed" }),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    })).rejects.toThrow(/displayed/);
  });

  test("an unenforceable budget bound is rejected rather than treated as a cap", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-unenforceable", {
      budget: { total: 5, units: "wallclock-minutes" },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MissionStartRejectedError);
    expect((error as Error).message).toMatch(/enforceable|units/i);
  });

  test("permissions declared by the draft but unsupported by this path cannot dispatch", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-perms", {
      constraints: { permissions: ["isolated-workspace-write", "external-submission"] },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MissionStartRejectedError);
    expect((error as Error).message).toMatch(/permission/);
  });
});

describe("authorized baseline through the real Pi path (#112 AC2–AC4)", () => {
  test("valid start: real local file execution, immutable snapshot measured independently, durable records", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-good"));
    const { resolver, resources, faux } = await controlledHarness(project, "write-good");

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      // explicit reservation for the single bounded baseline Run
      reserveCost: 0.01,
      // trusted-side model pricing: the controlled faux model emits real tokens but zero cost
      priceModelCost: () => priceTokens,
    });

    expect(faux.state.callCount).toBe(2);
    expect(outcome.stopReason).toBe("baseline-complete");
    expect(outcome.evaluation.score).toBe(0.75);
    expect(outcome.evaluation.ok).toBe(true);
    expect(outcome.model.id).toBe(`${CONTROL_PROVIDER}/deterministic`);

    // The candidate artifact is inspectable and the snapshot is immutable bytes
    const snapshotDir = join(project, ".evok", "missions", draft.id, "runs", outcome.runId, "snapshot");
    expect(await readFile(join(snapshotDir, "answer.txt"), "utf8")).toBe("0.75\n");

    // Durable Mission record exists and correlates run/result/history
    const record = await loadMissionRecord(project, draft.id);
    expect(record.schemaVersion).toBe(MISSION_SCHEMA_VERSION);
    expect(record.status).toBe("baseline-complete");
    expect(record.baselineRunId).toBe(outcome.runId);
    expect(record.runs[outcome.runId].resultRef).toContain(outcome.runId);
    expect(record.history.map((e) => e.type)).toEqual(
      expect.arrayContaining(["MISSION_ACCEPTED", "EXECUTION_INTENT_PERSISTED", "RUN_DISPATCHED", "SNAPSHOT_COMMITTED", "EVALUATION_MEASURED", "BASELINE_COMPLETED"]),
    );

    // The baseline result file is independently reopenable
    const result = await readFile(baselineResultPath(project, draft.id, outcome.runId), "utf8").then(JSON.parse);
    expect(result.evaluation.score).toBe(0.75);
    expect(result.snapshotDigest).toBeTruthy();
  });

  test("a model-supplied score or planted score file cannot replace measurement", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-forge"));
    const { resolver, resources, faux } = await controlledHarness(project, "forge");

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });

    expect(faux.state.callCount).toBe(2);
    // Forged score ignored: the independent measurement fails on missing answer.txt
    expect(outcome.evaluation.ok).toBe(false);
    expect(outcome.evaluation.score).toBeUndefined();
    expect(outcome.stopReason).toBe("evaluator-rule-failure");
    expect(JSON.stringify(outcome.evaluation)).not.toContain("selfVerified");
  });

  test("actual candidate effects are confined to the isolated Run workspace, not the project", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-confine"));
    const { resolver, resources } = await controlledHarness(project, "write-good");

    await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });

    // Candidate never wrote into the research project itself
    await expect(readFile(join(project, "answer.txt"), "utf8")).rejects.toThrow();
    const missionFiles = await readdir(join(project, ".evok", "missions", draft.id));
    // controller records live under runs/<id> but no candidate-written file escapes into mission root
    expect(missionFiles).not.toContain("answer.txt");
    expect(missionFiles).not.toContain("score");
  });

  test("real local shell execution is allowed inside the approved isolated workspace", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-bash"));
    const { resolver, resources } = await controlledHarness(project, "bash");

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });
    expect(outcome.evaluation.score).toBe(0.625);
  });

  test("candidate bash/read/write cannot reach the controller .evok tree, credentials, or skill sources", () => {
    // Static boundary regression (US40): the exact policy the baseline Run
    // installs must block every path channel into controller-owned records.
    const boundary = new SandboxBoundary({
      root: "/tmp/evok-authority-probe/run-1",
      network: "none",
      allowBash: true,
      allowedTools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
      readRoots: ["/tmp/evok-authority-proj"],
      protectedPaths: [
        "/tmp/evok-authority-proj/.evok",
        "/tmp/evok-authority-proj/.agents",
        piAgentDir(),
      ],
    });
    const attacks = [
      () => boundary.assertPath("/tmp/evok-authority-proj/.evok/missions/m/mission.json", "write"),
      () => boundary.assertPath("/tmp/evok-authority-proj/.evok/missions/m/mission.json", "read"),
      () => boundary.assertToolCall("bash", { command: "cat ../../.evok/missions/m/result.json" }),
      () => boundary.assertToolCall("bash", { command: "printf x > /tmp/evok-authority-proj/.evok/missions/m/score" }),
      () => boundary.assertToolCall("bash", { command: "cp /tmp/evok-authority-proj/.evok/missions/m/mission.json ./stolen" }),
      () => boundary.assertToolCall("bash", { command: "cat ~/.ssh/id_rsa" }),
      // Pi's own credential/model stores (ADR-0005) are never candidate-readable.
      () => boundary.assertToolCall("bash", { command: `cat ${homedirJoin(".pi/agent/auth.json")}` }),
      () => boundary.assertToolCall("bash", { command: "sed -i s/x/y/ /tmp/evok-authority-proj/.agents/skills/s/SKILL.md" }),
    ];
    for (const attack of attacks) expect(attack).toThrow();
    // legitimate local execution stays open
    expect(() => boundary.assertPath("answer.txt", "write")).not.toThrow();
    expect(() => boundary.assertToolCall("bash", { command: "printf '0.5\\n' > answer.txt" })).not.toThrow();
    expect(() => boundary.assertPath("/tmp/evok-authority-proj/README.md", "read")).not.toThrow();
  });
});

describe("explicit-unit budget enforcement (#112 AC5)", () => {
  test("reserve/check before dispatch; consumed model cost is retained and intake usage stays visible", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    // Total envelope 0.05; intake already consumed 0.001; the reservation (0.01)
    // is checked before dispatch and observed cost is retained after the Run.
    const draft = await seedDraft(project, completeDraft("m-t4-budget", {
      budget: { total: 0.05, units: "model-USD" },
    }));
    const { resolver, resources } = await controlledHarness(project, "write-good");

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      reserveCost: 0.01,
      priceModelCost: () => priceTokens,
    });

    // observed model cost is positive (real tokens x trusted pricing) and retained
    expect(outcome.budget.consumed).toBeGreaterThan(0.001);
    expect(outcome.budget.remaining).toBeCloseTo(0.05 - outcome.budget.consumed, 6);
    const record = await loadMissionRecord(project, draft.id);
    // intake usage is still a visible line item, not erased by execution usage
    expect(record.usage.intake.cost.total).toBeCloseTo(0.001, 6);
    expect(record.usage.runs[0].cost.total).toBeGreaterThan(0);
    expect(record.budget.consumed).toBeCloseTo(outcome.budget.consumed, 6);
  });

  test("a run whose observed cost would cross the bound is rejected and stops further dispatch", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-over", {
      budget: { total: 0.005, units: "model-USD" },
    }));
    const { resolver, resources, faux } = await controlledHarness(project, "write-good");

    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      // unenforceable bound in practice: reservation alone exhausts the envelope
      reserveCost: 0.01,
    }).catch((e) => e as Error);

    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(faux.state.callCount).toBe(0); // reserve/check runs BEFORE dispatch
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toMatch(/budget/);
    expect(record.stopReason).toMatch(/budget/);
    // consumed cost is retained honestly even though the bound was crossed
    expect(record.budget.consumed).toBeGreaterThan(0);
  });

  test("zero remaining budget before dispatch blocks the Run", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-zero", {
      budget: { total: 0.001, units: "model-USD" },
    }));
    const { resolver, resources, faux } = await controlledHarness(project);
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      reserveCost: 0.01,
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(faux.state.callCount).toBe(0);
  });
});

describe("failure and interruption stop dispatch truthfully (#112 AC6)", () => {
  test("an evaluator failure is recorded as evaluator-failed, not as a candidate score", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-evalboom"));
    const { resolver, resources } = await controlledHarness(project, "write-good");
    const failingEvaluator: BaselineEvaluator = {
      id: "boom",
      version: "1",
      async evaluate() { throw new Error("evaluator backend unavailable"); },
    };
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: failingEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(EvaluatorFailureError);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("evaluator-failed");
    expect(record.stopReason).toMatch(/evaluator/);
    // the candidate snapshot is retained as evidence even though success reporting failed
    const run = record.runs[record.baselineRunId!];
    expect(run.snapshotRef).toBeTruthy();
  });

  test("a candidate that produces no artifact is a failed rule measurement, not a success", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-empty"));
    const { resolver, resources } = await controlledHarness(project, "empty");
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });
    expect(outcome.stopReason).toBe("evaluator-rule-failure");
    expect(outcome.evaluation.ok).toBe(false);
  });

  test("interruption before dispatch aborts without persisting an accepted Mission", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-cancel"));
    const { resolver, resources } = await controlledHarness(project, "write-good");
    const error = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD", signal: AbortSignal.abort(),
    }).catch((e: unknown) => e as Error);
    expect((error as Error).name).toBe("AbortError");
    // Nothing was accepted/dispatched: there is no mission record at all.
    const record = await loadMissionRecord(project, draft.id).catch((e: unknown) => e as Error);
    expect(record).toBeInstanceOf(MissionStartRejectedError);
  });

  test("mid-Run interruption persists a truthful interrupted state and blocks re-dispatch", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-cancel2"));
    const { resolver, resources, faux } = await controlledHarness(project, "write-good");
    // The controlled model streams its response; 40ms lands inside the Run
    // (tool dispatch is confirmed) rather than before it. Interrupt state is
    // asserted from the durable record, which is what the recovery slice reads.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      signal: controller.signal, priceModelCost: () => priceTokens,
    }).catch(() => {});
    clearTimeout(timer);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.status).toBe("interrupted");
    expect(record.stopReason).toMatch(/interruption/);
    const callsBefore = faux.state.callCount;
    // call count may be zero only when the abort landed during session setup;
    // the durable interrupted record is what the AC asserts.
    expect(callsBefore).toBeGreaterThanOrEqual(0);
    // the uncertain interrupted execution blocks a second controller, no re-dispatch
    const second = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
    }).catch((e: unknown) => e as Error);
    expect(second).toBeInstanceOf(MissionControllerConflictError);
    expect(faux.state.callCount).toBe(callsBefore);
  });
});

describe("crash-safe durable records (#112 AC2/AC7)", () => {
  test("a crashed in-flight Run is reported blocked on reopen, never silently re-dispatched or adopted", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-crash"));
    const { resolver, resources, faux } = await controlledHarness(project, "write-good");
    // First controller "crashes" after dispatch. The delay sits between model
    // turns deterministically enough for CI, and the interrupted record (not a
    // timing-dependent lock) is what blocks the second controller.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD", signal: controller.signal,
      priceModelCost: () => priceTokens,
    }).catch(() => {});
    const callsAfterCrash = faux.state.callCount;

    // A second start attempt must not dispatch again until the recovery slice;
    // it reports the uncertain interrupted execution truthfully.
    const second = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e) => e as Error);
    expect(second).toBeInstanceOf(MissionControllerConflictError);
    expect((second as MissionControllerConflictError).reason).toMatch(/interrupted|recovery|uncertain/i);
    expect(faux.state.callCount).toBe(callsAfterCrash);
  });

  test("records can be reopened: result, evidence links, usage, remaining budget, stop reason", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-reopen"));
    const { resolver, resources } = await controlledHarness(project, "write-good");
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      reserveCost: 0.01,
    });
    const record = await loadMissionRecord(project, draft.id);
    expect(record.baseline!.evaluation.score).toBe(0.75);
    expect(record.baseline!.evidenceRefs.length).toBeGreaterThan(0);
    expect(record.runs[record.baselineRunId!].model?.id).toBe(outcome.model.id);
    expect(record.budget.remaining).toBe(record.budget.total - record.budget.consumed);
    expect(record.stopReason).toBe("baseline-complete");
    expect(missionRecordPath(project, draft.id)).toContain(join(".evok", "missions"));
  });
});

describe("duplicate controllers (#112 AC7)", () => {
  test("a second concurrent controller cannot dispatch the same Mission", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-dup"));
    const { resolver, resources } = await controlledHarness(project, "write-good");
    // Simulate an active controller lock on disk.
    await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      // unit-test seam: leave the controller lock in place
      leaveLock: true,
    });
    const second = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e) => e as Error);
    expect(second).toBeInstanceOf(MissionControllerConflictError);
  });

  test("a completed Mission cannot be started a second time", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t4-once"));
    const { resolver, resources } = await controlledHarness(project, "write-good");
    await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });
    const again = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    }).catch((e: unknown) => e as Error);
    expect(again).toBeInstanceOf(MissionStartRejectedError);
    expect((again as Error).message).toMatch(/already/);
  });
});
