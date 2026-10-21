import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = join(here, "../harness-patch/upstream/harness.mjs");
const applyScript = join(here, "../harness-patch/apply.mjs");

const STUB = `
import { writeFileSync } from "node:fs";
const handlers = new Map();
let sessionListener = () => {};
let stopGoal = false;
export const bus = {
  on(channel, fn) {
    const set = handlers.get(channel) ?? new Set();
    set.add(fn);
    handlers.set(channel, set);
    return () => set.delete(fn);
  },
  emit(channel, data) {
    for (const fn of [...(handlers.get(channel) ?? [])]) fn(data);
    if (channel === "pi-goal:cancel") stopGoal = true;
    if (channel !== "pi-goal:start") return;
    stopGoal = false;
    const turns = Number(process.env.HARNESS_STUB_TURNS || "3");
    let sent = 0;
    for (let i = 0; i < turns; i++) {
      if (stopGoal) break;
      sent += 1;
      sessionListener({ type: "turn_end" });
    }
    const ev = "pi-goal:event:" + data.runId;
    const reported = stopGoal ? sent : turns;
    bus.emit(ev, { type: "state", status: "active" });
    if (process.env.HARNESS_STUB_OFFICIAL === "0") {
      bus.emit(ev, { type: "state", status: "complete" });
    } else {
      bus.emit(ev, { type: "state", status: "complete", automaticModelTurns: reported });
    }
  },
};
export class DefaultResourceLoader {
  constructor(options) {
    this.eventBus = bus;
    const text = typeof options.systemPromptOverride === "function" ? options.systemPromptOverride("") : "";
    if (process.env.HARNESS_STUB_PROMPT) writeFileSync(process.env.HARNESS_STUB_PROMPT, text);
    if (process.env.HARNESS_STUB_LOADER) {
      writeFileSync(process.env.HARNESS_STUB_LOADER, JSON.stringify({ extensions: options.additionalExtensionPaths || [] }));
    }
  }
  async reload() {}
}
export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  getModel() { return { id: "stub" }; }
}
export class SettingsManager {
  static inMemory(settings) {
    if (process.env.HARNESS_STUB_SETTINGS) writeFileSync(process.env.HARNESS_STUB_SETTINGS, JSON.stringify(settings));
    return settings;
  }
}
export class SessionManager {
  static create() { return { getSessionFile() { return null; } }; }
}
export function createBashToolDefinition() { return { execute: async () => ({}) }; }
export function createSyntheticSourceInfo() { return {}; }
export async function createAgentSession() {
  return {
    session: {
      subscribe(fn) { sessionListener = fn; return () => {}; },
      async prompt() {},
      async abort() {},
      dispose() {},
      async compact() {},
      async bindExtensions() {},
    },
  };
}
`;

function prepareHome(root: string): string {
  const home = join(root, "home");
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(join(home, "extensions/pi-goal"), { recursive: true });
  mkdirSync(join(home, "src"), { recursive: true });
  mkdirSync(join(home, "node_modules/@earendil-works/pi-coding-agent"), { recursive: true });
  mkdirSync(join(home, "node_modules/pi-subagents"), { recursive: true });
  writeFileSync(join(home, "prompts/lead-system.md"), "lead {{CODE_DIR}} {{CONTRACT_FIRST_GATE}}\n");
  writeFileSync(join(home, "prompts/team.md"), "team {{INSTRUCTION}}\n");
  writeFileSync(join(home, "extensions/pi-goal/index.ts"), "export {};\n");
  writeFileSync(join(home, "node_modules/@earendil-works/pi-coding-agent/package.json"), `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" })}\n`);
  writeFileSync(join(home, "node_modules/@earendil-works/pi-coding-agent/index.js"), STUB);
  writeFileSync(join(home, "node_modules/pi-subagents/package.json"), `${JSON.stringify({ name: "pi-subagents", pi: { extensions: ["./ext.js"] } })}\n`);
  writeFileSync(join(home, "node_modules/pi-subagents/ext.js"), "export {};\n");
  writeFileSync(join(home, "src/instruction.md"), "Add one and one.\n");
  return home;
}

