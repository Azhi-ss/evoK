/**
 * Black-box Mission intake through the Pi SDK execution boundary (#111, T3).
 *
 * Faux model responses drive the real PiAgentRuntime: skill discovery/loading,
 * read-only project inspection, the trusted draft-record tool, and an
 * operator-configured retrieval capability. These tests assert semantic
 * outputs and tool effects (saved draft fields, sources, settled decisions,
 * usage) with controlled model responses — never an exact interview
 * transcript. No Experiment can dispatch from this path: coding/execution
 * tools and any start action are absent.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEvokModelResolver, type SessionModelResolver } from "../../src/evok-model";
import { discoverEvokResources, bundledSkillRoot } from "../../src/evok-resources";
import { runIntakeTurn, type RetrievalCapability } from "../../src/mission-intake";
import { loadMissionDraft, MissionDraftCorruptionError } from "../../src/mission-draft";

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "evok-in-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-in-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "evok-in-ws-"));
  await mkdir(join(home, ".evok", "skills"), { recursive: true });
  await mkdir(join(project, ".evok", "skills"), { recursive: true });
  // Authorized project fact the model can inspect instead of asking the user.
  await mkdir(join(project, "data"), { recursive: true });
  await writeFile(join(project, "data", "README.md"), "# data\ntrain.csv is the competition training table with a group column.\n", "utf8");
  return { home, project, workspaceRoot };
}

let providerCounter = 0;
async function setupFaux(label: string) {
  const providerId = `evok-intake-${label}-${++providerCounter}`;
  const faux = fauxProvider({ provider: providerId, models: [{ id: "deterministic" }] });
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${providerId}/deterministic`;
  const resolver: SessionModelResolver = await createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel(r: string) {
        if (r !== ref) return undefined;
        return { provider: providerId, model: "deterministic", id: ref };
      },
      defaultModel() {
        return { provider: providerId, model: "deterministic", id: ref };
      },
    },
  });
  return { faux, resolver };
}

function completeDraftToolCall(missionId?: string, overrides: Record<string, unknown> = {}) {
  return fauxToolCall("evok_record_draft", {
    ...(missionId ? { id: missionId } : {}),
    objective: "Beat the toy ranking baseline on NDCG@10 without leaking test labels.",
    successCriteria: ["NDCG@10 at least +0.02 over the reproduced baseline", "no split-contract violation"],
    data: { description: "competition training table at data/train.csv with a group column", sources: ["data/train.csv"] },
    evaluation: { method: "5-fold grouped cross-validation following the task split contract", metric: "NDCG@10" },
    constraints: { permissions: ["read project data"], hardRules: ["no external submission", "no label leakage"] },
    budget: { total: 20, units: "model-USD", note: "intake discussion draws the same envelope" },
    outputs: ["one evaluated candidate", "a short final report"],
    stopConditions: ["budget exhausted", "objective met", "rule risk"],
    unresolvedPrerequisites: [],
    decisions: [
      { id: "d1", question: "Which metric decides success?", answer: "NDCG@10", recommendation: "NDCG@10", settled: true },
    ],
    sources: [],
    plan: {
      baselineHypothesis: "The shipped gradient-boosted baseline is the comparison to beat; a grouped-feature hypothesis is the first test.",
      tasks: [
        { taskId: "t1", objective: "Reproduce the baseline end to end", expectedOutputs: ["logged baseline NDCG@10"], evidenceRequirements: ["logged score"] },
        { taskId: "t2", objective: "Test the grouped-feature hypothesis", dependencies: ["t1"], expectedOutputs: ["OOF comparison"], evidenceRequirements: ["OOF NDCG comparison"] },
      ],
    },
    ...overrides,
  });
}

describe("mission intake (#111) — complete request, skill loading, no dispatch", () => {
  test("a complete request loads the intake skill in place, inspects project facts, saves a reviewable draft + initial plan, and never dispatches", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("complete");

    let capturedSystem = "";
    const skillPath = join(bundledSkillRoot(), "mission-intake", "SKILL.md");
    faux.setResponses([
      (ctx: unknown) => {
        const system = ctx as { systemPrompt?: string; messages?: unknown[] };
        capturedSystem = [system.systemPrompt ?? "", JSON.stringify(system.messages ?? [])].join("\n");
        return fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("read", { path: join(project, "data", "README.md") }), { stopReason: "toolUse" }),
      fauxAssistantMessage(completeDraftToolCall(), { stopReason: "toolUse" }),
      fauxAssistantMessage("Mission draft ready for review: objective, NDCG@10 evaluation, two-task baseline plan. It is saved and remains unstarted; say so explicitly, nothing was executed."),
    ]);

    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "I want to beat the toy ranking baseline on NDCG@10; budget 20 model-USD, no external submission.",
      tools: {},
    });

    // Auto-selectable English metadata is in the system prompt; body loaded on demand.
    expect(capturedSystem).toContain("mission-intake");
    expect(capturedSystem.toLowerCase()).toContain("draft a bounded evok mission");
    expect(result.text).toContain("unstarted");

    const drafts = resources.skills; // sanity: discovery metadata only
    expect(drafts.some((s) => s.skill.name === "mission-intake")).toBe(true);

    expect(result.draft).toBeDefined();
    const draft = result.draft!;
    expect(draft.status).toBe("draft");
    expect(draft.objective).toContain("NDCG");
    expect(draft.successCriteria.length).toBeGreaterThan(0);
    expect(draft.evaluation.metric).toBe("NDCG@10");
    expect(draft.budget.units).toBe("model-USD");
    expect(draft.unresolvedPrerequisites).toEqual([]);
    expect(draft.plan.tasks[0]?.objective.toLowerCase()).toContain("baseline");
    expect(draft.plan.tasks[1]?.dependencies).toEqual(["t1"]);

    // It is really on disk under the project-local per-Mission convention.
    const reopened = await loadMissionDraft(project, draft.id);
    expect(reopened.objective).toBe(draft.objective);
    expect(reopened.status).toBe("draft");

    // Discussion cost is ordinary model usage and is recorded on the draft.
    expect(result.usage.tokens.total).toBeGreaterThan(0);
    expect(reopened.usage.tokens.total).toBeGreaterThan(0);
    expect(reopened.usage.cost.units).toBe("model-USD");

    // No execution tool exists on this path; only read-only inspection and the
    // two trusted intake operations appear in the run ledger.
    const toolNames = new Set(result.ledger.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName));
    expect(toolNames.has("bash")).toBe(false);
    expect(toolNames.has("edit")).toBe(false);
    expect(toolNames.has("write")).toBe(false);
    expect(toolNames.has("evok_record_draft")).toBe(true);
    for (const name of toolNames) {
      expect(["read", "grep", "find", "ls", "evok_record_draft"]).toContain(name);
    }

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("mission intake (#111) — incomplete requests and one-question convergence", () => {
  test("an incomplete request saves an unstarted draft with unresolved prerequisites; it is not ready for review", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("incomplete");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evok_record_draft", {
        objective: "Maybe improve ranking somehow.",
        successCriteria: [],
        data: { description: "" },
        evaluation: { method: "" },
        constraints: { permissions: [] },
        budget: { total: 0, units: "model-USD" },
        outputs: [],
        stopConditions: [],
        unresolvedPrerequisites: ["success metric", "available data", "budget amount"],
        decisions: [{ id: "d1", question: "Which metric decides success?", answer: "", recommendation: "NDCG@10", settled: false }],
        plan: { baselineHypothesis: "", tasks: [] },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("One decision first: which metric should decide success? I recommend NDCG@10."),
    ]);

    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "can you make ranking better?",
      tools: {},
    });

    expect(result.draft?.status).toBe("draft");
    expect(result.draft?.unresolvedPrerequisites.length).toBeGreaterThan(0);
    expect(result.readyForReview).toBe(false);
    expect(result.text).toMatch(/metric|NDCG/i);
    // The open question is a single recommendation, not a dispatched Experiment.
    expect(result.ledger.some((e) => e.toolName === "bash" || e.toolName === "write")).toBe(false);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("mission intake (#111) — configured retrieval capability", () => {
  test("a configured retrieval tool is actually called, sources reach the draft, and private content is not queried", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("retrieve");

    const queries: string[] = [];
    const retrieval: RetrievalCapability = {
      async search(query: string) {
        queries.push(query);
        return [{
          url: "https://example.test/ndcg-2026",
          title: "NDCG tuning notes",
          snippet: "Grouped NDCG@10 is the current standard treatment.",
        }];
      },
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evok_retrieve", { query: "NDCG@10 grouped validation current practice" }), { stopReason: "toolUse" }),
      (ctx: unknown) => {
        const messages = (ctx as { messages?: unknown[] }).messages ?? [];
        expect(JSON.stringify(messages)).toContain("https://example.test/ndcg-2026");
        return fauxAssistantMessage(completeDraftToolCall(undefined, {
          sources: [{
            url: "https://example.test/ndcg-2026",
            title: "NDCG tuning notes",
            claim: "Grouped NDCG@10 is the current standard treatment.",
          }],
        }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("draft saved with the cited external source and an explicit metric"),
    ]);

    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 20 model-USD.",
      tools: { retrieval },
    });

    expect(queries).toEqual(["NDCG@10 grouped validation current practice"]);
    // The query contains only a public factual question, no file contents or paths.
    expect(queries[0]).not.toContain("train.csv");
    expect(result.draft?.sources[0]?.url).toBe("https://example.test/ndcg-2026");
    expect(result.draft?.sources[0]?.claim.length).toBeGreaterThan(0);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("with no retrieval capability the tool is absent; a factual gap is reported as an unknown prerequisite, not invented", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("no-retrieve");

    // The capability is not configured, so evok_retrieve is not in the tool
    // list at all. A well-directed model notes the external gap and records it
    // honestly rather than claiming a search happened.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evok_record_draft", {
        objective: "Beat the toy ranking baseline.",
        successCriteria: ["improve over baseline"],
        data: { description: "data/train.csv" },
        evaluation: { method: "", metric: "NDCG@10" },
        constraints: { permissions: ["read project data"] },
        budget: { total: 5, units: "model-USD" },
        outputs: ["evaluated candidate"],
        stopConditions: ["budget exhausted"],
        unresolvedPrerequisites: ["external validation practice unverified: no retrieval capability configured"],
        decisions: [],
        sources: [],
        plan: { baselineHypothesis: "reproduce baseline first", tasks: [{ taskId: "t1", objective: "Reproduce baseline", expectedOutputs: ["score"] }] },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I could not verify external practice (no retrieval configured); it stays an explicit unknown."),
    ]);

    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 5 model-USD.",
      tools: {},
    });

    const toolNames = new Set(result.ledger.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName));
    expect(toolNames.has("evok_retrieve")).toBe(false);
    expect([...toolNames]).not.toContain("evok_retrieve");
    expect(result.draft?.unresolvedPrerequisites.join(" ")).toMatch(/retrieval|unknown|unverified/i);
    expect(result.text).toMatch(/unknown|no retrieval|could not/i);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("a configured retrieval capability that FAILS is reported as an unknown, not invented, and does not abort the draft", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("retrieve-fails");

    const retrieval: RetrievalCapability = {
      async search() {
        throw new Error("upstream 503");
      },
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evok_retrieve", { query: "NDCG@10 grouped validation practice" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("evok_record_draft", {
        objective: "Beat the toy ranking baseline.",
        successCriteria: ["improve over baseline"],
        data: { description: "data/train.csv" },
        evaluation: { method: "", metric: "NDCG@10" },
        constraints: { permissions: ["read project data"] },
        budget: { total: 5, units: "model-USD" },
        outputs: ["evaluated candidate"],
        stopConditions: ["budget exhausted"],
        unresolvedPrerequisites: ["external validation practice unverified: retrieval failed (upstream 503)"],
        decisions: [],
        sources: [],
        plan: { baselineHypothesis: "reproduce baseline first", tasks: [{ taskId: "t1", objective: "Reproduce baseline", expectedOutputs: ["score"] }] },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Retrieval failed, so the external practice stays an explicit unknown."),
    ]);

    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 5 model-USD.",
      tools: { retrieval },
    });

    expect(result.draft).toBeDefined();
    expect(result.draft?.sources).toEqual([]);
    expect(result.draft?.unresolvedPrerequisites.join(" ")).toMatch(/retrieval failed|503|unverified/i);
    expect(JSON.stringify(result.ledger)).toContain("Retrieval failed");

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("a private-content retrieval query is refused (fail closed): the Run aborts and the backend is never called", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("retrieve-private");

    let queried = false;
    const retrieval: RetrievalCapability = {
      async search() {
        queried = true;
        return [{ url: "https://example.test/x", snippet: "should never be returned" }];
      },
    };

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evok_retrieve", { query: "look up /home/dministrator/project/evoK/data/train.csv contents" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("unreachable after the fail-closed refusal"),
    ]);

    await expect(runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 5 model-USD.",
      tools: { retrieval },
    })).rejects.toThrow(/tool execution failed|private content/);

    // The guard runs inside the tool, before the configured backend.
    expect(queried).toBe(false);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

describe("mission intake (#111) — reopen, corruption, and ambiguous replies", () => {
  test("reopening feeds the saved draft into a fresh Run and preserves settled decisions", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const first = await setupFaux("reopen1");
    first.faux.setResponses([
      fauxAssistantMessage(completeDraftToolCall(), { stopReason: "toolUse" }),
      fauxAssistantMessage("draft saved"),
    ]);
    const turn1 = await runIntakeTurn({
      resolver: first.resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 20 model-USD.",
      tools: {},
    });
    expect(turn1.draft?.decisions[0]?.answer).toBe("NDCG@10");

    // Fresh context/Run: no transcript, only the persisted draft is handed over.
    const second = await setupFaux("reopen2");
    second.faux.setResponses([
      (ctx: unknown) => {
        const blob = JSON.stringify(ctx);
        // The current draft and its settled decision are handed to the fresh
        // Run in the task prompt; no transcript is involved.
        expect(blob).toContain("NDCG@10");
        expect(blob).toContain(turn1.draft!.id);
        return fauxAssistantMessage("the settled metric NDCG@10 is retained; no new questions needed");
      },
    ]);
    const turn2 = await runIntakeTurn({
      resolver: second.resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      missionId: turn1.draft!.id,
      message: "Remind me where we left off.",
      tools: {},
    });

    const reopened = await loadMissionDraft(project, turn1.draft!.id);
    expect(reopened.decisions.some((d) => d.answer === "NDCG@10")).toBe(true);
    expect(turn2.text).toContain("NDCG@10");

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("discussion usage is SUMMED across reopened turns, never clamped to one Run", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const first = await setupFaux("usage1");
    first.faux.setResponses([
      fauxAssistantMessage(completeDraftToolCall(), { stopReason: "toolUse" }),
      fauxAssistantMessage("draft saved"),
    ]);
    const turn1 = await runIntakeTurn({
      resolver: first.resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "Beat the toy ranking baseline; budget 20 model-USD.",
      tools: {},
    });
    const firstUsage = turn1.draft!.usage.tokens.total;
    expect(firstUsage).toBeGreaterThan(0);

    const second = await setupFaux("usage2");
    second.faux.setResponses([
      fauxAssistantMessage("still settled, no changes needed"),
    ]);
    const turn2 = await runIntakeTurn({
      resolver: second.resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      missionId: turn1.draft!.id,
      message: "Anything else?",
      tools: {},
    });
    // The second Run spent tokens too (its own fresh session); reopen did not
    // record a new draft save, so the persisted value stays the first Run's.
    expect(turn2.usage.tokens.total).toBeGreaterThan(0);
    const reopened = await loadMissionDraft(project, turn1.draft!.id);
    expect(reopened.usage.tokens.total).toBe(firstUsage);

    // A third turn that updates the draft adds its Run usage onto the stored total.
    const third = await setupFaux("usage3");
    third.faux.setResponses([
      fauxAssistantMessage(completeDraftToolCall(), { stopReason: "toolUse" }),
      fauxAssistantMessage("draft refreshed"),
    ]);
    const turn3 = await runIntakeTurn({
      resolver: third.resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      missionId: turn1.draft!.id,
      message: "Refresh the plan with the same objective.",
      tools: {},
    });
    const finalDraft = await loadMissionDraft(project, turn1.draft!.id);
    expect(finalDraft.usage.tokens.total).toBe(firstUsage + turn3.usage.tokens.total);
    expect(finalDraft.usage.tokens.total).toBeGreaterThan(turn3.usage.tokens.total);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("a corrupted draft is detected on reopen rather than silently starting over", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { resolver } = await setupFaux("corrupt");
    await mkdir(join(project, ".evok", "missions", "m-deadbeef0000"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-deadbeef0000", "draft.json"), "{broken", "utf8");

    await expect(runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      missionId: "m-deadbeef0000",
      message: "continue",
      tools: {},
    })).rejects.toBeInstanceOf(MissionDraftCorruptionError);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("an ambiguous reply can never start or dispatch anything: the draft stays status=draft", async () => {
    const { home, project, workspaceRoot } = await layout();
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("ambiguous");
    faux.setResponses([
      fauxAssistantMessage(completeDraftToolCall(), { stopReason: "toolUse" }),
      fauxAssistantMessage("If you meant to start, I still need an explicit authorization after review; for now nothing runs."),
    ]);
    const result = await runIntakeTurn({
      resolver,
      workspaceRoot,
      resources,
      projectRoot: project,
      message: "yeah sure do the thing maybe start",
      tools: {},
    });
    const reopened = await loadMissionDraft(project, result.draft!.id);
    expect(reopened.status).toBe("draft");
    expect(result.dispatched).toBe(false);
    expect(result.ledger.some((e) => e.type === "tool_execution_start" && ["bash", "edit", "write"].includes(e.toolName ?? ""))).toBe(false);

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});
