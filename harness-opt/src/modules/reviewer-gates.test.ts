import { describe, expect, test } from "bun:test";
import { evaluatePreflightGates, evaluateReviewerGates, parseAgentTimeoutSec, type ReviewerGateInput } from "./reviewer-gates";

function input(over: Partial<ReviewerGateInput> = {}): ReviewerGateInput {
  return {
    evidenceOk: true,
    gapCitedPrevious: true,
    knobPaths: ["agent-loop.maxSteps"],
    patchPaths: ["agent-loop.maxSteps"],
    changed: [{ path: "agent-loop.maxSteps", value: 20 }],
    effective: { "agent-loop.maxSteps": 20 },
    runEnd: null,
    scored: true,
    timedOut: false,
    wallS: 1,
    officialTimeoutSec: 90,
    reward: 1,
    baselineReward: 1,
    patchActive: true,
    baselineEffective: null,
    ...over,
  };
}

describe("reviewer gates", () => {
  test("passes in order when the run is real, active, and not worse", () => {
    const report = evaluateReviewerGates(input());
    expect(report.verdict).toBe("accept");
    expect(report.gates.map((gate) => `${gate.id}:${gate.pass}`)).toEqual(["G0:true", "G1:true", "G2:true", "G3:true"]);
  });

  test("G0 stops as anti_forgery and is not a reject", () => {
    const report = evaluateReviewerGates(input({ evidenceOk: false }));
    expect(report.verdict).toBe("anti_forgery");
    expect(report.rejectCode).toBeUndefined();
    expect(report.gates[0]).toEqual({ id: "G0", pass: false });
  });

  test("G1 rejects when the gap knob misses the patch", () => {
    const report = evaluateReviewerGates(input({ knobPaths: ["context.window"], patchPaths: ["agent-loop.maxSteps"] }));
    expect(report.verdict).toBe("reject");
    expect(report.gates[1]?.pass).toBe(false);
  });

  test("G2 rejects when patchActive is false even though the effective value matches", () => {
    const report = evaluateReviewerGates(input({ patchActive: false }));
    expect(report.verdict).toBe("reject");
    expect(report.rejectCode).toBe("inactive_key");
    expect(report.gates[2]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
  });

  test("G2 rejects a leaf that repeats the previous round's effective value", () => {
    const report = evaluateReviewerGates(input({
      baselineEffective: { "agent-loop.maxSteps": 20 },
    }));
    expect(report.verdict).toBe("reject");
    expect(report.rejectCode).toBe("inactive_key");
    expect(report.gates[2]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
  });

  test("G2 rejects an inactive key and a continuation past its cap", () => {
    const missing = evaluateReviewerGates(input({ effective: { "agent-loop.maxSteps": 25 } }));
    expect(missing.verdict).toBe("reject");
    expect(missing.rejectCode).toBe("inactive_key");
    const over = evaluateReviewerGates(input({
      changed: [{ path: "agent-loop.maxContinuationTurns", value: 2 }],
      effective: { "agent-loop.maxContinuationTurns": 2 },
      knobPaths: ["agent-loop.maxContinuationTurns"],
      patchPaths: ["agent-loop.maxContinuationTurns"],
      runEnd: { goalContinuationTurns: 8 },
    }));
    expect(over.verdict).toBe("reject");
    expect(over.rejectCode).toBe("inactive_key");
  });

  test("G2 rejects 44 continuations when the cap is 10 and uses 25 when the run sets none", () => {
    const over = evaluateReviewerGates(input({
      changed: [{ path: "agent-loop.maxContinuationTurns", value: 10 }],
      effective: { "agent-loop.maxContinuationTurns": 10 },
      knobPaths: ["agent-loop.maxContinuationTurns"],
      patchPaths: ["agent-loop.maxContinuationTurns"],
      runEnd: { goalContinuationTurns: 44 },
    }));
    expect(over.verdict).toBe("reject");
    expect(over.rejectCode).toBe("inactive_key");
    expect(over.gates[2]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
    const atCap = evaluateReviewerGates(input({
      changed: [{ path: "agent-loop.maxContinuationTurns", value: 10 }],
      effective: { "agent-loop.maxContinuationTurns": 10 },
      knobPaths: ["agent-loop.maxContinuationTurns"],
      patchPaths: ["agent-loop.maxContinuationTurns"],
      runEnd: { goalContinuationTurns: 10 },
    }));
    expect(atCap.verdict).toBe("accept");
    const unset = evaluateReviewerGates(input({ runEnd: { goalContinuationTurns: 44 } }));
    expect(unset.verdict).toBe("reject");
    expect(unset.rejectCode).toBe("inactive_key");
    const withinDefault = evaluateReviewerGates(input({ runEnd: { goalContinuationTurns: 25 } }));
    expect(withinDefault.verdict).toBe("accept");
  });

  test("G2 rejects a run_end with no finite goalContinuationTurns even when that knob was not changed, and accepts 25 of 25", () => {
    const unchanged = {
      changed: [{ path: "agent-loop.maxSteps", value: 20 }],
      effective: { "agent-loop.maxSteps": 20, "agent-loop.maxContinuationTurns": 25 },
      knobPaths: ["agent-loop.maxSteps"],
      patchPaths: ["agent-loop.maxSteps"],
    };
    const missing = evaluateReviewerGates(input({ ...unchanged, runEnd: { status: "ok" } }));
    expect(missing.verdict).toBe("reject");
    expect(missing.rejectCode).toBe("inactive_key");
    expect(missing.gates[2]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
    const text = evaluateReviewerGates(input({ ...unchanged, runEnd: { goalContinuationTurns: "25" } }));
    expect(text.verdict).toBe("reject");
    expect(text.rejectCode).toBe("inactive_key");
    expect(text.gates[2]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
    const exact = evaluateReviewerGates(input({ ...unchanged, runEnd: { goalContinuationTurns: 25 } }));
    expect(exact.verdict).toBe("accept");
    expect(exact.gates[2]).toEqual({ id: "G2", pass: true });
  });

  test("G3 rejects a timeout flag, a wall time at the official limit, or a reward under the signed baseline", () => {
    expect(evaluateReviewerGates(input({ timedOut: true })).verdict).toBe("reject");
    expect(evaluateReviewerGates(input({ wallS: 90, officialTimeoutSec: 90, timedOut: false })).gates[3]?.pass).toBe(false);
    expect(evaluateReviewerGates(input({ wallS: 89.9, officialTimeoutSec: 90 })).verdict).toBe("accept");
    expect(evaluateReviewerGates(input({ officialTimeoutSec: null })).gates[3]?.pass).toBe(false);
    expect(evaluateReviewerGates(input({ reward: 0, baselineReward: 1 })).gates[3]?.pass).toBe(false);
  });

  test("official agent timeout is the [agent] timeout_sec and nothing else", () => {
    expect(parseAgentTimeoutSec("[verifier]\ntimeout_sec = 12\n[agent]\ntimeout_sec = 90\n")).toBe(90);
    expect(parseAgentTimeoutSec("[agent]\n# timeout_sec = 1\n")).toBeNull();
    expect(parseAgentTimeoutSec("timeout_sec = 30\n")).toBeNull();
  });

  test("preflight records G1 and static G2 and is not a final verdict", () => {
    const pass = evaluatePreflightGates({
      gapCitedPrevious: true,
      knobPaths: ["agent-loop.maxSteps"],
      patchPaths: ["agent-loop.maxSteps"],
      changed: [{ path: "agent-loop.maxSteps", value: 20 }],
      whitelist: ["agent-loop.maxSteps"],
      harnessKeys: ["agent-loop.maxSteps"],
    });
    expect(pass.preflight).toBe(true);
    expect(pass.final).toBe(false);
    expect(pass.gates).toEqual([{ id: "G1", pass: true }, { id: "G2", pass: true }]);
    const inactive = evaluatePreflightGates({
      gapCitedPrevious: true,
      knobPaths: ["notes.foo"],
      patchPaths: ["notes.foo"],
      changed: [{ path: "notes.foo", value: 1 }],
      whitelist: ["agent-loop.maxSteps"],
      harnessKeys: ["agent-loop.maxSteps", "notes.foo"],
    });
    expect(inactive.final).toBe(false);
    expect(inactive.gates[1]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
    const missing = evaluatePreflightGates({
      gapCitedPrevious: false,
      knobPaths: ["goal.maxContinuationTurns"],
      patchPaths: ["goal.maxContinuationTurns"],
      changed: [{ path: "goal.maxContinuationTurns", value: 2 }],
      whitelist: ["goal.maxContinuationTurns"],
      harnessKeys: [],
    });
    expect(missing.gates[0]).toEqual({ id: "G1", pass: false });
    expect(missing.gates[1]).toEqual({ id: "G2", pass: false, code: "inactive_key" });
  });
});
