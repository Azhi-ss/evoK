import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleGuardExtension } from "../extensions/harness-opt/role-guard";
import { Lineage } from "./lineage";
import { guardSubagentToolCall } from "./role-guard";

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
