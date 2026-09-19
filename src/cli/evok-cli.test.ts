import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runEvok, parseEvokArgs, EVOK_EXIT, EVOK_USAGE, type EvokRunOptions } from "./evok-cli";
import { createEvokModelResolver } from "../evok-model";
import { isExplicitResumeRequest, isExplicitStartRequest } from "../mission-start";
import { parseResearchCommand } from "../mission/research-entry";
import { parseSkillsCommand } from "../mission/skills-routing";

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-cli-project-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# research project");
  return dir;
}

/** Real SDK modelRuntime registered with a deterministic faux provider, shared by the resolver factory. */
async function fauxRuntime(provider: string, models: Array<{ id: string; text: string }>) {
  const handles = models.map((m) => fauxProvider({ provider: `${provider}-${m.id}`, models: [{ id: m.id }] }));
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  for (const [i, handle] of handles.entries()) {
    handle.setResponses([fauxAssistantMessage(models[i].text)]);
    modelRuntime.registerNativeProvider(handle.provider);
  }
  await modelRuntime.refresh({ allowNetwork: false });
  return { modelRuntime, handles };
}

function catalogFrom(runtime: ModelRuntime, refs: string[], defaultRef?: string) {
  return {
    findModel(ref: string) {
      if (!refs.includes(ref)) return undefined;
      const [provider, ...rest] = ref.split("/");
      return { provider, model: rest.join("/"), id: ref };
    },
    defaultModel() {
      const ref = defaultRef ?? refs[0];
      const [provider, ...rest] = ref.split("/");
      return { provider, model: rest.join("/"), id: ref };
    },
  };
}

describe("parseEvokArgs", () => {
  test("reads request positional, --tier, --project, --orchestra and --timeout-ms", () => {
    const parsed = parseEvokArgs(["hello world", "--tier", "deep", "--project", "/tmp/p", "--timeout-ms", "42"]);
    expect(parsed.request).toBe("hello world");
    expect(parsed.tier).toBe("deep");
    expect(parsed.project).toBe("/tmp/p");
    expect(parsed.timeoutMs).toBe(42);
    expect(parsed.error).toBeUndefined();
  });

  test("rejects an unknown tier and unknown flag", () => {
    expect(parseEvokArgs(["x", "--tier", "ultra"]).error).toContain("--tier");
    expect(parseEvokArgs(["x", "--bogus"]).error).toContain("--bogus");
  });

  test("--help is a usage request, not an error", () => {
    expect(parseEvokArgs(["--help"]).help).toBe(true);
  });
});

