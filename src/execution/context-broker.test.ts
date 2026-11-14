/**
 * ContextBroker / ResearchRunAssembler: one Run gets ONE context, assembled
 * from its own Mission/Task/Run/target-agent identity under ITS competition's
 * contract + policy. Rules are per-competition and per-role, never broadcast.
 */
import { describe, expect, test } from "bun:test";
import {
  createCompetitionContract,
  type CompetitionContract,
} from "../competition/competition-contract";
import { createRuleVisibilityPolicy, type RuleVisibilityPolicy } from "../competition/rule-visibility";
import { ContextBroker, ContextBrokerError, validateBrokeredContext, type AssembleRunContextInput } from "./context-broker";
import { probeHostInventory, type HostInventory } from "./host-inventory";
import { createMemorySlice } from "../memory";

function contract(competitionId: string, metric: string): CompetitionContract {
  return createCompetitionContract({
    version: "2026.1",
    competitionId,
    title: competitionId,
    objective: `win ${competitionId}`,
    scoring: { metric, direction: "minimize" },
    dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
    submission: { format: "csv:id,prediction", maxPerDay: 5, quota: 50 },
    limits: { timeLimitMs: 3_600_000, network: "none" },
    resources: { cpus: 8, memoryBytes: 32 * 1024 ** 3, gpu: { backend: "cuda", count: 1 } },
  });
}

function policyFor(contractValue: CompetitionContract, role: "researcher" | "critic" = "researcher"): RuleVisibilityPolicy {
  return createRuleVisibilityPolicy({
    competitionId: contractValue.competitionId,
    contractDigest: contractValue.digest,
    allow: {
      [role]: ["objective", "scoring.metric", "scoring.direction", "dataSplit.folds"],
      reviewer: ["scoring.metric"],
    },
  });
}

