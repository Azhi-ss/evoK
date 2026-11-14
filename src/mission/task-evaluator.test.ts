import { describe, expect, test } from "bun:test";
import { createTaskArtifactEvaluator, taskContractErrors } from "./task-evaluator";
import { classifyRunOutcome } from "../evidence/run-outcome";

describe("scientific task evaluation", () => {
  test("measure tasks keep the Mission evaluator", () => {
    expect(createTaskArtifactEvaluator({ taskId: "t", objective: "measure", kind: "measure" })).toBeUndefined();
  });

  test("investigate succeeds on declared artifacts without a scientific score", async () => {
    const evaluator = createTaskArtifactEvaluator({
      taskId: "t", objective: "review evidence", kind: "investigate", artifacts: ["notes/evidence.md"],
    })!;
    const result = await evaluator.evaluate({ "notes/evidence.md": "observed evidence" }, {} as never);
    expect(result.ok).toBe(true);
    expect(result.score).toBeUndefined();
    expect(result.facts?.[0]?.source).toBe("notes/evidence.md");
  });

  test("repair without artifacts or with missing artifacts is a protocol failure, not a refutation", async () => {
    expect(taskContractErrors({ kind: "repair" })[0]).toContain("protocol:");
    const evaluator = createTaskArtifactEvaluator({
      taskId: "t", objective: "repair runner", kind: "repair", artifacts: ["repair.log"],
    })!;
    const result = await evaluator.evaluate({}, {} as never);
    expect(result.ok).toBe(false);
    expect(result.ruleViolations?.[0]).toContain("protocol:");
    expect(classifyRunOutcome({ ok: false, ruleViolations: result.ruleViolations }).state).toBe("operational");
    expect(classifyRunOutcome({ ok: false, ruleViolations: result.ruleViolations }).scientificNegativeEvidence).toBe(false);
  });

  test("artifact paths cannot escape the workspace", () => {
    expect(taskContractErrors({ kind: "investigate", artifacts: ["../secret"] })[0]).toContain("protocol:");
    expect(taskContractErrors({ kind: "investigate", artifacts: ["/tmp/secret"] })[0]).toContain("protocol:");
  });
});
