import { describe, expect, test } from "bun:test";
import { emptyParts, type HarnessConfig } from "../types";
import { runDev, type SandboxExec } from "./runner";

const config: HarnessConfig = {
  id: "cand",
  modelId: "glm-test",
  parts: emptyParts(),
  search: { samples: 2, selfChecks: 1, retries: 1 },
};

const task = { id: "t1", split: "dev" as const, path: "dev/t1.txt" };

function ok(taskId: string) {
  return {
    trace: {
      taskId,
      reward: 0.5,
      tokens: 3,
      failed: false,
      labels: [],
      raw: "ok",
    },
  };
}

describe("runner genes", () => {
  test("samples, retries, and self-check are taken from the config", () => {
    const modes: string[] = [];
    let failuresLeft = 1;
    const exec: SandboxExec = (call) => {
      modes.push(call.mode);
      if (call.mode === "sample" && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("infra");
      }
      if (call.mode === "self-check") {
        return { trace: { ...ok(call.task.id).trace, failed: true, labels: ["timeout" as const], reward: 0 } };
      }
      return ok(call.task.id);
    };
    const result = runDev({ config, tasks: [task], exec });
    expect(modes.filter((mode) => mode === "sample")).toHaveLength(3);
    expect(modes.filter((mode) => mode === "self-check")).toEqual(["self-check"]);
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain("self-check");
    expect(result.samplesPlanned).toBe(2);
  });

  test("held-out tasks are refused", () => {
    expect(() => runDev({
      config,
      tasks: [{ id: "h", split: "held-out", path: "hold/h.txt" }],
      exec: () => ok("h"),
    })).toThrow(/held-out/);
  });
});
