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
  ReconciliationBlockedError,
  baselineResultPath,
  startAuthorizedMission,
  resumeAuthorizedMission,
  submitSynthesisProposal,
  summarizeMission,
  type BaselineEvaluator,
  type StartAuthorization,
} from "../../src/mission-start";
import type { DirectorInput, MissionDirector } from "../../src/mission-director";
import { InMemoryResearchLedger } from "../../src/mission/research-loop";
import { projectInsightInbox, submitInsightDraft } from "../../src/mission/insight-inbox";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import { createEvokModelResolver } from "../../src/evok-model";
import { runEvok, parseEvokArgs } from "../../src/cli/evok-cli";
import { discoverEvokResources } from "../../src/evok-resources";
import { SandboxBoundary, type SandboxPolicy } from "../../src/security-boundary";
import { defaultSessionFactory, PiAgentRuntime, type AgentRuntimeSession, type SessionModelResolver } from "../../src/pi-agent-runtime";
import { createCompetitionContract } from "../../src/competition/competition-contract";
import { createRuleVisibilityPolicy } from "../../src/competition/rule-visibility";
import { probeHostInventory } from "../../src/execution/host-inventory";
import {
  createDelegatedResearchMemoryProvider,
  createResearchMemoryProvider,
  loadResearchMemorySnapshot,
} from "../../src/execution/research-memory-provider";
import { createMemorySlice, deriveDelegatedMemorySlice, validateMemorySlice } from "../../src/execution/memory-slice";
import type { MemoryProvider, MemoryProviderRequest } from "../../src/execution/context-broker";
import { ContextBroker, validateBrokeredContext } from "../../src/execution/context-broker";
import { createPiSubagentsAdapter } from "../../src/execution/subagents-adapter";
import { grantResourceLease } from "../../src/execution/resource-lease";
import { buildResearcherContext } from "../../src/execution/researcher-context";
import { researchMemoryDir } from "../../src/mission-start";
import { SYNTHESIS_PROPOSAL_SCHEMA } from "../../src/evidence/synthesis-proposal";
import { retrieveResearchMemory, validateResearchMemorySnapshot } from "../../src/evidence/research-memory";
import { projectDecisionAccountability } from "../../src/mission/decision-accountability";
import type { ResumeAuthorization } from "../../src/mission-start";

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

  test("CLI start/resume preserve candidate shell grants and price a separate director tier by its actual model", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-cli-tiers"));
    await writeFile(join(project, ".evok", "evaluation.json"), JSON.stringify({ id: "file-metric", version: "1", artifact: "answer.txt" }));
    const candidate = fauxProvider({ provider: "evok-cli-candidate", models: [{ id: "deep", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] });
    const director = fauxProvider({ provider: "evok-cli-director", models: [{ id: "fast", cost: { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 } }] });
    candidate.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf '0.625\\n' > answer.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("candidate prepared"),
    ]);
    director.setResponses(Array.from({ length: 6 }, () => (ctx) => {
      const state = JSON.stringify(ctx.messages).match(/\\"stateVersion\\":\s*(\d+)/);
      if (!state) throw new Error("director did not receive authoritative state");
      return fauxAssistantMessage(JSON.stringify({ stateVersion: Number(state[1]), action: "stop", rationale: "baseline measured", stopReason: "offline test complete" }));
    }));
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(candidate.provider);
    modelRuntime.registerNativeProvider(director.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const resolver = await createEvokModelResolver({
      modelRuntime,
      orchestra: { deep: "evok-cli-candidate/deep", fast: "evok-cli-director/fast" },
    });
    let output = "";
    const stream = { write(chunk: string) { output += chunk; return true; } };
    const code = await runEvok({
      args: parseEvokArgs(["--start", "--project", project, "--mission", draft.id, "--tier", "deep", "--director-tier", "fast"]),
      createResolver: async () => resolver, stdout: stream, stderr: stream,
    });
    expect(code).toBe(0);
    const initial = await loadMissionRecord(project, draft.id);
    const decisionCalls = director.state.callCount;
    const resumed = await runEvok({
      args: parseEvokArgs(["--resume", "--project", project, "--mission", draft.id, "--tier", "deep", "--director-tier", "fast"]),
      createResolver: async () => resolver, stdout: stream, stderr: stream,
    });
    expect(resumed).toBe(0);
    expect(director.state.callCount).toBeGreaterThan(decisionCalls);
    const record = await loadMissionRecord(project, draft.id);
    expect(record.usage.decisions!.length).toBeGreaterThan(initial.usage.decisions!.length);
    expect(record.baseline?.evaluation.score).toBe(0.625);
    expect(candidate.state.callCount).toBe(2);
    expect(director.state.callCount).toBeGreaterThan(0);
    for (const line of record.usage.decisions ?? []) {
      expect(line.tokens.total).toBeGreaterThan(0);
      expect(line.cost.total).toBeCloseTo(line.tokens.total * 7 / 1_000_000, 10);
    }
    expect(record.usage.decisions?.length).toBeGreaterThan(0);
  });

  for (const allowHost of [false, true]) {
    test(`Mission runtime factories retain ${allowHost ? "explicit host grants" : "network none by default"}`, async () => {
      const project = await tempProject();
      tempDirs.push(project);
      const draft = await seedDraft(project, completeDraft(`m-factory-network-${allowHost}`));
      const { resolver, resources } = await controlledHarness(project, "bash");
      let effective: SandboxPolicy | undefined;
      const outcome = await startAuthorizedMission({
        projectRoot: project, missionId: draft.id, authorization: auth(),
        resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
        priceModelCost: () => priceTokens,
        ...(allowHost ? { network: ["nose"] } : {}),
        runtimeFactory: (workspaceRoot, sandbox) => new PiAgentRuntime({
          workspaceRoot, sandbox, modelResolver: resolver, resources,
          sessionFactory: (options) => {
            effective = options.sandbox;
            return defaultSessionFactory(options);
          },
        }),
      });
      expect(outcome.evaluation.score).toBe(0.625);
      expect(effective?.allowBash).toBe(true);
      expect(effective?.network).toEqual(allowHost ? ["nose"] : "none");
      const boundary = new SandboxBoundary(effective);
      const approved = () => boundary.assertToolCall("bash", { command: "ssh nose 'pwd'" });
      if (allowHost) expect(approved).not.toThrow();
      else expect(approved).toThrow();
      expect(() => boundary.assertToolCall("bash", { command: "ssh other 'pwd'" })).toThrow();
      expect(() => boundary.assertToolCall("write", { path: join(project, "README.md") })).toThrow();
    });
  }

  test("Mission candidates receive explicitly approved domain context and read skill references in place", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-domain-context"));
    const template = await readFile(new URL("../../templates/research-context.APPEND_SYSTEM.md", import.meta.url), "utf8");
    await writeFile(join(project, ".evok", "APPEND_SYSTEM.md"), template.replaceAll("<kb-id>", "697419"));
    await writeFile(join(project, "AGENTS.md"), "UNAPPROVED-AGENTS-CONTEXT");
    const skillDir = join(project, ".pi", "skills", "domain-research");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(project, ".pi", "APPEND_SYSTEM.md"), "PERSONAL-PI-CONTEXT");
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: domain-research\ndescription: Approved project research references\nowner: evok\ncategory: policy\nstate: accepted\n---\nRead references/literature.md relative to this skill directory.\n");
    const reference = join(skillDir, "references", "literature.md");
    await writeFile(reference, "APPROVED-LITERATURE-EXCERPT");
    const { resolver, resources, faux } = await controlledHarness(project);
    let system = "";
    let observedReference = "";
    faux.setResponses([
      (ctx) => {
        system = JSON.stringify(ctx.messages);
        return fauxAssistantMessage(fauxToolCall("read", { path: reference }), { stopReason: "toolUse" });
      },
      (ctx) => {
        observedReference = JSON.stringify(ctx.messages);
        return fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "0.75\n" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("candidate prepared using the approved reference"),
    ]);
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
    });
    expect(outcome.evaluation.score).toBe(0.75);
    expect(system).toContain("bohr kb search 697419");
    expect(system).toContain("never invent measurements or citations");
    expect(system).toContain("Approved project research references");
    expect(system).not.toContain("UNAPPROVED-AGENTS-CONTEXT");
    expect(system).not.toContain("PERSONAL-PI-CONTEXT");
    expect(observedReference).toContain("APPROVED-LITERATURE-EXCERPT");
    expect(await readFile(reference, "utf8")).toBe("APPROVED-LITERATURE-EXCERPT");
  });

  for (const target of ["controller", "evaluator", "credentials", "outside", "project-write"] as const) {
    test(`domain context does not authorize candidate access to ${target}`, async () => {
      const project = await tempProject();
      const outside = await tempProject();
      tempDirs.push(project, outside);
      const draft = await seedDraft(project, completeDraft(`m-domain-deny-${target}`));
      await writeFile(join(project, ".evok", "APPEND_SYSTEM.md"), "Approved context: literature kb 697419.");
      await mkdir(join(project, "evaluator"));
      await mkdir(join(project, "credentials"));
      const paths = {
        controller: join(project, ".evok", "APPEND_SYSTEM.md"),
        evaluator: join(project, "evaluator", "hidden.txt"),
        credentials: join(project, "credentials", "key.txt"),
        outside: join(outside, "hidden.txt"),
        "project-write": join(project, "README.md"),
      };
      for (const path of [paths.evaluator, paths.credentials, paths.outside]) await writeFile(path, "PRIVATE-CONTENT");
      const { resolver, resources, faux } = await controlledHarness(project);
      const call = target === "project-write"
        ? fauxToolCall("write", { path: paths[target], content: "unauthorized replacement" })
        : fauxToolCall("read", { path: paths[target] });
      faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("unreachable")]);
      await expect(startAuthorizedMission({
        projectRoot: project, missionId: draft.id, authorization: auth(),
        resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
        priceModelCost: () => priceTokens,
      })).rejects.toThrow(/protected|escapes|workspace/i);
      expect(await readFile(join(project, "README.md"), "utf8")).toBe("# t4 research project");
    });
  }

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

/**
 * ContextBroker at the Mission Run seam: a Candidate Run receives its rules
 * through a broker-assembled role context bound to that Run/agent, while the
 * generic task constraints stay non-sensitive (never the full hardRules
 * array). The session is a controlled local writer so the evaluator still
 * measures a real artifact.
 */
function brokerSession(writes: { prompts: string[]; answer: string }) {
  return async (options: { cwd?: string }): Promise<AgentRuntimeSession> => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    return {
      sessionId: `broker-session-${Math.random().toString(36).slice(2)}`,
      subscribe(next) { listener = next; return () => { listener = undefined; }; },
      async prompt(text: string) {
        writes.prompts.push(text);
        listener?.({ type: "agent_start" });
        await writeFile(join(options.cwd!, "answer.txt"), `${writes.answer}\n`);
        listener?.({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: "candidate materialized" }],
            usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
            stopReason: "stop",
          }],
        });
      },
      async abort() {},
      dispose() { listener = undefined; },
      getSessionStats() {
        return { tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
      },
    };
  };
}