describe("runEvok foreground request/response (#109)", async () => {
  test("bounded request/response through the real Pi execution path reports model identity, usage and stop reason", async () => {
    const project = await tempProject();
    const { modelRuntime, handles } = await fauxRuntime("evok-cli", [{ id: "deterministic", text: "faux response body" }]);
    const ref = "evok-cli-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const stderr = new CollectStream();
    const options: EvokRunOptions = {
      args: { request: "summarize the project", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr,
    };
    const code = await runEvok(options);
    expect(code).toBe(0);
    expect(stdout.text()).toContain("faux response body");
    expect(stdout.text()).toContain(ref);
    expect(stdout.text()).toMatch(/tokens/i);
    expect(stdout.text()).toContain("stop");
    expect(handles[0].state.callCount).toBe(1);
    await rm(project, { recursive: true, force: true });
  });

  test("a --tier call routes to that tier's resolved model, not the default", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli2", [
      { id: "fast-1", text: "FAST ANSWER" },
      { id: "deep-1", text: "DEEP ANSWER" },
    ]);
    const fastRef = "evok-cli2-fast-1/fast-1";
    const deepRef = "evok-cli2-deep-1/deep-1";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [fastRef, deepRef], fastRef),
      orchestra: { fast: fastRef, deep: deepRef },
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "think hard", project, tier: "deep", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("DEEP ANSWER");
    expect(stdout.text()).toContain(deepRef);
    expect(stdout.text()).not.toContain("FAST ANSWER");
    await rm(project, { recursive: true, force: true });
  });

  test("missing model configuration fails clearly before dispatch with a non-zero exit", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli3", [{ id: "only-fast", text: "X" }]);
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, ["evok-cli3-only-fast/only-fast"], "evok-cli3-only-fast/only-fast"),
      orchestra: { fast: "evok-cli3-only-fast/only-fast" },
    });
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "deep", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.configError);
    expect(stderr.text()).toContain("deep");
    await rm(project, { recursive: true, force: true });
  });

  test("missing authentication is reported explicitly without silent fallback", async () => {
    const project = await tempProject();
    const locked = {
      async resolve() {
        return {
          tier: "default" as const,
          reason: "unconfigured" as const,
          model: { provider: "locked-provider", model: "m-1", id: "locked-provider/m-1" },
          modelId: {} as never,
          modelRuntime: {} as never,
        };
      },
      async preflight() {
        return { ok: false as const, error: 'missing or invalid authentication for provider "locked-provider"' };
      },
    };
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => locked,
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.authError);
    expect(stderr.text()).toContain("authentication");
    expect(stderr.text()).toContain("locked-provider");
    await rm(project, { recursive: true, force: true });
  });

  test("cancellation (abort) stops the bounded run and reports interruption", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli4", [{ id: "deterministic", text: "late" }]);
    const ref = "evok-cli4-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const controller = new AbortController();
    controller.abort();
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout: new CollectStream(),
      stderr,
      signal: controller.signal,
    });
    expect(code).toBe(EVOK_EXIT.cancelled);
    expect(stderr.text()).toMatch(/abort|cancel/i);
    await rm(project, { recursive: true, force: true });
  });

  test("the session can read files from the selected research project but not write there", async () => {
    const project = await tempProject();
    await writeFile(join(project, "FINDING.txt"), "project observable content 42");
    const faux = fauxProvider({ provider: "evok-cli-project", models: [{ id: "deterministic" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(project, "FINDING.txt") }), { stopReason: "toolUse" }),
      fauxAssistantMessage("found project observable content 42"),
    ]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-project/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "read FINDING.txt", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("project observable content 42");
    expect(faux.state.callCount).toBe(2);
    // project directory must remain untouched by the isolated Run
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(project, "FINDING.txt"))).resolves.toBeDefined();
    await rm(project, { recursive: true, force: true });
  });

  test("two identical one-shot Runs are both executed: fresh session identity, no result replay", async () => {
    const project = await tempProject();
    const faux = fauxProvider({ provider: "evok-cli-fresh", models: [{ id: "deterministic" }] });
    faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-fresh/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const args = { request: "same prompt", project, tier: "default" as const, timeoutMs: 600000 };
    const first = new CollectStream();
    const code1 = await runEvok({ args, createResolver: async () => resolver, stdout: first, stderr: new CollectStream() });
    const second = new CollectStream();
    const code2 = await runEvok({ args, createResolver: async () => resolver, stdout: second, stderr: new CollectStream() });
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(first.text()).toContain("answer one");
    expect(second.text()).toContain("answer two");
    expect(faux.state.callCount).toBe(2);
    const session1 = first.text().match(/session ([0-9a-f-]+)/)?.[1];
    const session2 = second.text().match(/session ([0-9a-f-]+)/)?.[1];
    expect(session1).toBeTruthy();
    expect(session1).not.toBe(session2);
    await rm(project, { recursive: true, force: true });
  });

  test("an in-flight abort while the model is running reports cancellation", async () => {
    const project = await tempProject();
    const faux = fauxProvider({
      provider: "evok-cli-abort",
      models: [{ id: "deterministic" }],
      // Fast but long token stream: the Run is still in flight when abort fires
      // (the SDK checks its abort signal between chunks).
      tokensPerSecond: 100,
    });
    faux.setResponses([fauxAssistantMessage("word ".repeat(500))]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-abort/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const controller = new AbortController();
    const stderr = new CollectStream();
    const run = runEvok({
      args: { request: "long request", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout: new CollectStream(),
      stderr,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const code = await run;
    expect(code).toBe(EVOK_EXIT.cancelled);
    expect(stderr.text()).toMatch(/cancel/i);
    await rm(project, { recursive: true, force: true });
  });
});

describe("runEvok project validation (#109)", () => {
  test("a non-existent project directory is a usage error", async () => {
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", tier: "default", timeoutMs: 600000, project: join(tmpdir(), `evok-no-such-${Date.now()}-${Math.random()}`) },
      createResolver: async () => { throw new Error("should not build resolver before project validation"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.usage);
  });
});

describe("runEvok research resources (#110)", () => {
  async function evokProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "evok-cli-res-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, ".evok", "skills"), { recursive: true });
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    return dir;
  }

  async function skillFile(path: string, name: string, description: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }

  test("startup reports selected prompt sources and skill metadata only, not bodies", async () => {
    const project = await evokProject();
    await writeFile(join(project, ".evok", "SYSTEM.md"), "project system marker");
    await writeFile(join(project, ".evok", "APPEND_SYSTEM.md"), "project append marker");
    await skillFile(join(project, ".agents", "skills", "shared-skill", "SKILL.md"), "shared-skill", "a shared project skill");
    await writeFile(join(project, ".agents", "skills", "shared-skill", "BODY-ONLY-MARKER.txt"), "x");

    const faux = fauxProvider({ provider: "evok-cli-res1", models: [{ id: "deterministic" }] });
    faux.setResponses([fauxAssistantMessage("done")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-res1/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    const report = stdout.text();
    expect(report).toContain(join(project, ".evok", "SYSTEM.md"));
    expect(report).toContain(join(project, ".evok", "APPEND_SYSTEM.md"));
    expect(report).toContain("shared-skill");
    expect(report).toContain("a shared project skill");
    expect(report).toContain(join(project, ".agents", "skills", "shared-skill", "SKILL.md"));
    expect(report).not.toContain("BODY-ONLY-MARKER");
    expect(report).toMatch(/metadata only/);
    await rm(project, { recursive: true, force: true });
  });

  test("plain agents/ and .evok/skills are not a parallel root; .pi/skills is the Pi scan", async () => {
    const project = await evokProject();
    await mkdir(join(project, "agents", "skills", "plain"), { recursive: true });
    await writeFile(join(project, "agents", "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: plain agents\n---\n");
    await mkdir(join(project, ".evok", "skills", "ghost"), { recursive: true });
    await writeFile(join(project, ".evok", "skills", "ghost", "SKILL.md"), "---\nname: ghost\ndescription: PARALLEL-EVOK-ROOT-MARKER\n---\n");
    await mkdir(join(project, ".pi", "skills", "keep"), { recursive: true });
    await writeFile(join(project, ".pi", "skills", "keep", "SKILL.md"), "---\nname: keep\ndescription: kept skill\nowner: evok\ncategory: search\nstate: accepted\n---\n");
    await mkdir(join(project, ".pi", "skills", "pi"), { recursive: true });
    await writeFile(join(project, ".pi", "skills", "pi", "SKILL.md"), "---\nname: pi\ndescription: pi skill\n---\n");

    const faux = fauxProvider({ provider: "evok-cli-res2", models: [{ id: "deterministic" }] });
    faux.setResponses([fauxAssistantMessage("done")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-res2/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    const report = stdout.text();
    expect(report).toContain("keep");
    expect(report).toContain("pi skill");
    expect(report).not.toContain("plain agents");
    expect(report).not.toContain("PARALLEL-EVOK-ROOT-MARKER");
    await rm(project, { recursive: true, force: true });
  });

  test("a name collision is resolved project-first and surfaced as a visible diagnostic", async () => {
    const project = await evokProject();
    await skillFile(join(project, ".agents", "skills", "dup", "SKILL.md"), "dup", "shared dup");
    await skillFile(join(project, ".pi", "skills", "dup", "SKILL.md"), "dup", "project dup");
    const faux = fauxProvider({ provider: "evok-cli-res3", models: [{ id: "deterministic" }] });
    faux.setResponses([fauxAssistantMessage("done")]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-res3/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "hi", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    const report = stdout.text();
    expect(report).toMatch(/resource collision/);
    expect(report).toContain(join(project, ".pi", "skills", "dup", "SKILL.md"));
    expect(report).toContain("wins over");
    await rm(project, { recursive: true, force: true });
  });

  test("a real SDK tool call reads an in-place skill reference even though the Run workspace differs", async () => {
    const project = await evokProject();
    const skillDir = join(project, ".pi", "skills", "method");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "guide.md"), "CLI-RELATIVE-REF-9");
    await skillFile(join(skillDir, "SKILL.md"), "method", "method skill");
    const faux = fauxProvider({ provider: "evok-cli-res4", models: [{ id: "deterministic" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(skillDir, "SKILL.md") }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: join(skillDir, "references", "guide.md") }), { stopReason: "toolUse" }),
      fauxAssistantMessage("skill reference read complete"),
    ]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const ref = "evok-cli-res4/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "use the method skill", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    // Tool results go to the model, not stdout. The model saw both reads succeed
    // (2 call cycles) and the final assistant text proves the in-place reads
    // were allowed through the boundary; content is asserted in the runtime test.
    expect(stdout.text()).toContain("skill reference read complete");
    expect(faux.state.callCount).toBe(3);
    await rm(project, { recursive: true, force: true });
  });
});

describe("runEvok Mission intake (#111)", () => {
  test("parseEvokArgs reads --intake and --mission", () => {
    const parsed = parseEvokArgs(["beat baseline", "--intake", "--mission", "m-abc123"]);
    expect(parsed.intake).toBe(true);
    expect(parsed.mission).toBe("m-abc123");
    expect(parsed.request).toBe("beat baseline");
  });

  test("--intake routes to the skill-led intake runner, shows the saved draft and metered usage, and never reports dispatch", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-intake", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-intake-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const calls: Array<{ missionId?: string; hasRetrieval: boolean }> = [];
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "beat the baseline", project, tier: "default", timeoutMs: 600000, intake: true },
      createResolver: async () => resolver,
      intakeRunner: async (opts) => {
        calls.push({ missionId: opts.missionId, hasRetrieval: Boolean(opts.tools.retrieval) });
        return {
          text: "draft ready for review; unstarted",
          readyForReview: true,
          dispatched: false,
          sessionId: "s",
          ledger: [],
          usage: {
            tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
          },
          draft: {
            schemaVersion: 1,
            id: "m-deadbeef0000",
            status: "draft" as const,
            objective: "beat the baseline",
            successCriteria: ["+0.02"],
            data: { description: "train.csv" },
            evaluation: { method: "CV", metric: "NDCG@10" },
            constraints: { permissions: ["read"] },
            budget: { total: 20, units: "model-USD" },
            outputs: ["report"],
            stopConditions: ["budget"],
            unresolvedPrerequisites: [],
            decisions: [],
            sources: [],
            plan: { baselineHypothesis: "gbm baseline", tasks: [{ taskId: "t1", objective: "reproduce" }] },
            usage: { tokens: { input: 100, output: 20, total: 120 }, cost: { total: 0.001, units: "model-USD" } },
            createdAt: "2026-09-10T00:00:00.000Z",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        };
      },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].hasRetrieval).toBe(false);
    const out = stdout.text();
    expect(out).toContain("m-deadbeef0000");
    expect(out).toContain("status draft (unstarted; nothing dispatched)");
    expect(out).toMatch(/tokens 120/);
    expect(out).toMatch(/ordinary model usage, not free/);
    await rm(project, { recursive: true, force: true });
  });

  test("--intake --mission passes the reopened mission id", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-reopen", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-reopen-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const seen: Array<string | undefined> = [];
    const code = await runEvok({
      args: { request: "where were we", project, tier: "default", timeoutMs: 600000, intake: true, mission: "m-abc123" },
      createResolver: async () => resolver,
      intakeRunner: async (opts) => {
        seen.push(opts.missionId);
        return {
          text: "reopened", readyForReview: false, dispatched: false, sessionId: "s", ledger: [],
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      },
      stdout: new CollectStream(),
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["m-abc123"]);
    await rm(project, { recursive: true, force: true });
  });
});

describe("runEvok Mission start (#112)", () => {
  test("parseEvokArgs reads --start, --status, --reserve-cost and /start recognition", () => {
    const parsed = parseEvokArgs(["/start", "--start", "--status", "--mission", "m-1", "--reserve-cost", "0.02"]);
    expect(parsed.start).toBe(true);
    expect(parsed.status).toBe(true);
    expect(parsed.mission).toBe("m-1");
    expect(parsed.reserveCost).toBe(0.02);
    expect(parsed.request).toBe("/start");
  });

  test("parseEvokArgs reads #113 --baseline-only and --max-experiments", () => {
    const parsed = parseEvokArgs(["--start", "--baseline-only", "--max-experiments", "5", "--mission", "m-1"]);
    expect(parsed.baselineOnly).toBe(true);
    expect(parsed.maxExperiments).toBe(5);
    const bad = parseEvokArgs(["--start", "--max-experiments", "nope"]);
    expect(bad.error).toMatch(/max-experiments/);
    const neg = parseEvokArgs(["--start", "--max-experiments", "-1"]);
    expect(neg.error).toMatch(/max-experiments/);
  });

  test("an explicit natural-language start request routes to the validated start action", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-displayed"), { recursive: true });
    const { modelRuntime } = await fauxRuntime("evok-cli-start", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-start-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const seen: Array<{ missionId?: string; reserve?: number }> = [];
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "please start the mission baseline now", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      startRunner: async (opts) => {
        seen.push({ missionId: opts.missionId, reserve: opts.reserveCost });
        return {
          runId: `${opts.missionId}:baseline:1`,
          status: "baseline-complete",
          stopReason: "baseline-complete",
          model: { provider: "p", model: "m", id: ref },
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          budget: { total: 1, units: "model-USD", consumed: 0, remaining: 1 },
          evaluation: { ok: true, score: 0.5 },
          record: {} as never,
          experiments: [],
        };
      },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].reserve).toBeGreaterThan(0);
    const out = stdout.text();
    expect(out).toContain("baseline-complete");
    expect(out).toContain("score=0.5");
    await rm(project, { recursive: true, force: true });
  });

  test("without an evaluator contract the start is refused before dispatch", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-noeval", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-noeval-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-x" },
      createResolver: async () => resolver,
      startRunner: async () => { throw new Error("must not be called"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.configError);
    expect(stderr.text()).toMatch(/evaluator/);
    await rm(project, { recursive: true, force: true });
  });

  test("a rejected (invalid/ambiguous) start reports usage exit and does not claim dispatch", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-reject", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-reject-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const { MissionStartRejectedError } = await import("../mission-start");
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-x" },
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 1 }; } },
      startRunner: async () => { throw new MissionStartRejectedError("start intent is ambiguous"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.usage);
    expect(stderr.text()).toMatch(/start refused/);
    await rm(project, { recursive: true, force: true });
  });

  test("--status without --mission is a usage error", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-status", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-status-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: undefined, project, tier: "default", timeoutMs: 600000, status: true },
      createResolver: async () => resolver,
      stdin: { fd: 1 } as never,
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.usage);
    expect(stderr.text()).toMatch(/--mission/);
    await rm(project, { recursive: true, force: true });
  });

  test("the real start path loads the project evaluation contract; a missing contract refuses before dispatch", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-nocontract"), { recursive: true });
    const { modelRuntime } = await fauxRuntime("evok-cli-nc", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-nc-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-nocontract" },
      createResolver: async () => resolver,
      startRunner: async () => { throw new Error("must not run"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.configError);
    expect(stderr.text()).toMatch(/evaluation\.json|measured/i);
    await rm(project, { recursive: true, force: true });
  });

  test("a damaged mission record on --status fails visibly instead of being treated as a new Mission", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-bad"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-bad", "mission.json"), "{ not json");
    const { modelRuntime } = await fauxRuntime("evok-cli-bad", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-bad-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { project, tier: "default", timeoutMs: 600000, mission: "m-bad", status: true },
      createResolver: async () => resolver,
      stdin: { fd: 1 } as never,
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.runtimeError);
    expect(stderr.text()).toMatch(/damaged|corrupt/i);
    await rm(project, { recursive: true, force: true });
  });

  test("#113 --baseline-only omits the director; otherwise the injected director option is passed through", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-loop"), { recursive: true });
    const { modelRuntime } = await fauxRuntime("evok-cli-loop", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-loop-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const seen: Array<{ hasDirector: boolean; maxExperiments?: number }> = [];
    const director = { id: "test-director", async decide() { return {} as never; } };
    const runner = async (opts: never) => {
      const o = opts as { director?: unknown; maxExperiments?: number };
      seen.push({ hasDirector: Boolean(o.director), ...(typeof o.maxExperiments === "number" ? { maxExperiments: o.maxExperiments } : {}) });
      return {
        runId: "m-loop:baseline:1", status: "baseline-complete", stopReason: "baseline-complete",
        model: { provider: "p", model: "m", id: ref },
        usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        budget: { total: 1, units: "model-USD", consumed: 0, remaining: 1 },
        evaluation: { ok: true, score: 0.5 }, record: {} as never, experiments: [],
      };
    };
    const makeArgs = (extra: string[]) => ({
      request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-loop", ...(parseEvokArgs(["/start", "--mission", "m-loop", ...extra]) as object),
    }) as Parameters<typeof runEvok>[0]["args"];
    // With an explicit director option and max-experiments, the runner receives them.
    await runEvok({
      args: makeArgs(["--max-experiments", "2"]),
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      startRunner: runner as never, director, stdout: new CollectStream(), stderr: new CollectStream(),
    });
    // --baseline-only suppresses the real Pi director construction and the
    // injected director is also treated as baseline-only when the flag is set.
    await runEvok({
      args: makeArgs(["--baseline-only"]),
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      startRunner: runner as never, stdout: new CollectStream(), stderr: new CollectStream(),
    });
    expect(seen[0]).toEqual({ hasDirector: true, maxExperiments: 2 });
    expect(seen[1]).toEqual({ hasDirector: false });
    await rm(project, { recursive: true, force: true });
  });
});

