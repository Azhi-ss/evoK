/**
 * ET-RSI-LIFT (#174): search-owned one-circle suite lift harness.
 * Public seams only — propose a Candidate, select with default fixed_uct.
 * Not a second control plane. #40 stays off. Score is not a promotion key.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
} from "./search-selection-port";
import {
  DEFAULT_SUITE_LIFT_TARGET,
  SUITE_LIFT_CIRCLE_ID,
  proposeSuiteLiftCandidate,
  runSuiteLiftCircle,
} from "./suite-lift-circle";

async function shippedBaselineFiles(): Promise<Readonly<Record<string, string>>> {
  const demo = join(process.cwd(), "examples", "demo-suite");
  return { "src/solve.js": await readFile(join(demo, "src", "solve.js"), "utf8") };
}

describe("suite-lift one-circle harness (ET-RSI-LIFT / #174)", () => {
  test("default parent selection stays fixed_uct and the circle does not unfreeze #40", () => {
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
    expect(createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(SUITE_LIFT_CIRCLE_ID).toBe("suite_lift_one_circle");
    expect(DEFAULT_SUITE_LIFT_TARGET).toBe(0.8);
  });

  test("the shipped demo-suite helpers get a local completion proposal, not a self-score", async () => {
    const baseline = await shippedBaselineFiles();
    const proposal = proposeSuiteLiftCandidate(baseline);
    expect(proposal.selectionId).toBe("fixed_uct");
    expect(proposal.selectionPolicy40).toBe("off");
    expect(proposal.files["src/solve.js"]).toBeDefined();
    expect(proposal.files["src/solve.js"]).not.toBe(baseline["src/solve.js"]);
    expect(proposal.files["src/solve.js"]).toMatch(/function sum\(a,\s*b\)/);
    expect(proposal.files["src/solve.js"]).toMatch(/return a \+ b/);
    expect(proposal.files["src/solve.js"]).not.toMatch(/^\s*0\.8\s*$/m);
    expect(proposal.files["src/solve.js"]).not.toMatch(/I scored|self-score|pass_rate\s*=\s*1/);
    expect(proposal.note).toMatch(/independent|measure/i);
  });

  test("one circle selects the unvisited helper-completion child with default fixed_uct", async () => {
    const baseline = await shippedBaselineFiles();
    const circle = runSuiteLiftCircle({
      baselineFiles: baseline,
      baselineScore: 0.4,
    });
    expect(circle.circleId).toBe(SUITE_LIFT_CIRCLE_ID);
    expect(circle.selection.adapterId).toBe("fixed_uct");
    expect(circle.selectionPolicy40).toBe("off");
    expect(circle.selectedNodeId).toBe("helper-completion");
    expect(circle.proposal.files["src/solve.js"]).not.toBe(baseline["src/solve.js"]);
    expect(circle.liftTarget).toBe(0.8);
  });

  test("an identity proposer yields only the baseline node and does not invent Progressive", async () => {
    const baseline = await shippedBaselineFiles();
    const circle = runSuiteLiftCircle({
      baselineFiles: baseline,
      baselineScore: 0.4,
      propose: (files) => ({
        files: { ...files },
        note: "identity",
        selectionId: DEFAULT_SEARCH_SELECTION_ID,
        selectionPolicy40: SELECTION_POLICY_40,
      }),
    });
    expect(circle.selectedNodeId).toBe("identity");
    expect(circle.proposal.files["src/solve.js"]).toBe(baseline["src/solve.js"]);
    expect(circle.selection.adapterId).toBe("fixed_uct");
    expect(circle.selectionPolicy40).toBe("off");
  });
});
