/**
 * M1-T9 (#218): Memory Off / Schema-only Sham / Real Memory at the authorized
 * Mission lifecycle seam.
 *
 * The three arms are three ordinary Missions started through the SAME
 * `startAuthorizedMission` seam with the SAME deterministic Director and the
 * SAME deterministic session factory — there is no Memory-specific test
 * controller, no live model provider, and no GPU. The test proves matched
 * budgets/decision calls/initial state, a Sham input with no research content,
 * no future-information leakage in offline replay, the separated report
 * readings, and a read-only status summary with no card bodies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  loadMissionRecord,
  startAuthorizedMission,
  summarizeMission,
  type BaselineEvaluator,
  type MissionRecord,
} from "../../src/mission-start";
import type { DirectorInput, DirectorProposal, MissionDirector } from "../../src/mission-director";
import { saveMissionDraft, type MissionDraft } from "../../src/mission-draft";
import { createEvokModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";
import { PiAgentRuntime, type AgentRuntimeSession } from "../../src/pi-agent-runtime";
import { createCompetitionContract } from "../../src/competition/competition-contract";
import { createRuleVisibilityPolicy } from "../../src/competition/rule-visibility";
import {
  RESEARCH_CONTROL_CARD_SCHEMA,
  RESEARCH_MEMORY_FINDING_CARD_SCHEMA,
  researchMemoryModeOf,
} from "../../src/evidence/research-memory";
import {
  RESEARCH_MEMORY_CONTROL_CAVEAT,
  evaluateResearchMemory,
  initialStateDigestOf,
  replayResearchMemory,
  type ResearchMemoryEvaluationMode,
} from "../../src/mission/memory-evaluation";

const CONTROL_PROVIDER = "evok-t9-control";
const MODEL_COST = { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0 };
const DECISION_USAGE = {
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
};
const DIRECTOR_MODEL = { provider: CONTROL_PROVIDER, model: "deterministic", id: `${CONTROL_PROVIDER}/deterministic` };

const fileEvaluator: BaselineEvaluator = {
  id: "file-answer-deterministic",
  version: "1",
  async evaluate(snapshot) {
    const raw = snapshot["answer.txt"];
    if (raw === undefined) return { ok: false, ruleViolations: ["answer.txt is missing"] };
    const value = Number(raw.split(/\r?\n/, 1)[0]?.trim());
    if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false, ruleViolations: ["answer.txt must be a number in [0,1]"] };
    return { ok: true, score: value, facts: [{ name: "answer", value, source: "answer.txt" }] };
  },
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-t9-project-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# t9 research project");
  return dir;
}

function completeDraft(id: string): MissionDraft {
  return {
    schemaVersion: 1,
    id,
    status: "draft",
    objective: "T9 objective: compare Memory Off, Schema-only Sham and Real Memory",
    successCriteria: ["a real artifact measured by the independent evaluator"],
    data: { description: "local synthetic data shipped with the project" },
    evaluation: { method: "file-answer-deterministic", metric: "answer in [0,1]" },
    constraints: {
      permissions: ["isolated-workspace-write", "read-project"],
      hardRules: ["no external submission"],
    },
    budget: { total: 1, units: "model-USD", note: "bounded comparison slice" },
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
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as MissionDraft;
}

function brokerSession(writes: { prompts: string[]; answer: string }) {
  return async (options: { cwd?: string }): Promise<AgentRuntimeSession> => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    return {
      sessionId: `t9-session-${Math.random().toString(36).slice(2)}`,
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

function priceTokens(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }) {
  return tokens.input * MODEL_COST.input + tokens.output * MODEL_COST.output;
}

async function harness(project: string) {
  const faux = fauxProvider({ provider: CONTROL_PROVIDER, models: [{ id: "deterministic", cost: MODEL_COST }], tokensPerSecond: 150 });
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${CONTROL_PROVIDER}/deterministic`;
  const resolver = await createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel: (requested: string) => (requested === ref ? { provider: CONTROL_PROVIDER, model: "deterministic", id: ref } : undefined),
      defaultModel: () => ({ provider: CONTROL_PROVIDER, model: "deterministic", id: ref }),
    },
  });
  const resources = await discoverEvokResources({ projectRoot: project });
  return { resolver, resources };
}

const toyContract = () => createCompetitionContract({
  version: "2026.1",
  competitionId: "toy-t9",
  objective: "Predict the target within the split discipline.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction", maxPerDay: 5 },
  limits: { timeLimitMs: 3_600_000, network: "none" },
});

const toyPolicy = (contract: ReturnType<typeof toyContract>) => createRuleVisibilityPolicy({
  competitionId: contract.competitionId,
  contractDigest: contract.digest,
  allow: { researcher: ["scoring.metric", "scoring.direction", "dataSplit.folds"] },
});

/** Drops wall-clock stamps so otherwise-identical inputs compare equal. */
function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "at" && key !== "dispatchedAt" && key !== "finishedAt")
      .map(([key, entry]) => [key, withoutTimestamps(entry)]));
  }
  return value;
}

