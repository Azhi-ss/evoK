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
  test("schedules the fixed machine and the evidence gate blocks submit", () => {
    const dir = out();
    let innovatorKeys: string[] = [];
    const result = runEmpty({
      out: dir,
      handlers: {
        innovator: (input) => {
          innovatorKeys = Object.keys(input);
          return {
            part: "agent-loop",
            motivation: "cap the idle reread",
            expectedFailureClass: "idle-loop",
            changes: { maxSteps: 4 },
          };
        },
      },
    });
    expect(result.visits).toEqual(["gap-finder", "innovator", "runner", "reviewer", "report-writer"]);
    expect(result.accepted).toBe(true);
    expect(result.receipt).toBeNull();
    expect(result.stoppedReason).toContain("evidence gate refused");
    expect(innovatorKeys).not.toContain("heldOut");
    const lineage = readFileSync(join(dir, "lineage.json"), "utf8");
    expect(lineage).toContain("\"status\": \"accepted\"");
    expect(readFileSync(join(dir, "gaps.json"), "utf8")).toContain("idle-loop");
    expect(readFileSync(join(dir, "review.json"), "utf8")).toContain("staged-threshold");
  });

  test("reviewer veto stops before the report writer", () => {
    const result = runEmpty({
      out: out(),
      handlers: {
        reviewer: () => ({ accept: false, reason: "veto", criterionId: "staged-threshold" }),
      },
    });
    expect(result.accepted).toBe(false);
    expect(result.phases).not.toContain("report-writer");
    expect(result.node?.status).toBe("rejected");
  });

  test("a green gate dry-runs and does not live-submit", () => {
    const result = runEmpty({
      out: out(),
      tts: "passed",
      heldOutScore: 70,
    });
    expect(result.evidence?.ok).toBe(true);
    expect(result.phases).toContain("submitter");
    expect(result.receipt).toMatchObject({ mode: "dry-run", submitted: false, ok: true });
  });

  test("pi-subagents delegation stays an unverified stub", () => {
    expect(() => new UnverifiedPiSubagentsDelegator().schedule("runner", "run", () => 1)).toThrow(/TODO\(pi-subagents\)/);
  });

  test("a role cannot write another role's artifact", () => {
    expect(() => assertRoleWrite("innovator", "gaps.json")).toThrow(/cannot write/);
    expect(() => assertRoleWrite("runner", "traces/t1.json")).not.toThrow();
  });

  test("cli empty run completes", () => {
    const dir = out();
    expect(main(["empty", "--out", dir])).toBe(0);
    expect(main(["nope"])).toBe(1);
    const state = JSON.parse(readFileSync(join(dir, "run_state.json"), "utf8")) as { stoppedReason: string };
    expect(state.stoppedReason).toContain("evidence gate refused");
  });
});
