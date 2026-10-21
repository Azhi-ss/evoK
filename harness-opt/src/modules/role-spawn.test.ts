import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRoleSpawn, buildRoleSpawn, launchRolePi, roleWrite } from "./role-spawn";

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
    const launched = launchRolePi(bin, config);
    expect(launched.status).toBe(0);
    expect(launched.argv).toEqual([bin, "--tools", "read"]);
    const text = readFileSync(recorded, "utf8");
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
    writeFileSync(bin, `#!/bin/sh\npwd > ${JSON.stringify(cwdFile)}\nprintf '%s' "$BASE_URL" > ${JSON.stringify(envFile)}\nif [ -n "$HARNESS_ATTEST_KEY_FILE$HARNESS_RELAY_LOG_ROOT$RELAY_UPSTREAM_KEY_FILE" ]; then printf 'leak' >> ${JSON.stringify(envFile)}; fi\n`);
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
      const launched = launchRolePi(bin, config);
      expect(launched.status).toBe(0);
      expect(readFileSync(cwdFile, "utf8").trim()).toBe(cwd);
      expect(readFileSync(envFile, "utf8")).toBe(baseUrl);
    } finally {
      if (previous.attest === undefined) delete process.env.HARNESS_ATTEST_KEY_FILE;
      else process.env.HARNESS_ATTEST_KEY_FILE = previous.attest;
      if (previous.root === undefined) delete process.env.HARNESS_RELAY_LOG_ROOT;
      else process.env.HARNESS_RELAY_LOG_ROOT = previous.root;
      if (previous.upstream === undefined) delete process.env.RELAY_UPSTREAM_KEY_FILE;
      else process.env.RELAY_UPSTREAM_KEY_FILE = previous.upstream;
    }
  });
});
