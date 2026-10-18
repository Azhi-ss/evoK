import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRoleJson } from "./artifacts";
import { Budget } from "./budget";
import { Node } from "./lineage";
import { liveRoles, reviewerTask } from "./live-round";
import type { HarnessExecutor } from "./modules/executor";
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

function plantParent(dir: string): void {
  writeRoleJson(dir, "orchestrator", "candidates/base/config.json", {
    id: "base",
    modelId: "parent-model",
    parts: {
      "agent-loop": { maxSteps: 8 },
      context: { window: 4 },
      memory: {},
      toolchain: { checker: "keep" },
      skills: { pack: "base" },
    },
    search: { samples: 3, selfChecks: 1, retries: 2 },
  });
}

describe("live round", () => {
  test("a child candidate inherits the parent config and overlays the patch part", async () => {
    const dir = root();
    plantParent(dir);
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
      id: string;
      modelId: string;
      parts: Record<string, Record<string, unknown>>;
      search: { samples: number; selfChecks: number; retries: number };
    };
    expect(config.id).toBe("c1");
    expect(config.modelId).toBe("parent-model");
    expect(config.parts.toolchain).toEqual({ checker: "strict" });
    expect(config.parts["agent-loop"]).toEqual({ maxSteps: 8 });
    expect(config.parts.context).toEqual({ window: 4 });
    expect(config.parts.skills).toEqual({ pack: "base" });
    expect(config.search).toEqual({ samples: 3, selfChecks: 1, retries: 2 });
    expect(seen).toContain("toolchain");

    const loopDir = root();
    plantParent(loopDir);
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
      search: { retries: number };
    };
    expect(loopConfig.parts["agent-loop"]).toEqual({ maxSteps: 4 });
    expect(loopConfig.parts.toolchain).toEqual({ checker: "keep" });
    expect(loopConfig.search.retries).toBe(2);
  });

  test("a child candidate refuses to invent a config when the parent file is missing", async () => {
    const dir = root();
    const roles = liveRoles({
      root: dir,
      round: 1,
      budget: new Budget(),
      tasks: [],
      delegate: async (input) => ({
        agent: input.agent,
        tokens: 1,
        value: {
          part: "toolchain",
          motivation: "pin the checker",
          expectedFailureClass: "tool-misuse",
          summary: "add a checker",
          changes: { checker: "strict" },
        },
      }),
    });
    await expect(roles.innovator(pair().parent, { gaps: [] }, [])).rejects.toThrow(/parent config is missing/);
  });

  test("parent and child traces stay in separate files", async () => {
    const dir = root();
    const executor: HarnessExecutor = {
      name: "fake",
      async run(task, configPath) {
        return {
          taskId: task.id,
          steps: [{ id: "s", tool: "read", args: {}, ok: true }],
          reward: configPath.includes("/base/") ? 0.4 : 0.8,
          tokens: 1,
          failed: false,
          labels: [],
          executor: "fake",
        };
      },
    };
    const roles = liveRoles({
      root: dir,
      round: 1,
      budget: new Budget(),
      tasks: [{ id: "dev-1", split: "dev", path: "tasks/dev-1.md" }],
      delegate: async () => {
        throw new Error("unused");
      },
      executor,
    });
    await roles.runner("candidates/base/config.json", "dev_full");
    await roles.runner("candidates/c1/config.json", "dev_full");
    const parent = JSON.parse(readFileSync(join(dir, "traces", "base", "dev-1.json"), "utf8")) as { reward: number };
    const child = JSON.parse(readFileSync(join(dir, "traces", "c1", "dev-1.json"), "utf8")) as { reward: number };
    expect(parent.reward).toBe(0.4);
    expect(child.reward).toBe(0.8);
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
      const saved = JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) as {
        accept: boolean;
        reason: string;
        modelReason: string;
      };
      expect(saved).toEqual({ ...verdict, modelReason: item.modelReason });
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
