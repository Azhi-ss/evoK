import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyParts } from "../types";
import type { SandboxCall } from "../modules/runner";
import { createEvokBoundedExec } from "./evok-sandbox";

function call(path: string, tool: SandboxCall["tool"] = "read"): SandboxCall {
  return {
    config: {
      id: "c",
      modelId: "deepseek-test",
      parts: emptyParts(),
      search: { samples: 1, selfChecks: 0, retries: 0 },
    },
    task: { id: "t", split: "dev", path },
    tool,
    path,
    mode: "sample",
    sampleIndex: 0,
  };
}

describe("evoK sandbox boundary", () => {
  test("reuses SandboxBoundary to refuse traversal and bash", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    const bounded = createEvokBoundedExec(root, () => {
      throw new Error("inner exec ran");
    });
    expect(() => bounded(call("../secret"))).toThrow(/traversal|escapes/i);
    expect(() => bounded({ ...call("dev/t.txt"), tool: "bash" as "read" })).toThrow(/bash|not allowed/i);
  });

  test("a relative read inside the root reaches the exec", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    let ran = false;
    const bounded = createEvokBoundedExec(root, (input) => {
      ran = true;
      return {
        trace: {
          taskId: input.task.id,
          reward: 1,
          tokens: 1,
          failed: false,
          labels: [],
          raw: "ran",
        },
      };
    });
    bounded(call("dev/t.txt"));
    expect(ran).toBe(true);
  });
});
