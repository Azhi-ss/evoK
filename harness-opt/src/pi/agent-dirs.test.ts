import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createHarnessOptExtension } from "../../extensions/harness-opt/index";
import { runClosedLoopDemo } from "../session";
import { EXTRA_AGENT_DIRS_ENV, PACKAGE_AGENT_DIR, pinPackageAgentDir, splitExtraAgentDirs } from "./agent-dirs";

const ROLES = ["gap-finder", "innovator", "reviewer-gate"] as const;

interface DiscoveredAgent {
  readonly name: string;
  readonly filePath?: string;
  readonly defaultContext?: string;
  readonly acceptanceRole?: string;
  readonly subagentOnlyExtensions?: readonly string[];
}

interface DiscoveryResult {
  readonly cwd: string;
  readonly agents: readonly DiscoveredAgent[];
  readonly directories: readonly { readonly source: string; readonly path: string; readonly state: string; readonly candidateCount?: number }[];
}

interface DiscoveryApi {
  discoverAgents(
    cwd: string,
    scope: "both",
    preferredModelProvider?: string,
    options?: { readonly globalNpmRoot?: string | null },
  ): DiscoveryResult;
  clearAgentDiscoveryCache(): void;
  resolveAgentName(name: string, agents: readonly DiscoveredAgent[]): { readonly agent?: DiscoveredAgent };
}

const savedEnv = {
  extra: process.env[EXTRA_AGENT_DIRS_ENV],
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  agentDir: process.env.PI_CODING_AGENT_DIR,
};

afterEach(() => {
  restoreEnv("HOME", savedEnv.home);
  restoreEnv("USERPROFILE", savedEnv.profile);
  restoreEnv("PI_CODING_AGENT_DIR", savedEnv.agentDir);
  restoreEnv(EXTRA_AGENT_DIRS_ENV, savedEnv.extra);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function outsideOutDir(): string {
  const out = mkdtempSync(join(tmpdir(), "harness-opt-out-"));
  const packageRoot = resolve(PACKAGE_AGENT_DIR, "..");
  expect(resolve(out).startsWith(`${packageRoot}/`)).toBe(false);
  return out;
}

function isolateUserAgentDirs(): void {
  const home = mkdtempSync(join(tmpdir(), "harness-opt-home-"));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  delete process.env.USERPROFILE;
  delete process.env[EXTRA_AGENT_DIRS_ENV];
}

async function discoveryApi(): Promise<DiscoveryApi> {
  const agentsUrl = new URL("../../node_modules/pi-subagents/src/agents/agents.js", import.meta.url);
  return await import(agentsUrl.href) as DiscoveryApi;
}

describe("package agent discovery", () => {
  test("pin appends the package agents directory and does not duplicate it", () => {
    process.env[EXTRA_AGENT_DIRS_ENV] = `  /tmp/keep  ${delimiter}${PACKAGE_AGENT_DIR}${delimiter}`;
    expect(pinPackageAgentDir()).toBe(PACKAGE_AGENT_DIR);
    expect(process.env[EXTRA_AGENT_DIRS_ENV]).toBe(`  /tmp/keep  ${delimiter}${PACKAGE_AGENT_DIR}${delimiter}`);

    delete process.env[EXTRA_AGENT_DIRS_ENV];
    pinPackageAgentDir();
    expect(splitExtraAgentDirs(process.env[EXTRA_AGENT_DIRS_ENV])).toEqual([PACKAGE_AGENT_DIR]);
    process.env[EXTRA_AGENT_DIRS_ENV] = `/tmp/other${delimiter}/tmp/also`;
    pinPackageAgentDir();
    pinPackageAgentDir();
    expect(splitExtraAgentDirs(process.env[EXTRA_AGENT_DIRS_ENV])).toEqual([
      "/tmp/other",
      "/tmp/also",
      PACKAGE_AGENT_DIR,
    ]);
  });

  test("an out dir outside the package still discovers gap-finder, innovator, and reviewer-gate", async () => {
    isolateUserAgentDirs();
    const out = outsideOutDir();
    const api = await discoveryApi();
    api.clearAgentDiscoveryCache();
    const before = api.discoverAgents(out, "both", undefined, { globalNpmRoot: null });
    expect(before.cwd).toBe(resolve(out));
    expect(before.directories.some((dir) => dir.path === PACKAGE_AGENT_DIR)).toBe(false);
    expect(api.resolveAgentName("gap-finder", before.agents).agent).toBeUndefined();

    pinPackageAgentDir();
    api.clearAgentDiscoveryCache();
    const after = api.discoverAgents(out, "both", undefined, { globalNpmRoot: null });
    expect(after.cwd).toBe(resolve(out));
    expect(after.directories).toContainEqual({
      source: "user",
      path: PACKAGE_AGENT_DIR,
      state: "candidates",
      candidateCount: 3,
    });
    const guard = resolve(PACKAGE_AGENT_DIR, "../extensions/harness-opt/role-guard.ts");
    for (const name of ROLES) {
      const agent = api.resolveAgentName(name, after.agents).agent;
      expect(agent?.filePath).toBe(join(PACKAGE_AGENT_DIR, `${name}.md`));
      expect(agent?.defaultContext).toBe("fresh");
      expect(agent?.subagentOnlyExtensions).toEqual([guard]);
    }
    expect(api.resolveAgentName("reviewer-gate", after.agents).agent?.acceptanceRole).toBe("read-only");
    expect(api.resolveAgentName("reviewer", after.agents).agent?.filePath).not.toBe(join(PACKAGE_AGENT_DIR, "reviewer-gate.md"));
  });

  test("loading the extension pins the package agents directory", () => {
    delete process.env[EXTRA_AGENT_DIRS_ENV];
    const pi = {
      events: { emit() {}, on() { return () => {}; } },
      registerCommand() {},
      registerTool() {},
      on() { return () => {}; },
    };
    createHarnessOptExtension()(pi as never);
    expect(splitExtraAgentDirs(process.env[EXTRA_AGENT_DIRS_ENV])).toEqual([PACKAGE_AGENT_DIR]);
  });

  test("step pins discovery when --out is outside the package and no extra dir was exported", async () => {
    delete process.env[EXTRA_AGENT_DIRS_ENV];
    const out = outsideOutDir();
    await runClosedLoopDemo(out);
    expect(splitExtraAgentDirs(process.env[EXTRA_AGENT_DIRS_ENV])).toContain(PACKAGE_AGENT_DIR);
  });
});
