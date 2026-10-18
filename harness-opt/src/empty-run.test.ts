import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRoleWrite } from "./artifacts";
import { main } from "./cli";
import { runEmpty } from "./empty-run";
import { UnverifiedPiSubagentsDelegator } from "./pi/subagents-port";

function out(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-"));
}

describe("empty round", () => {
  test("one greedy step keeps the better child and the baseline gate blocks submit", () => {
    const dir = out();
    const result = runEmpty({ out: dir });
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
    expect(readFileSync(join(dir, "state", "lineage.jsonl"), "utf8")).toContain("\"kind\":\"review\"");
    expect(readFileSync(join(dir, "gaps.json"), "utf8")).toContain("idle-loop");
  });

  test("reviewer veto rejects the child and does not submit", () => {
    const result = runEmpty({
      out: out(),
      roles: {
        reviewer: () => ({ accept: false, reason: "veto" }),
      },
    });
    expect(result.childStatus).toBe("rejected");
    expect(result.submit).toBe(false);
    expect(result.bestId).toBe("base");
  });

  test("a held-out score above the TTS baseline still does not call playground submit", () => {
    const result = runEmpty({
      out: out(),
      heldout: 0.9,
      ttsBaseline: 0.5,
      baseHeldout: 0.4,
    });
    expect(result.submit).toBe(true);
    expect(result.liveSubmitCalled).toBe(false);
  });

  test("pi-subagents delegation stays an unverified stub", () => {
    expect(() => new UnverifiedPiSubagentsDelegator().schedule("runner", "run", () => 1)).toThrow(/TODO\(pi-subagents\)/);
  });

  test("a role cannot write another role's artifact", () => {
    expect(() => assertRoleWrite("innovator", "gaps.json")).toThrow(/cannot write/);
    expect(() => assertRoleWrite("runner", "traces/t1.json")).not.toThrow();
    expect(() => assertRoleWrite("innovator", "candidates/c1/config.json")).not.toThrow();
  });

  test("cli empty run completes with submit false", () => {
    const dir = out();
    expect(main(["empty", "--out", dir])).toBe(0);
    expect(main(["nope"])).toBe(1);
    const state = JSON.parse(readFileSync(join(dir, "state", "run_state.json"), "utf8")) as { submit: boolean; selector: string };
    expect(state.submit).toBe(false);
    expect(state.selector).toBe("GreedySelector");
  });
});
