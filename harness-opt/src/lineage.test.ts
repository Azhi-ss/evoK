import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lineage, Node } from "./lineage";
import { backprop } from "./modules/selector";

describe("lineage", () => {
  test("atomic put reloads and ignores temp files", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-lin-"));
    const lineage = new Lineage(root);
    const node = new Node({
      id: "base",
      parentId: null,
      configPath: "candidates/base/config.json",
      status: "evaluated",
      devScores: [0.4, 0.6],
    });
    lineage.put(node);
    lineage.log("select", { node: "base" });
    writeFileSync(join(root, "nodes", ".ghost.tmp"), "{}\n");
    const again = new Lineage(root);
    expect([...again.nodes.keys()]).toEqual(["base"]);
    expect(again.rootNode().devMean).toBeCloseTo(0.5);
    expect(again.events()[0]).toMatchObject({ kind: "select", node: "base" });
  });

  test("backprop adds the reward up to the root", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-bp-"));
    const lineage = new Lineage(root);
    const parent = new Node({
      id: "p",
      parentId: null,
      configPath: "candidates/p/config.json",
      status: "evaluated",
      devScores: [0.4],
    });
    const child = new Node({
      id: "c",
      parentId: "p",
      configPath: "candidates/c/config.json",
      status: "rejected",
      devScores: [0.2],
    });
    parent.children = ["c"];
    lineage.put(parent);
    lineage.put(child);
    backprop(lineage, child, 0.2);
    expect(lineage.nodes.get("c")?.visits).toBe(1);
    expect(lineage.nodes.get("p")?.valueSum).toBeCloseTo(0.2);
    expect(lineage.best().id).toBe("p");
  });

  test("a node that names itself as parent does not spin", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-cycle-"));
    const lineage = new Lineage(root);
    const loop = new Node({
      id: "c",
      parentId: "c",
      configPath: "candidates/c/config.json",
      status: "evaluated",
      devScores: [0.2],
    });
    lineage.put(loop);
    backprop(lineage, loop, 0.2);
    expect(lineage.nodes.get("c")?.visits).toBe(1);
  });

  test("held-out keys stay in the gate log and out of the role view", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-gate-log-"));
    const lineage = new Lineage(root);
    lineage.log("gate", { node: "base", heldout: 0.77, hidden_score: 0.1, ok: false });
    lineage.gateLog({ node: "base", heldout: 0.77, tts: 0.5, ok: false });
    const raw = readFileSync(join(root, "lineage.jsonl"), "utf8");
    expect(raw).not.toContain("heldout");
    expect(raw).not.toContain("hidden_score");
    expect(raw).not.toContain("0.77");
    const view = lineage.roleView();
    expect(JSON.stringify(view.events())).not.toContain("heldout");
    expect(view.nodeSummaries()).toEqual([]);
    expect(lineage.gateEvents()[0]).toMatchObject({ heldout: 0.77, tts: 0.5, ok: false });
  });
});