describe("runEvok Mission resume and reopen (#114)", () => {
  test("parseEvokArgs reads --resume and --missions", () => {
    const parsed = parseEvokArgs(["/resume", "m-abc123def456", "--resume", "--missions", "--mission", "m-abc123def456"]);
    expect(parsed.resume).toBe(true);
    expect(parsed.missions).toBe(true);
  });

  test("an explicit NL resume routes to the resume runner with the named mission", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-resume", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-resume-deterministic/deterministic";
    const resolver = await createEvokModelResolver({ modelRuntime, catalog: catalogFrom(modelRuntime, [ref], ref) });
    const seen: Array<{ missionId?: string; token?: string }> = [];
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "resume mission m-abc123def456 now", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      resumeRunner: async (opts) => {
        seen.push({ missionId: opts.missionId, token: opts.authorization.token });
        return {
          runId: "m-abc123def456:exp:3", status: "director-stopped", stopReason: "example complete",
          model: { provider: "p", model: "m", id: ref },
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.8 },
          evaluation: { ok: true, score: 0.9 }, record: {} as never, experiments: [],
          reconciliation: { record: {} as never, adoptedRunIds: ["m-abc123def456:baseline:1"], remeasuredRunIds: [], abandonedIntents: [] },
        } as never;
      },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.missionId).toBe("m-abc123def456");
    expect(stdout.text()).toMatch(/adopted confirmed runs/);
    await rm(project, { recursive: true, force: true });
  });

  test("a status question about resuming never dispatches the resume runner", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-question", [{ id: "deterministic", text: "nothing to run" }]);
    const ref = "evok-cli-question-deterministic/deterministic";
    const resolver = await createEvokModelResolver({ modelRuntime, catalog: catalogFrom(modelRuntime, [ref], ref) });
    const stderr = new CollectStream();
    let resumed = false;
    const code = await runEvok({
      args: { request: "can we continue later?", project, tier: "default", timeoutMs: 600000, mission: "m-x" },
      createResolver: async () => resolver,
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true }; } },
      resumeRunner: async () => { resumed = true; throw new Error("must not resume"); },
      stdout: new CollectStream(),
      stderr,
    });
    // Routed to an ordinary foreground request (a real faux completion), not resume.
    expect(code).toBe(0);
    expect(resumed).toBe(false);
    await rm(project, { recursive: true, force: true });
  });

  test("--missions lists unfinished Missions without dispatching", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-missions", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-missions-deterministic/deterministic";
    const resolver = await createEvokModelResolver({ modelRuntime, catalog: catalogFrom(modelRuntime, [ref], ref) });
    await mkdir(join(project, ".evok", "missions", "m-abc123def456"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-abc123def456", "mission.json"), JSON.stringify({
      schemaVersion: 1, id: "m-abc123def456", status: "interrupted", objective: "x",
      contract: { objective: "x", expectedOutputs: [], evaluationMethod: "e", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.8 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
      stopReason: "user interruption during the Research Loop",
    }));
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { missions: true, project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      resumeRunner: async () => { throw new Error("must not resume on a listing"); },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    const out = stdout.text();
    expect(out).toContain("m-abc123def456");
    expect(out).toMatch(/resumable/);
    expect(out).toMatch(/0\.800000 remaining/);
    await rm(project, { recursive: true, force: true });
  });
  test("--missions reopens offline even when model auth/config is unusable (no preflight needed)", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-abc123def456"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-abc123def456", "mission.json"), JSON.stringify({
      schemaVersion: 1, id: "m-abc123def456", status: "interrupted", objective: "x",
      contract: { objective: "x", expectedOutputs: [], evaluationMethod: "e", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.8 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {}, stateVersion: 1, tasks: [], experiments: [], history: [],
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z",
      stopReason: "user interruption",
    }));
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { missions: true, project, tier: "default", timeoutMs: 600000 },
      // resolver that would fail preflight: listing must never call it
      createResolver: async () => { throw new Error("no model configuration"); },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("m-abc123def456");
    await rm(project, { recursive: true, force: true });
  });

  test("--missions surfaces a parseable-but-damaged mission record instead of hiding it", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-abc123def456"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-abc123def456", "mission.json"), JSON.stringify({
      schemaVersion: 1, id: "m-abc123def456", status: "interrupted", objective: "x",
      budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.9 },
    }));
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { missions: true, project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => { throw new Error("no model configuration"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).not.toBe(0);
    expect(stderr.text()).toMatch(/damaged/i);
    await rm(project, { recursive: true, force: true });
  });
});