function runHarness(home: string, harnessFile: string, runDir: string, extra: Record<string, string>) {
  mkdirSync(runDir, { recursive: true });
  const code = join(runDir, "code");
  const output = join(runDir, "output");
  mkdirSync(code, { recursive: true });
  mkdirSync(output, { recursive: true });
  const paths = {
    RUN_DIR: runDir,
    TRACE_PATH: join(runDir, "trace.jsonl"),
    HARNESS_AGENT_DIR: join(runDir, "agent"),
    HARNESS_STUB_SETTINGS: join(runDir, "settings.json"),
    HARNESS_STUB_LOADER: join(runDir, "loader.json"),
    HARNESS_STUB_PROMPT: join(runDir, "prompt.txt"),
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BASE_URL: "http://127.0.0.1:9",
    API_KEY: "smoke-test-key",
    PI_HARNESS_HOME: home,
    CODE_DIR: code,
    OUTPUT_DIR: output,
    RUN_DIR: runDir,
    TRACE_PATH: paths.TRACE_PATH,
    HARNESS_AGENT_DIR: paths.HARNESS_AGENT_DIR,
    HARNESS_SESSION_DIR: join(runDir, "sessions"),
    HARNESS_STUB_SETTINGS: paths.HARNESS_STUB_SETTINGS,
    HARNESS_STUB_LOADER: paths.HARNESS_STUB_LOADER,
    HARNESS_STUB_PROMPT: paths.HARNESS_STUB_PROMPT,
    ...extra,
  };
  delete env.HARNESS_CANDIDATE_CONFIG;
  delete env.HARNESS_MEMORY_PATH;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  const result = spawnSync("node", [harnessFile, "--task", join(home, "src/instruction.md"), "--model-name", "stub-model"], {
    encoding: "utf8",
    env,
    timeout: 20000,
  });
  const trace = existsSync(paths.TRACE_PATH)
    ? readFileSync(paths.TRACE_PATH, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string })
    : [];
  return { result, trace, env: paths };
}