function constraintsFromPrompt(prompt: string): Record<string, unknown> {
  const line = prompt.split("\n").find((entry) => entry.startsWith("Constraints: "));
  if (!line) throw new Error("prompt carried no Constraints block");
  return JSON.parse(line.slice("Constraints: ".length)) as Record<string, unknown>;
}

describe("broker-assembled context at the Mission Run seam", () => {
  test("rules reach the Run only through an allowlisted role context, not the task constraints", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-broker-ctx"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-challenge");
    const policy = toyPolicy(contract);
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      competitionContext: { contract, policy },
      // The factory owns the runtime policy (same grants as the default one).
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot,
        modelResolver: resolver,
        resources,
        sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("baseline-complete");
    expect(outcome.evaluation.ok).toBe(true);
    expect(writes.prompts).toHaveLength(1);
    const prompt = writes.prompts[0]!;

    // The generic task carries identity only — never the full hardRules array.
    const constraints = constraintsFromPrompt(prompt);
    expect(Object.keys(constraints).sort()).toEqual(["missionId", "runId", "taskId"]);
    expect(prompt).not.toContain("hardRules");
    expect(JSON.stringify(constraints)).not.toContain("no external submission");

    // The role context carries exactly the allowlisted rules for the researcher.
    expect(prompt).toContain("=== ROLE CONTEXT BEGIN (role=researcher,");
    expect(prompt).toContain('"rules":{"scoring.metric":"rmse","scoring.direction":"minimize","dataSplit.folds":5}');
    expect(prompt).toContain('"targetAgentId":"evok-baseline-candidate@m-broker-ctx:baseline:1"');
    expect(prompt).toContain('"runId":"m-broker-ctx:baseline:1"');
    expect(prompt).not.toContain('"holdout":"protected"'); // not allowlisted for researcher
    expect(prompt).not.toContain('"maxPerDay"');
  });

  test("without a competition context the Run keeps the legacy prompt and still carries no rule array", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-no-broker"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.5" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      // The factory owns the runtime policy (same grants as the default one).
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot,
        modelResolver: resolver,
        resources,
        sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("baseline-complete");
    const prompt = writes.prompts[0]!;
    expect(prompt).not.toContain("ROLE CONTEXT");
    expect(prompt).not.toContain("MEMORY SLICE");
    expect(prompt).not.toContain("hardRules");
    // No role-context path means no injection and no synthetic Competition
    // Contract; the legacy prompt is byte-identical.
    expect(outcome.record.researchMemory).toBeDefined();
    expect(Object.keys(constraintsFromPrompt(prompt)).sort()).toEqual(["missionId", "runId", "taskId"]);
  });

  test("contract resource requirements are checked before dispatch and the lease summary reaches the Run", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-broker-resources"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = createCompetitionContract({
      version: "2026.1",
      competitionId: "toy-resources",
      objective: "Run with the declared CPU and memory floor.",
      scoring: { metric: "rmse", direction: "minimize" },
      dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
      submission: { format: "csv:id,prediction" },
      limits: { timeLimitMs: 60_000, network: "none" },
      resources: { cpus: 1, memoryBytes: 1 },
    });
    const policy = createRuleVisibilityPolicy({
      competitionId: contract.competitionId,
      contractDigest: contract.digest,
      allow: { researcher: ["scoring.metric"] },
    });
    const inventory = await probeHostInventory({
      exec: async () => ({ code: 0, stdout: "" }),
      now: () => new Date("2026-10-24T00:00:00Z"),
    });
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      competitionContext: { contract, policy, inventory },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    expect(outcome.status).toBe("baseline-complete");
    expect(writes.prompts[0]).toContain('"resources":{"cpus":1,"memoryBytes":1,"gpuCount":0,"gpuNames":[]');
  });
});

/** A bounded decision port: one discriminating Experiment, then the loop bound stops. */
function oneExperimentDirector(): MissionDirector {
  return {
    id: "stub-research-memory-director",
    async decide(input: DirectorInput) {
      return {
        proposal: {
          stateVersion: input.stateVersion,
          action: "investigate",
          rationale: "follow the measured baseline with one fresh Experiment",
          task: { objective: "materialize answer.txt again in a fresh isolated workspace" },
        },
        sessionId: `director-session-${input.stateVersion}`,
        usage: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  };
}

function toyContract(competitionId: string) {
  return createCompetitionContract({
    version: "2026.1",
    competitionId,
    objective: "Predict the target within the split discipline.",
    scoring: { metric: "rmse", direction: "minimize" },
    dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
    submission: { format: "csv:id,prediction", maxPerDay: 5 },
    limits: { timeLimitMs: 3_600_000, network: "none" },
  });
}

function toyPolicy(contract: ReturnType<typeof toyContract>) {
  return createRuleVisibilityPolicy({
    competitionId: contract.competitionId,
    contractDigest: contract.digest,
    allow: { researcher: ["scoring.metric", "scoring.direction", "dataSplit.folds"] },
  });
}

function memorySliceFromPrompt(prompt: string): Record<string, any> {
  const begin = prompt.indexOf("=== MEMORY SLICE BEGIN");
  if (begin < 0) throw new Error("prompt carried no memory slice");
  const jsonStart = prompt.indexOf("\n", begin) + 1;
  const end = prompt.indexOf("\n=== MEMORY SLICE END ===", jsonStart);
  return JSON.parse(prompt.slice(jsonStart, end)) as Record<string, any>;
}

/**
 * M-d (#245): a broker session that also uses `memory_read` when the Run was
 * served the tool — one delivered read of a card the packet carries, and one
 * refused attempt outside it.
 */
function memoryReadingSession(writes: { prompts: string[]; answer: string }) {
  const base = brokerSession(writes);
  return async (options: Parameters<typeof base>[0] & { customTools?: readonly { name: string; execute: (...args: any[]) => Promise<unknown> }[] }): Promise<AgentRuntimeSession> => {
    const session = await base(options);
    const readTool = (options.customTools ?? []).find((tool) => tool.name === "memory_read");
    return {
      ...session,
      async prompt(text: string) {
        if (readTool) {
          const served = memorySliceFromPrompt(text);
          await readTool.execute("read-1", { ref: served.research.cards[0].cardId }, undefined, undefined, undefined);
          await readTool.execute("read-2", { ref: "finding:not-in-this-packet" }, undefined, undefined, undefined).catch(() => {});
        }
        await session.prompt(text);
      },
    };
  };
}

describe("Mission Research Memory at the authorized lifecycle seam (#210)", () => {
  test("a later fresh Researcher Run receives the bounded finding card from the pinned snapshot", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-memory-loop"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-memory");
    const writes = { prompts: [] as string[], answer: "0.75" };

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("iteration-limit");
    expect(writes.prompts).toHaveLength(2);
    // The first Run has no prior history, so it keeps the legacy prompt.
    expect(writes.prompts[0]).not.toContain("MEMORY SLICE");

    const slice = memorySliceFromPrompt(writes.prompts[1]!);
    expect(slice.schema).toBe("evok.memory-slice/v3");
    expect(slice.missionId).toBe(draft.id);
    expect(slice.taskId).toBe("task-exp-2");
    expect(slice.runId).toBe(`${draft.id}:exp:2`);
    expect(slice.targetAgentId).toBe(`evok-experiment-investigate@${draft.id}:exp:2`);
    expect(slice.research.missionId).toBe(draft.id);
    expect(slice.research.cards).toHaveLength(1);
    expect(slice.research.cards[0]).toMatchObject({
      cardId: `finding:${draft.id}:baseline:1`,
      kind: "finding",
      ok: true,
      sourceRefs: [`runs/${draft.id}:baseline:1/snapshot`, `runs/${draft.id}:baseline:1/result.json`],
    });
    expect(slice.research.omittedCardCount).toBe(0);

    // The consumed snapshot/slice digests are durable on the executed Run, and
    // the slice carries no prior transcript.
    const expRun = outcome.record.runs[`${draft.id}:exp:2`]!;
    expect(expRun.researchMemory?.snapshotId).toBe(slice.research.snapshotId);
    expect(expRun.researchMemory?.snapshotDigest).toBe(slice.research.digest);
    expect(expRun.researchMemory?.sliceDigest).toBe(slice.digest);
    expect(writes.prompts[1]).not.toContain("candidate materialized");
    expect(JSON.stringify(slice)).not.toContain("transcript");
    expect(JSON.stringify(slice)).not.toContain("messages");

    // The active projection now covers both measured Runs and is persisted.
    const active = outcome.record.researchMemory!;
    expect(active.cards.finding).toBe(2);
    expect(active.ledgerRevision).toBe(outcome.record.stateVersion);
    const pointer = JSON.parse(await readFile(
      join(project, ".evok", "missions", draft.id, "memory", "active.json"),
      "utf8",
    ));
    expect(pointer.snapshotId).toBe(active.snapshotId);
    expect(pointer.digest).toBe(active.snapshotDigest);
    expect(await readdir(join(project, ".evok", "missions", draft.id, "memory", "snapshots"))).toContain(`${active.snapshotDigest}.json`);

    // Status is read-only: ids and counts only, no card body or restricted refs.
    const summary = summarizeMission(outcome.record);
    expect(summary.researchMemory).toEqual({
      snapshotId: active.snapshotId,
      snapshotDigest: active.snapshotDigest,
      ledgerRevision: active.ledgerRevision,
      cards: { finding: 2 },
      omittedCards: 0,
    });
    expect(JSON.stringify(summary.researchMemory)).not.toContain(draft.id);
  });

  test("every served-card read is a Mission ledger event, including a refused one (#245)", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-memory-read"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-memory-read");
    const writes = { prompts: [] as string[], answer: "0.75" };

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: memoryReadingSession(writes),
      }),
    });

    // The Memory-Off baseline never had a packet, so it never had the tool.
    expect(writes.prompts[0]).not.toContain("MEMORY SLICE");
    const served = memorySliceFromPrompt(writes.prompts[1]!);
    const reads = outcome.record.history.filter((event) => event.type === "MEMORY_READ");
    expect(reads.map((event) => event.detail)).toMatchObject([
      {
        runId: `${draft.id}:exp:2`,
        cardId: `finding:${draft.id}:baseline:1`,
        snapshotId: served.research.snapshotId,
        snapshotDigest: served.research.digest,
        outcome: "delivered",
      },
      {
        runId: `${draft.id}:exp:2`,
        cardId: "finding:not-in-this-packet",
        outcome: "refused",
      },
    ]);
    expect(reads[1]!.detail!.reason).toContain("is not part of the delivered packet");
    // A read is not Evidence: the measurement and the Run accounting are unchanged.
    expect(outcome.record.runs[`${draft.id}:exp:2`]!.researchMemory?.snapshotDigest).toBe(served.research.digest);
  });

  test("the trusted switch disables projection and injection while keeping legacy behavior", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-memory-off"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-memory-off");
    const writes = { prompts: [] as string[], answer: "0.75" };

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      researchMemory: false,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("iteration-limit");
    expect(writes.prompts).toHaveLength(2);
    expect(writes.prompts[1]).not.toContain("MEMORY SLICE");
    expect(outcome.record.researchMemory).toBeUndefined();
    expect(outcome.record.runs[`${draft.id}:exp:2`]!.researchMemory).toBeUndefined();
    await expect(readdir(join(project, ".evok", "missions", draft.id, "memory"))).rejects.toThrow();
  });
});

