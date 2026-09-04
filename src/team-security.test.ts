import { describe, expect, test } from "bun:test";
import { DeterministicScheduler, PolicyGuard, type ExecutionPlan } from "./toy-harness";

const plan: ExecutionPlan = {
  version: 1,
  branchWidth: 1,
  maxAttempts: 1,
  branchBudget: 1,
  permissions: ["read"],
  resources: [],
  verificationGates: ["self-check", "falsifier"],
};
const guard = new PolicyGuard({
  maxBranchWidth: 1,
  maxAttempts: 1,
  maxBranchBudget: 1,
  permissions: ["read"],
  resources: [],
  mandatoryVerificationGates: ["self-check", "falsifier"],
});

const artifact = Object.freeze({ artifactId: "a-1", branchId: "a", address: "artifact://a/1", digest: "a:1" });

describe("team verification boundaries", () => {
  test("runs self-verification before execute and fails closed", async () => {
    let executed = false;
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan, {
      branchIds: ["a"],
      selfVerify: () => ({ ok: false, objections: ["not ready"] }),
      execute: () => { executed = true; return artifact; },
      falsifier: () => ({ ok: true, objections: [] }),
    });

    expect(executed).toBe(false);
    expect(result[0].status).toBe("REJECTED");
    expect(result[0].objections).toContain("not ready");
  });

  test("does not treat malformed falsifier output as approval", async () => {
    const scheduler = new DeterministicScheduler(guard);
    const result = await scheduler.run(plan, {
      branchIds: ["a"],
      execute: () => artifact,
      falsifier: () => ({ ok: "true" } as unknown as { ok: boolean; objections: string[] }),
    });

    expect(result[0].status).toBe("REJECTED");
    expect(result[0].artifact?.artifactId).toBe("a-1");
    expect(result[0].objections[0]).toContain("Falsifier");
  });
});
