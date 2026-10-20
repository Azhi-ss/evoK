import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntercomBridgeToAgent,
  resolveIntercomBridge,
} from "../node_modules/pi-subagents/src/intercom/intercom-bridge.js";
import { roleGuardExtension } from "../extensions/harness-opt/role-guard";
import { isReviewerGatePrompt, reviewerGateSystemPrompt } from "./reviewer-prompt";

type BridgeAgent = Parameters<typeof applyIntercomBridgeToAgent>[0];

const agentFile = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "reviewer-gate.md");

function agentConfig(systemPrompt: string): BridgeAgent {
  return {
    name: "reviewer-gate",
    description: "read only",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritGlobalContext: false,
    inheritSkills: false,
    systemPrompt,
    source: "file",
    filePath: "agents/reviewer-gate.md",
    tools: ["read", "grep", "find", "ls"],
  } as unknown as BridgeAgent;
}

describe("reviewer-gate prompt", () => {
  test("the shipped prompt does not contain contact_supervisor", () => {
    const markdown = readFileSync(agentFile, "utf8");
    expect(markdown).not.toContain("contact_supervisor");
    expect(markdown).not.toContain("Use contact_supervisor first");
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(isReviewerGatePrompt(body)).toBe(true);
    expect(reviewerGateSystemPrompt(body)).not.toContain("contact_supervisor");
  });

  test("an active pi-subagents bridge would expose contact_supervisor and the off mode does not", () => {
    const body = readFileSync(agentFile, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const active = resolveIntercomBridge({
      config: undefined,
      context: "fresh",
      orchestratorTarget: "parent-session",
    });
    expect(active.active).toBe(true);
    expect(active.instruction).toContain("Use contact_supervisor first");
    const exposed = applyIntercomBridgeToAgent(agentConfig(body), active);
    expect(exposed.systemPrompt).toContain("contact_supervisor");
    expect(exposed.tools).toContain("contact_supervisor");

    const off = resolveIntercomBridge({
      config: undefined,
      override: { mode: "off" },
      context: "fresh",
      orchestratorTarget: "parent-session",
    });
    expect(off.active).toBe(false);
    const kept = reviewerGateSystemPrompt(exposed.systemPrompt ?? "");
    expect(kept).not.toContain("contact_supervisor");
    expect(kept).not.toContain("Use contact_supervisor first");
    expect(kept).toContain("名字是 `reviewer-gate`");
  });

  test("before_agent_start strips the injected bridge sentence", () => {
    const handlers = new Map<string, (event: unknown, ctx: { getSystemPrompt: () => string }) => { systemPrompt?: string } | undefined>();
    roleGuardExtension({
      on(event: string, handler: (event: unknown, ctx: { getSystemPrompt: () => string }) => { systemPrompt?: string } | undefined) {
        handlers.set(event, handler);
      },
    } as never);
    const body = readFileSync(agentFile, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const active = resolveIntercomBridge({
      config: undefined,
      context: "fresh",
      orchestratorTarget: "parent-session",
    });
    const exposed = applyIntercomBridgeToAgent(agentConfig(body), active).systemPrompt ?? "";
    const result = handlers.get("before_agent_start")?.({}, { getSystemPrompt: () => exposed });
    expect(result?.systemPrompt).toBeDefined();
    expect(result?.systemPrompt).not.toContain("contact_supervisor");
  });
});