describe("Research Memory rejection never costs authoritative history (#210)", () => {
  test("a secret-like measured value is refused before storage and the Run stays durable", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-memory-secret"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.75" };
    const secretEvaluator: BaselineEvaluator = {
      id: "secret-refusing-evaluator",
      version: "1",
      async evaluate() {
        return { ok: false, ruleViolations: ["api_key=sk-live-123456"] };
      },
    };

    await expect(startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: secretEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    })).rejects.toThrow(/secret-like/);

    // The derived projection was refused, but the measured Run and its
    // authoritative record were already persisted.
    const record = await loadMissionRecord(project, draft.id);
    expect(record.baseline?.runId).toBe(`${draft.id}:baseline:1`);
    expect(record.baseline?.evaluation.ruleViolations).toEqual(["api_key=sk-live-123456"]);
    expect(record.runs[`${draft.id}:baseline:1`]?.status).toBe("measured");
    expect(record.researchMemory).toBeUndefined();
  });
});

// ── M1-T2 (#211): Memory-blind Proposal → Memory-informed Revision ──────────

const DECISION_USAGE = {
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
};

type StageScript = { proposal: unknown; usedMemoryRefs?: string[]; insightDispositions?: readonly { insightId: string; disposition: string; reason?: string; proposalRef?: string }[] };

/** A deterministic two-stage decision port that records what each stage saw. */
function twoStageDirector(script: (input: DirectorInput, stage: "blind" | "revision", attempt: number) => StageScript) {
  const calls: Array<{ input: DirectorInput; stage: "blind" | "revision"; attempt: number }> = [];
  const director: MissionDirector = {
    id: "two-stage-scripted",
    async decide(input, _signal, attempt = 1) {
      const stage = input.decisionPhase === undefined ? "blind" : "revision";
      calls.push({ input: structuredClone(input), stage, attempt });
      const result = script(input, stage, attempt);
      return {
        proposal: result.proposal as never,
        sessionId: `${stage}-${attempt}`,
        usage: DECISION_USAGE,
        model: { provider: CONTROL_PROVIDER, model: "deterministic", id: `${CONTROL_PROVIDER}/deterministic` },
        ...(result.usedMemoryRefs ? { usedMemoryRefs: result.usedMemoryRefs } : {}),
        ...(result.insightDispositions ? { insightDispositions: result.insightDispositions as never } : {}),
      };
    },
  };
  return { director, calls };
}

const investigateTask = (objective: string, stateVersion: number) => ({
  stateVersion,
  action: "investigate",
  rationale: `measured baseline is available; ${objective}`,
  task: { objective, expectedOutputs: ["answer.txt"] },
  expectedCost: 0.001,
});

describe("Memory-blind and Memory-informed Director decisions (#211)", () => {
  test("the blind stage sees no Research Memory; the revision is the same prompt plus the frozen proposal and one pinned packet", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-prompts"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-t2-prompts");
    const writes = { prompts: [] as string[], answer: "0.8" };
    const decisionPrompts: string[] = [];
    let decisionCalls = 0;

    // The REAL Pi decision adapter: its prompts are what the model actually saw.
    const { createPiMissionDirector } = await import("../../src/mission-director");
    const director = createPiMissionDirector({
      resources,
      runtimeFactory: (root) => new PiAgentRuntime({
        workspaceRoot: root,
        sessionFactory: async (): Promise<AgentRuntimeSession> => {
          let listener: ((event: Record<string, unknown>) => void) | undefined;
          return {
            sessionId: `decision-${decisionCalls}`,
            subscribe(next) { listener = next; return () => { listener = undefined; }; },
            async prompt(text: string) {
              decisionPrompts.push(text);
              decisionCalls += 1;
              const stateVersion = Number(text.match(/"stateVersion":(\d+)/)?.[1]);
              const proposal = { ...investigateTask("materialize answer.txt again in a fresh workspace", stateVersion), basedOn: [`${draft.id}:baseline:1`] };
              const body = decisionCalls === 2
                ? { ...proposal, usedMemoryRefs: [`finding:${draft.id}:baseline:1`] }
                : proposal;
              listener?.({ type: "agent_start" });
              listener?.({
                type: "agent_end",
                messages: [{
                  role: "assistant",
                  content: [{ type: "text", text: JSON.stringify(body) }],
                  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
                  stopReason: "stop",
                }],
              });
            },
            async abort() {},
            dispose() { listener = undefined; },
            getSessionStats() {
              return { tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
            },
          };
        },
      }),
    });

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    // One decision (both stages) then the authorized one-Experiment bound.
    expect(outcome.status).toBe("iteration-limit");
    expect(outcome.experiments).toHaveLength(1);
    expect(decisionPrompts).toHaveLength(2);

    // AC1: the blind prompt carries the trusted state and NO Memory projection.
    expect(decisionPrompts[0]).toContain("CURRENT AUTHORITATIVE MISSION STATE (JSON):");
    expect(decisionPrompts[0]).not.toContain("RESEARCH DECISION PACKET");
    expect(decisionPrompts[0]).not.toContain("BLIND PROPOSAL");
    expect(decisionPrompts[0]).toContain("0.75"); // measured evidence stays visible
    expect(decisionPrompts[0]).not.toContain("finding:");

    // AC9: the revision prompt is the SAME prompt plus only the allowed fields
    // (the runtime-appended task Constraints block is identical in both).
    const withoutConstraints = (text: string) => text.split("\n").filter((line) => !line.startsWith("Constraints: ")).join("\n");
    const base = withoutConstraints(decisionPrompts[0]!);
    const revisionPrompt = withoutConstraints(decisionPrompts[1]!);
    expect(revisionPrompt.slice(0, base.length)).toBe(base);
    expect(constraintsFromPrompt(decisionPrompts[1]!)).toEqual(constraintsFromPrompt(decisionPrompts[0]!));
    const added = revisionPrompt.slice(base.length);
    expect(added).toContain("BLIND PROPOSAL (frozen, JSON):");
    expect(added).toContain("RESEARCH DECISION PACKET (one pinned snapshot, JSON):");
    expect(added).toContain(`finding:${draft.id}:baseline:1`);
    expect(added).toContain('"action":"investigate"');
    expect(added).not.toContain('"observations"');
    expect(added).not.toContain('"stopConditions"');
    expect(added).not.toContain('"contract"');

    // Both proposals, the pinned refs, the derived delta, and per-stage usage
    // are durable; the model identity is the trusted-side one.
    const decisions = outcome.record.decisions!;
    const firstBlind = decisions.find((d) => d.phase === "blind")!;
    const firstRevision = decisions.find((d) => d.phase === "revision")!;
    expect(firstBlind.proposal?.action).toBe("investigate");
    expect(firstRevision.proposal?.action).toBe("investigate");
    expect(firstRevision.delta).toBe("unchanged");
    expect(firstRevision.revisionReason).toContain("measured baseline");
    expect(firstRevision.memory?.snapshotId).toBe(`research-memory:${firstRevision.memory!.snapshotDigest}`);
    expect(firstRevision.memory?.cardRefs).toContain(`finding:${draft.id}:baseline:1`);
    expect(firstRevision.memory?.usedCardRefs).toEqual([`finding:${draft.id}:baseline:1`]);
    expect(outcome.record.usage.decisions).toHaveLength(2);
  });

  test("the Blind Proposal is frozen before any Memory card is visible and only the Revised Proposal dispatches", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-freeze"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const frozenAtRevision: number[] = [];
    const { director } = twoStageDirector((input, stage) => {
      const last = input.observations[input.observations.length - 1]!;
      if (input.observations.length >= 2) {
        return { proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "two observations", stopReason: "done" } };
      }
      if (stage === "blind") {
        return { proposal: investigateTask("blind-only task objective", input.stateVersion) };
      }
      return { proposal: { ...investigateTask("revised task after Memory", input.stateVersion), basedOn: [last.runId] } };
    });

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      onPersistedEvent: async (event, record) => {
        if (event.type === "DIRECTOR_CALLED" && event.detail?.phase === "revision" && frozenAtRevision.length === 0) {
          // What was already durable when the revision call was persisted.
          frozenAtRevision.push(record.decisions!.filter((d) => d.phase === "blind").length);
        }
      },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(frozenAtRevision).toEqual([1]);
    expect(outcome.experiments).toHaveLength(1);
    // Only the Revised Proposal reached the Task/Run path.
    const directTasks = outcome.record.tasks!.filter((task) => task.source === "director");
    expect(directTasks).toHaveLength(1);
    expect(directTasks[0]!.objective).toBe("revised task after Memory");
    expect(JSON.stringify(outcome.record.tasks)).not.toContain("blind-only task objective");

    const revision = outcome.record.decisions!.find((d) => d.phase === "revision" && d.accepted)!;
    expect(revision.delta).toBe("replaced");
    expect(revision?.rejectedAlternatives?.map((entry) => entry.objective ?? entry.proposal?.task?.objective)).toContain("blind-only task objective");
    expect(revision?.rejectedAlternatives?.[0]?.reason).toMatch(/superseded/);
  });

  test("a withdrawn blind action dispatches nothing and is recorded as withdrawn", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-withdraw"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const { director } = twoStageDirector((input, stage) => ({
      proposal: stage === "blind"
        ? investigateTask("blind action that Memory later withdraws", input.stateVersion)
        : { stateVersion: input.stateVersion, action: "stop", rationale: "Memory shows the direction is already covered", stopReason: "withdrawn after Memory" },
    }));

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("director-stopped");
    expect(outcome.experiments).toHaveLength(0);
    expect(writes.prompts).toHaveLength(1); // baseline only
    const revision = outcome.record.decisions!.find((d) => d.phase === "revision")!;
    expect(revision.delta).toBe("withdrawn");
    expect(revision.rejectedAlternatives?.[0]?.proposal?.task?.objective).toContain("withdraws");
  });

  test("a revision claiming Memory cards outside the pinned packet is rejected, metered, and never dispatched", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-badrefs"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const { director } = twoStageDirector((input, stage, attempt) => {
      if (input.observations.length >= 2) {
        return { proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "two observations", stopReason: "done" } };
      }
      if (stage === "blind") return { proposal: investigateTask("bounded next experiment", input.stateVersion) };
      if (attempt === 1) {
        return { proposal: investigateTask("bounded next experiment", input.stateVersion), usedMemoryRefs: ["finding:another-mission:baseline:1"] };
      }
      return { proposal: investigateTask("bounded next experiment", input.stateVersion), usedMemoryRefs: [`finding:${draft.id}:baseline:1`] };
    });

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    const rejectedRevision = outcome.record.decisions!.find((d) => d.phase === "revision" && !d.accepted)!;
    expect(rejectedRevision.rejection).toMatch(/not part of the delivered packet/);
    expect(rejectedRevision.cost).toBeGreaterThan(0); // the failed revision was still priced
    const acceptedRevision = outcome.record.decisions!.find((d) => d.phase === "revision" && d.accepted)!;
    expect(acceptedRevision.memory?.usedCardRefs).toEqual([`finding:${draft.id}:baseline:1`]);
    expect(acceptedRevision.memory?.cardRefs).toContain(`finding:${draft.id}:baseline:1`);
    expect(outcome.experiments).toHaveLength(1);
  });

  test("a revision priced against the frozen budget is re-checked against the live budget before acceptance", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-livebudget"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    // The revision sees the frozen base state, so it can only be caught by the
    // live check: this proposal fits the frozen budget but not the live one.
    let frozenAvailable = 0;
    const { director } = twoStageDirector((input, stage, attempt) => {
      if (stage === "blind") {
        frozenAvailable = input.budget.remaining - input.budget.reserved;
        return { proposal: investigateTask("bounded next experiment", input.stateVersion) };
      }
      if (attempt === 1) {
        return { proposal: { ...investigateTask("bounded next experiment", input.stateVersion), expectedCost: frozenAvailable - 0.001 } };
      }
      return { proposal: investigateTask("bounded next experiment", input.stateVersion) };
    });

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    const revisions = outcome.record.decisions!.filter((decision) => decision.phase === "revision");
    expect(revisions[0]!.accepted).toBe(false);
    expect(revisions[0]!.rejection).toMatch(/available now/);
    expect(revisions[0]!.cost).toBeGreaterThan(0); // still a priced call
    expect(revisions[1]!.accepted).toBe(true);
    expect(outcome.experiments).toHaveLength(1);
  });

  test("both stages and every correction attempt are independently metered against the same budget", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t2-budget"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const { director } = twoStageDirector((input, stage, attempt) => ({
      // One malformed blind attempt (still a real priced call), then valid ones.
      proposal: stage === "blind" && attempt === 1
        ? { broken: true }
        : investigateTask("bounded next experiment", input.stateVersion),
    }));

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      reserveCost: 0.005,
      director,
      maxExperiments: 1,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    // blind rejection + blind correction + revision; the post-Experiment bound
    // stops the loop without asking for another decision.
    const decisions = outcome.record.decisions!;
    expect(decisions.map((decision) => decision.phase)).toEqual(["blind", "blind", "revision"]);
    expect(decisions.map((decision) => decision.accepted)).toEqual([false, true, true]);
    expect(decisions.every((decision) => decision.cost === DECISION_USAGE.cost.total)).toBe(true);
    // The trusted-side model identity of each stage is durable, not inferred.
    expect(decisions.every((decision) => decision.model?.id === `${CONTROL_PROVIDER}/deterministic`)).toBe(true);
    const decisionSpend = (outcome.record.usage.decisions ?? []).reduce((sum, line) => sum + line.cost.total, 0);
    expect(decisionSpend).toBeCloseTo(DECISION_USAGE.cost.total * 3, 6);
    const accounted = outcome.record.usage.intake.cost.total
      + outcome.record.usage.runs.reduce((sum, line) => sum + line.cost.total, 0)
      + decisionSpend;
    expect(accounted).toBeCloseTo(outcome.record.budget.consumed, 6);
    // Every decision line above is a settled reservation, not a free call.
    expect(outcome.record.budget.remaining).toBeCloseTo(outcome.record.budget.total - outcome.record.budget.consumed, 6);
  });
});

