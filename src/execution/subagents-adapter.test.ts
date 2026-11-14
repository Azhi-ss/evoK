/**
 * pi-subagents fan-out adapter: an OPTIONAL delegation path for short-lived
 * Researcher/Critic/Reviewer agents. It can never hold Mission authority,
 * allocate resources, evaluate, promote, or submit — the guard runs before
 * the transport, so a forbidden delegation never reaches pi-subagents.
 */
import { describe, expect, test } from "bun:test";
import { buildResearcherContext, type ResearcherContext } from "./researcher-context";
import { assembleRoleContext, type RoleTaskContext } from "./role-context";
import { createMemorySlice, createResearchMemorySlice, deriveDelegatedMemorySlice, validateMemorySlice } from "../memory";
import { projectResearchMemorySnapshot } from "../memory";
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

function childContext(args: { targetAgentId?: string; runId?: string; missionId?: string; taskId?: string; memoryDigest?: string } = {}): RoleTaskContext {
  return assembleRoleContext({
    role: "researcher",
    contract,
    policy,
    source: "team-coordinator",
    objective: "critique the candidate features",
    tools: ["read"],
    targetAgentId: args.targetAgentId ?? CHILD.targetAgentId,
    runId: args.runId ?? CHILD.runId,
    missionId: args.missionId ?? "m-1",
    taskId: args.taskId ?? "task-exp-3",
    ...(args.memoryDigest !== undefined ? { memoryDigest: args.memoryDigest } : {}),
  });
}

function childMemory(runId = CHILD.runId) {
  return createMemorySlice({ sliceId: "slice-sub-1", missionId: "m-1", taskId: "task-exp-3", runId, targetAgentId: CHILD.targetAgentId, findings: [{ findingId: "f-1", summary: "grouped split needed" }] });
}

function childRoleContext(): RoleTaskContext {
  return childContext({ memoryDigest: childMemory().digest });
}

function childDelegation(overrides: Partial<SubagentDelegation> = {}): SubagentDelegation {
  return {
    ...delegation("critique"),
    ...CHILD,
    roleContext: childRoleContext(),
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
    expect(calls[0]!.roleContext).toEqual(childRoleContext());
    expect(calls[0]!.memorySlice).toEqual(childMemory());
    // The legacy minimal context is still carried alongside it.
    expect(calls[0]!.context.schema).toBe("evok.researcher-context/v1");
  });

  test("the child identity cannot reuse or inherit the parent's", () => {
    const reuseRun = { runId: PARENT.runId, roleContext: childContext({ runId: PARENT.runId, memoryDigest: childMemory(PARENT.runId).digest }), memorySlice: childMemory(PARENT.runId) };
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
      .toThrow(/requires the child's own bound role context/);
  });

  test("a child context without its own identity is refused", () => {
    const base = childDelegation();
    expect(() => assertDelegationPermitted({ ...base, targetAgentId: undefined, runId: undefined } as SubagentDelegation))
      .toThrow(/requires the child's own targetAgentId and runId/);
  });
});

// ── Research Memory: a fresh child slice from the parent's pinned snapshot ──
const researchSnapshot = projectResearchMemorySnapshot({
  missionId: "m-1",
  ledgerRevision: 3,
  runs: [
    { runId: PARENT.runId, ok: true, score: 0.5, evidenceRefs: [`runs/${PARENT.runId}/result.json`] },
  ],
});

function pinnedParentSlice() {
  return createResearchMemorySlice({
    sliceId: "slice-parent",
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: PARENT.runId,
    targetAgentId: PARENT.targetAgentId,
    research: researchSnapshot,
  });
}

function delegatedResearchSlice(
  parent = pinnedParentSlice(),
  identity: { missionId?: string; taskId?: string; runId?: string; targetAgentId?: string } = {},
) {
  return deriveDelegatedMemorySlice({
    parent,
    missionId: identity.missionId ?? "m-1",
    taskId: identity.taskId ?? "task-exp-3",
    runId: identity.runId ?? CHILD.runId,
    targetAgentId: identity.targetAgentId ?? CHILD.targetAgentId,
  });
}

function researchDelegation(overrides: Partial<SubagentDelegation> = {}): SubagentDelegation {
  const parent = pinnedParentSlice();
  const slice = overrides.memorySlice ?? delegatedResearchSlice(parent);
  return childDelegation({
    roleContext: childContext({ memoryDigest: slice.digest }),
    memorySlice: slice,
    parentMemorySlice: parent,
    ...overrides,
  });
}

