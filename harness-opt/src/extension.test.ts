import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessOptExtension, resolveRoundWorkflow, ROUND_TOKEN_HARD } from "../extensions/harness-opt/index";
import { DEFAULT_DELEGATION_TIMEOUT_MS } from "./pi/delegate";
import { ATTRIBUTION_LABELS } from "./types";
import { HARNESSOPT_ROUND_SCRIPT } from "../workflows/round.js";
import { Lineage, Node } from "./lineage";
import { recordEvent } from "../bin/record";

describe("pi extension", () => {
  test("resolveRoundWorkflow authorises only the dev eval command", () => {
    expect(() => resolveRoundWorkflow({ cand: "../x" })).toThrow(/relative id/);
    expect(() => resolveRoundWorkflow({ cand: "/tmp/x" })).toThrow(/relative id/);
    const round = resolveRoundWorkflow({ cand: "abc" });
    expect(round.name).toBe("harnessopt.round");
    expect(round.script).toContain("gap-finder");
    expect(round.script).toContain("reviewer-gate");
    expect(round.script).toContain("agent-loop");
    for (const label of ATTRIBUTION_LABELS) expect(round.script).toContain(label);
    expect(round.hostCommands).toEqual([{ key: "eval", command: "bun bin/eval.ts --cand abc --split dev" }]);
    expect(round.usageBudget.tokens.hard).toBe(ROUND_TOKEN_HARD);
    expect(round).not.toHaveProperty("outputSchema");
    expect(HARNESSOPT_ROUND_SCRIPT).toBe(round.script);
  });

  test("session_start registers harnessopt.round and commands echo results", async () => {
    const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
    let tool: { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      events: { emit() {}, on() { return () => {}; } },
      registerCommand(name: string, spec: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, spec);
      },
      registerTool(spec: { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tool = spec;
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
        events.set(event, handler);
        return () => {};
      },
    };
    createHarnessOptExtension()(pi as never);
    expect([...commands.keys()]).toEqual([
      "harness-opt",
      "harnessopt-select",
      "harnessopt-record",
      "harnessopt-submit-gate",
    ]);
    expect(commands.get("harness-opt")?.description).toContain("--min-delta");
    expect(commands.get("harnessopt-select")?.description).toContain("--root");
    expect(tool?.name).toBe("harness-opt");
    const extensionSource = readFileSync(new URL("../extensions/harness-opt/index.ts", import.meta.url), "utf8");
    expect(extensionSource).toContain("timeoutMs: DEFAULT_DELEGATION_TIMEOUT_MS");
    expect(DEFAULT_DELEGATION_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    const sessionId = "session-test";
    await events.get("session_start")?.({}, {
      sessionManager: { getSessionId: () => sessionId },
      cwd: "/tmp",
      ui: { notify() {}, setWidget() {}, setStatus() {} },
    });
    const workflowUrl = new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url);
    const workflow = await import(workflowUrl.href) as {
      resolveWorkflowResource: (
        name: string,
        args: unknown,
        sessionId: string,
      ) => { ok: true; resource: { script: string; permit: unknown } } | { ok: false; error?: string };
    };
    const resolved = workflow.resolveWorkflowResource("harnessopt.round", { cand: "abc" }, sessionId);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.resource.script).toContain("gap-finder");
      expect(resolved.resource.permit).toBeDefined();
    }
    const bad = workflow.resolveWorkflowResource("harnessopt.round", { cand: "../x" }, sessionId);
    expect(bad.ok).toBe(false);

    const notices: string[] = [];
    const ui = {
      notify(message: string) { notices.push(message); },
      setWidget() {},
      setStatus() {},
    };
    const lineageDir = mkdtempSync(join(tmpdir(), "harness-opt-select-"));
    const lineage = new Lineage(lineageDir);
    lineage.put(new Node({
      id: "base",
      parentId: null,
      configPath: "candidates/base/config.json",
      status: "evaluated",
      devScores: [0.4],
      stage: "full",
    }));
    await commands.get("harnessopt-select")?.handler(`--root ${lineageDir}`, { ui, cwd: "/tmp" });
    expect(notices.at(-1)).toContain("base");
    await commands.get("harnessopt-select")?.handler("", { ui, cwd: "/tmp" });
    expect(notices.at(-1)).toContain("missing: --root");
    await commands.get("harnessopt-record")?.handler(`--root ${lineageDir} --kind note`, { ui, cwd: "/tmp" });
    expect(notices.at(-1)).toContain("recorded note");
    await commands.get("harnessopt-record")?.handler(
      `--root ${lineageDir} --kind note --json {"message": "has space"}`,
      { ui, cwd: "/tmp" },
    );
    expect(notices.at(-1)).toContain("recorded note");
    expect(new Lineage(lineageDir).events().some((event) => event.message === "has space")).toBe(true);
    await commands.get("harnessopt-record")?.handler(`--root ${lineageDir} --kind note --json {`, { ui, cwd: "/tmp" });
    expect(notices.at(-1)).toContain("not valid JSON");
    recordEvent(lineageDir, "seen", {});
    expect(new Lineage(lineageDir).events().some((event) => event.kind === "note")).toBe(true);

    const toolResult = await tool?.execute("call-1", { command: "status" }, undefined, undefined, {
      cwd: mkdtempSync(join(tmpdir(), "harness-opt-tool-")),
      ui,
    }) as { isError?: boolean; content: { text: string }[] };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain("no session");
    await events.get("session_shutdown")?.({}, {});
  });
});