// ── #240: the human Insight sidecar at the Director Revision ────────────────

describe("human Insight at the Director Revision (#240)", () => {
  const IDEA = "INSERTED HUMAN IDEA: temperature may be underweighted";

  /** A research ledger holding one pending Insight draft for this Mission. */
  function insightLedger(missionId: string) {
    const ledger = new InMemoryResearchLedger();
    submitInsightDraft(ledger, { missionId, insightId: "insight-temp", text: IDEA, author: "operator" });
    return ledger;
  }

  async function startWithInsight(missionId: string, script: Parameters<typeof twoStageDirector>[0], ledger?: InMemoryResearchLedger) {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft(missionId, {
      budget: { total: 3, units: "model-USD", note: "human Insight sidecar" },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const { director, calls } = twoStageDirector(script);
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      ...(ledger === undefined ? {} : { insightLedger: ledger }),
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    return { project, draft, outcome, calls, ledger };
  }

  test("the Revision receives the pinned sidecar and records one disposition per Insight", async () => {
    const ledger = insightLedger("m-insight-sidecar");
    const { draft, outcome, calls } = await startWithInsight("m-insight-sidecar", (input, stage) => stage === "blind"
      ? { proposal: investigateTask("materialize answer.txt", input.stateVersion) }
      : {
        proposal: investigateTask("materialize answer.txt again after weighing the human idea", input.stateVersion),
        insightDispositions: [{ insightId: "insight-temp", disposition: "rejected", reason: "temperature co-varies with the other variables, so it is not identifiable here" }],
      }, ledger);

    // Mandatory visibility, never mandatory adoption: the blind stage holds no
    // Insight at all, and the Revision stage is handed the pinned pin.
    expect(calls[0]!.stage).toBe("blind");
    expect(calls[0]!.input.decisionPhase).toBeUndefined();
    const revisionInput = calls[1]!.input;
    const sidecar = revisionInput.decisionPhase!.insightSidecar;
    expect(sidecar.items.map((item) => [item.insightId, item.version])).toEqual([["insight-temp", 1]]);
    expect(sidecar.items[0]!.text).toBe(IDEA);
    expect(sidecar.truncated).toBe(false);

    // Each Revision durably records the ids and versions it actually read.
    const revision = outcome.record.decisions!.find((decision) => decision.phase === "revision")!;
    expect(revision.insight).toEqual({
      sidecarDigest: sidecar.digest,
      items: [{ insightId: "insight-temp", version: 1 }],
      omittedCount: 0,
      truncated: false,
    });
    expect(outcome.record.decisions!.find((decision) => decision.phase === "blind")!.insight).toBeUndefined();

    // The judgement is appended through the existing Insight path, with the
    // decision ref the operator needs to trace it.
    const recorded = ledger.events().filter((event) => event.type === "HUMAN_INSIGHT_DISPOSITION_RECORDED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      missionId: draft.id,
      insightId: "insight-temp",
      version: 1,
      disposition: "rejected",
      decisionRef: revision.decisionGroupId,
    });
    expect(recorded[0]!.payload.reason).toContain("co-varies");
    expect(projectInsightInbox(ledger.events(), { missionId: draft.id }).items[0]!.status).toBe("rejected");

    // An Insight never dispatches: the one Experiment is the ordinary Revised
    // Proposal's, and no ledger event of any other kind appeared.
    expect(outcome.experiments).toHaveLength(1);
    expect(ledger.events().map((event) => event.type)).toEqual(["HUMAN_INSIGHT_DRAFT_CREATED", "HUMAN_INSIGHT_DISPOSITION_RECORDED"]);
  }, 60_000);

  test("an unanswered pinned Insight is a recorded gap, not a blocked Revision", async () => {
    const ledger = insightLedger("m-insight-gap");
    submitInsightDraft(ledger, { missionId: "m-insight-gap", insightId: "insight-split", text: "SHOULD STAY PENDING", author: "operator" });
    const { draft, outcome } = await startWithInsight("m-insight-gap", (input, stage) => stage === "blind"
      ? { proposal: investigateTask("materialize answer.txt", input.stateVersion) }
      : {
        proposal: investigateTask("materialize answer.txt after the human idea", input.stateVersion),
        insightDispositions: [{ insightId: "insight-temp", disposition: "deferred", reason: "revisit once the split is re-measured" }],
      }, ledger);

    // The Revision is not blocked by the second, unanswered pin: the gap is
    // durable and the unread Insight stays pending for a later Revision.
    expect(outcome.status).toBe("iteration-limit");
    expect(outcome.experiments).toHaveLength(1);
    const revision = outcome.record.decisions!.find((decision) => decision.phase === "revision")!;
    expect(revision.insight?.items.map((item) => item.insightId)).toEqual(["insight-temp", "insight-split"]);
    expect(revision.insight?.undispositioned).toEqual(["insight-split"]);
    const inbox = projectInsightInbox(ledger.events(), { missionId: draft.id });
    expect(inbox.items.map((item) => [item.draft.insightId, item.status])).toEqual([["insight-temp", "deferred"], ["insight-split", "pending"]]);
    // A deferred Insight keeps its reason, so the operator sees when to revisit.
    expect(inbox.items[0]!.disposition?.reason).toContain("re-measured");
  }, 60_000);

  test("a missing reason is a rejected attempt, and its retry cannot disposition the Insight twice", async () => {
    const ledger = insightLedger("m-insight-retry");
    const { outcome, calls, draft } = await startWithInsight("m-insight-retry", (input, stage, attempt) => stage === "blind"
      ? { proposal: investigateTask("materialize answer.txt", input.stateVersion) }
      : {
        proposal: investigateTask("materialize answer.txt after the retry", input.stateVersion),
        // First Revision attempt refutes the idea without a reason: refused.
        insightDispositions: attempt === 1
          ? [{ insightId: "insight-temp", disposition: "rejected" }]
          : [{ insightId: "insight-temp", disposition: "ignored", reason: "not worth pursuing before the split is re-measured" }],
      }, ledger);

    expect(calls.filter((call) => call.stage === "revision").map((call) => call.attempt)).toEqual([1, 2]);
    const revisionAttempts = outcome.record.decisions!.filter((decision) => decision.phase === "revision");
    expect(revisionAttempts.map((decision) => decision.accepted)).toEqual([false, true]);
    expect(revisionAttempts[0]!.rejection).toContain("requires a reason");

    // Exactly one disposition event: the refused attempt wrote nothing, and the
    // accepted one wrote once even though the cycle ran two attempts.
    const recorded = ledger.events().filter((event) => event.type === "HUMAN_INSIGHT_DISPOSITION_RECORDED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ disposition: "ignored", decisionRef: revisionAttempts[1]!.decisionGroupId });
    expect(projectInsightInbox(ledger.events(), { missionId: draft.id }).items[0]!.status).toBe("ignored");
    // `ignored` is a judgement, not a refutation: no rejected event was ever written.
    expect(ledger.events().some((event) => event.payload.disposition === "rejected")).toBe(false);
  }, 60_000);
});

// ── M1-T3 (#212): accepted Synthesis Proposals stay unverified cards ────────

function synthesisPayload(missionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SYNTHESIS_PROPOSAL_SCHEMA,
    proposalId: "proposal-1",
    operationId: "op-proposal-1",
    missionId,
    agentId: `evok-experiment-investigate@${missionId}:exp:2`,
    taskId: "task-exp-2",
    runId: `${missionId}:exp:2`,
    kind: "hypothesis",
    statement: "the second Run repeats the baseline outcome",
    rationale: "both measured Runs agree",
    supportingRefs: [{ kind: "run", ref: `${missionId}:baseline:1` }],
    contradictingRefs: [],
    competingRefs: [],
    unknowns: ["holdout effect unknown"],
    applicability: ["dataset:train-v1"],
    visibility: "mission",
    limitations: [],
    conditions: [],
    nextValidation: { objective: "ablate the fold window in one fresh Experiment", advisory: true },
    ...overrides,
  };
}

describe("Synthesis Proposals at the authorized lifecycle seam (#212)", () => {
  test("Proposal → validation → deterministic Snapshot → later bounded read", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-synthesis"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-synthesis");
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    expect(outcome.status).toBe("iteration-limit");
    const baselineRunId = outcome.record.baseline!.runId;
    const runsBefore = Object.keys(outcome.record.runs).length;
    const promptsBefore = writes.prompts.length;

    const submission = await submitSynthesisProposal({
      projectRoot: project,
      missionId: draft.id,
      proposal: synthesisPayload(draft.id, { supportingRefs: [{ kind: "run", ref: baselineRunId }] }),
    });
    expect(submission.outcome).toBe("accepted_for_storage");
    expect(submission.epistemicStatus).toBe("unverified");

    // Durable and unverified: no extra Run is dispatched and no model is called.
    const stored = await loadMissionRecord(project, draft.id);
    expect(stored.synthesisProposals).toHaveLength(1);
    expect(stored.synthesisProposals![0]).toMatchObject({ outcome: "accepted_for_storage", epistemicStatus: "unverified" });
    expect(stored.history[stored.history.length - 1]!.type).toBe("SYNTHESIS_PROPOSAL_RECORDED");
    expect(Object.keys(stored.runs)).toHaveLength(runsBefore);
    expect(writes.prompts).toHaveLength(promptsBefore);

    // The next deterministic snapshot carries the unverified hypothesis card.
    const memoryDir = join(project, ".evok", "missions", draft.id, "memory");
    const snapshot = await loadResearchMemorySnapshot(memoryDir);
    expect(snapshot).toBeDefined();
    const card = snapshot!.cards.find((entry) => entry.kind === "hypothesis")!;
    expect(card).toMatchObject({
      cardId: "hypothesis:synthesis:proposal-1",
      epistemicStatus: "unverified",
      lifecycle: "provisional",
      visibility: "mission",
      supportingRefs: [`run:${baselineRunId}`],
      contradictingRefs: [],
      unknowns: ["holdout effect unknown"],
      nextValidation: { objective: "ablate the fold window in one fresh Experiment", advisory: true },
    });
    expect(stored.researchMemory?.cards).toEqual({ finding: 2, hypothesis: 1 });
    expect(stored.researchMemory?.snapshotDigest).toBe(snapshot!.digest);

    // Identical replay is idempotent: one record, one card, same content address.
    const replay = await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, { supportingRefs: [{ kind: "run", ref: baselineRunId }] }),
    });
    expect(replay.outcome).toBe("accepted_for_storage");
    const replayed = await loadMissionRecord(project, draft.id);
    expect(replayed.synthesisProposals).toHaveLength(1);
    expect(replayed.researchMemory?.snapshotDigest).toBe(stored.researchMemory?.snapshotDigest);

    // A Pitfall keeps its operational conditions in the same projection.
    await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        proposalId: "proposal-pitfall",
        operationId: "op-proposal-pitfall",
        kind: "pitfall",
        statement: "the workspace runs out of memory above batch 32",
        rationale: "keep the batch small on this host",
        applicability: ["runtime:cuda-12"],
        conditions: ["batch size >= 32"],
        unknowns: ["whether other hosts share the limit"],
      }),
    });
    const withPitfall = await loadResearchMemorySnapshot(memoryDir);
    expect(withPitfall!.cards.find((entry) => entry.kind === "pitfall")).toMatchObject({
      cardId: "pitfall:synthesis:proposal-pitfall",
      conditions: ["batch size >= 32"],
      epistemicStatus: "unverified",
    });

    // Later bounded read: a fresh Run-bound slice from the pinned snapshot.
    const provider = createResearchMemoryProvider(memoryDir);
    const slice = await provider({
      missionId: draft.id,
      taskId: "task-exp-2",
      runId: `${draft.id}:exp:3`,
      targetAgentId: `researcher@${draft.id}:exp:3`,
      role: "researcher",
      evidenceRefs: [],
    });
    expect(slice?.research?.snapshotId).toBe(withPitfall!.snapshotId);
    expect(slice?.research?.cards.map((entry) => entry.kind)).toContain("hypothesis");
    // The suggestion stayed advisory: nothing was dispatched by it.
    expect(Object.keys((await loadMissionRecord(project, draft.id)).runs)).toHaveLength(runsBefore);
    await expect(provider({
      missionId: "m-foreign",
      taskId: "task-exp-2",
      runId: "m-foreign:exp:1",
      targetAgentId: "researcher@m-foreign:exp:1",
      role: "researcher",
      evidenceRefs: [],
    })).rejects.toThrow(/belongs to Mission/);
  });

  test("a rejected Proposal is auditable without storing the sensitive payload", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-synthesis-rejected"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    expect(outcome.status).toBe("baseline-complete");
    const baselineRunId = outcome.record.baseline!.runId;
    const runsBefore = Object.keys(outcome.record.runs).length;
    const digestBefore = outcome.record.researchMemory?.snapshotDigest;
    const baselineIdentity = {
      agentId: `evok-baseline-candidate@${baselineRunId}`,
      runId: baselineRunId,
      taskId: undefined,
      supportingRefs: [{ kind: "run", ref: baselineRunId }],
    };

    const rejected = await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        ...baselineIdentity,
        rationale: "the trick is api_key=sk-live-123456",
      }),
    });
    expect(rejected).toMatchObject({ outcome: "rejected", reason: "sensitive-content" });

    const record = await loadMissionRecord(project, draft.id);
    const entry = record.synthesisProposals![record.synthesisProposals!.length - 1]!;
    expect(entry).toMatchObject({ outcome: "rejected", reason: "sensitive-content" });
    expect(Object.keys(entry).sort()).toEqual(["at", "explanation", "outcome", "payloadDigest", "reason"]);
    // Only a reason code and a content address are kept, never the payload.
    expect(JSON.stringify(record)).not.toContain("sk-live-123456");
    expect(JSON.stringify(record)).not.toContain("api_key");
    // A refused Proposal cannot change the published research state.
    expect(record.researchMemory?.snapshotDigest).toBe(digestBefore);
    expect(Object.keys(record.runs)).toHaveLength(runsBefore);

    const foreign = await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        ...baselineIdentity,
        proposalId: "proposal-foreign",
        operationId: "op-proposal-foreign",
        supportingRefs: [{ kind: "run", ref: "m-somewhere-else:baseline:1" }],
      }),
    });
    expect(foreign).toMatchObject({ outcome: "rejected", reason: "refs" });

    // Two submissions never race the same record: the second is refused, not
    // allowed to overwrite the first one's durable write.
    await writeFile(join(project, ".evok", "missions", draft.id, "synthesis.lock"), "{}");
    await expect(submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        ...baselineIdentity,
        proposalId: "proposal-during-lock",
        operationId: "op-proposal-during-lock",
      }),
    })).rejects.toThrow(/submission in progress/);
    await rm(join(project, ".evok", "missions", draft.id, "synthesis.lock"));
  });
});

