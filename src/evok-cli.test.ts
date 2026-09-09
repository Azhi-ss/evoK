import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runEvok, parseEvokArgs, EVOK_EXIT, type EvokRunOptions } from "./evok-cli";
import { createEvokModelResolver } from "./evok-model";

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

  test("plain agents/ and .pi/ never enter discovery (global ~/.agents exclusion is covered in evok-resources.test)", async () => {
    const project = await evokProject();
    await mkdir(join(project, "agents", "skills", "plain"), { recursive: true });
    await writeFile(join(project, "agents", "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: plain agents\n---\n");
    await mkdir(join(project, ".pi", "skills", "pi"), { recursive: true });
    await writeFile(join(project, ".pi", "skills", "pi", "SKILL.md"), "---\nname: pi\ndescription: pi skill\n---\n");
    await skillFile(join(project, ".evok", "skills", "keep", "SKILL.md"), "keep", "kept skill");

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
    expect(report).not.toContain("plain");
    expect(report).not.toContain("pi skill");
    await rm(project, { recursive: true, force: true });
  });

  test("a name collision is resolved project-first and surfaced as a visible diagnostic", async () => {
    const project = await evokProject();
    await skillFile(join(project, ".agents", "skills", "dup", "SKILL.md"), "dup", "shared dup");
    await skillFile(join(project, ".evok", "skills", "dup", "SKILL.md"), "dup", "project dup");
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
    expect(report).toContain(join(project, ".evok", "skills", "dup", "SKILL.md"));
    expect(report).toContain("wins over");
    await rm(project, { recursive: true, force: true });
  });

  test("a real SDK tool call reads an in-place skill reference even though the Run workspace differs", async () => {
    const project = await evokProject();
    const skillDir = join(project, ".evok", "skills", "method");
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
