import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRoleRead, assertRoleTool, assertRoleWrite } from "./artifacts";
import { main } from "./cli";
import { runEmpty } from "./empty-run";
import { UnverifiedPiSubagentsDelegator } from "./pi/subagents-port";

function out(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-"));
}

describe("empty round", () => {
  test("one greedy step keeps the better child and the baseline gate blocks submit", async () => {
    const dir = out();
    const result = await runEmpty({ out: dir });
    expect(result.selector).toBe("GreedySelector");
    expect(result.submit).toBe(false);
    expect(result.heldout).toBe(0.1);
    expect(result.childStatus).toBe("evaluated");
    expect(result.bestId).toBe("c1");
    expect(result.liveSubmitCalled).toBe(false);
    const proposal = readFileSync(join(dir, "candidates", "c1", "config.json"), "utf8");
    expect(proposal).not.toContain("held-out");
    expect(proposal).toContain("\"retries\": 1");
    const child = readFileSync(join(dir, "state", "nodes", "c1.json"), "utf8");
    expect(child).toContain("\"stage\": \"full\"");
    const lineageLog = readFileSync(join(dir, "state", "lineage.jsonl"), "utf8");
    expect(lineageLog).toContain("\"kind\":\"review\"");
    expect(lineageLog).not.toContain("heldout");
    expect(lineageLog).not.toContain("0.1");
    const saved = JSON.parse(readFileSync(join(dir, "state", "run_state.json"), "utf8")) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("heldout");
    expect(JSON.stringify(saved)).not.toContain("0.1");
    expect(readFileSync(join(dir, "state", "gate.jsonl"), "utf8")).toContain("\"heldout\":0.1");
    expect(readFileSync(join(dir, "gaps.json"), "utf8")).toContain("idle-loop");
    const gapsMd = readFileSync(join(dir, "gaps.md"), "utf8");
    for (const field of ["id:", "failureClass:", "summary:", "traceIds:"]) {
      expect(gapsMd).toContain(field);
    }
    const patch = JSON.parse(readFileSync(join(dir, "patch.json"), "utf8")) as Record<string, unknown>;
    expect(patch).toMatchObject({
      part: "agent-loop",
      expectedFailureClass: "idle-loop",
    });
    expect(typeof patch.motivation).toBe("string");
    expect(result.failedChecks).toEqual(expect.arrayContaining(["held-out", "tts", "playground-submit-dry-run"]));
    expect(readFileSync(join(dir, "evidence_pack", "change-note.md"), "utf8").trim().length).toBeGreaterThan(0);
  });

  test("reviewer veto rejects the child and does not submit", async () => {
    const result = await runEmpty({
      out: out(),
      roles: {
        reviewer: () => ({ accept: false, reason: "veto" }),
      },
    });
    expect(result.childStatus).toBe("rejected");
    expect(result.submit).toBe(false);
    expect(result.bestId).toBe("base");
  });

  test("a green numeric gate still does not live-submit, and a missing dry-run stays shut", async () => {
    const blocked = await runEmpty({
      out: out(),
      heldout: 0.9,
      ttsBaseline: 0.5,
      baseHeldout: 0.4,
    });
    expect(blocked.submit).toBe(false);
    expect(blocked.failedChecks).toContain("held-out");
    expect(blocked.failedChecks).toContain("playground-submit-dry-run");
    expect(blocked.liveSubmitCalled).toBe(false);
    const greenDir = out();
    const opened = await runEmpty({
      out: greenDir,
      heldout: 0.9,
      ttsBaseline: 0.5,
      baseHeldout: 0.4,
      minDelta: 0.1,
      dryRun: "passed",
      tts: "passed",
    });
    expect(opened.submit).toBe(true);
    expect(opened.liveSubmitCalled).toBe(false);
    expect(opened.failedChecks).toEqual([]);
    const receipt = JSON.parse(readFileSync(join(greenDir, "submit-receipt.json"), "utf8")) as { submitted: boolean };
    expect(receipt.submitted).toBe(false);
  });

  test("the retired unverified scheduler still throws", async () => {
    expect(() => new UnverifiedPiSubagentsDelegator().schedule("runner", "run", () => 1)).toThrow(/TODO\(pi-subagents\)/);
  });

  test("a role cannot write another role's artifact", async () => {
    expect(() => assertRoleWrite("innovator", "gaps.json")).toThrow(/cannot write/);
    expect(() => assertRoleWrite("runner", "traces/t1.json")).not.toThrow();
    expect(() => assertRoleWrite("innovator", "candidates/c1/config.json")).not.toThrow();
    expect(() => assertRoleWrite("innovator", "candidates/base/config.json")).toThrow(/baseline/);
    expect(() => assertRoleWrite("innovator", "candidates/base")).toThrow(/baseline/);
    expect(() => assertRoleWrite("innovator", "candidates/base-copy/config.json")).not.toThrow();
    expect(() => assertRoleWrite("orchestrator", "candidates/base/config.json")).not.toThrow();
    expect(() => assertRoleWrite("innovator", "sealed/heldout-score.json")).toThrow(/held-out/);
    expect(() => assertRoleRead("innovator", "sealed/heldout-score.json")).toThrow(/held-out/);
    expect(() => assertRoleRead("gap-finder", "state/gate.jsonl")).toThrow(/gate log/);
    expect(() => assertRoleRead("innovator", "state/gate.jsonl")).toThrow(/gate log/);
    expect(() => assertRoleRead("reviewer-gate", "state/gate.jsonl")).toThrow(/gate log/);
    expect(() => assertRoleRead("runner", "state/gate.jsonl")).toThrow(/gate log/);
    expect(() => assertRoleRead("orchestrator", "state/gate.jsonl")).not.toThrow();
    expect(() => assertRoleRead("gap-finder", "review.json")).toThrow(/cannot read/);
    expect(() => assertRoleRead("gap-finder", "traces/t1.json")).not.toThrow();
    expect(() => assertRoleTool("innovator", "bash")).toThrow(/cannot use tool/);
    expect(() => assertRoleTool("reviewer-gate", "contact_supervisor")).toThrow(/cannot use tool/);
    expect(() => assertRoleTool("gap-finder", "write")).toThrow(/cannot use tool/);
    expect(() => assertRoleTool("reviewer-gate", "read")).not.toThrow();
  });

  test("cli empty run completes with submit false", async () => {
    const dir = out();
    expect(await main(["empty", "--out", dir])).toBe(0);
    expect(await main(["nope"])).toBe(1);
    const state = JSON.parse(readFileSync(join(dir, "state", "run_state.json"), "utf8")) as { submit: boolean; selector: string };
    expect(state.submit).toBe(false);
    expect(state.selector).toBe("GreedySelector");
  });
});