describe("pi-subagents Research Memory delegation (#217)", () => {
  test("the child receives a newly generated slice bound to its own identity from the pinned snapshot", async () => {
    const calls: SubagentDelegation[] = [];
    const adapter = createPiSubagentsAdapter(async (d) => {
      calls.push(d);
      return { agent: d.agent, value: "ok" };
    });
    const parent = pinnedParentSlice();
    await adapter.delegate(researchDelegation({ parentMemorySlice: parent }));

    const slice = calls[0]!.memorySlice!;
    // Own identity, own slice id: never the parent's slice.
    expect(slice.missionId).toBe("m-1");
    expect(slice.taskId).toBe("task-exp-3");
    expect(slice.runId).toBe(CHILD.runId);
    expect(slice.targetAgentId).toBe(CHILD.targetAgentId);
    expect(slice.sliceId).not.toBe(parent.sliceId);
    expect(slice.digest).not.toBe(parent.digest);
    // Same pinned snapshot: the child packet is never wider than the parent's.
    expect(slice.research?.digest).toBe(parent.research!.digest);
    expect(slice.research?.cards.map((card) => card.cardId))
      .toEqual(parent.research!.cards.map((card) => card.cardId));
    // Fresh session: the child's own identity replaces the parent's.
    expect(slice.runId).not.toBe(PARENT.runId);
    expect(slice.targetAgentId).not.toBe(PARENT.targetAgentId);
    expect(slice.sliceId).not.toBe(parent.sliceId);
  });

  test("parent, sibling, previous-Run, and mismatched slices are rejected before the child session starts", async () => {
    let transportCalls = 0;
    const adapter = createPiSubagentsAdapter(async (d) => {
      transportCalls += 1;
      return { agent: d.agent, value: null };
    });
    const parent = pinnedParentSlice();
    const sibling = delegatedResearchSlice(parent, { runId: "m-1:exp:3:sub:2", targetAgentId: "researcher-child@m-1:exp:3:sub:2" });
    const previousRun = delegatedResearchSlice(parent, { runId: "m-1:exp:2:sub:0" });
    // Another Mission's slice that happens to name the child's run/agent.
    const otherMission = createResearchMemorySlice({
      sliceId: "slice-other-mission", missionId: "m-2", taskId: "task-exp-3",
      runId: CHILD.runId, targetAgentId: CHILD.targetAgentId,
      research: projectResearchMemorySnapshot({ missionId: "m-2", ledgerRevision: 0, runs: [] }),
    });
    const otherTask = delegatedResearchSlice(parent, { taskId: "task-exp-9" });

    const cases: Array<[SubagentDelegation, RegExp]> = [
      // The parent's own slice is never the child's slice.
      [researchDelegation({ memorySlice: parent }), /memory slice belongs to another run/],
      [researchDelegation({ memorySlice: sibling }), /memory slice belongs to another run/],
      [researchDelegation({ memorySlice: previousRun }), /memory slice belongs to another run/],
      [researchDelegation({ memorySlice: otherMission }), /memory slice belongs to another Mission/],
      [researchDelegation({ memorySlice: otherTask }), /memory slice belongs to another Task/],
    ];
    for (const [value, expected] of cases) {
      await expect(adapter.delegate(value)).rejects.toThrow(expected);
      expect(() => assertDelegationPermitted(value)).toThrow(expected);
    }
    expect(transportCalls).toBe(0);
  });

  test("a child slice from another snapshot than the parent's pinned one is refused", () => {
    const parent = pinnedParentSlice();
    const newer = projectResearchMemorySnapshot({
      missionId: "m-1",
      ledgerRevision: 4,
      runs: [
        { runId: PARENT.runId, ok: true, score: 0.5, evidenceRefs: [] },
        { runId: "m-1:exp:4", ok: false, ruleViolations: ["answer.txt is missing"], evidenceRefs: [] },
      ],
    });
    const widened = delegatedResearchSlice(createResearchMemorySlice({
      sliceId: "slice-parent-2", missionId: "m-1", taskId: "task-exp-2",
      runId: PARENT.runId, targetAgentId: PARENT.targetAgentId, research: newer,
    }));
    expect(() => assertDelegationPermitted(researchDelegation({ memorySlice: widened })))
      .toThrow(/not from the parent's pinned snapshot/);
  });

  test("tampering with the child slice or its role-context binding fails closed", () => {
    const tamperedRun = { ...delegatedResearchSlice(), runId: "m-1:exp:9" };
    expect(() => assertDelegationPermitted(researchDelegation({ memorySlice: tamperedRun })))
      .toThrow(/digest mismatch/);
    // A role context recorded with another memory digest is not this slice's context.
    expect(() => assertDelegationPermitted(researchDelegation({
      roleContext: childContext({ memoryDigest: childMemory().digest }),
    }))).toThrow(/role context was assembled with another memory slice/);
    expect(() => assertDelegationPermitted(researchDelegation({ roleContext: undefined })))
      .toThrow(/requires the child's own bound role context/);
    // A delegated memory slice is bound to the child's own Mission/Task.
    expect(() => assertDelegationPermitted(researchDelegation({
      roleContext: childContext({ taskId: "task-exp-9" }),
    }))).toThrow(/belongs to another Task/);
    expect(() => assertDelegationPermitted(researchDelegation({
      roleContext: childContext({ targetAgentId: PARENT.targetAgentId }),
    }))).toThrow(/targets another agent/);
    expect(() => assertDelegationPermitted(researchDelegation({ freshSession: false })))
      .toThrow(/always starts a fresh session/);
  });

  test("a delegation with only the parent's pinned slice gets a freshly derived child slice", async () => {
    const calls: SubagentDelegation[] = [];
    const adapter = createPiSubagentsAdapter(async (d) => {
      calls.push(d);
      return { agent: d.agent, value: "ok" };
    });
    // Callers do not have to pre-derive: the adapter mints the child slice.
    await adapter.delegate(childDelegation({
      roleContext: childContext(),
      memorySlice: undefined,
      parentMemorySlice: pinnedParentSlice(),
    }));
    const slice = calls[0]!.memorySlice!;
    expect(slice.runId).toBe(CHILD.runId);
    expect(slice.targetAgentId).toBe(CHILD.targetAgentId);
    expect(slice.research!.digest).toBe(pinnedParentSlice().research!.digest);
    // The same derivation the fan-out path produces, deterministically.
    expect(slice).toEqual(delegatedResearchSlice(pinnedParentSlice()));
  });

  test("a research child slice is refused unless it names the parent's pinned slice", () => {
    expect(() => assertDelegationPermitted(childDelegation({
      roleContext: childContext({ memoryDigest: delegatedResearchSlice().digest }),
      memorySlice: delegatedResearchSlice(),
      parentMemorySlice: undefined,
    }))).toThrow(/must name the parent's pinned memory slice/);
  });

  test("a parent slice without the child's Mission/Task binding fails closed instead of dropping memory", async () => {
    let transportCalls = 0;
    const adapter = createPiSubagentsAdapter(async (d) => {
      transportCalls += 1;
      return { agent: d.agent, value: null };
    });
    await expect(adapter.delegate(childDelegation({
      // A role context without the Mission/Task audit binding.
      roleContext: assembleRoleContext({
        role: "researcher", contract, policy, source: "team-coordinator",
        objective: "critique the candidate features", tools: ["read"],
        targetAgentId: CHILD.targetAgentId, runId: CHILD.runId,
      }),
      memorySlice: undefined,
      parentMemorySlice: pinnedParentSlice(),
    }))).rejects.toThrow(/needs the child's own runId/);
    expect(transportCalls).toBe(0);
  });

  test("a legacy MemorySlice v2 child keeps its previous contract", async () => {
    const parentV2 = createMemorySlice({
      sliceId: "slice-parent-legacy", missionId: "m-1", taskId: "task-exp-2",
      runId: PARENT.runId, targetAgentId: PARENT.targetAgentId,
      findings: [{ findingId: "f-0", summary: "grouped split needed" }],
    });
    const childV2 = deriveDelegatedMemorySlice({
      parent: parentV2, missionId: "m-1", taskId: "task-exp-3", runId: CHILD.runId, targetAgentId: CHILD.targetAgentId,
    });
    expect(childV2.schema).toBe("evok.memory-slice/v2");
    expect(childV2.research).toBeUndefined();
    expect(childV2.findings).toEqual(parentV2.findings);
    // A v2 payload still validates and survives the delegation guard unchanged.
    expect(validateMemorySlice(childV2)).toEqual(childV2);
    const calls: SubagentDelegation[] = [];
    const adapter = createPiSubagentsAdapter(async (d) => {
      calls.push(d);
      return { agent: d.agent, value: "ok" };
    });
    await adapter.delegate(childDelegation({
      roleContext: childContext({ memoryDigest: childV2.digest }),
      memorySlice: childV2,
      parentMemorySlice: parentV2,
    }));
    expect(calls[0]!.memorySlice!.digest).toBe(childV2.digest);
  });

});
