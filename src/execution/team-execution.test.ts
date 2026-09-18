import { describe, expect, test } from "bun:test";
import {
  ArtifactFanIn,
  Coordinator,
  DEFAULT_BRANCH_WIDTH,
  DeterministicScheduler,
  PolicyGuard,
  createThinExecutionPlan,
  registerIdeaType,
  type ArtifactReference,
  type ExecutionPlan,
} from "../toy-harness";

const plan = (overrides: Partial<ExecutionPlan> = {}): ExecutionPlan => ({
  version: 1,
  branchWidth: 2,
  maxAttempts: 2,
  branchBudget: 10,
  permissions: ["read"],
  resources: ["cpu"],
  verificationGates: ["self-check", "falsifier"],
  ...overrides,
});

const guard = new PolicyGuard({
  maxBranchWidth: 3,
  maxAttempts: 2,
  maxBranchBudget: 10,
  permissions: ["read"],
  resources: ["cpu"],
  mandatoryVerificationGates: ["self-check", "falsifier"],
});

function ref(branchId: string, suffix = "1"): ArtifactReference {
  return Object.freeze({
    artifactId: `${branchId}-${suffix}`,
    branchId,
    address: `artifact://${branchId}/${suffix}`,
    digest: `${branchId}:${suffix}`,
  });
}

