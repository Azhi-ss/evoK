/**
 * pi-subagents fan-out adapter: an OPTIONAL delegation path for short-lived
 * Researcher/Critic/Reviewer agents. It can never hold Mission authority,
 * allocate resources, evaluate, promote, or submit — the guard runs before
 * the transport, so a forbidden delegation never reaches pi-subagents.
 */
import { describe, expect, test } from "bun:test";
import { buildResearcherContext, type ResearcherContext } from "./researcher-context";
import { assembleRoleContext, type RoleTaskContext } from "./role-context";
import { createMemorySlice } from "./memory-slice";
import { createCompetitionContract } from "../competition/competition-contract";
import { createRuleVisibilityPolicy } from "../competition/rule-visibility";
import {
  FORBIDDEN_DELEGATION_CAPABILITIES,
  SubagentAuthorityError,
  assertDelegationPermitted,
  createPiSubagentsAdapter,
  type SubagentDelegation,
} from "./subagents-adapter";

function context(): ResearcherContext {
  return buildResearcherContext({ objective: "Improve the feature pipeline.", tools: ["read", "edit"] });
}

function delegation(capability: string): SubagentDelegation {
  return { agent: "researcher-1", capability, task: "propose a candidate", context: context() };
}

describe("pi-subagents adapter", () => {
  test("delegates research/critique/review fan-out through the transport", async () => {
    const calls: SubagentDelegation[] = [];
    const adapter = createPiSubagentsAdapter(async (d) => {
      calls.push(d);
      return { agent: d.agent, value: "ok" };
    });
    const result = await adapter.delegate(delegation("research"));
    expect(result.value).toBe("ok");
    expect(calls).toHaveLength(1);
    const fanOut = await adapter.fanOut([delegation("critique"), delegation("review")]);
    expect(fanOut).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  test("every forbidden authority is rejected before the transport runs", async () => {
    let transportCalls = 0;
    const adapter = createPiSubagentsAdapter(async (d) => {
      transportCalls += 1;
      return { agent: d.agent, value: null };
    });
    for (const capability of FORBIDDEN_DELEGATION_CAPABILITIES) {
      await expect(adapter.delegate(delegation(capability))).rejects.toThrow(SubagentAuthorityError);
      await expect(adapter.delegate(delegation(capability))).rejects.toThrow(/authority stays with/);
      expect(() => assertDelegationPermitted(delegation(capability))).toThrow(SubagentAuthorityError);
    }
    expect(transportCalls).toBe(0);
  });

  test("mission-critical authorities named explicitly cannot delegate", async () => {
    const adapter = createPiSubagentsAdapter(async (d) => ({ agent: d.agent, value: null }));
    for (const capability of ["mission-authority", "resource-allocation", "evaluation", "promotion", "submission"]) {
      await expect(adapter.delegate(delegation(capability))).rejects.toThrow(SubagentAuthorityError);
    }
  });

  test("unknown capabilities and non-minimal contexts fail closed", async () => {
    const adapter = createPiSubagentsAdapter(async (d) => ({ agent: d.agent, value: null }));
    await expect(adapter.delegate(delegation("admin"))).rejects.toThrow(/capability must be one of/);
    await expect(adapter.delegate({ ...delegation("research"), context: { objective: "raw, unsanitized" } as never }))
      .rejects.toThrow(/researcher-context/);
    await expect(adapter.delegate({ ...delegation("research"), context: { ...context(), credentials: "secret" } as never }))
      .rejects.toThrow(/unsupported fields/);
    expect(() => assertDelegationPermitted(null)).toThrow(SubagentAuthorityError);
    expect(() => assertDelegationPermitted({ ...delegation("research"), agent: "" })).toThrow(/agent is required/);
  });
});

// ── Explicit child context: fresh session, own identity, own memory ─────────
const contract = createCompetitionContract({
  version: "2026.1",
  competitionId: "challenge-a",
  objective: "Predict the target within the split discipline.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction" },
  limits: { network: "none" },
});
const policy = createRuleVisibilityPolicy({
  competitionId: "challenge-a",
  contractDigest: contract.digest,
  allow: { researcher: ["scoring.metric"] },
});
const PARENT = { runId: "m-1:exp:2", targetAgentId: "researcher@m-1:exp:2" };
const CHILD = { runId: "m-1:exp:3:sub:1", targetAgentId: "researcher-child@m-1:exp:3:sub:1" };

function childContext(args: { targetAgentId?: string; runId?: string } = {}): RoleTaskContext {
  return assembleRoleContext({
    role: "researcher",
    contract,
    policy,
    source: "team-coordinator",
    objective: "critique the candidate features",
    tools: ["read"],
    targetAgentId: args.targetAgentId ?? CHILD.targetAgentId,
    runId: args.runId ?? CHILD.runId,
    missionId: "m-1",
    taskId: "task-exp-3",
  });
}

function childMemory(runId = CHILD.runId) {
  return createMemorySlice({ sliceId: "slice-sub-1", missionId: "m-1", taskId: "task-exp-3", runId, targetAgentId: CHILD.targetAgentId, findings: [{ findingId: "f-1", summary: "grouped split needed" }] });
}

function childDelegation(overrides: Partial<SubagentDelegation> = {}): SubagentDelegation {
  return {
    ...delegation("critique"),
    ...CHILD,
    roleContext: childContext(),
    memorySlice: childMemory(),
    parentBinding: PARENT,
    ...overrides,
  };
}

describe("pi-subagents child context boundary", () => {
  test("a delegation carries an explicit child role context and memory slice", async () => {
    const calls: SubagentDelegation[] = [];
    const adapter = createPiSubagentsAdapter(async (d) => {
      calls.push(d);
      return { agent: d.agent, value: "ok" };
    });
    const delegationValue = childDelegation();
    await adapter.delegate(delegationValue);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.targetAgentId).toBe(CHILD.targetAgentId);
    expect(calls[0]!.runId).toBe(CHILD.runId);
    expect(calls[0]!.roleContext).toEqual(childContext());
    expect(calls[0]!.memorySlice).toEqual(childMemory());
    // The legacy minimal context is still carried alongside it.
    expect(calls[0]!.context.schema).toBe("evok.researcher-context/v1");
  });

  test("the child identity cannot reuse or inherit the parent's", () => {
    const reuseRun = { runId: PARENT.runId, roleContext: childContext({ runId: PARENT.runId }), memorySlice: childMemory(PARENT.runId) };
    expect(() => assertDelegationPermitted(childDelegation(reuseRun))).toThrow(/must not reuse the parent Run id/);
    expect(() => assertDelegationPermitted(childDelegation({ targetAgentId: PARENT.targetAgentId })))
      .toThrow(/must not reuse the parent target agent id/);
    expect(() => assertDelegationPermitted(childDelegation({ freshSession: false })))
      .toThrow(/always starts a fresh session/);
  });

  test("a child context/memory bound to another agent or run fails closed", () => {
    expect(() => assertDelegationPermitted(childDelegation({ roleContext: childContext({ targetAgentId: PARENT.targetAgentId }) })))
      .toThrow(/targets another agent/);
    expect(() => assertDelegationPermitted(childDelegation({ roleContext: childContext({ runId: "m-1:exp:9" }) })))
      .toThrow(/bound to another run/);
    expect(() => assertDelegationPermitted(childDelegation({ memorySlice: childMemory("m-1:exp:9") })))
      .toThrow(/memory slice belongs to another run/);
    expect(() => assertDelegationPermitted(childDelegation({ roleContext: undefined, memorySlice: childMemory() })))
      .toThrow(/memory slice requires a bound role context/);
  });

  test("a child context without its own identity is refused", () => {
    const base = childDelegation();
    expect(() => assertDelegationPermitted({ ...base, targetAgentId: undefined, runId: undefined } as SubagentDelegation))
      .toThrow(/requires the child's own targetAgentId and runId/);
  });
});
