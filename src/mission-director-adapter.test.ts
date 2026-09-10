/**
 * Unit tests for the Pi-backed Mission Director adapter (#113): one fresh
 * read-only decision Run, the trusted observation projection reaching the
 * model prompt, strict JSON parsing, and controller re-validation.
 *
 * The end-to-end controlled-model seam (real candidate Runs + different
 * observations => different dispatched work) lives in
 * tests/integration/mission-continue.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgentRuntime, type AgentRuntimeSession } from "./pi-agent-runtime";
import {
  DirectorProposalRejectedError,
  createPiMissionDirector,
  type DirectorInput,
} from "./mission-director";
import type { EvokResources } from "./evok-resources";

const stats = {
  tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
  cost: 0,
};

function fakeSession(text: string): { session: AgentRuntimeSession; prompts: string[]; tools: string[][] } {
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const prompts: string[] = [];
  const tools: string[][] = [];
  const session: AgentRuntimeSession = {
    sessionId: `decision-${Math.random().toString(36).slice(2)}`,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt(p) {
      prompts.push(p);
      listener?.({ type: "agent_start" });
      listener?.({
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        }],
      });
    },
    async abort() {},
    dispose() { listener = undefined; },
    getSessionStats() { return stats; },
  };
  return { session, prompts, tools };
}

async function resources(): Promise<EvokResources> {
  const projectRoot = await mkdtemp(join(tmpdir(), "evok-director-"));
  return {
    userRoot: join(tmpdir(), "evok-director-user"),
    projectRoot,
    appendSystemPromptPaths: [],
    skills: [],
    diagnostics: [],
    readRoots: [],
  };
}

function directorInput(): DirectorInput {
  return {
    missionId: "m-unit",
    stateVersion: 2,
    objective: "raise measured answer toward 0.9",
    contract: { objective: "raise measured answer toward 0.9", expectedOutputs: ["answer.txt"], evaluationMethod: "file", hardRules: [] },
    policy: { permissions: ["isolated-workspace-write"], hardRules: ["no external submission"] },
    budget: { total: 1, units: "model-USD", consumed: 0.1, remaining: 0.9, reserved: 0 },
    stopConditions: ["budget exhausted"],
    tasks: [{ taskId: "baseline", objective: "write 0.4" }],
    observations: [
      { runId: "m-unit:baseline:1", attempt: 1, kind: "baseline", action: "baseline", ok: true, score: 0.4, evidenceRefs: ["runs/b/snapshot"], dispatchedAt: "2026-09-11T00:00:00.000Z" },
      { runId: "m-unit:exp:2", attempt: 2, kind: "experiment", action: "repair", ok: false, negativeEvidence: true, ruleViolations: ["answer.txt is missing"], evidenceRefs: ["runs/e2/snapshot"], dispatchedAt: "2026-09-11T00:00:01.000Z" },
    ],
  };
}

describe("createPiMissionDirector (#113 AC2)", () => {
  test("the trusted observation projection reaches a fresh read-only decision Run", async () => {
    const res = await resources();
    const fake = fakeSession(JSON.stringify({
      stateVersion: 2,
      action: "change-direction",
      rationale: "0.4 then a missing artifact; a different approach is warranted",
      task: { objective: "materialize answer.txt with value 0.9", expectedOutputs: ["answer.txt"] },
      expectedCost: 0.01,
      basedOn: ["m-unit:exp:2"],
    }));
    const director = createPiMissionDirector({
      resources: res,
      runtimeFactory: (root) => new PiAgentRuntime({
        workspaceRoot: root,
        sessionFactory: async (options) => {
          fake.tools.push(options.tools!);
          // read-only boundary: no coding tools on the decision Run
          expect(options.tools).not.toContain("write");
          expect(options.tools).not.toContain("bash");
          return fake.session;
        },
      }),
    });
    const decision = await director.decide(directorInput());
    expect(decision.proposal.action).toBe("change-direction");
    expect(decision.sessionId).toMatch(/^decision-/);
    // the REAL observations (score and negative evidence) reached the prompt
    expect(fake.prompts[0]!).toContain("0.4");
    expect(fake.prompts[0]!).toContain("answer.txt is missing");
    expect(fake.prompts[0]!).toContain("0.9"); // objective
    // read-only tools only
    expect(fake.tools[0]).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    expect(fake.tools[0]!.sort()).toEqual([...new Set(fake.tools[0]!)].sort());
  });

  test("non-JSON model text is surfaced as a proposal rejection (controller owns correction)", async () => {
    const res = await resources();
    const fake = fakeSession("I think you should maybe try harder next time");
    const director = createPiMissionDirector({
      resources: res,
      runtimeFactory: (root) => new PiAgentRuntime({
        workspaceRoot: root,
        sessionFactory: async () => fake.session,
      }),
    });
    await expect(director.decide(directorInput())).rejects.toBeInstanceOf(DirectorProposalRejectedError);
  });

  test("a stale/invalid JSON proposal is re-validated inside the adapter and rejected", async () => {
    const res = await resources();
    const fake = fakeSession(JSON.stringify({ stateVersion: 1, action: "change-direction", rationale: "stale", task: { objective: "x" } }));
    let sessions = 0;
    const director = createPiMissionDirector({
      resources: res,
      runtimeFactory: (root) => new PiAgentRuntime({
        workspaceRoot: root,
        sessionFactory: async () => { sessions += 1; return fake.session; },
      }),
    });
    await expect(director.decide(directorInput())).rejects.toThrow(/stale/i);
    // exactly one decision Run for one decide() call (fresh session, no inner retry)
    expect(sessions).toBe(1);
  });
});