function proposal(stateVersion: number, objective: string): DirectorProposal {
  return {
    stateVersion,
    action: "investigate",
    rationale: `bounded next step: ${objective}`,
    task: { objective, expectedOutputs: ["answer.txt"] },
    expectedCost: 0.001,
  };
}

/**
 * A deterministic Director: it diverges ONLY when the revision stage was given
 * real research content. A Sham packet (structure without research content) and
 * an Off arm therefore keep the frozen Blind Proposal.
 */
function armDirector() {
  const calls: { readonly stage: "blind" | "revision"; readonly input: DirectorInput }[] = [];
  const director: MissionDirector = {
    id: "m-t9-scripted-director",
    async decide(input, _signal, attempt = 1) {
      calls.push({ stage: input.decisionPhase === undefined ? "blind" : "revision", input: structuredClone(input) });
      const packet = input.decisionPhase?.memoryPacket;
      const researchContent = packet !== undefined
        && packet.control !== "sham"
        && packet.cards.some((card) => card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA);
      const chosen = researchContent
        ? proposal(input.stateVersion, "probe the memory-informed competing kernel")
        : proposal(input.stateVersion, "materialize answer.txt again in a fresh isolated workspace");
      return {
        proposal: chosen,
        sessionId: `${input.decisionPhase === undefined ? "blind" : "revision"}-${attempt}`,
        usage: DECISION_USAGE,
        model: DIRECTOR_MODEL,
        ...(researchContent ? { usedMemoryRefs: [packet!.cards[0]!.cardId] } : {}),
      };
    },
  };
  return { director, calls };
}

interface Arm {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly project: string;
  readonly record: MissionRecord;
  readonly calls: { readonly stage: "blind" | "revision"; readonly input: DirectorInput }[];
  readonly prompts: string[];
  readonly draft: MissionDraft;
}

const MISSION_ID = "m-t9-arms";

async function runArm(mode: ResearchMemoryEvaluationMode): Promise<Arm> {
  const project = await tempProject();
  const draft = await saveMissionDraft(project, completeDraft(MISSION_ID));
  const { resolver, resources } = await harness(project);
  const contract = toyContract();
  const writes = { prompts: [] as string[], answer: "0.75" };
  const { director, calls } = armDirector();
  const outcome = await startAuthorizedMission({
    projectRoot: project,
    missionId: draft.id,
    authorization: { requested: true, token: "/start", missionSelector: "displayed" },
    resolver,
    resources,
    evaluator: fileEvaluator,
    budgetUnits: "model-USD",
    priceModelCost: () => priceTokens,
    director,
    maxExperiments: 1,
    researchMemory: mode,
    competitionContext: { contract, policy: toyPolicy(contract) },
    runtimeFactory: (workspaceRoot) => new PiAgentRuntime({
      workspaceRoot,
      modelResolver: resolver,
      resources,
      sandbox: { allowBash: false },
      sessionFactory: brokerSession(writes),
    }),
  });
  expect(outcome.status).toBe("iteration-limit");
  const record = await loadMissionRecord(project, draft.id);
  return { mode, project, record, calls, prompts: writes.prompts, draft };
}

