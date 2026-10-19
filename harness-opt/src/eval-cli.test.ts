import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../bin/eval";
import { recordEvent } from "../bin/record";
import { selectParent } from "../bin/select";
import { Lineage, Node } from "./lineage";

function root(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-eval-"));
}

describe("host commands", () => {
  test("held-out without --gate throws before the sealed file is required", () => {
    const dir = root();
    expect(() => runEval({ root: dir, cand: "c1", split: "heldout", gate: false })).toThrow(/harnessopt_submit_gate/);
    expect(() => runEval({ root: dir, cand: "../c1", split: "dev", gate: false })).toThrow(/relative id/);
  });

  test("held-out with --gate reads the sealed score, and dev refuses a self-reported fixtureScore", () => {
    const dir = root();
    mkdirSync(join(dir, "sealed"), { recursive: true });
    writeFileSync(join(dir, "sealed", "heldout-score.json"), JSON.stringify({ score: 0.7, tokens: 3 }));
    mkdirSync(join(dir, "candidates", "c1"), { recursive: true });
    writeFileSync(join(dir, "candidates", "c1", "config.json"), JSON.stringify({ fixtureScore: 0.99, tokens: 8 }));
    expect(runEval({ root: dir, cand: "c1", split: "heldout", gate: true })).toMatchObject({
      scores: [0.7],
      split: "heldout",
      tokens: 3,
    });
    expect(() => runEval({ root: dir, cand: "c1", split: "dev", gate: false })).toThrow(/executor traces/);
    expect(() => runEval({ root: dir, cand: "c1", split: "dev_small", gate: false })).toThrow(/executor traces/);
    expect(() => runEval({ root: dir, cand: "c1", split: "dev_full", gate: false })).toThrow(/executor traces/);
    mkdirSync(join(dir, "traces", "c1"), { recursive: true });
    writeFileSync(join(dir, "traces", "c1", "dev-1.json"), JSON.stringify({
      reward: 0.8,
      tokens: 40,
      taskId: "dev-1",
    }));
    expect(runEval({ root: dir, cand: "c1", split: "dev_small", gate: false })).toMatchObject({
      scores: [0.8],
      tokens: 40,
    });
    expect(runEval({ root: dir, cand: "c1", split: "dev_full", gate: false }).scores).toEqual([0.8]);
  });

  test("select and record use the lineage directory", () => {
    const dir = root();
    const lin = new Lineage(dir);
    lin.put(new Node({
      id: "base",
      parentId: null,
      configPath: "candidates/base/config.json",
      status: "evaluated",
      devScores: [0.4],
    }));
    lin.put(new Node({
      id: "better",
      parentId: "base",
      configPath: "candidates/better/config.json",
      status: "evaluated",
      devScores: [0.8],
    }));
    expect(selectParent(dir).id).toBe("better");
    recordEvent(dir, "note", { node: "better" });
    expect(new Lineage(dir).events().some((event) => event.kind === "note")).toBe(true);
  });
});