async function inventory(): Promise<HostInventory> {
  return probeHostInventory({
    exec: async () => ({ code: 0, stdout: "0, NVIDIA A100-SXM4-80GB, GPU-aaaa, 81920\n" }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
}

function runInput(overrides: Partial<AssembleRunContextInput> = {}): AssembleRunContextInput {
  return {
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: "m-1:exp:2",
    targetAgentId: "researcher@m-1:exp:2",
    role: "researcher",
    objective: "Improve the feature pipeline.",
    hypothesis: "target encoding reduces overfit",
    evidenceRefs: ["runs/exp-1/result.json"],
    allowedPaths: ["."],
    tools: ["read", "edit"],
    ...overrides,
  };
}

describe("ContextBroker", () => {
  test("each competition and role gets its own independently addressed context", async () => {
    const alpha = contract("challenge-alpha", "rmse");
    const beta = contract("challenge-beta", "logloss");
    const brokerAlpha = new ContextBroker({ contract: alpha, policy: policyFor(alpha) });
    const brokerBeta = new ContextBroker({ contract: beta, policy: policyFor(beta) });

    const a = await brokerAlpha.assemble(runInput());
    const b = await brokerBeta.assemble(runInput({ missionId: "m-2", runId: "m-2:exp:2", targetAgentId: "researcher@m-2:exp:2" }));

    expect(a.context.kind).toBe("role");
    if (a.context.kind !== "role" || b.context.kind !== "role") throw new Error("expected role contexts");
    expect(a.context.roleContext.rules).toEqual({
      objective: "win challenge-alpha",
      "scoring.metric": "rmse",
      "scoring.direction": "minimize",
      "dataSplit.folds": 5,
    });
    expect(b.context.roleContext.rules["scoring.metric"]).toBe("logloss");
    expect(a.competition.competitionId).toBe("challenge-alpha");
    expect(b.competition.competitionId).toBe("challenge-beta");
    expect(a.digests.contract).toBe(alpha.digest);
    expect(b.digests.contract).toBe(beta.digest);
    expect(a.digests.context).not.toBe(b.digests.context);

    // A policy bound to another competition's contract is never usable here.
    expect(() => new ContextBroker({ contract: beta, policy: policyFor(alpha) })).toThrow(ContextBrokerError);
    expect(() => new ContextBroker({ contract: beta, policy: policyFor(alpha) })).toThrow(/does not match/);
  });

  test("binds target agent, run, contract, policy, and memory digests", async () => {
    const alpha = contract("challenge-alpha", "rmse");
    let asked: unknown;
    const broker = new ContextBroker({
      contract: alpha,
      policy: policyFor(alpha),
      inventory: await inventory(),
      memory: (request) => {
        asked = request;
        return createMemorySlice({
          sliceId: "slice-exp-2",
          missionId: request.missionId,
          taskId: request.taskId,
          runId: request.runId,
          targetAgentId: request.targetAgentId,
          evidenceRefs: request.evidenceRefs,
          findings: [{ findingId: "f-1", summary: "drop the leaky column", ok: false }],
        });
      },
    });

    const brokered = await broker.assemble(runInput());
    expect(asked).toEqual({
      missionId: "m-1",
      taskId: "task-exp-2",
      runId: "m-1:exp:2",
      targetAgentId: "researcher@m-1:exp:2",
      role: "researcher",
      evidenceRefs: ["runs/exp-1/result.json"],
    });
    if (brokered.context.kind !== "role") throw new Error("expected a role context");
    const roleContext = brokered.context.roleContext;
    expect(roleContext.audit).toEqual({
      role: "researcher",
      contractDigest: alpha.digest,
      policyDigest: broker.policy.digest,
      source: "context-broker",
      targetAgentId: "researcher@m-1:exp:2",
      runId: "m-1:exp:2",
      missionId: "m-1",
      taskId: "task-exp-2",
      memoryDigest: brokered.memorySlice!.digest,
    });
    expect(brokered.digests).toEqual({
      contract: alpha.digest,
      policy: broker.policy.digest,
      context: roleContext.digest,
      memory: brokered.memorySlice!.digest,
    });
    expect(brokered.memorySlice!.runId).toBe("m-1:exp:2");
    expect(validateBrokeredContext(JSON.parse(JSON.stringify(brokered)))).toEqual(brokered);

    // Trusted roles never receive agent memory.
    const trusted = await broker.assemble(trustedInput(alpha, "evaluator"));
    expect(trusted.memorySlice).toBeUndefined();
    expect(trusted.digests.memory).toBeUndefined();
  });

  test("a memory slice from another run is refused", async () => {
    const alpha = contract("challenge-alpha", "rmse");
    const broker = new ContextBroker({
      contract: alpha,
      policy: policyFor(alpha),
      memory: () => createMemorySlice({ sliceId: "s", missionId: "m-1", taskId: "task-exp-2", runId: "m-1:exp:9", targetAgentId: "researcher@m-1:exp:2" }),
    });
    await expect(broker.assemble(runInput())).rejects.toThrow(/runId .* does not match this Run/);
  });

  test("trusted evaluator gets holdout; executor asking for holdout fails closed", async () => {
    const alpha = contract("challenge-alpha", "rmse");
    const inv = await inventory();
    const broker = new ContextBroker({ contract: alpha, policy: policyFor(alpha), inventory: inv, source: "mission-controller" });

    const evaluator = await broker.assemble(trustedInput(alpha, "evaluator", "holdout"));
    if (evaluator.context.kind !== "execution") throw new Error("expected an execution context");
    const context = evaluator.context.executionContext;
    expect(context.evaluation.dataAccess).toBe("holdout");
    expect(context.contract.digest).toBe(alpha.digest);
    expect(context.workspace.isolated).toBe(true);
    expect(context.workspace.readRoots).toEqual(["/research/project"]);
    expect(evaluator.digests).toEqual({
      contract: alpha.digest,
      policy: broker.policy.digest,
      context: context.digest,
      inventory: inv.digest,
      lease: context.lease.digest,
    });
    expect(validateBrokeredContext(JSON.parse(JSON.stringify(evaluator)))).toEqual(evaluator);

    await expect(broker.assemble(trustedInput(alpha, "executor", "holdout"))).rejects.toThrow(/must not grant holdout/);
    // A trusted context without a lease is never assembled.
    await expect(new ContextBroker({ contract: alpha, policy: policyFor(alpha) }).assemble(trustedInput(alpha, "evaluator", "holdout", false)))
      .rejects.toThrow(/requires a resource lease/);
    await expect(broker.assemble({ ...trustedInput(alpha, "executor"), network: "open" }))
      .rejects.toThrow(/exceeds the competition contract limit/);
    await expect(broker.assemble({ ...trustedInput(alpha, "executor"), timeLimitMs: 3_600_001 }))
      .rejects.toThrow(/exceeds the competition contract limit/);
  });

  test("tampered or cross-wired brokered contexts fail validation", async () => {
    const alpha = contract("challenge-alpha", "rmse");
    const brokered = await new ContextBroker({ contract: alpha, policy: policyFor(alpha) }).assemble(runInput());
    if (brokered.context.kind !== "role") throw new Error("expected a role context");

    // Injected rule tampering (even with a re-computed role digest) is caught.
    const widened = {
      ...brokered,
      context: {
        kind: "role" as const,
        roleContext: { ...brokered.context.roleContext, rules: { ...brokered.context.roleContext.rules, "resources.cpus": 64 } },
      },
    };
    expect(() => validateBrokeredContext(widened)).toThrow(/role context digest mismatch|digest/);

    expect(() => validateBrokeredContext({ ...brokered, targetAgentId: "researcher@m-1:baseline:1" }))
      .toThrow(/targetAgentId does not match/);
    expect(() => validateBrokeredContext({ ...brokered, runId: "m-1:baseline:1" })).toThrow(/runId does not match/);
    expect(() => validateBrokeredContext({ ...brokered, digests: { ...brokered.digests, policy: "other" } }))
      .toThrow(/competition and digest block disagree/);
    expect(() => validateBrokeredContext({ ...brokered, digests: { ...brokered.digests, context: "other" } }))
      .toThrow(/digest does not match its role context/);
  });
});

function trustedInput(
  contractValue: CompetitionContract,
  role: "executor" | "evaluator",
  dataAccess: "none" | "public" | "holdout" = "public",
  withResourceRequest = true,
): AssembleRunContextInput {
  return {
    missionId: "m-1",
    taskId: "task-exp-2",
    runId: "m-1:exp:2",
    targetAgentId: `${role}@m-1:exp:2`,
    role,
    objective: `measure ${contractValue.competitionId}`,
    ...(withResourceRequest ? { resourceRequest: { cpus: 2, gpus: 1, timeLimitMs: 60_000 } } : {}),
    workspace: { root: "/runs/exp-2", readRoots: ["/research/project"] },
    evaluation: { entry: "competition/suite-metric", dataAccess },
  };
}
