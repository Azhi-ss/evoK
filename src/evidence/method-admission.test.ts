/**
 * ET-M1-EXP / #142 — Method Admission + writeback shape.
 *
 * Seams: evaluateMethodAdmission / MethodWritebackSession.
 * Missing protected holdout refuses Admission. Elite / score / Fan-Out
 * are not Admission keys. Writeback is propose → regression → admit/rollback,
 * one slice at a time.
 */
import { describe, expect, test } from "bun:test";
import { evaluateExperimentValidity } from "./experiment-validity";
import {
  MethodWritebackIsolationError,
  MethodWritebackSession,
  evaluateMethodAdmission,
} from "./method-admission";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search-selection-port";

function validityPass() {
  return evaluateExperimentValidity({
    slices: [
      { kind: "official_samples", present: true, outcome: "pass" },
      { kind: "adversarial_labeled", present: true, outcome: "pass" },
      { kind: "protected_holdout", present: true, outcome: "pass" },
    ],
  });
}

describe("Admission minimal set — official + adversarial + protected holdout", () => {
  test("missing protected holdout refuses Admission", () => {
    const validity = evaluateExperimentValidity({
      claimed: "effective",
      slices: [
        { kind: "official_samples", present: true, outcome: "pass" },
        { kind: "adversarial_labeled", present: true, outcome: "pass" },
      ],
    });
    expect(validity.ok).toBe(true);
    const admission = evaluateMethodAdmission({
      validity,
      slices: {
        officialSamples: true,
        adversarialLabeled: true,
        protectedHoldout: false,
      },
    });
    expect(admission.ok).toBe(false);
    expect(admission.admitted).toBe(false);
    expect(admission.outcome).toBe("fail");
    expect(admission.objections.join(" ")).toMatch(/protected holdout/i);
  });

  test("incomplete official or adversarial subset also refuses", () => {
    const validity = validityPass();
    const missingOfficial = evaluateMethodAdmission({
      validity,
      slices: { officialSamples: false, adversarialLabeled: true, protectedHoldout: true },
    });
    const missingAdversarial = evaluateMethodAdmission({
      validity,
      slices: { officialSamples: true, adversarialLabeled: false, protectedHoldout: true },
    });
    expect(missingOfficial.admitted).toBe(false);
    expect(missingAdversarial.admitted).toBe(false);
    expect(missingOfficial.objections.join(" ")).toMatch(/official samples/i);
    expect(missingAdversarial.objections.join(" ")).toMatch(/adversarial/i);
  });

  test("complete minimal set plus validity pass admits", () => {
    const admission = evaluateMethodAdmission({
      validity: validityPass(),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
      protocolVersion: "exp-w1",
      evidenceDigest: "sha256:admission-pass",
    });
    expect(admission.ok).toBe(true);
    expect(admission.admitted).toBe(true);
    expect(admission.outcome).toBe("pass");
    expect(admission.protocolVersion).toBe("exp-w1");
    expect(admission.evidenceDigest).toBe("sha256:admission-pass");
  });

  test("validity hang is an explicit hang point and is not Admission pass", () => {
    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({ hang: true, slices: [] }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
    });
    expect(admission.hang).toBe(true);
    expect(admission.admitted).toBe(false);
    expect(admission.outcome).toBe("inconclusive");
    expect(admission.ok).toBe(false);
  });

  test("Elite, score, or Team Fan-Out cannot substitute for the holdout", () => {
    const admission = evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [{ kind: "official_samples", present: true, outcome: "pass" }],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
      elite: true,
      teamFanOut: true,
      score: 99,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.outcome).toBe("fail");
    expect(admission.objections.join(" ")).toMatch(/protected holdout/i);
    expect(admission.objections.join(" ")).not.toMatch(/elite|fan-out|score/i);
  });
});

describe("method writeback — propose → regression → admit / rollback", () => {
  test("failed or inconclusive regression rolls back and never admits", () => {
    const session = new MethodWritebackSession();
    const proposed = session.propose({ sliceId: "skill:try-search", kind: "skill", targetName: "try-search" });
    expect(proposed.phase).toBe("propose");
    expect(proposed.currentState).toBe("candidate");

    const failed = session.regress("fail");
    expect(failed.phase).toBe("rolled_back");
    expect(failed.currentState).toBe("candidate");
    expect(failed.admitted).toBe(false);

    const again = new MethodWritebackSession();
    again.propose({ sliceId: "harness:template", kind: "harness", targetName: "template" });
    const hung = again.regress("inconclusive");
    expect(hung.phase).toBe("rolled_back");
    expect(hung.admitted).toBe(false);
    expect(hung.objections.join(" ")).toMatch(/inconclusive|not pass/i);
  });

  test("regression pass still refuses admit without Admission pass", () => {
    const session = new MethodWritebackSession();
    session.propose({ sliceId: "skill:try-search", kind: "skill", targetName: "try-search" });
    expect(session.regress("pass").phase).toBe("regression");
    const refused = session.admit(evaluateMethodAdmission({
      validity: evaluateExperimentValidity({
        claimed: "effective",
        slices: [{ kind: "official_samples", present: true, outcome: "pass" }],
      }),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: false },
    }));
    expect(refused.admitted).toBe(false);
    expect(refused.currentState).toBe("candidate");
    expect(refused.phase).toBe("rolled_back");
    expect(refused.objections.join(" ")).toMatch(/protected holdout/i);
  });

  test("one slice at a time; a second open slice is refused", () => {
    const session = new MethodWritebackSession();
    session.propose({ sliceId: "skill:one", kind: "skill", targetName: "one" });
    expect(() => session.propose({ sliceId: "skill:two", kind: "skill", targetName: "two" }))
      .toThrow(MethodWritebackIsolationError);
    expect(() => session.propose({ sliceId: "skill:two", kind: "skill", targetName: "two" }))
      .toThrow(/one slice/i);
  });

  test("admit after regression pass + Admission pass; rollback demotes an accepted slice", () => {
    const session = new MethodWritebackSession();
    session.propose({ sliceId: "skill:keep", kind: "skill", targetName: "keep" });
    session.regress("pass");
    const admitted = session.admit(evaluateMethodAdmission({
      validity: validityPass(),
      slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
      evidenceDigest: "sha256:keep",
    }));
    expect(admitted.phase).toBe("admitted");
    expect(admitted.currentState).toBe("accepted");
    expect(admitted.admitted).toBe(true);

    const rolled = session.rollback();
    expect(rolled.phase).toBe("rolled_back");
    expect(rolled.currentState).toBe("demoted");
    expect(rolled.admitted).toBe(false);
  });
});

describe("EXP gate does not thaw frozen pins", () => {
  test("default search stays fixed_uct and #40 stays off", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });
});
