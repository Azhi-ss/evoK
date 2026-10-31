/**
 * RoleTaskContext: per-role injectable Task Contract. Rule detail comes only
 * from the competition policy's per-role allowlist; the audit block records
 * role, contract digest, policy digest, and injection source; the whole
 * context is content-addressed. buildResearcherContext stays unchanged
 * (backward compatibility).
 */
import { describe, expect, test } from "bun:test";
import { createCompetitionContract } from "../competition/competition-contract";
import { createRuleVisibilityPolicy } from "../competition/rule-visibility";
import { probeHostInventory } from "./host-inventory";
import { grantResourceLease } from "./resource-lease";
import { buildResearcherContext } from "./researcher-context";
import {
  RoleContextError,
  assembleRoleContext,
  validateRoleContext,
  type AssembleRoleContextInput,
} from "./role-context";

const contract = createCompetitionContract({
  version: "2026.1",
  competitionId: "challenge-a",
  objective: "Predict the target within the split discipline.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction", maxPerDay: 5, quota: 50 },
  limits: { timeLimitMs: 3_600_000, network: "none" },
  resources: { cpus: 8, memoryBytes: 32 * 1024 ** 3, gpu: { backend: "cuda", count: 1, minMemoryBytes: 40 * 1024 ** 3 } },
});

const policy = createRuleVisibilityPolicy({
  competitionId: "challenge-a",
  contractDigest: contract.digest,
  allow: {
    researcher: ["objective", "scoring.metric", "scoring.direction", "dataSplit.kind", "submission.format", "limits.network"],
    critic: ["scoring.metric", "dataSplit.holdout"],
    // reviewer intentionally absent: gets an empty rule summary.
  },
});

async function input(role: "researcher" | "critic" | "reviewer"): Promise<AssembleRoleContextInput> {
  const inventory = await probeHostInventory({
    exec: async () => ({ code: 0, stdout: "0, NVIDIA A100-SXM4-80GB, GPU-aaaa, 81920\n" }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
  const lease = grantResourceLease({ inventory, taskId: "task-1", request: { cpus: 4, gpus: 1 }, now: () => new Date("2026-10-24T01:00:00Z") });
  return {
    role,
    contract,
    policy,
    source: "team-coordinator",
    objective: "Improve the feature pipeline.",
    hypothesis: "Target encoding reduces overfit.",
    evidenceRefs: ["ledger:exp-1"],
    allowedPaths: ["src/features/**"],
    tools: ["read", "edit", "bash"],
    lease,
  };
}

describe("role task context", () => {
  test("each role receives exactly its allowlisted rule summary", async () => {
    const researcher = assembleRoleContext(await input("researcher"));
    expect(researcher.rules).toEqual({
      objective: "Predict the target within the split discipline.",
      "scoring.metric": "rmse",
      "scoring.direction": "minimize",
      "dataSplit.kind": "kfold",
      "submission.format": "csv:id,prediction",
      "limits.network": "none",
    });
    const critic = assembleRoleContext(await input("critic"));
    expect(critic.rules).toEqual({ "scoring.metric": "rmse", "dataSplit.holdout": "protected" });
    const reviewer = assembleRoleContext(await input("reviewer"));
    expect(reviewer.rules).toEqual({});
  });

  test("typed resource requirements and quota never enter any role context", async () => {
    for (const role of ["researcher", "critic", "reviewer"] as const) {
      const context = assembleRoleContext(await input(role));
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain("34359738368"); // resources.memoryBytes
      expect(serialized).not.toContain("minMemoryBytes");
      expect(serialized).not.toContain("\"quota\"");
      expect(serialized).not.toContain("GPU-aaaa");
    }
  });

  test("audit records role, contract digest, policy digest, and source; context digest validates", async () => {
    const context = assembleRoleContext(await input("researcher"));
    expect(context.audit).toEqual({
      role: "researcher",
      contractDigest: contract.digest,
      policyDigest: policy.digest,
      source: "team-coordinator",
    });
    expect(context.schema).toBe("evok.role-context/v1");
    expect(Object.isFrozen(context)).toBe(true);
    const restored = validateRoleContext(JSON.parse(JSON.stringify(context)));
    expect(restored).toEqual(context);
  });

  test("a policy bound to another contract fails closed", async () => {
    const other = createCompetitionContract({
      version: "1.0",
      competitionId: "challenge-b",
      objective: "Other competition.",
      scoring: { metric: "logloss", direction: "minimize" },
      dataSplit: { kind: "time", holdout: "protected" },
      submission: { format: "csv" },
      limits: { network: "restricted" },
    });
    const base = await input("researcher");
    expect(() => assembleRoleContext({ ...base, contract: other })).toThrow(RoleContextError);
    expect(() => assembleRoleContext({ ...base, contract: other })).toThrow(/does not match/);
  });

  test("digest tampering and audit/role mismatch fail validation", async () => {
    const context = assembleRoleContext(await input("researcher"));
    expect(() => validateRoleContext({ ...context, tools: ["read", "bash", "write"] })).toThrow(/digest mismatch/);
    expect(() => validateRoleContext({ ...context, audit: { ...context.audit, role: "critic" } })).toThrow(/audit.role must match/);
    expect(() => validateRoleContext({ ...context, role: "executor" })).toThrow(/role must be one of/);
  });

  test("backward compatibility: buildResearcherContext output is unchanged", async () => {
    const base = buildResearcherContext({ objective: "x", tools: ["read"] }) as unknown as Record<string, unknown>;
    expect(base.schema).toBe("evok.researcher-context/v1");
    expect(base.rules).toBeUndefined();
    expect(base.audit).toBeUndefined();
    expect(base.role).toBeUndefined();
  });
});