// ── M1-T5 (#214): condition drift downgrades a card, never silently reuses it ──

describe("Research Memory applicability and lifecycle at the mission seam (#214)", () => {
  test("a Proposal declared under another Evaluation protocol is projected stale and is not a direct prior", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-lifecycle-drift"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-lifecycle");
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    expect(outcome.status).toBe("iteration-limit");
    const memoryDir = join(project, ".evok", "missions", draft.id, "memory");
    const before = await loadResearchMemorySnapshot(memoryDir);
    const evidenceBefore = outcome.record.experiments!.map((entry) => entry.evidenceRefs);

    // The card declares a condition the Mission record does not hold.
    await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        supportingRefs: [{ kind: "run", ref: outcome.record.baseline!.runId }],
        applicability: ["evaluation:an unrelated evaluation protocol"],
      }),
    });

    const record = await loadMissionRecord(project, draft.id);
    const after = await loadResearchMemorySnapshot(memoryDir);
    const stale = after!.cards.find((card) => card.kind === "hypothesis")!;
    expect(stale).toMatchObject({ lifecycle: "stale", revalidationRequired: true });
    expect(after!.digest).not.toBe(before!.digest);
    // The snapshot explains itself: the condition it was projected under is recorded.
    expect(after!.conditions?.some((condition) => condition.startsWith("evaluation:"))).toBe(true);
    // The earlier published snapshot and the authoritative history are untouched.
    expect(validateResearchMemorySnapshot(JSON.parse(JSON.stringify(before)))).toEqual(before);
    expect(record.experiments!.map((entry) => entry.evidenceRefs)).toEqual(evidenceBefore);

    // Declaring the mismatching protocol makes the card answer the query but it
    // is not an active direct prior until it is revalidated.
    const verdict = retrieveResearchMemory(after!, { conditions: ["evaluation:an unrelated evaluation protocol"] })
      .verdicts.find((entry) => entry.card.cardId === stale.cardId)!;
    expect(verdict).toMatchObject({ state: "direct-prior", directPrior: false });
  });
});

// ── M1-T6 (#215): anchoring accountability at the authorized lifecycle seam ──

const resumeAuth = (): ResumeAuthorization => ({ requested: true, token: "/resume", missionSelector: "displayed" });