describe("adaptive team execution", () => {
  test("coordinator selects single-worker and bounded fan-out from data, not competition name", () => {
    const coordinator = new Coordinator();
    expect(coordinator.propose({ requestedBranches: 1, competition: "alpha" }).branchWidth).toBe(1);
    expect(coordinator.propose({ requestedBranches: 3, competition: "alpha" }).branchWidth).toBe(3);
    expect(coordinator.propose({ requestedBranches: 3, competition: "beta" })).toEqual(
      coordinator.propose({ requestedBranches: 3, competition: "alpha" }),
    );
  });

  test("policy guard rejects zero or over-limit width and accepts one attempt/budget", () => {
    expect(() => guard.validate(plan({ branchWidth: 0 }))).toThrow();
    expect(() => guard.validate(plan({ branchWidth: 4 }))).toThrow();
    expect(() => guard.validate(plan({ maxAttempts: 1, branchBudget: 1 }))).not.toThrow();
  });

  test("policy guard rejects budget, permissions, resources, and verification violations", () => {
    expect(() => guard.validate(plan({ maxAttempts: 3 }))).toThrow();
    expect(() => guard.validate(plan({ branchBudget: 11 }))).toThrow();
    expect(() => guard.validate(plan({ permissions: ["write"] }))).toThrow();
    expect(() => guard.validate(plan({ resources: ["gpu"] }))).toThrow();
    expect(() => guard.validate(plan({ verificationGates: ["self-check"] }))).toThrow();
  });

  test("scheduler creates isolated branches with independent session, workspace, context, and budget", async () => {
    const scheduler = new DeterministicScheduler(guard);
    const branches = scheduler.createBranches(plan(), ["a", "b"]);
    expect(branches[0].sessionId).not.toBe(branches[1].sessionId);
    expect(branches[0].workspace).not.toBe(branches[1].workspace);
    expect(branches[0].context).not.toBe(branches[1].context);
    expect(branches[0].budget).not.toBe(branches[1].budget);
    branches[0].workspace.value = "a";
    branches[0].context.value = "a";
    expect(branches[1].workspace).toEqual({});
    expect(branches[1].context).toEqual({});
    expect(await scheduler.run(plan(), { branchIds: ["a", "b"], execute: async (branch) => ref(branch.branchId), falsifier: () => ({ ok: true, objections: [] }) })).toHaveLength(2);
  });

  test("scheduler rejects duplicate branch state and exhausted branch attempts", async () => {
    const scheduler = new DeterministicScheduler(guard);
    expect(() => scheduler.createBranches(plan(), ["a", "a"])).toThrow();
    const branches = scheduler.createBranches(plan({ maxAttempts: 1 }), ["a"]);
    expect(branches[0].consumeAttempt()).toBe(true);
    expect(branches[0].consumeAttempt()).toBe(false);
  });

  test("contains worker attempts to inflate scheduler-owned branch budgets", async () => {
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan({ maxAttempts: 1, branchBudget: 1 }), {
      branchIds: ["a"],
      execute: (branch) => {
        (branch.budget as unknown as { remainingAttempts: number }).remainingAttempts = 99;
        (branch.budget as unknown as { remainingUnits: number }).remainingUnits = 99;
        return ref(branch.branchId);
      },
      falsifier: () => ({ ok: true, objections: [] }),
    });

    expect(result[0].status).toBe("REJECTED");
    expect(result[0].artifact).toBeUndefined();
    expect(result[0].branch.budget.remainingAttempts).toBe(0);
    expect(result[0].branch.budget.remainingUnits).toBe(0);
    expect(result[0].branch.budget.remainingAttempts).toBeLessThanOrEqual(result[0].branch.budget.maxAttempts);
    expect(result[0].branch.budget.remainingUnits).toBeLessThanOrEqual(result[0].branch.budget.maxUnits);
  });

  test("rejects replacement of the scheduler-owned budget slot without rejecting a valid artifact", async () => {
    const scheduler = new DeterministicScheduler(guard);
    let replacementRejected = false;
    const result = await scheduler.run(plan({ maxAttempts: 1, branchBudget: 1 }), {
      branchIds: ["a"],
      execute: (branch) => {
        try {
          (branch as unknown as { budget: object }).budget = {
            maxAttempts: 99,
            remainingAttempts: 99,
            maxUnits: 99,
            remainingUnits: 99,
          };
        } catch {
          replacementRejected = true;
        }
        return ref(branch.branchId);
      },
      falsifier: () => ({ ok: true, objections: [] }),
    });

    expect(replacementRejected).toBe(true);
    expect(result[0].status).toBe("COMPLETED");
    expect(result[0].artifact?.artifactId).toBe("a-1");
    expect(result[0].branch.budget.maxAttempts).toBe(1);
    expect(result[0].branch.budget.remainingAttempts).toBe(0);
    expect(result[0].branch.budget.maxUnits).toBe(1);
    expect(result[0].branch.budget.remainingUnits).toBe(0);
  });

  test("scheduler rejects an artifact owned by another branch before falsification", async () => {
    const falsifierCalls: string[] = [];
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan(), {
      branchIds: ["a", "b"],
      execute: (branch) => ref(branch.branchId === "a" ? "b" : branch.branchId),
      falsifier: (branch) => {
        falsifierCalls.push(branch.branchId);
        return { ok: true, objections: [] };
      },
    });

    expect(result.find((entry) => entry.branch.branchId === "a")).toMatchObject({
      status: "REJECTED",
      objections: ["artifact reference belongs to another branch"],
    });
    expect(result.find((entry) => entry.branch.branchId === "a")?.artifact).toBeUndefined();
    expect(falsifierCalls).toEqual(["b"]);
  });

  test("competitive branches retain dedicated falsifier objections", async () => {
    const calls: string[] = [];
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan(), {
      branchIds: ["a", "b"],
      execute: (branch) => ref(branch.branchId),
      falsifier: (branch) => {
        calls.push(branch.branchId);
        return { ok: branch.branchId === "a", objections: branch.branchId === "a" ? [] : ["counterexample"] };
      },
    });
    expect(calls).toEqual(["a", "b"]);
    expect(result.find((entry) => entry.branch.branchId === "b")?.objections).toEqual(["counterexample"]);
  });

  test("fan-in accepts immutable artifact references only and keeps evaluator/promotion independent", async () => {
    const evaluated: string[] = [];
    const promoted: string[] = [];
    const fanIn = new ArtifactFanIn(
      async (artifact) => { evaluated.push(artifact.artifactId); return { score: artifact.branchId === "b" ? 2 : 1 }; },
      (artifact, evaluation) => { promoted.push(artifact.artifactId); return evaluation.score > 1; },
      ["a", "b"],
    );
    const result = await fanIn.reconcile([ref("a"), ref("b")]);
    expect(evaluated).toEqual(["a-1", "b-1"]);
    expect(promoted).toEqual(["a-1", "b-1"]);
    expect(result.promoted?.artifactId).toBe("b-1");
    await expect(fanIn.reconcile([{ artifactId: "x", branchId: "a", address: "artifact://a/1", digest: "a:1" }])).rejects.toThrow();
    await expect(fanIn.reconcile([Object.assign({}, ref("a"), { workspace: {} }) as ArtifactReference])).rejects.toThrow();
  });

  test("rejects foreign or missing branch ownership before evaluator and promotion callbacks", async () => {
    const evaluated: string[] = [];
    const promoted: string[] = [];
    const fanIn = new ArtifactFanIn(
      (artifact) => { evaluated.push(artifact.artifactId); return { score: 1 }; },
      (artifact) => { promoted.push(artifact.artifactId); return true; },
      ["a", "b"],
    );

    await expect(fanIn.reconcile([ref("foreign")])).rejects.toThrow();
    await expect(fanIn.reconcile([Object.freeze({
      artifactId: "missing-1",
      address: "artifact://missing/1",
      digest: "missing:1",
    }) as ArtifactReference])).rejects.toThrow();
    expect(evaluated).toEqual([]);
    expect(promoted).toEqual([]);
  });

  test("requires exactly four own immutable artifact properties", async () => {
    const fanIn = new ArtifactFanIn(
      () => ({ score: 1 }),
      () => true,
      ["a"],
    );
    const inheritedArtifactId = Object.create({ artifactId: "a-1" }) as Record<string, unknown>;
    Object.assign(inheritedArtifactId, { branchId: "a", address: "artifact://a/1", digest: "a:1" });
    Object.freeze(inheritedArtifactId);
    const nestedPayload = Object.freeze({ ...ref("a"), metadata: Object.freeze({ mutable: true }) });

    await expect(fanIn.reconcile([inheritedArtifactId as unknown as ArtifactReference])).rejects.toThrow();
    await expect(fanIn.reconcile([nestedPayload as ArtifactReference])).rejects.toThrow();
  });

  test("rejects valid own fields with inherited custom metadata before evaluation or promotion", async () => {
    const evaluated: string[] = [];
    const promoted: string[] = [];
    const fanIn = new ArtifactFanIn(
      (artifact) => { evaluated.push(artifact.artifactId); return { score: 1 }; },
      (artifact) => { promoted.push(artifact.artifactId); return true; },
      ["a"],
    );
    const artifact = Object.create({ metadata: { mutable: true } }) as Record<string, unknown>;
    Object.assign(artifact, ref("a"));
    Object.freeze(artifact);

    await expect(fanIn.reconcile([artifact as unknown as ArtifactReference])).rejects.toThrow();
    expect(evaluated).toEqual([]);
    expect(promoted).toEqual([]);
  });

  describe("idea typing and search diversity", () => {
    const diversityGuard = new PolicyGuard({
      maxBranchWidth: 3,
      maxAttempts: 2,
      maxBranchBudget: 10,
      permissions: ["read"],
      resources: ["cpu"],
      mandatoryVerificationGates: ["self-check", "falsifier"],
      diversity: { minIdeaTypes: 2 },
    });

    const allSystemsMicroTweaks = (): ExecutionPlan => plan({
      branches: [
        { branchId: "a", ideaType: "systems", focus: "micro-tweak" },
        { branchId: "b", ideaType: "systems", focus: "micro-tweak" },
      ],
    });

    const mixedPlan = (): ExecutionPlan => plan({
      branches: [
        { branchId: "a", ideaType: "systems", focus: "micro-tweak" },
        { branchId: "b", ideaType: "algorithmic" },
      ],
    });

    test("guard rejects a fan-out where every branch is one near-identical idea type and accepts a mixed-type plan", () => {
      expect(() => diversityGuard.validate(allSystemsMicroTweaks())).toThrow(/idea type diversity/);
      expect(() => diversityGuard.validate(mixedPlan())).not.toThrow();
    });

    test("guard enforces the per-kind branch quota on top of the distinct-type minimum", () => {
      const quotaGuard = new PolicyGuard({
        maxBranchWidth: 3,
        maxAttempts: 2,
        maxBranchBudget: 10,
        permissions: ["read"],
        resources: ["cpu"],
        mandatoryVerificationGates: ["self-check", "falsifier"],
        diversity: { minIdeaTypes: 2, maxBranchesPerKind: 1 },
      });
      registerIdeaType("systems:augmentation", "systems");
      const sameKind = plan({
        branchWidth: 3,
        branches: [
          { branchId: "a", ideaType: "systems" },
          { branchId: "b", ideaType: "systems:augmentation" },
          { branchId: "c", ideaType: "algorithmic" },
        ],
      });
      expect(() => quotaGuard.validate(sameKind)).toThrow(/one base kind/);
      expect(() => quotaGuard.validate(mixedPlan())).not.toThrow();
    });

    test("guard demands typed branches covering the full plan width when diversity is declared", () => {
      expect(() => diversityGuard.validate(plan())).toThrow(/typed branches/);
      expect(() => diversityGuard.validate(plan({
        branches: [{ branchId: "a", ideaType: "systems" }, { branchId: "b", ideaType: "algorithmic" }],
      }))).not.toThrow();
      expect(() => diversityGuard.validate(plan({
        branchWidth: 3,
        branches: [
          { branchId: "a", ideaType: "systems" },
          { branchId: "b", ideaType: "algorithmic" },
          { branchId: "c", ideaType: "open-search" },
        ],
      }))).not.toThrow();
    });

    test("guard rejects idea types that are not registered under a base kind", () => {
      const unregistered = plan({
        branches: [
          { branchId: "a", ideaType: "systems" },
          { branchId: "b", ideaType: "vibes" },
        ],
      });
      expect(() => diversityGuard.validate(unregistered)).toThrow(/registered idea type/);
      expect(() => registerIdeaType("systems", "algorithmic")).toThrow();
    });

    test("diversity guard blocks branch creation before any candidate work and promotion stays behind the evaluator gate", async () => {
      const scheduler = new DeterministicScheduler(diversityGuard);
      expect(() => scheduler.createBranches(allSystemsMicroTweaks(), ["a", "b"])).toThrow();

      let executed = 0;
      const result = await scheduler.run(mixedPlan(), {
        branchIds: ["a", "b"],
        execute: (branch) => { executed += 1; return ref(branch.branchId); },
        falsifier: () => ({ ok: true, objections: [] }),
      });
      expect(executed).toBe(2);
      expect(result.every((entry) => entry.status === "COMPLETED")).toBe(true);

      // A diverse batch alone promotes nothing: the independent evaluator and the promotion
      // policy remain the only route to promotion.
      const evaluated: string[] = [];
      const fanIn = new ArtifactFanIn(
        async (artifact) => { evaluated.push(artifact.artifactId); return { score: 1 }; },
        () => false,
        ["a", "b"],
      );
      const fanInResult = await fanIn.reconcile([ref("a"), ref("b")]);
      expect(evaluated).toEqual(["a-1", "b-1"]);
      expect(fanInResult.promoted).toBeUndefined();
    });

    test("scheduler carries branch idea type and focus into the branch context", () => {
      const scheduler = new DeterministicScheduler(guard);
      const branches = scheduler.createBranches(mixedPlan(), ["a", "b"]);
      expect(branches[0].context).toEqual({ ideaType: "systems", focus: "micro-tweak" });
      expect(branches[1].context).toEqual({ ideaType: "algorithmic" });
    });
  });
});

