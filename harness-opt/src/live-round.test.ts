import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "./budget";
import { Node } from "./lineage";
import { liveRoles, reviewerTask } from "./live-round";
import type { ReviewInput } from "./orchestrator";

function root(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-live-"));
}

function pair(): { parent: Node; child: Node } {
  return {
    parent: new Node({
      id: "base",
      parentId: null,
      configPath: "candidates/base/config.json",
      status: "evaluated",
      devScores: [0.4],
      stage: "full",
    }),
    child: new Node({
      id: "c1",
      parentId: "base",
      configPath: "candidates/c1/config.json",
      status: "evaluated",
      devScores: [0.9],
      stage: "full",
    }),
  };
}

describe("live round", () => {
  test("a toolchain patch is stored on toolchain and leaves agent-loop empty", async () => {
    const dir = root();
    let seen = "";
    const roles = liveRoles({
      root: dir,
      round: 1,
      budget: new Budget(),
      tasks: [],
      delegate: async (input) => {
        seen = input.task;
        return {
          agent: input.agent,
          tokens: 4,
          value: {
            part: "toolchain",
            motivation: "pin the checker",
            expectedFailureClass: "tool-misuse",
            summary: "add a checker",
            changes: { checker: "strict" },
          },
        };
      },
    });
    await roles.innovator(pair().parent, { gaps: [] }, []);
    const config = JSON.parse(readFileSync(join(dir, "candidates", "c1", "config.json"), "utf8")) as {
      parts: Record<string, Record<string, unknown>>;
    };
    expect(config.parts.toolchain).toEqual({ checker: "strict" });
    expect(config.parts["agent-loop"]).toEqual({});
    expect(config.parts.context).toEqual({});
    expect(seen).toContain("toolchain");

    const loopDir = root();
    const loop = liveRoles({
      root: loopDir,
      round: 1,
      budget: new Budget(),
      tasks: [],
      delegate: async (input) => ({
        agent: input.agent,
        tokens: 2,
        value: {
          part: "agent-loop",
          motivation: "cap the idle reread",
          expectedFailureClass: "idle-loop",
          summary: "cap steps",
          changes: { maxSteps: 4 },
        },
      }),
    });
    await loop.innovator(pair().parent, { gaps: [] }, []);
    const loopConfig = JSON.parse(readFileSync(join(loopDir, "candidates", "c1", "config.json"), "utf8")) as {
      parts: Record<string, Record<string, unknown>>;
    };
    expect(loopConfig.parts["agent-loop"]).toEqual({ maxSteps: 4 });
    expect(loopConfig.parts.toolchain).toEqual({});
  });

  test("the stored review reason follows unread, fell, and held", async () => {
    const { parent, child } = pair();
    const cases: { state: ReviewInput["heldOutState"]; flag: boolean; modelReason: string; accept: boolean; stored: string }[] = [
      {
        state: "unread",
        flag: false,
        modelReason: "dev rose and held-out fell",
        accept: false,
        stored: "milestone-unread：里程碑没读到",
      },
      {
        state: "fell",
        flag: true,
        modelReason: "milestone was not read",
        accept: false,
        stored: "held-out 相对父节点下跌",
      },
      {
        state: "held",
        flag: false,
        modelReason: "keep-better",
        accept: true,
        stored: "keep-better",
      },
    ];
    for (const item of cases) {
      const dir = root();
      let task = "";
      const roles = liveRoles({
        root: dir,
        round: 1,
        budget: new Budget(),
        tasks: [],
        delegate: async (input) => {
          task = input.task;
          return { agent: input.agent, tokens: 1, value: { accept: true, reason: item.modelReason } };
        },
      });
      const input: ReviewInput = {
        child,
        parent,
        heldOut: item.state === "unread" ? null : { child: item.state === "fell" ? 0.2 : 0.6, parent: 0.5 },
        heldOutState: item.state,
        devRoseHeldOutFell: item.flag,
      };
      const verdict = await roles.reviewer(input);
      expect(verdict).toEqual({ accept: item.accept, reason: item.stored });
      expect(task).toContain(item.state);
      if (item.state === "unread") {
        expect(task).toContain("不能写成下跌");
        expect(verdict.reason).not.toContain("下跌");
      }
      const saved = JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) as { accept: boolean; reason: string };
      expect(saved).toEqual(verdict);
    }
    expect(reviewerTask({
      child,
      parent,
      heldOut: null,
      heldOutState: "unread",
      devRoseHeldOutFell: false,
    })).toContain("没读到");
  });
});