describe("decision accountability and anti-collapse safeguards (#215)", () => {
  test("an H1/H2 anchoring revision keeps H2 with its contradicting refs and leaves H1's outcome unobserved", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t6-anchor"));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.75" };
    const runtimeFactory = (workspaceRoot: string) => new PiAgentRuntime({
      workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
      sessionFactory: brokerSession(writes),
    });

    // Phase 1: a measured baseline, then ONE measured refutation. The refutation
    // is what a later Hypothesis cites as contradicting Evidence.
    const refuting: MissionDirector = {
      id: "refuting-experiment-director",
      async decide(input: DirectorInput) {
        writes.answer = "not-a-number";
        return {
          proposal: investigateTask("H1 fold window direction", input.stateVersion) as never,
          sessionId: "phase-1",
          usage: DECISION_USAGE,
        };
      },
    };
    const started = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: refuting,
      maxExperiments: 1,
      runtimeFactory,
    });
    expect(started.status).toBe("iteration-limit");
    const refutedRunId = started.record.experiments![0]!.runId;
    expect(started.record.experiments![0]!.negativeEvidence).toBe(true);

    // Two competing Hypotheses under the same conditions: H1 restates the blind
    // direction, H2 survives by citing the measured refutation.
    await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        proposalId: "p-h1", operationId: "op-h1",
        statement: "a shorter fold window lowers rmse under the same split",
        supportingRefs: [{ kind: "run", ref: started.record.baseline!.runId }],
        contradictingRefs: [],
      }),
    });
    await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        proposalId: "p-h2", operationId: "op-h2",
        statement: "the fold window is irrelevant once the split is purged",
        supportingRefs: [{ kind: "run", ref: started.record.baseline!.runId }],
        contradictingRefs: [{ kind: "negative-evidence", ref: refutedRunId }],
        competingRefs: [{ kind: "claim", ref: "p-h1" }],
      }),
    });

    // Phase 2: Memory repeatedly replaces the blind H1 direction with H2. Both
    // resumed Runs measure fine, so no new discriminating Evidence appears.
    const H2_CARD = "hypothesis:synthesis:p-h2";
    const { director } = twoStageDirector((input, stage) => {
      writes.answer = "0.8";
      if (stage === "blind") return { proposal: investigateTask("H1 fold window direction", input.stateVersion) };
      return {
        proposal: investigateTask("H2 purged-split direction", input.stateVersion),
        usedMemoryRefs: [H2_CARD],
      };
    });
    const resumed = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 3,
      runtimeFactory,
    });

    // Review cannot force an action: the authorized bound still governs, and
    // the durable trail keeps every Experiment (the phase-1 refutation too).
    expect(resumed.status).toBe("iteration-limit");
    expect(resumed.experiments).toHaveLength(4);

    // AC3/AC4: every rejected direction keeps its Memory refs, applicability,
    // reason and an UNOBSERVED outcome — never a failure and never a regret.
    const revisions = resumed.record.decisions!.filter((decision) => decision.phase === "revision" && decision.accepted && decision.delta === "replaced");
    expect(revisions).toHaveLength(3);
    const rejected = revisions[0]!.rejectedAlternatives!;
    expect(rejected[0]).toMatchObject({
      objective: "H1 fold window direction",
      counterfactualStatus: "unobserved",
      influencingMemoryRefs: [H2_CARD],
      applicability: { declared: ["dataset:train-v1"], status: "declared" },
    });
    expect(rejected[0]!.reason).toMatch(/superseded/);

    const accountability = projectDecisionAccountability(resumed.record);
    expect(accountability.decisions).toHaveLength(4);
    const h1Rejection = accountability.decisions
      .flatMap((decision) => decision.rejected)
      .find((rejected) => rejected.objective === "H1 fold window direction")!;
    expect(h1Rejection.counterfactualStatus).toBe("unobserved");
    expect(h1Rejection.counterfactualRunIds).toEqual([]);
    expect(h1Rejection.decisionRegret).toBeUndefined();

    // AC9: H2 survives in Memory with its contradicting refs intact.
    const snapshot = await loadResearchMemorySnapshot(join(project, ".evok", "missions", draft.id, "memory"));
    const h2 = snapshot!.cards.find((card) => card.cardId === H2_CARD)!;
    expect(h2).toMatchObject({
      kind: "hypothesis",
      lifecycle: "contested",
      contradictingRefs: [`negative-evidence:${refutedRunId}`],
      competingRefs: ["claim:p-h1"],
    });
    expect(snapshot!.cards.find((card) => card.cardId === "hypothesis:synthesis:p-h1")!.lifecycle).toBe("contested");

    // AC6/AC7: repeated Memory-driven concentration toward one direction, with
    // no new discriminating Evidence, is durably recorded ONCE as advisory.
    const reviews = resumed.record.history.filter((event) => event.type === "DIRECTION_CONCENTRATION_REVIEW");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.detail).toMatchObject({ objective: "h2 purged-split direction", advisory: true });
    // A third change re-states the same concentration; it must not re-fire.
    expect(accountability.diversity.memoryChangedDecisions).toBe(3);
    expect(accountability.diversity.branches).toContainEqual({
      objective: "h2 purged-split direction",
      runIds: resumed.record.experiments!.filter((entry) => entry.taskObjective === "H2 purged-split direction").map((entry) => entry.runId),
    });
    expect(summarizeMission(resumed.record).diversity?.memoryChangedDecisions).toBe(3);

    // AC1/AC2: the packet that revision saw reserved the competitor and the
    // measured refutation ahead of the (more numerous) supporting cards.
    expect(revisions[0]!.memory?.cardRefs).toContain(H2_CARD);
    expect(revisions[0]!.memory?.cardRefs).toContain(`finding:${refutedRunId}`);
  });
});

