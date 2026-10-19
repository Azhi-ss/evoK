import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleGuardExtension } from "../extensions/harness-opt/role-guard";
import { writeRoleJson } from "./artifacts";
import { Lineage } from "./lineage";
import { FILE_IO_TOOLS, FRAMEWORK_TOOLS, guardSubagentToolCall } from "./role-guard";

function prompt(role: string): string {
  return `<active_agent name="${role}"/>\n只读合约内的文件。`;
}

function runRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-guard-"));
}

function contractEvents(root: string): readonly Record<string, unknown>[] {
  return new Lineage(join(root, "state")).events().filter((event) => event.kind === "contract");
}

describe("subagent role guard", () => {
  test("an out-of-contract write is blocked and recorded", () => {
    const root = runRoot();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "tests/secret.ts", content: "leak" },
    })).toThrow(/forbidden path/);
    const events = contractEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ role: "innovator", tool: "write", path: "tests/secret.ts" });
    expect(JSON.stringify(events[0])).not.toContain("leak");

    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "write",
      input: { path: "gaps.json", content: "{}" },
    })).toThrow(/cannot use tool write/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "gaps.json", content: "{}" },
    })).toThrow(/cannot write gaps\.json/);
    expect(contractEvents(root)).toHaveLength(3);

    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "edit",
      input: { path: "candidates/c1/config.json" },
    })).toThrow(/cannot use tool edit/);
  });

  test("reads of solution, private, tests, and other out-of-contract paths are blocked", () => {
    const root = runRoot();
    for (const path of ["solution", "solution.md", "private/key.txt", "tests/hidden.ts", "src/private.json"]) {
      expect(() => guardSubagentToolCall({
        root,
        prompt: prompt("innovator"),
        tool: "read",
        input: { path },
      })).toThrow(/forbidden path/);
    }
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "candidates/c1/config.json" },
    })).toThrow(/cannot read/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "bash",
      input: { command: "cat tests/hidden.ts" },
    })).toThrow(/forbidden path/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "read",
      input: { path: join(root, "..", "outside.txt") },
    })).toThrow(/escapes the run root/);
    const events = contractEvents(root);
    expect(events.length).toBeGreaterThanOrEqual(7);
    expect(events.some((event) => event.path === "solution")).toBe(true);
    expect(events.some((event) => event.path === "private/key.txt")).toBe(true);
    expect(events.some((event) => event.tool === "bash" && String(event.path).includes("tests/hidden.ts"))).toBe(true);
  });

  test("a contract read and a contract write pass and leave no contract event", () => {
    const root = runRoot();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/t1.json" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "candidates/c1/config.json", content: "{}" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: join(root, "patch.json"), content: "{}" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "read",
      input: { path: "gaps.json" },
    })).not.toThrow();
    expect(contractEvents(root)).toHaveLength(0);
    expect(() => guardSubagentToolCall({
      root,
      prompt: "no active agent",
      tool: "read",
      input: { path: "traces/t1.json" },
    })).toThrow(/role is missing/);
    expect(contractEvents(root)).toHaveLength(1);
  });

  test("list and grep of a contract directory are allowed", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    mkdirSync(join(root, "candidates", "c1"), { recursive: true });
    mkdirSync(join(root, "state", "nodes"), { recursive: true });
    writeFileSync(join(root, "traces", "t1.json"), "{}\n");
    for (const tool of ["ls", "grep", "find", "read"]) {
      for (const path of ["traces", "traces/", "traces/t1.json"]) {
        expect(() => guardSubagentToolCall({
          root,
          prompt: prompt("gap-finder"),
          tool,
          input: { path },
        })).not.toThrow();
      }
    }
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "ls",
      input: { path: "candidates" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "grep",
      input: { path: "state/nodes" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("reviewer-gate"),
      tool: "find",
      input: { path: "candidates/" },
    })).not.toThrow();
    expect(contractEvents(root)).toHaveLength(0);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "ls",
      input: { path: "traces-other" },
    })).toThrow(/cannot read/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "grep",
      input: { path: "." },
    })).toThrow(/cannot read/);
  });

  test("symlinks to /etc, sealed, and outside the run root are blocked", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    mkdirSync(join(root, "sealed"), { recursive: true });
    mkdirSync(join(root, "candidates"), { recursive: true });
    writeFileSync(join(root, "traces", "t1.json"), "{}\n");
    writeFileSync(join(root, "sealed", "heldout-score.json"), "{\"score\":0.1}\n");
    symlinkSync("/etc/passwd", join(root, "traces", "host"));
    symlinkSync("../sealed/heldout-score.json", join(root, "traces", "via-sealed"));
    symlinkSync("/etc", join(root, "traces", "hop"));
    symlinkSync("t1.json", join(root, "traces", "alias"));
    const outside = mkdtempSync(join(tmpdir(), "harness-opt-out-"));
    symlinkSync(outside, join(root, "candidates", "escape"));

    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/alias" },
    })).not.toThrow();

    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/host" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "ls",
      input: { path: "traces/hop/passwd" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/via-sealed" },
    })).toThrow(/held-out/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "candidates/escape/pwned.txt", content: "x" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "bash",
      input: { command: "cat traces/host" },
    })).toThrow(/escapes the run root/);

    const events = contractEvents(root);
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.tool)).toEqual(["read", "ls", "read", "write", "bash"]);
    expect(events.every((event) => event.kind === "contract" && typeof event.err === "string")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("\"score\":0.1");
  });

  test("a chained symlink read of /etc or sealed is blocked", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    mkdirSync(join(root, "sealed"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "sealed", "heldout-score.json"), "{\"score\":0.1}\n");
    writeFileSync(join(root, "tests", "secret.ts"), "secret\n");
    symlinkSync("/etc/hostname", join(root, "traces", "host2"));
    symlinkSync("host2", join(root, "traces", "host1"));
    symlinkSync("/etc", join(root, "traces", "etc2"));
    symlinkSync("etc2/hostname", join(root, "traces", "etc1"));
    symlinkSync(join(root, "sealed"), join(root, "traces", "seal2"));
    symlinkSync("seal2/heldout-score.json", join(root, "traces", "seal1"));
    symlinkSync(join(root, "tests"), join(root, "traces", "deny2"));
    symlinkSync("deny2/secret.ts", join(root, "traces", "deny1"));

    for (const path of ["traces/host1", "traces/etc1"]) {
      expect(() => guardSubagentToolCall({
        root,
        prompt: prompt("gap-finder"),
        tool: "read",
        input: { path },
      })).toThrow(/escapes the run root/);
    }
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/seal1" },
    })).toThrow(/held-out/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/deny1" },
    })).toThrow(/forbidden path/);
    const events = contractEvents(root);
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.kind === "contract" && event.tool === "read")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("\"score\":0.1");
  });

  test("a chained symlink write outside the run root is blocked", () => {
    const root = runRoot();
    const outside = mkdtempSync(join(tmpdir(), "harness-opt-out-"));
    mkdirSync(join(root, "candidates"), { recursive: true });
    symlinkSync(join(outside, "pwned.json"), join(root, "candidates", "file2"));
    symlinkSync("file2", join(root, "candidates", "file1"));
    symlinkSync(outside, join(root, "candidates", "dir2"));
    symlinkSync("dir2/pwned.json", join(root, "candidates", "dir1"));

    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "candidates/file1", content: "{\"summary\":\"must-not-land\"}" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "candidates/dir1", content: "{\"summary\":\"must-not-land\"}" },
    })).toThrow(/escapes the run root/);
    expect(() => writeRoleJson(root, "innovator", "candidates/dir1", { summary: "must-not-land" })).toThrow(/escapes the run root/);
    expect(existsSync(join(outside, "pwned.json"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    const events = contractEvents(root);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.kind === "contract" && event.tool === "write")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("must-not-land");
  });

  test("framework tools pass and filesystem tools stay on the contract", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    for (const role of ["gap-finder", "innovator", "reviewer-gate"]) {
      for (const tool of FRAMEWORK_TOOLS) {
        expect(() => guardSubagentToolCall({
          root,
          prompt: prompt(role),
          tool,
          input: { value: { accept: true, reason: "kept" }, path: "should-not-matter" },
        })).not.toThrow();
      }
      expect(() => guardSubagentToolCall({
        root,
        prompt: prompt(role),
        tool: "structured_output",
        input: { value: { gaps: [] } },
      })).not.toThrow();
    }
    expect(contractEvents(root)).toHaveLength(0);
    expect(FILE_IO_TOOLS).toContain("read");
    expect(FILE_IO_TOOLS).toContain("write");
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "tests/hidden.ts" },
    })).toThrow(/forbidden path/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "ls",
      input: { path: "traces" },
    })).not.toThrow();
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "custom_reader",
      input: { path: "solution/secret.ts" },
    })).toThrow(/forbidden path/);
    expect(contractEvents(root).every((event) => event.tool !== "structured_output")).toBe(true);
  });

  test("innovator cannot write the baseline through the subagent guard", () => {
    const root = runRoot();
    mkdirSync(join(root, "candidates", "base"), { recursive: true });
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "write",
      input: { path: "candidates/base/config.json", content: "{\"id\":\"pwn\"}" },
    })).toThrow(/baseline/);
    expect(contractEvents(root)).toHaveLength(1);
  });

  test("a second path argument cannot point outside the contract", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    writeFileSync(join(root, "traces", "t1.json"), "{}\n");
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/t1.json", file_path: "/etc/hostname" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "grep",
      input: { path: "traces", paths: ["/etc/hostname"] },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { file_path: "tests/hidden.ts" },
    })).toThrow(/forbidden path/);
    const events = contractEvents(root);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.kind === "contract")).toBe(true);
    expect(JSON.stringify(events)).toContain("/etc/hostname");
    expect(JSON.stringify(events)).toContain("tests/hidden.ts");
  });

  test("an argument key outside the list is refused and framework tools stay allowed", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    writeFileSync(join(root, "traces", "t1.json"), "{}\n");
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/t1.json", note: "side channel" },
    })).toThrow(/argument note is not allowed/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "clock",
      input: { now: 1 },
    })).toThrow(/argument now is not allowed/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "contact_supervisor",
      input: { message: "blocked", extra: "kept", location: "/etc/hostname" },
    })).not.toThrow();
    const events = contractEvents(root);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.kind === "contract")).toBe(true);
    expect(events.some((event) => event.tool === "contact_supervisor")).toBe(false);
    expect(existsSync(join(root, "traces", "t1.json"))).toBe(true);
  });

  test("location is contained and contact_supervisor stays on the whitelist", () => {
    const root = runRoot();
    mkdirSync(join(root, "traces"), { recursive: true });
    writeFileSync(join(root, "traces", "t1.json"), "{}\n");
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "read",
      input: { path: "traces/t1.json", location: "/etc/hostname" },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("gap-finder"),
      tool: "custom_reader",
      input: { locations: ["/etc/hostname"] },
    })).toThrow(/escapes the run root/);
    expect(() => guardSubagentToolCall({
      root,
      prompt: prompt("innovator"),
      tool: "contact_supervisor",
      input: { location: "/etc/hostname", message: "blocked on the skill file" },
    })).not.toThrow();
    const events = contractEvents(root);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.kind === "contract")).toBe(true);
    expect(events.some((event) => event.tool === "contact_supervisor")).toBe(false);
    expect(JSON.stringify(events)).toContain("/etc/hostname");
  });

  test("the child tool_call hook blocks the built-in write and read", () => {
    const handlers = new Map<string, (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string; getSystemPrompt: () => string }) => { block?: boolean; reason?: string } | undefined>();
    roleGuardExtension({
      on(event: string, handler: (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string; getSystemPrompt: () => string }) => { block?: boolean; reason?: string } | undefined) {
        handlers.set(event, handler);
      },
    } as never);
    const root = runRoot();
    const ctx = { cwd: root, getSystemPrompt: () => prompt("innovator") };
    const write = handlers.get("tool_call")?.(
      { toolName: "write", input: { path: "tests/secret.ts", content: "nope" } },
      ctx,
    );
    expect(write?.block).toBe(true);
    expect(write?.reason).toContain("tests/secret.ts");
    const read = handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "private/key.txt" } },
      ctx,
    );
    expect(read?.block).toBe(true);
    expect(read?.reason).toContain("private/key.txt");
    const allowed = handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "gaps.json" } },
      ctx,
    );
    expect(allowed).toBeUndefined();
    expect(contractEvents(root)).toHaveLength(2);
  });
});
