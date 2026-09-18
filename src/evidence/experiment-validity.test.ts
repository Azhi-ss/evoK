/**
 * ET-M1-EXP / #142 — Experiment-validity gate.
 *
 * Seam: evaluateExperimentValidity / experimentValidityIsPass.
 * Validity is not optimality. Inconclusive is not pass. These predicates
 * are new experiment-validity rules, not Kill-test / AtCoder hang copies.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateExperimentValidity,
  experimentValidityIsPass,
} from "./experiment-validity";

describe("experiment validity — effective ≠ optimal, inconclusive ≠ pass", () => {
  test("inconclusive is recorded and is not pass", () => {
    const decision = evaluateExperimentValidity({
      slices: [{ kind: "official_samples", present: true, outcome: "inconclusive" }],
    });
    expect(decision.outcome).toBe("inconclusive");
    expect(decision.ok).toBe(false);
    expect(experimentValidityIsPass(decision.outcome)).toBe(false);
    expect(decision.blocksAdmission).toBe(true);
    expect(decision.objections.join(" ")).toMatch(/inconclusive|not pass/i);
  });

  test("effective on official samples is not optimality and does not claim pass-as-optimal", () => {
    const decision = evaluateExperimentValidity({
      claimed: "effective",
      slices: [{ kind: "official_samples", present: true, outcome: "pass" }],
    });
    expect(decision.effective).toBe(true);
    expect(decision.optimal).toBe(false);
    expect(decision.outcome).toBe("pass");
    expect(decision.ok).toBe(true);
    expect(decision.blocksAdmission).toBe(true);
    expect(decision.slices.protectedHoldout).toBe(false);
  });

  test("claiming optimal from official samples alone fails closed", () => {
    const decision = evaluateExperimentValidity({
      claimed: "optimal",
      slices: [{ kind: "official_samples", present: true, outcome: "pass" }],
    });
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("fail");
    expect(decision.optimal).toBe(false);
    expect(decision.blocksAdmission).toBe(true);
    expect(decision.objections.join(" ")).toMatch(/effective|optimal/i);
  });

  test("an explicit hang point is inconclusive, not a silent pass", () => {
    const decision = evaluateExperimentValidity({
      hang: true,
      slices: [
        { kind: "official_samples", present: true, outcome: "pass" },
        { kind: "adversarial_labeled", present: true, outcome: "pass" },
        { kind: "protected_holdout", present: true, outcome: "pass" },
      ],
    });
    expect(decision.hang).toBe(true);
    expect(decision.outcome).toBe("inconclusive");
    expect(decision.ok).toBe(false);
    expect(decision.blocksAdmission).toBe(true);
    expect(decision.objections.join(" ")).toMatch(/hang/i);
  });

  test("a complete measured set is validity pass and does not by itself block Admission", () => {
    const decision = evaluateExperimentValidity({
      slices: [
        { kind: "official_samples", present: true, outcome: "pass" },
        { kind: "adversarial_labeled", present: true, outcome: "pass" },
        { kind: "protected_holdout", present: true, outcome: "pass" },
      ],
    });
    expect(decision.ok).toBe(true);
    expect(decision.blocksAdmission).toBe(false);
    expect(decision.slices).toEqual({
      officialSamples: true,
      adversarialLabeled: true,
      protectedHoldout: true,
    });
  });

  test("no measured slices is inconclusive, not a free pass", () => {
    const decision = evaluateExperimentValidity({ slices: [] });
    expect(decision.outcome).toBe("inconclusive");
    expect(decision.ok).toBe(false);
    expect(experimentValidityIsPass("inconclusive")).toBe(false);
    expect(experimentValidityIsPass("fail")).toBe(false);
    expect(experimentValidityIsPass("pass")).toBe(true);
  });
});
