/**
 * ET-A4 compatibility seam: `src/execution/` implementations and the flat
 * `src/*.ts` re-exports must stay isomorphic. Thin-default (B) literals
 * here are independent of the moved module bodies.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as dagFlat from "../dag-scheduler";
import * as dagPacked from "./dag-scheduler";
import * as executionPacked from "./index";
import * as orchestraFlat from "../model-orchestra";
import * as orchestraPacked from "./model-orchestra";
import * as runtimeFlat from "../pi-agent-runtime";
import * as runtimePacked from "./pi-agent-runtime";
import * as securityFlat from "../security-boundary";
import * as securityPacked from "./security-boundary";
import * as teamFlat from "../team-execution";
import * as teamPacked from "./team-execution";

const PACK_DIR = dirname(fileURLToPath(import.meta.url));

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

function ref(branchId: string, suffix = "1") {
  return Object.freeze({
    artifactId: `${branchId}-${suffix}`,
    branchId,
    address: `artifact://${branchId}/${suffix}`,
    digest: `${branchId}:${suffix}`,
  });
}

describe("execution pack re-export isomorphism", () => {
  test("flat src/*.ts re-exports the same runtime bindings as src/execution/", () => {
    expectSameRuntimeSurface(teamFlat, teamPacked);
    expectSameRuntimeSurface(dagFlat, dagPacked);
    expectSameRuntimeSurface(orchestraFlat, orchestraPacked);
    expectSameRuntimeSurface(runtimeFlat, runtimePacked);
    expectSameRuntimeSurface(securityFlat, securityPacked);
  });

  test("src/execution/ is importable and keeps thin default B", async () => {
    expect(executionPacked.DEFAULT_BRANCH_WIDTH).toBe(1);
    expect(executionPacked.createThinExecutionPlan().branchWidth).toBe(1);
    expect(executionPacked.createThinExecutionPlan().verificationGates).toEqual([]);
    expect(new executionPacked.Coordinator().propose({}).branchWidth).toBe(1);

    const thinGuard = new executionPacked.PolicyGuard({
      maxBranchWidth: 3,
      maxAttempts: 1,
      maxBranchBudget: 1,
      permissions: [],
      resources: [],
    });
    expect(() => thinGuard.validate(executionPacked.createThinExecutionPlan())).not.toThrow();

    const scheduler = new executionPacked.DeterministicScheduler(thinGuard);
    const completed = await scheduler.run(executionPacked.createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.status).toBe("COMPLETED");
    expect(completed[0]?.verification).toEqual({});

    const rejected = await scheduler.run(executionPacked.createThinExecutionPlan(), {
      branchIds: ["a"],
      execute: (branch) => ref(branch.branchId),
      falsifier: () => ({ ok: false, objections: ["counterexample"] }),
    });
    expect(rejected[0]?.status).toBe("REJECTED");
    expect(rejected[0]?.objections).toEqual(["counterexample"]);
    expect(rejected[0]?.verification?.Falsifier).toBe(false);

    expect(teamFlat.DEFAULT_BRANCH_WIDTH).toBe(executionPacked.DEFAULT_BRANCH_WIDTH);
  });

  test("Elite / fan-out width / role roster are not promotion keys", async () => {
    const fanIn = new executionPacked.ArtifactFanIn(
      () => ({ score: 1, elite: true, teamFanOutWidth: 8, roster: ["Falsifier", "Critic"] }),
      (_artifact, evaluation) => evaluation.score > 5,
      ["a"],
    );
    const denied = await fanIn.reconcile([ref("a")]);
    expect(denied.promoted).toBeUndefined();

    const byScore = new executionPacked.ArtifactFanIn(
      () => ({ score: 2 }),
      (_artifact, evaluation) => evaluation.score > 1,
      ["a"],
    );
    const promoted = await byScore.reconcile([ref("a")]);
    expect(promoted.promoted?.artifactId).toBe("a-1");
  });

  test("pattern files are read-only specs and do not force a runtime track switch", () => {
    const names = ["contest-loop.md", "dual-arm.md", "research-thin.md"] as const;
    for (const name of names) {
      const path = join(PACK_DIR, "patterns", name);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body).toMatch(/who plays|上场/i);
      expect(body).toMatch(/advance|前进/i);
      expect(body).not.toMatch(/```(?:ts|js|typescript|javascript)/i);
      expect(body.toLowerCase()).not.toContain("full roster present");
    }

    const keys = runtimeKeys(executionPacked);
    expect(keys).not.toContain("selectExecutionPattern");
    expect(keys).not.toContain("switchCoordinatorTrack");
    expect(keys).not.toContain("applyPattern");
    expect(keys).not.toContain("requireFullRoster");
    expect("selectExecutionPattern" in executionPacked).toBe(false);
    expect("switchCoordinatorTrack" in executionPacked).toBe(false);

    const plan = executionPacked.createThinExecutionPlan();
    expect(plan.branchWidth).toBe(1);
    expect(plan.verificationGates).toEqual([]);
  });
});
