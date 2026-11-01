import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Phase2PlaygroundAdapter, createPhase2JsonStore } from "../competition/phase2-playground";
import { FakePhase2Platform } from "../competition/phase2-fake-platform";
import { Phase2Research, initPhase2Research } from "./phase2-research";
import { createPhase2WorkspaceRunner } from "./phase2-workspace-runner";

function setup(result: { sourceDigest: string; executionExit: number; score?: number; costCNY?: number }) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "phase2-ws-"));
  mkdirSync(join(workspaceDir, "evok-agent"), { recursive: true });
  writeFileSync(join(workspaceDir, "evok-agent", "agent.json"), "{}\n");
  const store = createPhase2JsonStore(join(workspaceDir, "state.json"));
  initPhase2Research(store, { cap: 100 });
  const research = new Phase2Research({ store, adapter: new Phase2PlaygroundAdapter({ store, platform: new FakePhase2Platform() }) });
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    if (argv.includes("--propose")) {
      const newTree = argv[argv.length - 1];
      mkdirSync(newTree, { recursive: true });
      writeFileSync(join(newTree, "agent.json"), '{"v":2}\n');
      return { code: 0, stdout: "", stderr: "" };
    }
    const resultDir = argv[argv.length - 1];
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(result));
    return { code: 0, stdout: "", stderr: "" };
  };
  const runner = createPhase2WorkspaceRunner({ workspaceDir, taskId: "hb016", baseTree: "evok-agent", run });
  return { workspaceDir, research, runner, calls };
}

describe("phase2 workspace research runner", () => {
  test("proposes and scores a candidate, books cost only in the S1 ledger", async () => {
    const { research, runner, calls, workspaceDir } = setup({ sourceDigest: "sha-candidate", executionExit: 0, score: 0.47, costCNY: 12.5 });
    const outcome = await runner(research);
    expect(outcome.executionExit).toBe(0);
    expect(outcome.score).toBe(0.47);
    const propose = calls[0];
    expect(propose[0]).toBe("python3");
    expect(propose[1]).toBe(join(workspaceDir, "local", "evaluate_candidate.py"));
    expect(propose[2]).toBe("--propose");
    expect(propose[3]).toBe(join(workspaceDir, "evok-agent"));
    const evaluate = calls[1];
    expect(evaluate[3]).toBe("hb016");
    // Proposal feedback is the sanitized researcher view, not raw rules.
    const feedback = JSON.parse(readFileSync(propose[4], "utf8"));
    expect(Object.keys(feedback)).toEqual(["nomineeId", "revisions"]);
    const view = research.directorView();
    expect(view.revisions.length).toBe(1);
    expect(view.revisions[0].local.screening).toBe(0.47);
    expect(view.budget.spent).toBe(0);
    expect(research.getRevision(view.revisions[0].revisionId).change.sourceDigest).toBe("sha-candidate");
  });

  test("a Pi-managed workspace reports the durable handoff without launching a second researcher", async () => {
    const {workspaceDir, research} = setup({sourceDigest: "unused", executionExit: 0});
    const bridge = join(workspaceDir, "scripts", "pi_campaign_work.py");
    mkdirSync(join(workspaceDir, "scripts"));
    writeFileSync(bridge, "");
    const calls: string[][] = [];
    const runner = createPhase2WorkspaceRunner({workspaceDir, taskId: "hb016",
      async run(args) {
        calls.push([...args]);
        return {code: 0, stdout: JSON.stringify({id: "proposal-003", state: "review-pending"}), stderr: ""};
      }});
    expect(await runner(research)).toMatchObject({pending: {state: "review-pending"}});
    expect(calls).toEqual([["python3", bridge, "pending"]]);
    expect(research.directorView().revisions.length).toBe(0);
  });

  test("a failed execution is negative evidence without a score", async () => {
    const { research, runner } = setup({ sourceDigest: "sha-failed", executionExit: 1, costCNY: 3 });
    const outcome = await runner(research);
    expect(outcome.executionExit).toBe(1);
    const view = research.directorView();
    expect(view.revisions[0].local.screening).toBeUndefined();
    expect(view.revisions[0].eligible).toBe(false);
    expect(view.budget.spent).toBe(0);
  });

  test("a result without sourceDigest fails closed", async () => {
    const { research, runner } = setup({ sourceDigest: "", executionExit: 0 });
    await expect(runner(research)).rejects.toThrow("sourceDigest");
  });
});