describe("thin execution default", () => {
  const thinGuard = new PolicyGuard({
    maxBranchWidth: 3,
    maxAttempts: 1,
    maxBranchBudget: 1,
    permissions: [],
    resources: [],
  });

  test("omitting requestedBranches yields default branchWidth of 1", () => {
    expect(DEFAULT_BRANCH_WIDTH).toBe(1);
    expect(createThinExecutionPlan().branchWidth).toBe(1);
    expect(new Coordinator().propose({}).branchWidth).toBe(1);
    expect(new Coordinator().propose({ competition: "alpha" }).branchWidth).toBe(1);
  });

  test("explicit requestedBranches greater than 1 still selects that width", () => {
    expect(createThinExecutionPlan({ requestedBranches: 3 }).branchWidth).toBe(3);
    expect(new Coordinator().propose({ requestedBranches: 2 }).branchWidth).toBe(2);
  });

  test("default plan does not pre-fill a standing verification-role roster", () => {
    expect(createThinExecutionPlan().verificationGates).toEqual([]);
  });

  test("policy guard defaults do not mandate the Falsifier roster and still honor explicit gates", () => {
    expect(() => thinGuard.validate(createThinExecutionPlan())).not.toThrow();
    const openGuard = new PolicyGuard({
      maxBranchWidth: 3,
      maxAttempts: 2,
      maxBranchBudget: 10,
      permissions: ["read"],
      resources: ["cpu"],
    });
    expect(() => openGuard.validate(plan({ verificationGates: [] }))).not.toThrow();

    const mandatory = new PolicyGuard({
      maxBranchWidth: 3,
      maxAttempts: 2,
      maxBranchBudget: 10,
      permissions: ["read"],
      resources: ["cpu"],
      mandatoryVerificationGates: ["self-check", "falsifier"],
    });
    expect(() => mandatory.validate(plan({ verificationGates: ["self-check"] }))).toThrow(/mandatory verification gate/);
    expect(() => mandatory.validate(plan())).not.toThrow();
  });

  test("scheduler completes on execute alone when no verification callbacks are passed", async () => {
    const invoked: string[] = [];
    const scheduler = new DeterministicScheduler(thinGuard);
    const result = await scheduler.run(createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => {
        invoked.push("execute");
        return ref(branch.branchId);
      },
    });

    expect(invoked).toEqual(["execute"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("COMPLETED");
    expect(result[0]?.artifact?.artifactId).toBe("a-1");
    expect(result[0]?.verification).toEqual({});
  });

  test("scheduler does not auto-pull Falsifier from plan gate names when the callback is omitted", async () => {
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan({ branchWidth: 1 }), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
    });

    expect(result[0]?.status).toBe("COMPLETED");
    expect(result[0]?.verification?.Falsifier).toBeUndefined();
    expect(result[0]?.verification?.Critic).toBeUndefined();
    expect(result[0]?.verification?.Challenger).toBeUndefined();
    expect(result[0]?.verification?.Auditor).toBeUndefined();
    expect(result[0]?.verification?.SuccessAuditor).toBeUndefined();
  });

  test("explicit Falsifier failure still rejects the branch", async () => {
    const scheduler = new DeterministicScheduler(thinGuard);
    const result = await scheduler.run(createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
      falsifier: () => ({ ok: false, objections: ["counterexample"] }),
    });

    expect(result[0]?.status).toBe("REJECTED");
    expect(result[0]?.artifact?.artifactId).toBe("a-1");
    expect(result[0]?.objections).toEqual(["counterexample"]);
    expect(result[0]?.verification?.Falsifier).toBe(false);
  });

  test("branch width and verification roster are not promotion keys", async () => {
    const scheduler = new DeterministicScheduler(thinGuard);
    const scheduled = await scheduler.run(createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
    });
    expect(scheduled[0]?.status).toBe("COMPLETED");

    const fanIn = new ArtifactFanIn(
      () => ({ score: 1, elite: true, teamFanOutWidth: 8, roster: ["Falsifier", "Critic"] }),
      (_artifact, evaluation) => evaluation.score > 5,
      ["a"],
    );
    const denied = await fanIn.reconcile([ref("a")]);
    expect(denied.promoted).toBeUndefined();

    const byScore = new ArtifactFanIn(
      () => ({ score: 2 }),
      (_artifact, evaluation) => evaluation.score > 1,
      ["a"],
    );
    const promoted = await byScore.reconcile([ref("a")]);
    expect(promoted.promoted?.artifactId).toBe("a-1");
  });
});
