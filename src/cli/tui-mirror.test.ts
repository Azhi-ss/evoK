/**
 * ET-TUI-MIRROR / #148 — TUI full mirror of CLI capabilities.
 *
 * Seams: EVOK_TUI_MIRROR_COMMANDS / parseTuiMirrorInput /
 * executeTuiMirrorCommand / createEvokTuiMirrorExtension /
 * formatTuiConflictTable. TUI is an entry mirror, not a second
 * control plane: dispatch reuses runEvok so refusals stay identical.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEvokModelResolver } from "../evok-model";
import { BudgetExhaustedError } from "../mission-start";
import { EVOK_EXIT, EVOK_USAGE, parseEvokArgs, runEvok } from "./evok-cli";
import {
  EVOK_TUI_MIRROR_COMMANDS,
  PI_OWNED_SHORT_NAMES,
  createEvokTuiMirrorExtension,
  executeTuiMirrorCommand,
  formatTuiConflictTable,
  parseTuiMirrorInput,
} from "./tui-mirror";

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-tui-mirror-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# research project");
  return dir;
}

async function fauxResolver(label: string) {
  const handle = fauxProvider({ provider: `${label}-deterministic`, models: [{ id: "deterministic" }] });
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  handle.setResponses([fauxAssistantMessage("unused")]);
  modelRuntime.registerNativeProvider(handle.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const ref = `${label}-deterministic/deterministic`;
  return createEvokModelResolver({
    modelRuntime,
    catalog: {
      findModel(id: string) {
        if (id !== ref) return undefined;
        return { provider: `${label}-deterministic`, model: "deterministic", id: ref };
      },
      defaultModel() {
        return { provider: `${label}-deterministic`, model: "deterministic", id: ref };
      },
    },
  });
}

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

async function runCli(args: ReturnType<typeof parseEvokArgs>, extras: {
  project: string;
  startRunner?: Parameters<typeof runEvok>[0]["startRunner"];
  resumeRunner?: Parameters<typeof runEvok>[0]["resumeRunner"];
  intakeRunner?: Parameters<typeof runEvok>[0]["intakeRunner"];
} ) {
  const stdout = new CollectStream();
  const stderr = new CollectStream();
  const resolver = await fauxResolver("tui-mirror-cli");
  const code = await runEvok({
    args: { ...args, project: extras.project },
    createResolver: async () => resolver,
    isTty: () => true,
    launchNativeTui: async () => { throw new Error("TUI must not launch from CLI comparison"); },
    stdout,
    stderr,
    ...(extras.startRunner ? { startRunner: extras.startRunner } : {}),
    ...(extras.resumeRunner ? { resumeRunner: extras.resumeRunner } : {}),
    ...(extras.intakeRunner ? { intakeRunner: extras.intakeRunner } : {}),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe("Pi short-name conflict table (ET-TUI-MIRROR / #148)", () => {
  test("Pi owns Pi shorts; Mission resume is /mission-resume, not /resume", () => {
    const names = EVOK_TUI_MIRROR_COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]);
    for (const short of PI_OWNED_SHORT_NAMES) {
      expect(names).not.toContain(short);
    }
    expect(PI_OWNED_SHORT_NAMES).toContain("model");
    expect(PI_OWNED_SHORT_NAMES).toContain("new");
    expect(PI_OWNED_SHORT_NAMES).toContain("resume");
    expect(names).toContain("mission-resume");
    expect(names).toContain("evok-resume");
    expect(names).not.toContain("resume");
  });

  test("reachable TUI catalog covers skills, skill, research, missions, intake, start, Mission resume", () => {
    const names = new Set(EVOK_TUI_MIRROR_COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]));
    expect(names.has("skills") || names.has("evok-skills")).toBe(true);
    expect(names.has("skill")).toBe(true);
    expect(names.has("research")).toBe(true);
    expect(names.has("missions")).toBe(true);
    expect(names.has("intake") || names.has("mission-intake")).toBe(true);
    expect(names.has("start")).toBe(true);
    expect(names.has("mission-resume")).toBe(true);
  });

  test("docs/UI conflict table states Pi /resume stays on Pi and Mission uses /mission-resume", () => {
    const table = formatTuiConflictTable();
    expect(table).toMatch(/\/resume/);
    expect(table).toMatch(/\/mission-resume/);
    expect(table).toMatch(/Pi owns/i);
    expect(EVOK_USAGE).toMatch(/\/mission-resume/);
    expect(EVOK_USAGE).toMatch(/Pi owns/i);
  });

  test("parseTuiMirrorInput leaves Pi shorts to Pi and maps Mission resume to the alias", () => {
    expect(parseTuiMirrorInput("/resume")).toEqual({ kind: "pi-owned", name: "resume" });
    expect(parseTuiMirrorInput("/model")).toEqual({ kind: "pi-owned", name: "model" });
    expect(parseTuiMirrorInput("/new")).toEqual({ kind: "pi-owned", name: "new" });
    expect(parseTuiMirrorInput("/mission-resume")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/evok-resume")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/skills")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/evok-skills")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/skill mission-intake")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/research continue")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/missions")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/intake draft a Mission")?.kind).toBe("mirror");
    expect(parseTuiMirrorInput("/start")?.kind).toBe("mirror");
  });
});

describe("TUI mirror extension registration", () => {
  test("registers evoK mirror names and never registers Pi shorts", () => {
    const registered: string[] = [];
    const factory = createEvokTuiMirrorExtension({ projectRoot: "/tmp/evok-tui-mirror" });
    factory({
      registerCommand(name: string) {
        registered.push(name);
      },
    });
    expect(registered).toContain("skills");
    expect(registered).toContain("evok-skills");
    expect(registered).toContain("skill");
    expect(registered).toContain("research");
    expect(registered).toContain("missions");
    expect(registered).toContain("intake");
    expect(registered).toContain("start");
    expect(registered).toContain("mission-resume");
    expect(registered).toContain("evok-resume");
    expect(registered).not.toContain("resume");
    expect(registered).not.toContain("model");
    expect(registered).not.toContain("new");
  });
});

describe("TUI mirror = CLI gates (no dilution)", () => {
  test("/skills in TUI is the same readable directory as CLI", async () => {
    const project = await tempProject();
    try {
      const cli = await runCli(parseEvokArgs(["/skills"]), { project });
      const tui = await executeTuiMirrorCommand({
        input: "/skills",
        projectRoot: project,
        createResolver: async () => { throw new Error("no model"); },
      });
      expect(tui.exitCode).toBe(0);
      expect(tui.exitCode).toBe(cli.code);
      expect(tui.stdout).toBe(cli.stdout);
      expect(tui.stdout).toMatch(/8 categor/);
      expect(tui.stdout).toMatch(/writeback not opened/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("/skill <name> discloses L1 from the existing catalog and refuses unknown names", async () => {
    const project = await tempProject();
    try {
      await mkdir(join(project, ".evok", "skills", "try-search"), { recursive: true });
      await writeFile(
        join(project, ".evok", "skills", "try-search", "SKILL.md"),
        "---\nname: try-search\ndescription: candidate search tip\nstate: candidate\ncategory: search\n---\nCANDIDATE-BODY\n",
      );
      const loaded = await executeTuiMirrorCommand({
        input: "/skill try-search",
        projectRoot: project,
        createResolver: async () => { throw new Error("no model"); },
      });
      expect(loaded.exitCode).toBe(0);
      expect(loaded.stdout).toContain("CANDIDATE-BODY");
      expect(loaded.stdout).toMatch(/l1-body|L1/);
      expect(loaded.stdout).toMatch(/not authorization|does not authorize/i);

      const missing = await executeTuiMirrorCommand({
        input: "/skill not-a-real-skill",
        projectRoot: project,
        createResolver: async () => { throw new Error("no model"); },
      });
      expect(missing.exitCode).toBe(EVOK_EXIT.usage);
      expect(missing.stderr).toMatch(/not in the evoK catalog/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("/evok-start is the documented evok-prefix alias and uses the same start gates as /start", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-nocontract"), { recursive: true });
    try {
      const startRunner = async () => { throw new Error("must not run"); };
      const viaStart = await executeTuiMirrorCommand({
        input: "/start --mission m-nocontract",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-evok-start-a"),
        startRunner,
      });
      const viaAlias = await executeTuiMirrorCommand({
        input: "/evok-start --mission m-nocontract",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-evok-start-b"),
        startRunner,
      });
      expect(viaAlias.exitCode).toBe(viaStart.exitCode);
      expect(viaAlias.stderr).toBe(viaStart.stderr);
      expect(viaAlias.exitCode).toBe(EVOK_EXIT.configError);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("missing evaluation refuses TUI /start with the same text and exit as CLI", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-nocontract"), { recursive: true });
    try {
      const startRunner = async () => { throw new Error("must not run"); };
      const cli = await runCli(
        { request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-nocontract" },
        { project, startRunner },
      );
      const tui = await executeTuiMirrorCommand({
        input: "/start --mission m-nocontract",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-start"),
        startRunner,
      });
      expect(cli.code).toBe(EVOK_EXIT.configError);
      expect(tui.exitCode).toBe(cli.code);
      expect(tui.stderr).toBe(cli.stderr);
      expect(tui.stderr).toMatch(/evaluation\.json|measured/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("unauthorized /research continue refuses TUI with the same text and exit as CLI", async () => {
    const project = await tempProject();
    const missionId = "m-evt138demo01";
    await mkdir(join(project, ".evok", "missions", missionId), { recursive: true });
    await writeFile(join(project, ".evok", "missions", missionId, "control-events.jsonl"), `${JSON.stringify({
      eventId: "evt-1", sequence: 1, type: "BASELINE_RECORDED", at: "2026-09-19T04:00:00.000Z",
      missionId, payload: { runId: `${missionId}:baseline:1`, ok: true, score: 0.2 },
    })}\n`);
    try {
      const cli = await runCli(
        parseEvokArgs(["/research", "continue", "--project", project, "--mission", missionId]),
        { project },
      );
      const tui = await executeTuiMirrorCommand({
        input: `/research continue --mission ${missionId}`,
        projectRoot: project,
        createResolver: async () => { throw new Error("no model"); },
      });
      expect(cli.code).not.toBe(0);
      expect(tui.exitCode).toBe(cli.code);
      expect(tui.stderr).toBe(cli.stderr);
      expect(tui.stderr).toMatch(/not authorized/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("over-budget /start refuses TUI with the same text and exit as CLI", async () => {
    const project = await tempProject();
    await mkdir(join(project, ".evok", "missions", "m-overbudget1"), { recursive: true });
    await writeFile(join(project, ".evok", "evaluation.json"), JSON.stringify({
      id: "toy", version: "1", artifact: "README.md",
    }));
    try {
      const startRunner = async () => {
        throw new BudgetExhaustedError("budget exhausted: refuse start");
      };
      const cli = await runCli(
        { request: "/start", project, tier: "default", timeoutMs: 600000, mission: "m-overbudget1" },
        { project, startRunner },
      );
      const tui = await executeTuiMirrorCommand({
        input: "/start --mission m-overbudget1",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-budget"),
        startRunner,
      });
      expect(cli.code).toBe(EVOK_EXIT.runtimeError);
      expect(tui.exitCode).toBe(cli.code);
      expect(tui.stderr).toBe(cli.stderr);
      expect(tui.stderr).toMatch(/budget exhausted/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("/intake without request text is the same usage refuse as CLI — not a draft and not TUI launch", async () => {
    const project = await tempProject();
    try {
      const intakeRunner = async () => { throw new Error("must not intake without request text"); };
      const cli = await runCli(
        { project, tier: "default", timeoutMs: 600000, intake: true },
        { project, intakeRunner },
      );
      const tui = await executeTuiMirrorCommand({
        input: "/intake",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-intake"),
        intakeRunner,
      });
      expect(cli.code).toBe(EVOK_EXIT.usage);
      expect(tui.exitCode).toBe(cli.code);
      expect(tui.stderr).toBe(cli.stderr);
      expect(tui.stderr).toMatch(/--intake requires request text|intake requires request text/);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("/resume stays Pi-owned and does not dispatch Mission resume", async () => {
    const project = await tempProject();
    try {
      let resumed = false;
      const tui = await executeTuiMirrorCommand({
        input: "/resume --mission m-abc123def456",
        projectRoot: project,
        createResolver: async () => fauxResolver("tui-mirror-pi-resume"),
        resumeRunner: async () => {
          resumed = true;
          throw new Error("must not resume");
        },
      });
      expect(resumed).toBe(false);
      expect(tui.exitCode).toBe(EVOK_EXIT.usage);
      expect(tui.stderr).toMatch(/\/mission-resume/);
      expect(tui.stderr).toMatch(/Pi/i);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