// ── M1-T7 (#216): resume frozen decisions and rebuild Research Memory ───────
describe("frozen Director decisions and Memory recovery on resume (#216)", () => {
  const memoryDirOf = (project: string, missionId: string) => join(project, ".evok", "missions", missionId, "memory");
  const deleteLock = (project: string, missionId: string) => rm(join(project, ".evok", "missions", missionId, "controller.lock"), { force: true });
  const resumeAuth: ResumeAuthorization = { requested: true, token: "/resume", missionSelector: "displayed" };
  const decisionSpend = (record: { usage: { decisions?: readonly { cost: { total: number } }[] } }) =>
    (record.usage.decisions ?? []).reduce((sum, line) => sum + line.cost.total, 0);

  const runtimeFactoryFor = (resolver: SessionModelResolver, resources: Awaited<ReturnType<typeof discoverEvokResources>>, writes: { prompts: string[]; answer: string }) =>
    (workspaceRoot: string) => new PiAgentRuntime({
      workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
      sessionFactory: brokerSession(writes),
    });

  /** The first durable two-stage crash: `crashPhase` is the stage that just committed. */
  async function crashAfterStage(missionId: string, crashPhase: "blind" | "revision") {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft(missionId, {
      budget: { total: 3, units: "model-USD", note: "T7 recovery slice" },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const { director } = twoStageDirector((input, stage) => stage === "blind"
      ? { proposal: investigateTask("frozen blind objective", input.stateVersion) }
      : { proposal: { ...investigateTask("revised objective after Memory", input.stateVersion), basedOn: [input.observations[input.observations.length - 1]!.runId] } });
    const crashed = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
      maxExperiments: 1,
      onPersistedEvent: async (event) => {
        if (event.type === "DIRECTOR_CALLED" && event.detail?.phase === crashPhase) throw new Error("simulated process crash");
      },
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    }).catch((error) => error as Error);
    expect(crashed).toBeInstanceOf(Error);
    await deleteLock(project, draft.id);
    return { project, draft, resolver, resources, writes };
  }

  test("a resume after the frozen Blind Proposal reuses that exact proposal and pinned snapshot", async () => {
    const { project, draft, resolver, resources, writes } = await crashAfterStage("m-t7-blind", "blind");
    const durable = await loadMissionRecord(project, draft.id);
    const frozenBlind = durable.decisions!.find((decision) => decision.phase === "blind")!;
    expect(frozenBlind.accepted).toBe(true);
    const pinnedDigest = durable.researchMemory!.snapshotDigest;
    expect(durable.experiments ?? []).toHaveLength(0);
    const spendAtCrash = decisionSpend(durable);

    // A fresh context (the only durable state is the record) resumes.
    const { director, calls } = twoStageDirector((input, stage) => stage === "blind"
      ? { proposal: investigateTask("REGENERATED blind objective", input.stateVersion) }
      : { proposal: investigateTask("revised from the frozen blind proposal", input.stateVersion) });
    const outcome = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });

    // The blind stage is NEVER regenerated, and its frozen proposal is the
    // one the revision stage received.
    expect(calls.filter((call) => call.stage === "blind")).toHaveLength(0);
    expect(calls.filter((call) => call.stage === "revision")).toHaveLength(1);
    expect(calls[0]!.input.decisionPhase?.blindProposal).toEqual(frozenBlind.proposal);
    // …pinned to the snapshot the Mission already served, not a newer one.
    const revision = outcome.record.decisions!.filter((decision) => decision.phase === "revision").at(-1)!;
    expect(revision.memory?.snapshotDigest).toBe(pinnedDigest);
    expect(outcome.record.decisions!.filter((decision) => decision.phase === "blind")).toHaveLength(1);
    // Exactly one Experiment; the completed blind stage is not charged twice.
    expect(outcome.experiments).toHaveLength(1);
    expect(outcome.experiments[0]!.taskObjective).toBe("revised from the frozen blind proposal");
    expect(decisionSpend(outcome.record) - spendAtCrash).toBeCloseTo(DECISION_USAGE.cost.total, 6);
  }, 60_000);

  test("a resume after the Revised Proposal dispatches that validated action once, with no re-charge", async () => {
    const { project, draft, resolver, resources, writes } = await crashAfterStage("m-t7-revision", "revision");
    const durable = await loadMissionRecord(project, draft.id);
    const frozenRevision = durable.decisions!.find((decision) => decision.phase === "revision")!;
    expect(frozenRevision.accepted).toBe(true);
    const spendAtCrash = decisionSpend(durable);
    const runsBefore = Object.keys(durable.runs).sort();

    const { director, calls } = twoStageDirector((input) => ({
      proposal: investigateTask("a DIFFERENT action the resumed model would pick", input.stateVersion),
    }));
    const outcome = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });

    // Both stages were already decided: no model call is repeated.
    expect(calls).toHaveLength(0);
    // The validated Revised Proposal's action is dispatched exactly once.
    expect(outcome.experiments).toHaveLength(1);
    expect(outcome.experiments[0]!.taskObjective).toBe(frozenRevision.proposal!.task!.objective);
    expect(outcome.record.decisions).toHaveLength(durable.decisions!.length);
    expect(decisionSpend(outcome.record)).toBeCloseTo(spendAtCrash, 9);
    // A fresh Run identity is issued for the never-executed attempt; the
    // recorded runs are preserved, none is duplicated.
    const runsAfter = Object.keys(outcome.record.runs).sort();
    expect(runsAfter).toHaveLength(runsBefore.length + 1);
    for (const runId of runsBefore) expect(runsAfter).toContain(runId);
  }, 60_000);

  test("a cleanly stopped Mission asks again on resume instead of replaying the same stop", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t7-stopped", {
      budget: { total: 3, units: "model-USD", note: "T7 stopped slice" },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const writes = { prompts: [] as string[], answer: "0.8" };
    const stop = twoStageDirector((input) => ({
      proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "nothing worth measuring yet", stopReason: "done" },
    }));
    const stopped = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: stop.director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });
    expect(stopped.status).toBe("director-stopped");

    // The user resumes explicitly; that is a NEW decision, not a replay of the stop.
    const { director, calls } = twoStageDirector((input) => ({
      proposal: { ...investigateTask("a direction the user resumed for", input.stateVersion), basedOn: [input.observations[0]!.runId] },
    }));
    const resumed = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });
    expect(calls.filter((call) => call.stage === "blind")).toHaveLength(1);
    expect(resumed.experiments.map((entry) => entry.taskObjective)).toEqual(["a direction the user resumed for"]);
    expect(resumed.status).toBe("iteration-limit");
  }, 60_000);

  test("a damaged snapshot is rebuilt deterministically, kept competing records, and never served empty", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-t7-rebuild", {
      budget: { total: 3, units: "model-USD", note: "T7 rebuild slice" },
    }));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-t7-rebuild");
    const writes = { prompts: [] as string[], answer: "0.75" };
    const twoExperiments = twoStageDirector((input) => input.observations.length >= 3
      ? { proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "enough observations", stopReason: "done" } }
      : {
          proposal: {
            ...investigateTask(`competing branch objective ${input.observations.length}`, input.stateVersion),
            basedOn: [input.observations[input.observations.length - 1]!.runId],
          },
        });
    const started = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: twoExperiments.director, maxExperiments: 2,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });
    expect(started.experiments).toHaveLength(2);
    // A stored accepted Proposal is part of the authoritative rebuild input.
    await submitSynthesisProposal({
      projectRoot: project, missionId: draft.id,
      proposal: synthesisPayload(draft.id, {
        agentId: `evok-experiment-investigate@${draft.id}:exp:2`,
        runId: `${draft.id}:exp:2`,
        supportingRefs: [{ kind: "run", ref: started.experiments[0]!.runId }],
      }),
    });
    const published = await loadResearchMemorySnapshot(memoryDirOf(project, draft.id));
    const authoritativeDigest = published!.digest;
    const before = await loadMissionRecord(project, draft.id);
    expect(before.researchMemory?.snapshotDigest).toBe(authoritativeDigest);

    // Crash-style damage: the pointer survives, its snapshot bytes do not.
    await writeFile(join(memoryDirOf(project, draft.id), "snapshots", `${authoritativeDigest}.json`), "{ corrupted");
    const { director } = twoStageDirector((input) => ({ proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "recovered", stopReason: "done" } }));
    const resumed = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });
    // Deterministic rebuild from Mission history + stored proposals: same digest.
    expect(resumed.record.researchMemory?.snapshotDigest).toBe(authoritativeDigest);
    const rebuilt = await loadResearchMemorySnapshot(memoryDirOf(project, draft.id));
    expect(rebuilt!.digest).toBe(authoritativeDigest);
    expect(rebuilt!.cards.filter((card) => card.kind === "hypothesis")).toHaveLength(1);
    // Both competing Branch outcomes and the stored Proposal survive recovery.
    expect(resumed.record.experiments).toHaveLength(2);
    expect(resumed.record.synthesisProposals).toHaveLength(1);
    expect(rebuilt!.cards.filter((card) => card.kind === "finding")).toHaveLength(3);
    expect(resumed.record.history.some((event) => event.type === "RECOVERY_MEMORY_REBUILT")).toBe(true);
    // Consumed budget never shrinks on recovery.
    expect(resumed.record.budget.consumed).toBeGreaterThanOrEqual(before.budget.consumed - 1e-12);
    // An already executed Run keeps the snapshot/slice digests it consumed.
    const consumingRunId = before.experiments![1]!.runId;
    const consumed = before.runs[consumingRunId]!.researchMemory;
    expect(consumed).toBeDefined();
    // It was pinned to the snapshot of that moment, not to the active pointer.
    expect(consumed!.snapshotDigest).not.toBe(authoritativeDigest);
    expect(resumed.record.runs[consumingRunId]!.researchMemory).toEqual(consumed);

    // Missing derived artifacts (no pointer, no snapshots) rebuild the same snapshot.
    await rm(memoryDirOf(project, draft.id), { recursive: true, force: true });
    const again = await resumeAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director, maxExperiments: 1,
      runtimeFactory: runtimeFactoryFor(resolver, resources, writes),
    });
    expect(again.record.researchMemory?.snapshotDigest).toBe(authoritativeDigest);
    expect((await loadResearchMemorySnapshot(memoryDirOf(project, draft.id)))!.digest).toBe(authoritativeDigest);
  }, 90_000);

  test("a rebuild that would serve less history than the Mission committed to fails closed", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const id = "m-t7-shrunk";
    const seeded = await seedDraft(project, completeDraft(id, { budget: { total: 2, units: "model-USD" } }));
    const dir = join(project, ".evok", "missions", id);
    await mkdir(dir, { recursive: true });
    // Structurally valid, but the Experiment trail no longer supports the
    // snapshot the Mission already committed to (a truncated sequence).
    await writeFile(join(dir, "mission.json"), JSON.stringify({
      schemaVersion: 1, id, status: "director-stopped", objective: seeded.objective,
      contract: { objective: seeded.objective, expectedOutputs: ["answer.txt"], evaluationMethod: "file-answer-deterministic", hardRules: seeded.constraints.hardRules },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 4, tasks: [],
      experiments: [{ runId: `${id}:exp:2`, attempt: 2, action: "investigate", ok: true, taskObjective: "kept", evidenceRefs: [], at: "2026-11-07T00:00:00.000Z" }],
      researchMemory: { snapshotId: "research-memory:committed", snapshotDigest: "ab".repeat(32), ledgerRevision: 4, cards: { finding: 4, hypothesis: 2 }, omittedCards: 0 },
      history: [], createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z",
    }, null, 2));
    const { resolver, resources } = await controlledHarness(project);
    const { director } = twoStageDirector((input) => ({ proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "no" } }));
    const blocked = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
    }).catch((error) => error as Error);
    expect(blocked).toBeInstanceOf(ReconciliationBlockedError);
    expect((blocked as Error).message).toMatch(/shrunken or empty/);
    // The shrunken rebuild is never published over the committed snapshot.
    expect(await loadResearchMemorySnapshot(memoryDirOf(project, id))).toBeUndefined();
  }, 60_000);

  test("unrebuildable Memory corruption fails closed instead of serving an empty snapshot", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const id = "m-t7-corrupt";
    const seeded = await seedDraft(project, completeDraft(id, { budget: { total: 2, units: "model-USD" } }));
    const dir = join(project, ".evok", "missions", id);
    await mkdir(dir, { recursive: true });
    // A structurally valid record whose derived input is damaged: the trail
    // entry cannot be projected, so no snapshot can be verified or rebuilt.
    await writeFile(join(dir, "mission.json"), JSON.stringify({
      schemaVersion: 1, id, status: "director-stopped", objective: seeded.objective,
      contract: { objective: seeded.objective, expectedOutputs: ["answer.txt"], evaluationMethod: "file-answer-deterministic", hardRules: seeded.constraints.hardRules },
      budget: { total: 2, units: "model-USD", consumed: 0.001, remaining: 1.999 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0.001, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [],
      experiments: [{ runId: `${id}:exp:2`, attempt: 2, action: "investigate", ok: "maybe", taskObjective: "damaged", evidenceRefs: [], at: "2026-11-07T00:00:00.000Z" }],
      researchMemory: { snapshotId: "research-memory:deadbeef", snapshotDigest: "deadbeef", ledgerRevision: 1, cards: { finding: 1 }, omittedCards: 0 },
      history: [], createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z",
    }, null, 2));
    const { resolver, resources } = await controlledHarness(project);
    const { director } = twoStageDirector((input) => ({ proposal: { stateVersion: input.stateVersion, action: "stop", rationale: "no" } }));
    const blocked = await resumeAuthorizedMission({
      projectRoot: project, missionId: id, authorization: resumeAuth,
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director,
    }).catch((error) => error as Error);
    expect(blocked).toBeInstanceOf(ReconciliationBlockedError);
    expect((blocked as Error).message).toMatch(/Research Memory|research memory/);
    // Never an empty research history: no snapshot is published or served,
    // and the damaged authoritative record is left untouched.
    expect(await loadResearchMemorySnapshot(memoryDirOf(project, id))).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "mission.json"), "utf8")).status).toBe("director-stopped");
  }, 60_000);
});

/**
 * M1-T8 (#217): a delegated child agent gets a NEWLY generated slice bound to
 * its own Mission/Task/Run/targetAgent from the PARENT's pinned Research
 * Memory snapshot — never from the active pointer, the parent's slice, a
 * sibling's, a previous Run's, or an Evaluator's context.
 */