describe("Memory Off / Sham / Real at the authorized lifecycle seam (M1-T9)", () => {
  test("the three arms are selectable through trusted configuration with matched budgets, decision calls and initial state", async () => {
    const off = await runArm("off");
    const sham = await runArm("sham");
    const real = await runArm("real");

    for (const arm of [off, sham, real]) {
      // The trusted arm is durable, so recovery cannot silently switch arms.
      expect(arm.record.researchMemoryMode).toBe(arm.mode);
      expect(researchMemoryModeOf(arm.record.researchMemoryMode)).toBe(arm.mode);
      // Two priced decision calls (blind + revision), matched across arms.
      expect(arm.record.decisions).toHaveLength(2);
      expect(arm.record.decisions!.map((decision) => decision.phase)).toEqual(["blind", "revision"]);
      expect(arm.record.budget.total).toBe(off.record.budget.total);
      expect(arm.record.budget.units).toBe(off.record.budget.units);
      expect(arm.record.stopConditions).toEqual(off.record.stopConditions);
      expect(initialStateDigestOf(arm.record)).toBe(initialStateDigestOf(off.record));
    }

    // The blind stage is identical across arms: only the revision packet differs.
    // Wall-clock stamps are the only fields an arm cannot share.
    const blindInputs = [off, sham, real].map((arm) => withoutTimestamps(arm.calls.find((call) => call.stage === "blind")!.input));
    expect(blindInputs[1]).toEqual(blindInputs[0]!);
    expect(blindInputs[2]).toEqual(blindInputs[0]!);
  });

  test("Memory Off delivers no Memory and attributes no change to it", async () => {
    const off = await runArm("off");
    const revision = off.calls.find((call) => call.stage === "revision")!;
    expect(revision.input.decisionPhase?.memoryPacket).toBeUndefined();
    const revisionRecord = off.record.decisions!.find((decision) => decision.phase === "revision")!;
    expect(revisionRecord.memory).toBeUndefined();
    expect(revisionRecord.delta).toBeUndefined();
    expect(off.record.researchMemory).toBeUndefined();
    expect(off.prompts.every((prompt) => !prompt.includes("MEMORY SLICE"))).toBe(true);
  });

  test("Schema-only Sham keeps card structure and bounds but carries no research content", async () => {
    const sham = await runArm("sham");
    const revision = sham.calls.find((call) => call.stage === "revision")!;
    const packet = revision.input.decisionPhase!.memoryPacket!;
    expect(packet.control).toBe("sham");
    expect(packet.cards.length).toBeGreaterThan(0);
    expect(packet.cards.every((card) => card.schema === RESEARCH_CONTROL_CARD_SCHEMA)).toBe(true);
    // Same bounded presentation, no research facts, refs or advice.
    const body = JSON.stringify(packet);
    for (const leak of ["0.75", "evidence:", "score=", "kernel", "answer.txt", `${MISSION_ID}:`]) {
      expect(body).not.toContain(leak);
    }
    for (const card of packet.cards) {
      if (card.schema !== RESEARCH_CONTROL_CARD_SCHEMA) throw new Error("expected a control card");
      expect(card.applicability).toEqual([]);
      expect(card.sourceRefs).toEqual([]);
      expect(card.control).toBe("sham");
    }
    // The revision therefore cannot diverge on research content (structure only).
    const revisionRecord = sham.record.decisions!.find((decision) => decision.phase === "revision")!;
    expect(revisionRecord.delta).toBe("unchanged");
    expect(revisionRecord.memory!.cardRefs).toEqual(packet.cards.map((card) => card.cardId));

    // A later Researcher gets the Sham slice from the published control snapshot.
    // The trusted measured-evidence summary is NOT Memory; only the slice must be
    // free of research facts, refs and advice.
    const researcherPrompt = sham.prompts[1]!;
    expect(researcherPrompt).toContain("MEMORY SLICE");
    const sliceStart = researcherPrompt.indexOf("=== MEMORY SLICE BEGIN");
    const slice = JSON.parse(researcherPrompt.slice(researcherPrompt.indexOf("\n", sliceStart) + 1, researcherPrompt.indexOf("\n=== MEMORY SLICE END ===")));
    const memory = JSON.stringify(slice.research);
    expect(memory).toContain(RESEARCH_CONTROL_CARD_SCHEMA);
    for (const leak of ["0.75", "evidence:", "score=", "kernel", "answer.txt", `${MISSION_ID}:`]) {
      expect(memory).not.toContain(leak);
    }
  });

  test("Real Memory reaches the revision stage and can change the decision", async () => {
    const real = await runArm("real");
    const revision = real.calls.find((call) => call.stage === "revision")!;
    const packet = revision.input.decisionPhase!.memoryPacket!;
    expect(packet.control).toBeUndefined();
    expect(packet.cards.some((card) => card.schema === RESEARCH_MEMORY_FINDING_CARD_SCHEMA)).toBe(true);
    const revisionRecord = real.record.decisions!.find((decision) => decision.phase === "revision")!;
    expect(revisionRecord.delta).toBe("replaced");
    expect(revisionRecord.memory?.cardRefs.length).toBe(packet.cards.length);
    // Exactly one Experiment was dispatched (the revised proposal), not two.
    expect(real.record.experiments).toHaveLength(1);
  });

  test("the three-arm report separates the readings without claiming a causal control", async () => {
    const off = await runArm("off");
    const sham = await runArm("sham");
    const real = await runArm("real");
    const report = evaluateResearchMemory({
      plan: {
        modelVersion: "default",
        basePromptRevision: "director-prompt/v1",
        tools: ["read", "grep", "find", "ls"],
        decisionCalls: 2,
        budgets: { token: off.record.budget.total, experiment: 1, retry: 2, evaluation: 1 },
        stoppingConditions: off.record.stopConditions!,
        initialStateDigest: initialStateDigestOf(off.record),
      },
      arms: [off, sham, real].map((arm) => ({
        mode: arm.mode,
        record: arm.record,
        controls: {
          modelVersion: "default",
          basePromptRevision: "director-prompt/v1",
          tools: ["read", "grep", "find", "ls"],
          experimentBudget: 1,
          retryBudget: 2,
          evaluationBudget: 1,
        },
      })),
    });

    expect(report.controls.filter((control) => !control.matched)).toEqual([]);
    expect(report.controls.every((control) => control.matched)).toBe(true);
    expect(report.comparisons.map((comparison) => comparison.reading)).toEqual(["overall-benefit", "content-contribution", "context-effect"]);
    expect(report.comparisons.every((comparison) => comparison.perfectCausalControl === false)).toBe(true);
    expect(report.comparisons.every((comparison) => comparison.caveat === RESEARCH_MEMORY_CONTROL_CAVEAT)).toBe(true);
    // Real diverged, Sham (structure only) and Off did not.
    const byReading = new Map(report.comparisons.map((comparison) => [comparison.reading, comparison]));
    expect(byReading.get("overall-benefit")!.delta.decisionDivergence).toBe(1);
    expect(byReading.get("content-contribution")!.delta.decisionDivergence).toBe(1);
    expect(byReading.get("context-effect")!.delta.decisionDivergence).toBe(0);
    // Both Director-stage costs are priced in every arm.
    for (const arm of report.arms) {
      expect(arm.stageCosts.blind).toBeGreaterThan(0);
      expect(arm.stageCalls).toEqual({ blind: 1, revision: 1 });
      expect(arm.validEvidence).toBe(1);
    }
  });

  test("offline replay pins every Run to information that existed before it began", async () => {
    const real = await runArm("real");
    const replay = replayResearchMemory({ record: real.record, mode: "real" });
    expect(replay.map((entry) => entry.runId)).toEqual([`${MISSION_ID}:baseline:1`, `${MISSION_ID}:exp:2`]);
    // The baseline Run began before any measured result existed.
    expect(replay[0]!.visibleRunIds).toEqual([]);
    expect(replay[1]!.visibleRunIds).toEqual([`${MISSION_ID}:baseline:1`]);
    // Same record, same replay.
    expect(replayResearchMemory({ record: real.record, mode: "real" })).toEqual(replay);
  });

  test("Mission status exposes only the read-only Memory summary", async () => {
    const sham = await runArm("sham");
    const summary = summarizeMission(sham.record);
    expect(summary.researchMemory?.controlCards).toBeGreaterThan(0);
    expect(summary.researchMemory?.cards.finding).toBe(0);
    const exposed = JSON.stringify(summary.researchMemory);
    // Counts and ids only: no card bodies, no restricted refs, no Evidence.
    for (const leak of ["control input", "sourceRefs", "evidence:", "summary", MISSION_ID]) {
      expect(exposed).not.toContain(leak);
    }
  });
});
