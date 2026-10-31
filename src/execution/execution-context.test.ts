/**
 * ExecutionContext for trusted Executor/Evaluator: binds contract
 * version+digest, evaluation entry + data-access policy, inventory digest +
 * lease, workspace, network/time. Executor can never get holdout access.
 */
import { describe, expect, test } from "bun:test";
import { createCompetitionContract } from "../competition/competition-contract";
import { probeHostInventory } from "./host-inventory";
import { grantResourceLease, type ResourceLease } from "./resource-lease";
import {
  ExecutionContextError,
  createExecutionContext,
  validateExecutionContext,
  type CreateExecutionContextInput,
} from "./execution-context";

const contract = createCompetitionContract({
  version: "2026.1",
  competitionId: "challenge-a",
  objective: "Predict the target.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction", quota: 50 },
  limits: { network: "none" },
});

let sharedLease: ResourceLease | undefined;

async function lease(): Promise<ResourceLease> {
  if (sharedLease) return sharedLease;
  const inventory = await probeHostInventory({
    exec: async () => ({ code: 0, stdout: "0, NVIDIA A100-SXM4-80GB, GPU-aaaa, 81920\n" }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
  sharedLease = grantResourceLease({
    inventory,
    taskId: "task-1",
    request: { cpus: 4, memoryBytes: 8 * 1024 ** 3, gpus: 1, timeLimitMs: 3_600_000 },
    now: () => new Date("2026-10-24T01:00:00Z"),
  });
  return sharedLease;
}

async function input(overrides: Partial<CreateExecutionContextInput> = {}): Promise<CreateExecutionContextInput> {
  return {
    audience: "evaluator",
    contract,
    evaluation: { entry: "competition/suite-metric", dataAccess: "holdout" },
    lease: await lease(),
    workspace: { root: "/runs/task-1", isolated: true, readRoots: ["/research"] },
    network: "none",
    timeLimitMs: 3_600_000,
    source: "mission-controller",
    ...overrides,
  };
}

describe("execution context", () => {
  test("binds contract digest, lease, workspace, and policies; digest validates", async () => {
    const context = createExecutionContext(await input());
    expect(context.contract).toEqual({ version: "2026.1", digest: contract.digest });
    expect(context.inventoryDigest).toBe(context.lease.inventoryDigest);
    expect(context.evaluation.dataAccess).toBe("holdout");
    expect(Object.isFrozen(context)).toBe(true);
    const restored = validateExecutionContext(JSON.parse(JSON.stringify(context)));
    expect(restored).toEqual(context);
  });

  test("executor asking for holdout data access fails closed", async () => {
    const base = await input({ audience: "executor", evaluation: { entry: "x", dataAccess: "holdout" } });
    expect(() => createExecutionContext(base)).toThrow(ExecutionContextError);
    expect(() => createExecutionContext(base)).toThrow(/must not grant holdout/);
  });

  test("executor with public/none data access is fine; evaluator may hold holdout", async () => {
    const executor = createExecutionContext(await input({ audience: "executor", evaluation: { entry: "x", dataAccess: "public" } }));
    expect(executor.audience).toBe("executor");
    const evaluator = createExecutionContext(await input());
    expect(evaluator.evaluation.dataAccess).toBe("holdout");
  });

  test("inventory digest must match the lease binding", async () => {
    const context = createExecutionContext(await input());
    const otherInventory = await probeHostInventory({ exec: async () => ({ code: 1, stdout: "" }), now: () => new Date("2026-10-25T00:00:00Z") });
    expect(() => validateExecutionContext({ ...context, inventoryDigest: otherInventory.digest })).toThrow(ExecutionContextError);
  });

  test("workspace must be isolated; source and entry are required", async () => {
    expect(() => createExecutionContextSync({ workspace: { root: "/x", isolated: false } })).toThrow(/isolated/);
    expect(() => createExecutionContextSync({ source: "" })).toThrow(/source is required/);
    expect(() => createExecutionContextSync({ evaluation: { entry: "", dataAccess: "public" } })).toThrow(/evaluation.entry/);
    await lease();
  });

  test("tampering with audience or network after creation fails closed", async () => {
    const context = createExecutionContext(await input());
    expect(() => validateExecutionContext({ ...context, network: "open" })).toThrow(/digest mismatch/);
    expect(() => validateExecutionContext({ ...context, audience: "executor" })).toThrow(ExecutionContextError);
  });
});

function createExecutionContextSync(overrides: Record<string, unknown>) {
  if (!sharedLease) throw new Error("lease must be cached by an earlier test");
  return createExecutionContext({
    audience: "executor",
    contract,
    evaluation: { entry: "x", dataAccess: "public" },
    lease: sharedLease,
    workspace: { root: "/runs/task-1", isolated: true },
    network: "none",
    source: "mission-controller",
    ...overrides,
  } as CreateExecutionContextInput);
}
