import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_AGENT_DIR } from "../pi/agent-dirs";
import {
  assertRoleSpawn,
  buildRoleSpawn,
  DOCUMENTED_MODEL_MAX_TOKENS,
  launchRolePi,
  outputHitLengthLimit,
  PI_OUTPUT_LIMIT_STDERR,
  ROLE_OUTPUT_CAPS,
  roleAgentPath,
  roleArgvRecord,
  roleOutputCap,
  rolePiArgv,
  roleWrite,
} from "./role-spawn";

describe("role spawn", () => {
  test("gap and reviewer stay read-only, and the session stays outside the cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "role-spawn-"));
    const cwd = join(root, "cwd");
    const sessions = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const trace = join(root, "trace.jsonl");
    const config = buildRoleSpawn({
      role: "gap-finder",
      cwd,
      allowedPaths: [trace],
      sessionPath: join(sessions, "gap-finder.jsonl"),
      ledgerPath: join(sessions, "ledger.json"),
    });
    expect(config.tools).toEqual(["read"]);
    expect(() => assertRoleSpawn(config)).not.toThrow();
    expect(() => assertRoleSpawn({ ...config, tools: ["read", "bash"] })).toThrow(/bash/);
    expect(() => assertRoleSpawn({ ...config, tools: ["read", "write"] })).toThrow(/write/);
    expect(() => assertRoleSpawn({ ...config, tools: ["read", "edit"] })).toThrow(/edit/);
    expect(() => assertRoleSpawn({ ...config, sessionPath: join(cwd, "session.jsonl") })).toThrow(/cwd/);
    expect(() => assertRoleSpawn({ ...config, allowedPaths: [sessions] })).toThrow(/allowed path/);
    expect(roleWrite(config, config.sessionPath, "forged\n")).toBe(false);
    expect(existsSync(config.sessionPath)).toBe(false);
    const reviewer = buildRoleSpawn({
      role: "reviewer-gate",
      cwd: join(root, "reviewer"),
      allowedPaths: [trace],
      sessionPath: join(sessions, "reviewer-gate.jsonl"),
      ledgerPath: join(sessions, "ledger.json"),
    });
    expect(reviewer.tools).toEqual(["read"]);
    expect(roleWrite(reviewer, reviewer.sessionPath, "forged\n")).toBe(false);
    for (const role of ["critic", "ranker"] as const) {
      const spawned = buildRoleSpawn({
        role,
        cwd: join(root, role),
        allowedPaths: [trace],
        sessionPath: join(sessions, `${role}.jsonl`),
        ledgerPath: join(sessions, "ledger.json"),
      });
      expect(spawned.tools).toEqual(["read"]);
    }
  });

  test("a real pi launch receives --tools read and no role run id", () => {
    const root = mkdtempSync(join(tmpdir(), "role-argv-"));
    const cwd = join(root, "cwd");
    const sessions = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const recorded = join(root, "argv.txt");
    const bin = join(root, "pi");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(recorded)}\n`);
    chmodSync(bin, 0o755);
    const config = buildRoleSpawn({
      role: "gap-finder",
      cwd,
      allowedPaths: [join(root, "trace.jsonl")],
      sessionPath: join(sessions, "gap-finder.jsonl"),
      ledgerPath: join(sessions, "ledger.json"),
    });
    const roleRunId = "ab".repeat(16);
    const prompt = "name the shared failure";
    const launched = launchRolePi(bin, config, prompt);
    expect(launched.status).toBe(0);
    expect(launched.argv).toEqual([
      bin,
      "--print",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--tools",
      "read",
      "--model",
      "ai-modeling/deepseek-v4-1-flash-261017",
      "--system-prompt",
      roleAgentPath("gap-finder"),
      prompt,
    ]);
    expect(roleAgentPath("gap-finder")).toBe(join(PACKAGE_AGENT_DIR, "gap-finder.md"));
    const text = readFileSync(recorded, "utf8");
    expect(text).toContain("--print");
    expect(text).toContain("--tools");
    expect(text).toContain("read");
    expect(text).not.toContain("write");
    expect(text).not.toContain("bash");
    expect(text).not.toContain(roleRunId);
  });

  test("an innovator launch uses its cwd and the relay BASE_URL, and cannot write the relay log", () => {
    const root = mkdtempSync(join(tmpdir(), "role-relay-"));
    const cwd = join(root, "cwd");
    const sessions = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const cwdFile = join(root, "cwd.txt");
    const envFile = join(root, "env.txt");
    const bin = join(root, "pi");
    const keyFile = join(root, "api.txt");
    writeFileSync(bin, `#!/bin/sh\npwd > ${JSON.stringify(cwdFile)}\nprintf '%s' "$BASE_URL" > ${JSON.stringify(envFile)}\nprintf '%s' "$API_KEY" > ${JSON.stringify(keyFile)}\nif [ -n "$HARNESS_ATTEST_KEY_FILE$HARNESS_RELAY_LOG_ROOT$RELAY_UPSTREAM_KEY_FILE" ]; then printf 'leak' >> ${JSON.stringify(envFile)}; fi\n`);
    chmodSync(bin, 0o755);
    const relayLog = join(root, "private", "ab".repeat(16), "relay.jsonl");
    const baseUrl = `http://10.204.0.1:8642/r/${"ab".repeat(16)}/v1`;
    const config = buildRoleSpawn({
      role: "innovator",
      cwd,
      allowedPaths: [],
      sessionPath: join(sessions, "innovator.jsonl"),
      ledgerPath: join(sessions, "ledger.json"),
      relayLog,
      baseUrl,
    });
    expect(() => buildRoleSpawn({
      role: "innovator",
      cwd,
      allowedPaths: [],
      sessionPath: join(sessions, "innovator.jsonl"),
      ledgerPath: join(sessions, "ledger.json"),
      relayLog: join(cwd, "relay.jsonl"),
    })).toThrow(/relay log/);
    expect(roleWrite(config, relayLog, "forged\n")).toBe(false);
    expect(existsSync(relayLog)).toBe(false);
    const previous = {
      attest: process.env.HARNESS_ATTEST_KEY_FILE,
      root: process.env.HARNESS_RELAY_LOG_ROOT,
      upstream: process.env.RELAY_UPSTREAM_KEY_FILE,
    };
    process.env.HARNESS_ATTEST_KEY_FILE = join(root, "attest.key");
    process.env.HARNESS_RELAY_LOG_ROOT = join(root, "private");
    process.env.RELAY_UPSTREAM_KEY_FILE = join(root, "upstream.key");
    try {
      const launched = launchRolePi(bin, config, "draft one patch");
      expect(launched.status).toBe(0);
      expect(launched.argv[launched.argv.indexOf("--tools") + 1]).toBe("read,write");
      expect(readFileSync(cwdFile, "utf8").trim()).toBe(cwd);
      expect(readFileSync(envFile, "utf8")).toBe(baseUrl);
      expect(readFileSync(keyFile, "utf8")).toBe("relay-placeholder-not-a-key");
      const models = JSON.parse(readFileSync(join(sessions, "innovator-pi-agent", "models.json"), "utf8")) as {
        providers: { "ai-modeling": { baseUrl: string; models: { maxTokens: number }[] } };
      };
      expect(models.providers["ai-modeling"].baseUrl).toBe(baseUrl);
      expect(models.providers["ai-modeling"].models[0]?.maxTokens).toBe(16_384);
      expect(join(sessions, "innovator-pi-agent").startsWith(cwd)).toBe(false);
    } finally {
      if (previous.attest === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previous.attest;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
      if (previous.upstream === undefined) delete process.env.RELAY_UPSTREAM_KEY_FILE;
      else process.env.RELAY_UPSTREAM_KEY_FILE = previous.upstream;
    }
  });

  test("each role's output cap defaults, clamps to the documented max, and is recorded", () => {
    expect(DOCUMENTED_MODEL_MAX_TOKENS).toBe(384_000);
    expect(roleOutputCap("ranker")).toBe(32_768);
    expect(roleOutputCap("critic")).toBe(32_768);
    expect(roleOutputCap("reviewer-gate")).toBe(32_768);
    expect(roleOutputCap("gap-finder")).toBe(16_384);
    expect(roleOutputCap("innovator")).toBe(16_384);
    expect(roleOutputCap("ranker", 1_000)).toBe(1_000);
    expect(roleOutputCap("ranker", 400_000)).toBe(384_000);
    expect(roleOutputCap("ranker", 32_768, 4_096)).toBe(4_096);
    expect(ROLE_OUTPUT_CAPS.ranker).toBe(32_768);
    const root = mkdtempSync(join(tmpdir(), "role-cap-"));
    const cwd = join(root, "cwd");
    const sessions = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const bin = join(root, "pi");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    const baseUrl = `http://10.204.0.1:8642/r/${"cd".repeat(16)}/v1`;
    for (const role of ["gap-finder", "innovator", "critic", "ranker", "reviewer-gate"] as const) {
      const config = buildRoleSpawn({
        role,
        cwd: join(root, role),
        allowedPaths: [],
        sessionPath: join(sessions, `${role}.jsonl`),
        ledgerPath: join(sessions, "ledger.json"),
        baseUrl,
        ...(role === "ranker" ? { maxTokens: 400_000 } : {}),
        ...(role === "critic" ? { documentedMaxTokens: 4_096 } : {}),
      });
      mkdirSync(config.cwd, { recursive: true });
      const launched = launchRolePi(bin, config, "answer");
      expect(launched.status).toBe(0);
      expect(launched.argv).not.toContain("--max-tokens");
      const recorded = roleArgvRecord(config, rolePiArgv(bin, config, "answer"));
      expect(recorded.argv).toEqual(launched.argv);
      const models = JSON.parse(readFileSync(join(sessions, `${role}-pi-agent`, "models.json"), "utf8")) as {
        providers: { "ai-modeling": { models: { maxTokens: number }[] } };
      };
      const cap = models.providers["ai-modeling"].models[0]?.maxTokens;
      expect(recorded.maxTokens).toBe(cap);
      expect(config.maxTokens).toBe(cap);
      if (role === "ranker") expect(cap).toBe(384_000);
      else if (role === "critic") expect(cap).toBe(4_096);
      else expect(cap).toBe(ROLE_OUTPUT_CAPS[role]);
    }
  });

  test("a non-zero empty length-limit exit is role_output_truncated", () => {
    const notice = PI_OUTPUT_LIMIT_STDERR;
    expect(outputHitLengthLimit(1, "", notice, null)).toBe(true);
    expect(outputHitLengthLimit(1, "   ", `${notice}\n`, "")).toBe(true);
    expect(outputHitLengthLimit(1, "partial answer\n", notice, null)).toBe(false);
    expect(outputHitLengthLimit(1, "", notice, "{\"winnerId\":\"c0\"}")).toBe(false);
    expect(outputHitLengthLimit(1, "", "boom", null)).toBe(false);
    expect(outputHitLengthLimit(0, "", notice, null)).toBe(false);
    expect(outputHitLengthLimit(null, "", notice, null)).toBe(false);
  });
});
