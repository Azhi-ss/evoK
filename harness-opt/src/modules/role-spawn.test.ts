import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRoleSpawn, buildRoleSpawn, roleWrite } from "./role-spawn";

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
  });
});
