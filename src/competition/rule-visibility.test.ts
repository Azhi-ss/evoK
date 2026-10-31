/**
 * RuleVisibilityPolicy: per-competition "which rules go to whom". Closed
 * catalog — unknown or unsafe fields are rejected; a role the policy does
 * not name gets an empty summary; the policy is bound to one contract digest.
 */
import { describe, expect, test } from "bun:test";
import { createCompetitionContract } from "./competition-contract";
import {
  RULE_SUMMARY_FIELDS,
  RuleVisibilityError,
  createRuleVisibilityPolicy,
  summarizeRulesForRole,
  validateRuleVisibilityPolicy,
} from "./rule-visibility";

const contractA = createCompetitionContract({
  version: "2026.1",
  competitionId: "challenge-a",
  objective: "Predict the target for challenge A.",
  scoring: { metric: "rmse", direction: "minimize" },
  dataSplit: { kind: "kfold", folds: 5, holdout: "protected" },
  submission: { format: "csv:id,prediction", maxPerDay: 5, quota: 50 },
  limits: { timeLimitMs: 3_600_000, network: "none", allowedResources: ["cpu", "gpu"] },
});

const contractB = createCompetitionContract({
  version: "1.0",
  competitionId: "challenge-b",
  objective: "Classify the series for challenge B.",
  scoring: { metric: "logloss", direction: "minimize" },
  dataSplit: { kind: "time", purge: "7d", embargo: "1d", holdout: "protected" },
  submission: { format: "parquet:id,prob" },
  limits: { network: "restricted" },
});

describe("rule visibility policy", () => {
  test("independent competitions keep independent rule summaries", () => {
    const policyA = createRuleVisibilityPolicy({
      competitionId: "challenge-a",
      contractDigest: contractA.digest,
      allow: { researcher: ["objective", "scoring.metric", "dataSplit.kind", "dataSplit.folds"] },
    });
    const policyB = createRuleVisibilityPolicy({
      competitionId: "challenge-b",
      contractDigest: contractB.digest,
      allow: { researcher: ["objective", "dataSplit.purge", "dataSplit.embargo"] },
    });
    expect(summarizeRulesForRole(contractA, policyA, "researcher")).toEqual({
      objective: "Predict the target for challenge A.",
      "scoring.metric": "rmse",
      "dataSplit.kind": "kfold",
      "dataSplit.folds": 5,
    });
    expect(summarizeRulesForRole(contractB, policyB, "researcher")).toEqual({
      objective: "Classify the series for challenge B.",
      "dataSplit.purge": "7d",
      "dataSplit.embargo": "1d",
    });
  });

  test("a role the policy does not name gets an empty summary (no broadcast)", () => {
    const policy = createRuleVisibilityPolicy({
      competitionId: "challenge-a",
      contractDigest: contractA.digest,
      allow: { critic: ["scoring.metric"] },
    });
    expect(summarizeRulesForRole(contractA, policy, "critic")).toEqual({ "scoring.metric": "rmse" });
    expect(summarizeRulesForRole(contractA, policy, "researcher")).toEqual({});
    expect(summarizeRulesForRole(contractA, policy, "reviewer")).toEqual({});
  });

  test("unknown and unsafe fields are rejected at policy creation", () => {
    const base = { competitionId: "challenge-a", contractDigest: contractA.digest };
    expect(() => createRuleVisibilityPolicy({ ...base, allow: { researcher: ["rules.body"] } })).toThrow(RuleVisibilityError);
    expect(() => createRuleVisibilityPolicy({ ...base, allow: { researcher: ["resources.cpus"] } })).toThrow(/not in the safe summary catalog/);
    expect(() => createRuleVisibilityPolicy({ ...base, allow: { researcher: ["credentials"] } })).toThrow(RuleVisibilityError);
    expect(() => createRuleVisibilityPolicy({ ...base, allow: { researcher: ["submission.quota"] } })).toThrow(RuleVisibilityError);
    expect(() => createRuleVisibilityPolicy({ ...base, allow: { evaluator: ["objective"] } as never })).toThrow(/role must be one of/);
  });

  test("policy is bound to its contract: digest or competitionId drift fails", () => {
    const policy = createRuleVisibilityPolicy({
      competitionId: "challenge-a",
      contractDigest: contractA.digest,
      allow: { researcher: ["objective"] },
    });
    expect(() => summarizeRulesForRole(contractB, policy, "researcher")).toThrow(/competitionId does not match/);
    const rebound = createRuleVisibilityPolicy({
      competitionId: "challenge-a",
      contractDigest: contractB.digest,
      allow: { researcher: ["objective"] },
    });
    expect(() => summarizeRulesForRole(contractA, rebound, "researcher")).toThrow(/contractDigest does not match/);
  });

  test("policy digest validates and tampering fails closed", () => {
    const policy = createRuleVisibilityPolicy({
      competitionId: "challenge-a",
      contractDigest: contractA.digest,
      allow: { researcher: ["objective"] },
    });
    const restored = validateRuleVisibilityPolicy(JSON.parse(JSON.stringify(policy)));
    expect(restored).toEqual(policy);
    expect(() => validateRuleVisibilityPolicy({ ...policy, allow: { researcher: ["objective", "limits.network"] } }))
      .toThrow(/digest mismatch/);
  });

  test("every catalog field resolves to a scalar or is skipped", () => {
    const policy = createRuleVisibilityPolicy({
      competitionId: "challenge-b",
      contractDigest: contractB.digest,
      allow: { reviewer: [...RULE_SUMMARY_FIELDS] },
    });
    const summary = summarizeRulesForRole(contractB, policy, "reviewer");
    // challenge-b has no folds/timeLimitMs: missing fields are skipped, not null-filled.
    expect(summary["dataSplit.folds"]).toBeUndefined();
    expect(summary["limits.network"]).toBe("restricted");
    expect(summary["submission.format"]).toBe("parquet:id,prob");
  });
});