describe("patched harness smoke", () => {
  test("defaults match the original harness, and a candidate config is consumed", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-smoke-"));
    const home = prepareHome(root);
    const original = join(home, "src/harness-original.mjs");
    const patched = join(home, "src/harness.mjs");
    const applied = spawnSync("node", [applyScript, upstream, patched], { encoding: "utf8" });
    expect(applied.status).toBe(0);
    writeFileSync(original, readFileSync(upstream));
    const plainOriginal = runHarness(home, original, join(root, "orig"), {});
    const plainPatched = runHarness(home, patched, join(root, "plain"), {});
    expect(plainOriginal.result.status).not.toBe(null);
    expect(plainPatched.result.status).toBe(plainOriginal.result.status);
    expect(plainPatched.trace.map((event) => event.type)).toEqual(plainOriginal.trace.map((event) => event.type));
    const originalStart = plainOriginal.trace.find((event) => event.type === "run_start") as Record<string, unknown>;
    const patchedStart = plainPatched.trace.find((event) => event.type === "run_start") as Record<string, unknown>;
    expect(Object.keys(patchedStart).sort()).toEqual(Object.keys(originalStart).sort());
    expect(patchedStart.candidateConfigHash).toBeUndefined();
    expect(patchedStart.effective).toBeUndefined();
    const originalEnd = plainOriginal.trace.find((event) => event.type === "run_end") as Record<string, unknown>;
    const patchedEnd = plainPatched.trace.find((event) => event.type === "run_end") as Record<string, unknown>;
    expect(Object.keys(patchedEnd).sort()).toEqual(Object.keys(originalEnd).sort());
    expect(patchedEnd.goalContinuationTurns).toBeUndefined();
    const originalSettings = JSON.parse(readFileSync(plainOriginal.env.HARNESS_STUB_SETTINGS, "utf8")) as { defaultTools: string[]; compaction: { keepRecentTokens: number } };
    const patchedSettings = JSON.parse(readFileSync(plainPatched.env.HARNESS_STUB_SETTINGS, "utf8")) as { defaultTools: string[]; compaction: { keepRecentTokens: number } };
    expect(patchedSettings).toEqual(originalSettings);
    expect(patchedSettings.defaultTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(patchedSettings.compaction.keepRecentTokens).toBe(16000);
    const goal = JSON.parse(readFileSync(join(plainPatched.env.HARNESS_AGENT_DIR, "pi-goal.json"), "utf8")) as { continuationLimits: { automaticTurns: number; noProgressTurns: number } };
    expect(goal.continuationLimits).toEqual({ automaticTurns: 25, noProgressTurns: 3, maxContinuationTurns: 25 });

    const memory = join(root, "memory.jsonl");
    writeFileSync(memory, `${JSON.stringify({ text: "repeat tool errors", scope: "all" })}\n`);
    const before = createHash("sha256").update(readFileSync(memory)).digest("hex");
    const control = {
      parts: {
        "agent-loop": { maxSteps: 25, noProgressTurns: 3, maxNudges: 2, requireWrite: false },
        toolchain: { checker: "none", subagents: false, bashTimeoutSec: 300, tools: { enabled: ["read", "write"] } },
        context: { compaction: { keepRecentTokens: 100 } },
        memory: { enabled: true, scope: "all", recall: "recent", maxItems: 4 },
      },
    };
    const treatment = { parts: { "agent-loop": { maxSteps: 3 } } };
    const controlPath = join(root, "control.json");
    const treatmentPath = join(root, "treatment.json");
    writeFileSync(controlPath, JSON.stringify(control));
    writeFileSync(treatmentPath, JSON.stringify(treatment));
    const controlRun = runHarness(home, patched, join(root, "control"), {
      HARNESS_CANDIDATE_CONFIG: controlPath,
      HARNESS_MEMORY_PATH: memory,
    });
    const treatmentRun = runHarness(home, patched, join(root, "treatment"), {
      HARNESS_CANDIDATE_CONFIG: treatmentPath,
      HARNESS_MEMORY_PATH: memory,
      HARNESS_STUB_OFFICIAL: "0",
      HARNESS_STUB_TURNS: "2",
    });
    expect(controlRun.result.status).toBe(0);
    const controlStart = controlRun.trace.find((event) => event.type === "run_start") as unknown as {
      candidateConfigHash: string;
      effective: Record<string, unknown>;
      memoryInjected: number;
    };
    const treatmentStart = treatmentRun.trace.find((event) => event.type === "run_start") as unknown as {
      candidateConfigHash: string;
      effective: Record<string, unknown>;
    };
    expect(controlStart.candidateConfigHash).toBe(createHash("sha256").update(readFileSync(controlPath)).digest("hex"));
    expect(treatmentStart.candidateConfigHash).toBe(createHash("sha256").update(readFileSync(treatmentPath)).digest("hex"));
    expect(controlStart).not.toHaveProperty("systemPrompt");
    const controlPrompt = readFileSync(join(controlRun.env.RUN_DIR, "prompt.txt"), "utf8");
    const treatmentPrompt = readFileSync(join(treatmentRun.env.RUN_DIR, "prompt.txt"), "utf8");
    expect(controlPrompt).toContain(`candidateConfigHash: ${controlStart.candidateConfigHash}`);
    expect(treatmentPrompt).toContain(`candidateConfigHash: ${treatmentStart.candidateConfigHash}`);
    expect(controlPrompt).not.toContain(treatmentStart.candidateConfigHash);
    expect(readFileSync(join(plainPatched.env.RUN_DIR, "prompt.txt"), "utf8")).not.toContain("candidateConfigHash:");
    expect(controlStart.candidateConfigHash).not.toBe(treatmentStart.candidateConfigHash);
    expect(controlStart.effective["agent-loop.maxSteps"]).toBe(25);
    expect(treatmentStart.effective["agent-loop.maxSteps"]).toBe(3);
    expect(controlStart.effective["toolchain.checker"]).toBe("none");
    expect(controlStart.effective["toolchain.tools.enabled"]).toEqual(["read", "write"]);
    expect(controlStart.effective["context.compaction.keepRecentTokens"]).toBe(100);
    expect(controlStart.effective["memory.enabled"]).toBe(true);
    expect(controlStart.memoryInjected).toBe(1);
    expect(createHash("sha256").update(readFileSync(memory)).digest("hex")).toBe(before);
    const controlEnd = controlRun.trace.find((event) => event.type === "run_end") as unknown as { goalContinuationTurns: number };
    const treatmentEnd = treatmentRun.trace.find((event) => event.type === "run_end") as unknown as { goalContinuationTurns: number };
    expect(controlEnd.goalContinuationTurns).toBe(3);
    expect(treatmentEnd.goalContinuationTurns).toBe(2);
    const controlGoal = JSON.parse(readFileSync(join(controlRun.env.HARNESS_AGENT_DIR, "pi-goal.json"), "utf8")) as { continuationLimits: { automaticTurns: number } };
    const treatmentGoal = JSON.parse(readFileSync(join(treatmentRun.env.HARNESS_AGENT_DIR, "pi-goal.json"), "utf8")) as { continuationLimits: { automaticTurns: number } };
    expect(controlGoal.continuationLimits.automaticTurns).toBe(25);
    expect(treatmentGoal.continuationLimits.automaticTurns).toBe(3);
    const controlSettings = JSON.parse(readFileSync(controlRun.env.HARNESS_STUB_SETTINGS, "utf8")) as { defaultTools: string[]; compaction: { keepRecentTokens: number } };
    expect(controlSettings.defaultTools).toEqual(["read", "write"]);
    expect(controlSettings.compaction.keepRecentTokens).toBe(100);
    const loader = JSON.parse(readFileSync(controlRun.env.HARNESS_STUB_LOADER, "utf8")) as { extensions: string[] };
    expect(loader.extensions.some((item) => item.includes("pi-subagents"))).toBe(false);
    const result = JSON.parse(readFileSync(join(controlRun.env.RUN_DIR, "result.json"), "utf8")) as { nudges: number; status: string };
    expect(result.nudges).toBe(0);
    expect(result.status).toBe("ok");
    expect(controlRun.result.stdout).not.toContain("smoke-test-key");
  }, 30000);

  test("goal.maxContinuationTurns stops the continuation loop at N", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cap-"));
    const home = prepareHome(root);
    const patched = join(home, "src/harness.mjs");
    const applied = spawnSync("node", [applyScript, upstream, patched], { encoding: "utf8" });
    expect(applied.status).toBe(0);
    const config = {
      parts: {
        "agent-loop": { maxSteps: 25, noProgressTurns: 3, maxNudges: 2, requireWrite: false },
        toolchain: { checker: "none", subagents: false, bashTimeoutSec: 300, tools: { enabled: ["read", "write"] } },
        goal: { maxContinuationTurns: 2 },
      },
    };
    const configPath = join(root, "goal.json");
    writeFileSync(configPath, JSON.stringify(config));
    const run = runHarness(home, patched, join(root, "run"), {
      HARNESS_CANDIDATE_CONFIG: configPath,
      HARNESS_STUB_TURNS: "8",
    });
    expect(run.result.status).toBe(0);
    const start = run.trace.find((event) => event.type === "run_start") as unknown as { effective: Record<string, unknown> };
    const end = run.trace.find((event) => event.type === "run_end") as unknown as { goalContinuationTurns: number; maxContinuationTurns: number };
    expect(start.effective["goal.maxContinuationTurns"]).toBe(2);
    expect(end.goalContinuationTurns).toBe(2);
    expect(end.maxContinuationTurns).toBe(2);
    const goal = JSON.parse(readFileSync(join(run.env.HARNESS_AGENT_DIR, "pi-goal.json"), "utf8")) as { continuationLimits: { maxContinuationTurns: number } };
    expect(goal.continuationLimits.maxContinuationTurns).toBe(2);
  });
});
