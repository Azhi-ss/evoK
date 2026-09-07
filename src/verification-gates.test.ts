import { describe, expect, test } from "bun:test";
import {
  VERIFICATION_ROLE_CONTRACTS,
  normalizeVerificationResult,
  verificationRoleContract,
} from "./verification-gates";

describe("verification role contracts", () => {
  test("keeps each verifier's trigger and input contract distinct", () => {
    expect(verificationRoleContract("SelfVerifier")).toMatchObject({ trigger: "before-expensive-execution", input: "task-contract" });
    expect(verificationRoleContract("Falsifier")).toMatchObject({ trigger: "after-snapshot", input: "candidate-snapshot" });
    expect(verificationRoleContract("Critic")).toMatchObject({ trigger: "after-snapshot", input: "candidate-snapshot" });
    expect(verificationRoleContract("Challenger")).toMatchObject({ trigger: "after-snapshot", input: "candidate-snapshot" });
    expect(verificationRoleContract("Auditor")).toMatchObject({ trigger: "after-evaluation", input: "evidence" });
    expect(verificationRoleContract("SuccessAuditor")).toMatchObject({ trigger: "before-promotion", input: "success-claim" });
    expect(verificationRoleContract("KillTester")).toMatchObject({ trigger: "before-promotion", input: "success-claim" });
    expect(new Set(Object.values(VERIFICATION_ROLE_CONTRACTS).map((contract) => contract.purpose)).size).toBe(7);
    expect(Object.values(VERIFICATION_ROLE_CONTRACTS).every((contract) => contract.authoritative === false)).toBe(true);
  });

  test("fails closed on malformed verification output", () => {
    expect(normalizeVerificationResult({ ok: true, objections: [] }, "Critic")).toEqual({ ok: true, objections: [] });
    expect(normalizeVerificationResult({ ok: "true" }, "Critic")).toMatchObject({ ok: false });
    expect(normalizeVerificationResult({ ok: true, objections: "none" }, "Auditor")).toMatchObject({ ok: false });
    expect(normalizeVerificationResult(undefined, "SuccessAuditor").objections[0]).toContain("SuccessAuditor");
  });
});
