import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime } from "../../src/pi-agent-runtime";
import { createEvokModelResolver, type SessionModelResolver } from "../../src/evok-model";
import { discoverEvokResources } from "../../src/evok-resources";

async function layout(): Promise<{ home: string; project: string; workspaceRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), "evok-res-home-"));
  const project = await mkdtemp(join(tmpdir(), "evok-res-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "evok-res-ws-"));
  await mkdir(join(home, ".evok", "skills"), { recursive: true });
  await mkdir(join(home, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".evok", "skills"), { recursive: true });
  await mkdir(join(project, ".pi", "skills"), { recursive: true });
  await mkdir(join(project, ".agents", "skills"), { recursive: true });
  return { home, project, workspaceRoot };
}

async function skillFile(path: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\nowner: evok\nstate: accepted\n---\n${body}`);
}

function newWorkspace(workspaceRoot: string): Promise<string> {
  return mkdtemp(join(workspaceRoot, "run-"));
}

async function setupFaux(providerId: string) {
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

describe("evok resources through the Pi SDK execution boundary (#110)", () => {
  test("startup is metadata-only: skill name/description/location are in the system prompt but the body is not", async () => {
    const { home, project, workspaceRoot } = await layout();
    await skillFile(join(project, ".pi", "skills", "probe", "SKILL.md"), "probe", "probe skill description", "SECRET-SKILL-BODY-MARKER");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const { faux, resolver } = await setupFaux("evok-res-meta");
    let capturedSystem = "";
    faux.setResponses([
      (ctx: unknown) => {
        const system = ctx as { systemPrompt?: string; messages?: unknown[] };
        capturedSystem = [system.systemPrompt ?? "", JSON.stringify(system.messages ?? [])].join("\n");
        return fauxAssistantMessage("meta probe complete");
      },
    ]);

    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources });
    const ws = await newWorkspace(workspaceRoot);
    const result = await runtime.execute({
      task: { objective: "report readiness" },
      role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
      workspace: { path: ws, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
    });
    expect(result.stopReason).toBeTruthy();
    expect(capturedSystem).toContain("probe");
    expect(capturedSystem).toContain("probe skill description");
    expect(capturedSystem).toContain(join(project, ".pi", "skills", "probe", "SKILL.md"));
    expect(capturedSystem).not.toContain("SECRET-SKILL-BODY-MARKER");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  test("a real SDK read tool call reads a skill body and a skill-relative reference in place", async () => {
    const { home, project, workspaceRoot } = await layout();
    const skillDir = join(project, ".pi", "skills", "method");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "guide.md"), "RELATIVE-REFERENCE-CONTENT 7", "utf8");
    await skillFile(join(skillDir, "SKILL.md"), "method", "method skill", "follow references/guide.md");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const { faux, resolver } = await setupFaux("evok-res-read");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(skillDir, "SKILL.md") }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: join(skillDir, "references", "guide.md") }), { stopReason: "toolUse" }),
      fauxAssistantMessage("read skill and relative reference"),
    ]);

    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources });
    const ws = await newWorkspace(workspaceRoot);
    const result = await runtime.execute({
      task: { objective: "read the method skill then its relative reference" },
      role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
      // The Run workspace differs from the research project; skill roots are granted in place.
      workspace: { path: ws, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
    });
    expect(result.text).toContain("read skill and relative reference");
    const reads = result.ledger.filter((e) => e.type === "tool_execution_start" && e.toolName === "read");
    expect(reads.length).toBe(2);
    // The read tool really returned the in-place reference content (not a fabricated answer).
    const toolResults = result.ledger.filter((e) => e.type === "tool_execution_end" && e.toolName === "read");
    expect(JSON.stringify(toolResults)).toContain("RELATIVE-REFERENCE-CONTENT 7");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  test("negative permissions: protected credential reads under the project root are blocked", async () => {
    const { home, project, workspaceRoot } = await layout();
    await skillFile(join(project, ".pi", "skills", "m", "SKILL.md"), "m", "m skill", "body");
    await mkdir(join(project, "credentials"), { recursive: true });
    await writeFile(join(project, "credentials", "api-key.txt"), "top-secret");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const { faux, resolver } = await setupFaux("evok-res-deny");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(project, "credentials", "api-key.txt") }), { stopReason: "toolUse" }),
      fauxAssistantMessage("should not reach this text zzz"),
    ]);

    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources });
    const ws = await newWorkspace(workspaceRoot);
    await expect(
      runtime.execute({
        task: { objective: "attempt protected read" },
        role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
        workspace: { path: ws, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
      }),
    ).rejects.toThrow(/protected|credential|sandbox/i);

    // write/edit/bash are not part of the read-only role and are rejected up front.
    const wsWrite = await newWorkspace(workspaceRoot);
    await expect(
      runtime.execute({
        task: { objective: "attempt a write" },
        role: { name: "evok-foreground", tools: ["write"] },
        workspace: { path: wsWrite, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
      }),
    ).rejects.toThrow(/coding tools|write/i);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  test("negative permissions: a skill-relative path escaping via ../ is blocked and a readable helper script is not executable", async () => {
    const { home, project, workspaceRoot } = await layout();
    const skillDir = join(project, ".pi", "skills", "s");
    await mkdir(join(skillDir, "bin"), { recursive: true });
    await skillFile(join(skillDir, "SKILL.md"), "s", "s skill", "run bin/helper.sh");
    await writeFile(join(skillDir, "bin", "helper.sh"), "#!/bin/sh\necho nope\n", "utf8");
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });

    const { faux, resolver } = await setupFaux("evok-res-trav");
    // ../../../ from project/.pi/skills/s lands at the project root; one more
    // ../ escapes the approved roots entirely.
    const secretOutside = join(dirname(project), `outside-${Date.now()}.txt`);
    await writeFile(secretOutside, "secret", "utf8");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: join(skillDir, "..", "..", "..", "..", basename(secretOutside)) }), { stopReason: "toolUse" }),
      fauxAssistantMessage("unreachable"),
    ]);

    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources });
    const ws = await newWorkspace(workspaceRoot);
    await expect(
      runtime.execute({
        task: { objective: "attempt traversal and script execution" },
        role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
        workspace: { path: ws, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
      }),
    ).rejects.toThrow(/protected|traversal|sandbox|escapes/i);

    // The helper script is readable text...
    const boundaryResources = resources;
    expect(boundaryResources.readRoots).toContain(skillDir);
    // ...but bash is not in the read-only role, so it cannot be executed.
    const wsBash = await newWorkspace(workspaceRoot);
    await expect(
      runtime.execute({
        task: { objective: "execute helper" },
        role: { name: "evok-foreground", tools: ["read", "bash"] },
        workspace: { path: wsBash, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
      }),
    ).rejects.toThrow(/bash|sandbox|unknown tool/i);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
    await rm(secretOutside, { force: true });
  });

  test("a runtime WITHOUT evok resources never loads project .pi or global ~/.agents skills (#110 P1 regression)", async () => {
    const { home, project, workspaceRoot } = await layout();
    // A personal/global skill that must not leak into an evoK session.
    await mkdir(join(home, ".agents", "skills", "personal"), { recursive: true });
    await writeFile(join(home, ".agents", "skills", "personal", "SKILL.md"), "---\nname: personal\ndescription: PERSONAL-GLOBAL-SKILL-MARKER\n---\nbody\n");
    await mkdir(join(project, ".pi", "skills", "pi"), { recursive: true });
    await writeFile(join(project, ".pi", "skills", "pi", "SKILL.md"), "---\nname: pi\ndescription: PI-PROJECT-SKILL-MARKER\n---\nbody\n");

    const { faux, resolver } = await setupFaux("evok-res-none");
    let capturedSystem = "";
    faux.setResponses([
      (ctx: unknown) => {
        const system = ctx as { systemPrompt?: string; messages?: unknown[] };
        capturedSystem = [system.systemPrompt ?? "", JSON.stringify(system.messages ?? [])].join("\n");
        return fauxAssistantMessage("locked loader ok");
      },
    ]);

    // No `resources` option: the runtime must keep the locked-down #109 loader.
    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver });
    const ws = await newWorkspace(workspaceRoot);
    await runtime.execute({
      task: { objective: "report readiness" },
      role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
      workspace: { path: ws, isolated: true, approved: true, readRoots: [project] },
    });
    expect(capturedSystem).not.toContain("PERSONAL-GLOBAL-SKILL-MARKER");
    expect(capturedSystem).not.toContain("PI-PROJECT-SKILL-MARKER");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });
});

describe("evok resources through the Pi SDK execution boundary (ET-M1-SKILL / #140)", () => {
  test("default context loads accepted L0 pointers only; candidate and demoted stay out", async () => {
    const { home, project, workspaceRoot } = await layout();
    await skillFile(join(project, ".pi", "skills", "keep", "SKILL.md"), "keep", "accepted short", "ACCEPTED-BODY");
    await writeFile(
      join(project, ".pi", "skills", "keep", "SKILL.md"),
      "---\nname: keep\ndescription: accepted short\nowner: evok\nstate: accepted\n---\nACCEPTED-BODY\n",
    );
    await mkdir(join(project, ".pi", "skills", "try"), { recursive: true });
    await writeFile(
      join(project, ".pi", "skills", "try", "SKILL.md"),
      "---\nname: try\ndescription: candidate must stay out\nowner: evok\nstate: candidate\n---\nCANDIDATE-BODY\n",
    );
    await mkdir(join(project, ".pi", "skills", "drop"), { recursive: true });
    await writeFile(
      join(project, ".pi", "skills", "drop", "SKILL.md"),
      "---\nname: drop\ndescription: demoted must stay out\nowner: evok\nstate: demoted\n---\nDEMOTED-BODY\n",
    );
    const resources = await discoverEvokResources({ projectRoot: project, userRoot: join(home, ".evok") });
    const { faux, resolver } = await setupFaux("evok-res-states");
    let capturedSystem = "";
    faux.setResponses([
      (ctx: unknown) => {
        const system = ctx as { systemPrompt?: string; messages?: unknown[] };
        capturedSystem = [system.systemPrompt ?? "", JSON.stringify(system.messages ?? [])].join("\n");
        return fauxAssistantMessage("state filter complete");
      },
    ]);
    const runtime = new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources });
    const ws = await newWorkspace(workspaceRoot);
    await runtime.execute({
      task: { objective: "report readiness" },
      role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
      workspace: { path: ws, isolated: true, approved: true, readRoots: [project, ...resources.readRoots] },
    });
    expect(capturedSystem).toContain("keep");
    expect(capturedSystem).toContain("accepted short");
    expect(capturedSystem).not.toContain("candidate must stay out");
    expect(capturedSystem).not.toContain("demoted must stay out");
    expect(capturedSystem).not.toContain("CANDIDATE-BODY");
    expect(capturedSystem).not.toContain("DEMOTED-BODY");
    expect(capturedSystem).not.toContain("ACCEPTED-BODY");
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });
});