describe("Research Memory delegation at the authorized lifecycle seam (#217)", () => {
  async function runMemoryMission(missionId: string) {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft(missionId));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract(`toy-${missionId}`);
    const writes = { prompts: [] as string[], answer: "0.75" };
    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      director: oneExperimentDirector(),
      maxExperiments: 1,
      competitionContext: { contract, policy: toyPolicy(contract) },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });
    expect(outcome.status).toBe("iteration-limit");
    return { project, draft, resolver, resources, contract, writes, outcome };
  }

  test("the child gets a fresh child-bound slice from the parent's pinned snapshot, never the active one", async () => {
    const { project, draft, resolver, resources, contract, writes, outcome } = await runMemoryMission("m-sub-memory");
    const parentSlice = validateMemorySlice(memorySliceFromPrompt(writes.prompts[1]!));
    expect(parentSlice.schema).toBe("evok.memory-slice/v3");
    // Pinned when the parent was dispatched: only the baseline card.
    expect(parentSlice.research!.cards).toHaveLength(1);
    // The active projection has already moved on to a wider snapshot.
    const active = await loadResearchMemorySnapshot(researchMemoryDir(project, draft.id));
    expect(active!.digest).not.toBe(parentSlice.research!.digest);
    expect(active!.cards.length).toBeGreaterThan(parentSlice.research!.cards.length);

    const childRunId = `${parentSlice.runId}:sub:1`;
    const childAgentId = `critic@${childRunId}`;
    const childTaskId = parentSlice.taskId;
    // The child's role context is assembled by the SAME broker path, with a
    // provider pinned to the parent's snapshot for exactly this child Run.
    const childBroker = new ContextBroker({
      contract,
      policy: toyPolicy(contract),
      memory: createDelegatedResearchMemoryProvider({
        parent: parentSlice, taskId: childTaskId, runId: childRunId, targetAgentId: childAgentId,
      }),
      source: "team-coordinator",
    });
    const brokered = await childBroker.assemble({
      missionId: draft.id,
      taskId: childTaskId,
      runId: childRunId,
      targetAgentId: childAgentId,
      role: "critic",
      objective: "critique the candidate from the parent's pinned research state",
    });
    if (brokered.context.kind !== "role") throw new Error("expected a role context");
    const childSlice = brokered.memorySlice!;

    // Fresh child binding, same pinned packet: never wider than the parent's.
    expect(childSlice.runId).toBe(childRunId);
    expect(childSlice.targetAgentId).toBe(childAgentId);
    expect(childSlice.sliceId).not.toBe(parentSlice.sliceId);
    expect(childSlice.digest).not.toBe(parentSlice.digest);
    expect(childSlice.research!.digest).toBe(parentSlice.research!.digest);
    expect(validateBrokeredContext(JSON.parse(JSON.stringify(brokered)))).toEqual(brokered);

    // Delegation: the guard accepts exactly this child's slice + pinned parent.
    const delegated: typeof brokered[] = [];
    const adapter = createPiSubagentsAdapter(async (delegation) => {
      delegated.push(delegation as never);
      return { agent: delegation.agent, value: "critique delivered" };
    });
    const result = await adapter.delegate({
      agent: "critic-1",
      capability: "critique",
      task: "critique the candidate",
      context: buildResearcherContext({ objective: "critique the candidate", tools: ["read"] }),
      roleContext: brokered.context.roleContext,
      memorySlice: childSlice,
      parentMemorySlice: parentSlice,
      runId: childRunId,
      targetAgentId: childAgentId,
      parentBinding: { runId: parentSlice.runId, targetAgentId: parentSlice.targetAgentId },
      freshSession: true,
    });
    expect(result.value).toBe("critique delivered");
    expect(delegated).toHaveLength(1);

    // A caller may also hand over only the parent's pinned slice: the adapter
    // derives the same Deterministic child slice the brokered provider served.
    const derivedOnly: typeof brokered[] = [];
    const derivingAdapter = createPiSubagentsAdapter(async (delegation) => {
      derivedOnly.push(delegation as never);
      return { agent: delegation.agent, value: "derived" };
    });
    await derivingAdapter.delegate({
      agent: "critic-2",
      capability: "review",
      task: "review the candidate",
      context: buildResearcherContext({ objective: "review the candidate", tools: ["read"] }),
      roleContext: brokered.context.roleContext,
      parentMemorySlice: parentSlice,
      runId: childRunId,
      targetAgentId: childAgentId,
      parentBinding: { runId: parentSlice.runId, targetAgentId: parentSlice.targetAgentId },
      freshSession: true,
    });
    expect((derivedOnly[0] as never as { memorySlice: { digest: string } }).memorySlice.digest).toBe(childSlice.digest);

    // The child executes in its OWN fresh session: the pinned card is in its
    // prompt, the newer active card is not, and no parent transcript travels.
    const childWrites = { prompts: [] as string[], answer: "0.75" };
    const childRuntime = new PiAgentRuntime({
      workspaceRoot: join(project, "child-runtime"),
      modelResolver: resolver,
      resources,
      sandbox: { allowBash: false },
      sessionFactory: brokerSession(childWrites),
    });
    const childResult = await childRuntime.execute({
      task: { objective: "critique the candidate", constraints: { missionId: draft.id, runId: childRunId, taskId: childTaskId }, expectedOutputs: ["critique.md"] },
      role: { name: "critic", instructions: "critique the candidate", tools: ["read"], allowCodingTools: true, audience: "critic" },
      targetAgentId: childAgentId,
      roleContext: brokered.context.roleContext,
      memorySlice: childSlice,
      workspace: { path: join(project, "child-runtime", "child-ws"), isolated: true, approved: true },
      tier: "default",
      intentId: `${childRunId}:intent`,
      identity: { branchId: "sub", runId: childRunId, attempt: 1, workspaceId: join(project, "child-ws"), fencingToken: 1 },
    });
    expect(childResult.sessionId).not.toBe(undefined);
    expect(childWrites.prompts).toHaveLength(1);
    const childPrompt = childWrites.prompts[0]!;
    expect(childPrompt).toContain("=== ROLE CONTEXT BEGIN (role=critic");
    expect(childPrompt).toContain(`"sliceId":"${childSlice.sliceId}"`);
    expect(childPrompt).toContain(parentSlice.research!.cards[0]!.cardId);
    // The active (wider) snapshot's later card never reached the child.
    const newerCard = active!.cards.find((card) => !parentSlice.research!.cards.some((pinned) => pinned.cardId === card.cardId))!;
    expect(childPrompt).not.toContain(newerCard.cardId);
    expect(childPrompt).not.toContain("candidate materialized");
    // Visibility is not widened by delegation: the critic's own policy yields
    // no researcher-only rule fields, and the child packet is the pinned one.
    expect(brokered.context.roleContext.rules).toEqual({});
    expect(childPrompt).not.toContain('"dataSplit.folds":5');

    // The Mission's own ledger never records the child as an executed Run.
    expect(outcome.record.runs[childRunId]).toBeUndefined();
  });

  test("a legacy custom MemoryProvider and its v2 slice still execute under the previous contract", async () => {
    const project = await tempProject();
    tempDirs.push(project);
    const draft = await seedDraft(project, completeDraft("m-legacy-provider"));
    const { resolver, resources } = await controlledHarness(project);
    const contract = toyContract("toy-legacy-provider");
    const writes = { prompts: [] as string[], answer: "0.75" };
    const requests: MemoryProviderRequest[] = [];
    const legacyProvider: MemoryProvider = (request) => {
      requests.push(request);
      return createMemorySlice({
        sliceId: "legacy-slice",
        missionId: request.missionId,
        taskId: request.taskId,
        runId: request.runId,
        targetAgentId: request.targetAgentId,
        facts: [{ name: "score", value: 0.5 }],
      });
    };

    const outcome = await startAuthorizedMission({
      projectRoot: project, missionId: draft.id, authorization: auth(),
      resolver, resources, evaluator: fileEvaluator, budgetUnits: "model-USD",
      priceModelCost: () => priceTokens,
      competitionContext: { contract, policy: toyPolicy(contract), memory: legacyProvider },
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
        workspaceRoot, modelResolver: resolver, resources, sandbox: { allowBash: true },
        sessionFactory: brokerSession(writes),
      }),
    });

    expect(outcome.status).toBe("baseline-complete");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.role).toBe("researcher");
    // The custom provider is never displaced by the durable one: the Run gets
    // exactly its legacy v2 slice, with no fabricated research packet.
    const slice = memorySliceFromPrompt(writes.prompts[0]!);
    expect(slice.schema).toBe("evok.memory-slice/v2");
    expect(slice.research).toBeUndefined();
    expect(slice.facts).toEqual([{ name: "score", value: 0.5 }]);
    expect(outcome.record.runs[`${draft.id}:baseline:1`]!.researchMemory).toBeUndefined();
  });

  test("parent, sibling, previous-Run, and trusted-context slices are rejected before the child session starts", async () => {
    const { project, draft, contract, writes } = await runMemoryMission("m-sub-reject");
    const parentSlice = validateMemorySlice(memorySliceFromPrompt(writes.prompts[1]!));
    const childRunId = `${parentSlice.runId}:sub:1`;
    const childAgentId = `critic@${childRunId}`;
    const childTaskId = parentSlice.taskId;
    const broker = new ContextBroker({
      contract,
      policy: toyPolicy(contract),
      memory: createDelegatedResearchMemoryProvider({
        parent: parentSlice, taskId: childTaskId, runId: childRunId, targetAgentId: childAgentId,
      }),
      source: "team-coordinator",
    });
    const brokered = await broker.assemble({
      missionId: draft.id, taskId: parentSlice.taskId, runId: childRunId,
      targetAgentId: childAgentId, role: "critic", objective: "critique the candidate",
    });
    if (brokered.context.kind !== "role") throw new Error("expected a role context");
    const roleContext = brokered.context.roleContext;
    const childSlice = brokered.memorySlice!;

    let transportCalls = 0;
    const adapter = createPiSubagentsAdapter(async (delegation) => {
      transportCalls += 1;
      return { agent: delegation.agent, value: null };
    });
    const base = {
      agent: "critic-1",
      capability: "critique" as const,
      task: "critique the candidate",
      context: buildResearcherContext({ objective: "critique the candidate", tools: ["read"] }),
      roleContext,
      runId: childRunId,
      targetAgentId: childAgentId,
      parentBinding: { runId: parentSlice.runId, targetAgentId: parentSlice.targetAgentId },
      freshSession: true,
    };

    // The parent's own slice, a sibling's, and a previous Run's all fail closed.
    await expect(adapter.delegate({ ...base, memorySlice: parentSlice, parentMemorySlice: parentSlice }))
      .rejects.toThrow(/another run/);
    const sibling = createDelegatedResearchMemoryProvider({
      parent: parentSlice, taskId: parentSlice.taskId,
      runId: `${parentSlice.runId}:sub:2`, targetAgentId: `critic@${parentSlice.runId}:sub:2`,
    });
    await expect(sibling({
      missionId: draft.id, taskId: parentSlice.taskId, runId: childRunId,
      targetAgentId: childAgentId, role: "critic", evidenceRefs: [],
    })).rejects.toThrow(/bound to child Task/);
    // A well-formed slice for a previous Run of the same Mission is refused.
    const previousRun = deriveDelegatedMemorySlice({
      parent: parentSlice,
      missionId: draft.id,
      taskId: parentSlice.taskId,
      runId: `${parentSlice.runId}:sub:0`,
      targetAgentId: `critic@${parentSlice.runId}:sub:0`,
    });
    await expect(adapter.delegate({ ...base, memorySlice: previousRun, parentMemorySlice: parentSlice }))
      .rejects.toThrow(/belongs to another run/);
    // A tampered slice never reaches the transport either.
    await expect(adapter.delegate({
      ...base,
      memorySlice: { ...childSlice, runId: `${childRunId}:9` },
    })).rejects.toThrow(/digest mismatch/);
    expect(transportCalls).toBe(0);

    // An Evaluator (trusted) context is never injected with Research Memory.
    const evaluatorBroker = new ContextBroker({
      contract, policy: toyPolicy(contract),
      memory: createResearchMemoryProvider(researchMemoryDir(project, draft.id)),
      source: "mission-controller",
    });
    const evaluator = await evaluatorBroker.assemble({
      missionId: draft.id, taskId: parentSlice.taskId, runId: `${draft.id}:eval:1`,
      targetAgentId: `evaluator@${draft.id}:eval:1`, role: "evaluator",
      objective: "measure the candidate independently",
      evaluation: { entry: "evaluate" },
      lease: await grantResourceLease({
        inventory: await probeHostInventory(),
        taskId: parentSlice.taskId,
        request: { cpus: 1, memoryBytes: 1 },
      }),
      workspace: { root: join(project, "eval-ws") },
    });
    expect(evaluator.memorySlice).toBeUndefined();
    expect(evaluator.digests.memory).toBeUndefined();
    expect(JSON.stringify(evaluator)).not.toContain("research-memory-snapshot");
  });
});