describe("runEvok tty path uses Pi native TUI (ET-TUI1)", () => {
  test("tty without request launches Pi native TUI and does not start the evoK REPL", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-tui", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-tui-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const launches: Array<Record<string, unknown>> = [];
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async (launch) => {
        launches.push({ ...launch });
      },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.projectRoot).toBe(await realpath(project));
    expect(launches[0]!.tier).toBe("default");
    expect(launches[0]).not.toHaveProperty("slashCommands");
    expect(launches[0]).not.toHaveProperty("commandTable");
    expect(stdout.text()).not.toMatch(/foreground REPL/);
    expect(stdout.text()).toMatch(/native TUI/i);
    expect(stdout.text()).toMatch(/mission-resume/);
    expect(stdout.text()).toMatch(/Pi owns Pi shorts/);
    expect(stdout.text()).not.toMatch(/personal Pi prompts\/skills\/extensions\/history and global shared skills are not loaded/);
    expect(stdout.text()).toMatch(/credentials stay in ~\/\.pi\/agent/);
    expect(stdout.text()).toMatch(/mode=explore/);
    expect(launches[0]!.promptMode).toBe("explore");
    expect(launches[0]!.modeBanner).toBe("mode=explore");
    expect(launches[0]).toHaveProperty("promptModeExtension");
    await rm(project, { recursive: true, force: true });
  });

  test("TUI launch banner shows mode=intake when writing a draft and mode=mission when a Mission is active", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-tui-mode", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-tui-mode-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    const { saveMissionDraft } = await import("../mission/mission-draft");
    await saveMissionDraft(project, { id: "m-deadbeef0002", objective: "write a draft" });
    const intakeLaunch: Array<Record<string, unknown>> = [];
    const intakeOut = new CollectStream();
    await runEvok({
      args: { project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async (launch) => { intakeLaunch.push({ ...launch }); },
      stdout: intakeOut,
      stderr: new CollectStream(),
    });
    expect(intakeOut.text()).toMatch(/mode=intake/);
    expect(intakeLaunch[0]!.promptMode).toBe("intake");

    await mkdir(join(project, ".evok", "missions", "m-abc123def456"), { recursive: true });
    await writeFile(join(project, ".evok", "missions", "m-abc123def456", "mission.json"), JSON.stringify({
      schemaVersion: 1, id: "m-abc123def456", status: "running", objective: "active research",
      contract: { objective: "active research", expectedOutputs: [], evaluationMethod: "e", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.1, remaining: 0.9 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {}, history: [],
      createdAt: "2026-09-19T03:00:00.000Z", updatedAt: "2026-09-19T03:05:00.000Z",
    }));
    const missionLaunch: Array<Record<string, unknown>> = [];
    const missionOut = new CollectStream();
    await runEvok({
      args: { project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async (launch) => { missionLaunch.push({ ...launch }); },
      stdout: missionOut,
      stderr: new CollectStream(),
    });
    expect(missionOut.text()).toMatch(/mode=mission/);
    expect(missionLaunch[0]!.promptMode).toBe("mission");
    await rm(project, { recursive: true, force: true });
  });

  test("Pi native slash commands /model /new /resume are not stolen by evoK; Mission resume is /mission-resume", () => {
    expect(EVOK_USAGE).toMatch(/native TUI/i);
    expect(EVOK_USAGE).toMatch(/\/mission-resume/);
    expect(EVOK_USAGE).toMatch(/Pi owns/i);
    expect(EVOK_USAGE).not.toMatch(/REPL/);
    expect(EVOK_USAGE).not.toMatch(/in a REPL/);
    expect(isExplicitStartRequest("/model")).toBe(false);
    expect(isExplicitStartRequest("/new")).toBe(false);
    expect(isExplicitResumeRequest("/model").resume).toBe(false);
    expect(isExplicitResumeRequest("/new").resume).toBe(false);
    expect(isExplicitResumeRequest("/mission-resume").resume).toBe(true);
    expect(parseResearchCommand("/model")).toBeUndefined();
    expect(parseResearchCommand("/new")).toBeUndefined();
    expect(parseSkillsCommand("/model")).toBeUndefined();
    expect(parseSkillsCommand("/new")).toBeUndefined();
    expect(parseEvokArgs(["/model"]).research).toBeUndefined();
    expect(parseEvokArgs(["/new"]).research).toBeUndefined();
    expect(parseEvokArgs(["/model"]).skills).toBeUndefined();
    expect(parseEvokArgs(["/new"]).skills).toBeUndefined();
    expect(parseEvokArgs(["/model"]).request).toBe("/model");
    expect(parseEvokArgs(["/new"]).request).toBe("/new");
    expect(parseEvokArgs(["/mission-resume"]).resume).toBe(true);
  });

  test("one-shot request still uses the headless Run path, not TUI", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-tui-oneshot", [{ id: "deterministic", text: "one-shot body" }]);
    const ref = "evok-cli-tui-oneshot-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    let tuiLaunched = false;
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { request: "summarize the project", project, tier: "default", timeoutMs: 600000 },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    expect(stdout.text()).toContain("one-shot body");
    await rm(project, { recursive: true, force: true });
  });

  test("--start without request text dispatches Mission start, not TUI", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-tui-start"), { recursive: true });
    const { modelRuntime } = await fauxRuntime("evok-cli-tui-start", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-tui-start-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    let tuiLaunched = false;
    const seen: string[] = [];
    const stdout = new CollectStream();
    const code = await runEvok({
      args: { project, tier: "default", timeoutMs: 600000, start: true, mission: "m-tui-start" },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      startRunner: async (opts) => {
        seen.push(opts.missionId);
        return {
          runId: `${opts.missionId}:baseline:1`,
          status: "baseline-complete",
          stopReason: "baseline-complete",
          model: { provider: "p", model: "m", id: ref },
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          budget: { total: 1, units: "model-USD", consumed: 0, remaining: 1 },
          evaluation: { ok: true, score: 0.5 },
          record: {} as never,
          experiments: [],
        };
      },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    expect(seen).toEqual(["m-tui-start"]);
    expect(stdout.text()).toContain("baseline-complete");
    await rm(project, { recursive: true, force: true });
  });

  test("--resume without request text dispatches Mission resume, not TUI", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-tui-resume", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-tui-resume-deterministic/deterministic";
    const resolver = await createEvokModelResolver({ modelRuntime, catalog: catalogFrom(modelRuntime, [ref], ref) });
    let tuiLaunched = false;
    const seen: string[] = [];
    const code = await runEvok({
      args: { project, tier: "default", timeoutMs: 600000, resume: true, mission: "m-abc123def456" },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      evaluator: { id: "e", version: "1", async evaluate() { return { ok: true, score: 0.5 }; } },
      resumeRunner: async (opts) => {
        seen.push(opts.missionId);
        return {
          runId: "m-abc123def456:exp:3", status: "director-stopped", stopReason: "example complete",
          model: { provider: "p", model: "m", id: ref },
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          budget: { total: 1, units: "model-USD", consumed: 0.2, remaining: 0.8 },
          evaluation: { ok: true, score: 0.9 }, record: {} as never, experiments: [],
        } as never;
      },
      stdout: new CollectStream(),
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    expect(seen).toEqual(["m-abc123def456"]);
    await rm(project, { recursive: true, force: true });
  });

  test("--intake without request on tty is a usage error, not TUI or REPL", async () => {
    const project = await tempProject();
    const { modelRuntime } = await fauxRuntime("evok-cli-tui-intake", [{ id: "deterministic", text: "unused" }]);
    const ref = "evok-cli-tui-intake-deterministic/deterministic";
    const resolver = await createEvokModelResolver({
      modelRuntime,
      catalog: catalogFrom(modelRuntime, [ref], ref),
    });
    let tuiLaunched = false;
    const stderr = new CollectStream();
    const code = await runEvok({
      args: { project, tier: "default", timeoutMs: 600000, intake: true },
      createResolver: async () => resolver,
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      intakeRunner: async () => { throw new Error("must not intake without request text"); },
      stdout: new CollectStream(),
      stderr,
    });
    expect(code).toBe(EVOK_EXIT.usage);
    expect(tuiLaunched).toBe(false);
    expect(stderr.text()).toMatch(/--intake requires request text/);
    await rm(project, { recursive: true, force: true });
  });
});

describe("thin /research product entry (ET-M1-EVT / #138)", () => {
  test("parseEvokArgs reads /research and --research without treating them as TUI slashes", () => {
    expect(parseEvokArgs(["/research", "status", "--mission", "m-evt138demo01"])).toMatchObject({
      research: "status",
      mission: "m-evt138demo01",
      request: "/research status",
    });
    expect(parseEvokArgs(["--research", "continue", "--mission", "m-evt138demo01"])).toMatchObject({
      research: "continue",
      mission: "m-evt138demo01",
    });
    expect(parseEvokArgs(["/research"]).research).toBe("status");
  });

  test("/research status is readable offline and does not launch TUI or need a model", async () => {
    const project = await tempProject();
    const missionId = "m-evt138demo01";
    await mkdir(join(project, ".evok", "missions", missionId), { recursive: true });
    await writeFile(join(project, ".evok", "missions", missionId, "mission.json"), JSON.stringify({
      schemaVersion: 1, id: missionId, status: "baseline-complete", objective: "demo visible status",
      contract: { objective: "demo visible status", expectedOutputs: [], evaluationMethod: "e", hardRules: [] },
      budget: { total: 1, units: "model-USD", consumed: 0.1, remaining: 0.9 }, reserved: 0,
      usage: { intake: { tokens: {}, cost: { total: 0, units: "model-USD" } }, runs: [] },
      runs: {},
      baselineRunId: `${missionId}:baseline:1`,
      baseline: {
        runId: `${missionId}:baseline:1`,
        evaluation: { ok: true, score: 0.41 },
        evidenceRefs: ["snap:1"],
        measuredAt: "2026-09-19T03:00:00.000Z",
      },
      experiments: [{
        runId: `${missionId}:exp:2`, attempt: 1, action: "run-experiment", ok: true,
        taskObjective: "one experiment entry visible", evidenceRefs: [], at: "2026-09-19T03:05:00.000Z",
      }],
      history: [], createdAt: "2026-09-19T03:00:00.000Z", updatedAt: "2026-09-19T03:05:00.000Z",
    }));
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/research", "status", "--project", project, "--mission", missionId]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    expect(stdout.text()).toMatch(/phase experimenting/);
    expect(stdout.text()).toContain("demo visible status");
    expect(stdout.text()).toContain(`${missionId}:baseline:1`);
    expect(stdout.text()).toContain("one experiment entry visible");
    expect(stdout.text()).toMatch(/chat transcript is not authority/);
    await rm(project, { recursive: true, force: true });
  });

  test("/research continue records one authorized experiment entry without a model", async () => {
    const project = await tempProject();
    const missionId = "m-evt138demo01";
    await mkdir(join(project, ".evok", "missions", missionId), { recursive: true });
    await writeFile(join(project, ".evok", "missions", missionId, "control-events.jsonl"), [
      JSON.stringify({
        eventId: "evt-1", sequence: 1, type: "MISSION_AUTHORIZED", at: "2026-09-19T04:00:00.000Z",
        missionId, action: "authorize", payload: { objective: "continue after baseline" },
      }),
      JSON.stringify({
        eventId: "evt-2", sequence: 2, type: "BASELINE_RECORDED", at: "2026-09-19T04:00:01.000Z",
        missionId, payload: { runId: `${missionId}:baseline:1`, ok: true, score: 0.2 },
      }),
    ].join("\n") + "\n");
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/research", "continue", "--project", project, "--mission", missionId]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    expect(stdout.text()).toMatch(/phase experimenting/);
    expect(stdout.text()).toMatch(/last action: continue/);
    expect(stdout.text()).toMatch(/experiments: 1/);
    await rm(project, { recursive: true, force: true });
  });
});

describe("thin /skills directory view (ET-M1-SKILL / #140)", () => {
  test("parseEvokArgs reads /skills and --skills without treating them as TUI slashes", () => {
    expect(parseEvokArgs(["/skills"])).toMatchObject({
      skills: "status",
      request: "/skills",
    });
    expect(parseEvokArgs(["--skills"]).skills).toBe("status");
    expect(parseEvokArgs(["/research"]).skills).toBeUndefined();
    expect(parseEvokArgs(["/model"]).skills).toBeUndefined();
    expect(parseEvokArgs(["/new"]).skills).toBeUndefined();
  });

  test("/skills is readable offline and does not launch TUI or need a model", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".pi", "skills", "evok", "search", "try-search"), { recursive: true });
    await writeFile(
      join(project, ".pi", "skills", "evok", "search", "try-search", "SKILL.md"),
      "---\nname: try-search\ndescription: candidate search tip\nowner: evok\nstate: candidate\ncategory: search\n---\nCANDIDATE-BODY\n",
    );
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skills", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/8 categor/);
    expect(text).toContain("intake");
    expect(text).toContain("mission-intake");
    expect(text).toContain("accepted");
    expect(text).toContain("try-search");
    expect(text).toContain("candidate");
    expect(text).toContain("writeback not opened — read-only shell");
    expect(text).toMatch(/protected holdout/i);
    expect(text).toMatch(/Budget Gate/i);
    expect(text).toMatch(/not a second control plane/i);
    expect(text).not.toContain("CANDIDATE-BODY");
    expect(text).toMatch(/- experiment \[experiment\]/);
    expect(text).toMatch(/- evidence \[evidence\]/);
    expect(text).toMatch(/- policy \[policy\]/);
    expect(text).toMatch(/- search \[search\]/);
    expect(text).toMatch(/- method-improvement \[method-improvement\]/);
    expect(text).toMatch(/- recovery \[recovery\]/);
    expect(text).toMatch(/- pitfalls \[pitfalls\]/);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill experiment loads L1 and is not start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "experiment", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toContain("Task Contract");
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill evidence loads L1 and is not start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "evidence", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/lineage/i);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill method-improvement loads L1 and is not start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "method-improvement", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/version id/i);
    expect(text).toMatch(/verify command/i);
    expect(text).toMatch(/enable record/i);
    expect(text).toMatch(/rollback/i);
    expect(text).toMatch(/not automatic promotion|≠ automatic promotion|not auto-promote|≠ auto-promote/i);
    expect(text).toMatch(/Elite.{0,40}not.{0,20}Admission|Elite.{0,20}≠.{0,20}Admission/i);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill recovery loads L1 and is not start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "recovery", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/continueResearch/);
    expect(text).toMatch(/\/research continue/);
    expect(text).toMatch(/MISSION_REPAIRED/);
    expect(text).toMatch(/\/research repair/);
    expect(text).toMatch(/reserved/i);
    expect(text).toMatch(/resumeAuthorizedMission|reconcileInterruptedMission/);
    expect(text).toMatch(/\/mission-resume/);
    expect(text).toMatch(/runKillTestHang/);
    expect(text).toMatch(/not a second control plane|≠ second control plane/i);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill pitfalls loads L1 and is not a rejection library or start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "pitfalls", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/failure signature/i);
    expect(text).toMatch(/Goodhart/i);
    expect(text).toMatch(/holdout/i);
    expect(text).toMatch(/inconclusive/i);
    expect(text).toMatch(/Elite/i);
    expect(text).toMatch(/not a rejection library|≠ rejection library|not an? auto-refuse|≠ auto-refuse/i);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill search loads L1 and is not start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "search", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/fixed_uct/);
    expect(text).toMatch(/opt-in/i);
    expect(text).toMatch(/Progressive/i);
    expect(text).toMatch(/#40/);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });

  test("/skill policy loads L1 and is not privilege expansion or start/continue/submit authorization", async () => {
    const project = await tempProject();
    const stdout = new CollectStream();
    let tuiLaunched = false;
    const code = await runEvok({
      args: parseEvokArgs(["/skill", "policy", "--project", project]),
      createResolver: async () => { throw new Error("no model configuration"); },
      isTty: () => true,
      launchNativeTui: async () => { tuiLaunched = true; },
      stdout,
      stderr: new CollectStream(),
    });
    expect(code).toBe(0);
    expect(tuiLaunched).toBe(false);
    const text = stdout.text();
    expect(text).toMatch(/disclosure l1-body/i);
    expect(text).toMatch(/privilege expansion/i);
    expect(text).toMatch(/red lights? still ask/i);
    expect(text).toMatch(/not authorization to start, continue, or submit/i);
    expect(text).toMatch(/does not relax/i);
    await rm(project, { recursive: true, force: true });
  });
});

class CollectStream {
  private chunks: string[] = [];
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}
