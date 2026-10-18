import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxBoundary } from "../../src/execution/security-boundary";
import { writeRoleFile, writeRoleJson } from "./artifacts";
import { Budget } from "./budget";
import { writeRunState } from "../bin/record";
import { Lineage, Node } from "./lineage";
import { HeldOutVault } from "./modules/probe";
import { GreedySelector } from "./modules/selector";
import { Orchestrator, type Proposal, type Roles } from "./orchestrator";
import { emptyParts, type HarnessConfig, type TaskRef } from "./types";

export interface EmptyRunOptions {
  readonly out: string;
  readonly modelId?: string;
  readonly heldout?: number;
  readonly ttsBaseline?: number;
  readonly baseHeldout?: number;
  readonly day?: string;
  readonly devTasks?: readonly TaskRef[];
  readonly heldOutTasks?: readonly TaskRef[];
  readonly roles?: Partial<Roles>;
}

export interface EmptyRunResult {
  readonly bestId: string;
  readonly submit: boolean;
  readonly heldout: number;
  readonly selector: string;
  readonly phase: string;
  readonly childStatus: string;
  readonly liveSubmitCalled: boolean;
}

const SECRET_HELD_OUT = "sealed-held-out-body";

/**
 * One local step with fixture roles. Scores stay in [0, 1].
 * The submit gate sees a held-out number that is below the TTS baseline,
 * so `submit` is false and nothing is posted to the playground.
 */
export function runEmpty(options: EmptyRunOptions): EmptyRunResult {
  mkdirSync(options.out, { recursive: true });
  const state = join(options.out, "state");
  const modelId = options.modelId ?? "deepseek-v4.1-flash";
  const base: HarnessConfig = {
    id: "base",
    modelId,
    parts: { ...emptyParts(), "agent-loop": { maxSteps: 8 } },
    search: { samples: 1, selfChecks: 0, retries: 0 },
  };
  writeCandidate(options.out, "base", { ...base, fixtureScore: 0.4, tokens: 20 });
  writeFileSync(join(options.out, "sealed-note.txt"), `${SECRET_HELD_OUT}\n`);
  const heldOut = new HeldOutVault(options.heldOutTasks ?? [{
    id: "h1",
    split: "held-out",
    path: "sealed-note.txt",
  }]);
  void options.devTasks;
  void heldOut.size;

  const lineage = new Lineage(state);
  lineage.put(new Node({
    id: "base",
    parentId: null,
    configPath: "candidates/base/config.json",
    status: "evaluated",
    devScores: [0.4],
    stage: "full",
  }));

  const boundary = new SandboxBoundary({
    root: options.out,
    network: "none",
    allowBash: false,
    allowedTools: ["read"],
  });
  let liveSubmitCalled = false;
  const fixture: Roles = {
    gapFinder: () => {
      const gaps = {
        gaps: [{
          id: "g1",
          failureClass: "idle-loop",
          summary: "the loop rereads the task and never writes an answer",
          traceIds: ["seed"],
        }],
      };
      writeRoleJson(options.out, "gap-finder", "gaps.json", gaps);
      return gaps;
    },
    innovator: (_parent, gaps, tried) => {
      const blob = JSON.stringify({ gaps, tried });
      if (blob.includes(SECRET_HELD_OUT) || blob.includes("heldOut") || blob.includes("held-out")) {
        throw new Error("innovator saw held-out material");
      }
      const config = {
        id: "c1",
        modelId,
        fixtureScore: 0.8,
        tokens: 30,
        parts: { ...emptyParts(), "agent-loop": { maxSteps: 4, requireWrite: true } },
        search: { samples: 1, selfChecks: 0, retries: 1 },
      };
      writeRoleJson(options.out, "innovator", "candidates/c1/config.json", config);
      const proposal: Proposal = {
        summary: "cap idle reread and require a write",
        configPath: "candidates/c1/config.json",
        tokens: 30,
      };
      return proposal;
    },
    runner: (configPath, subset) => {
      const abs = boundary.assertPath(configPath, "read");
      const config = JSON.parse(readFileSync(abs, "utf8")) as { fixtureScore?: number };
      const score = config.fixtureScore ?? 0.5;
      return subset === "dev_full" ? [score, score] : [score];
    },
    reviewer: (child, parent) => {
      const accept = (child.devMean ?? 0) >= (parent.devMean ?? 0) - 0.01;
      const verdict = { accept, reason: accept ? "keep-better" : "below parent" };
      writeRoleJson(options.out, "reviewer-gate", "review.json", verdict);
      return verdict;
    },
  };
  const roles: Roles = { ...fixture, ...options.roles };
  const orchestrator = new Orchestrator(lineage, roles, new GreedySelector(), new Budget(), { ids: () => "c1" });
  const phase = orchestrator.step();
  const gate = orchestrator.submitGate(
    () => options.heldout ?? 0.1,
    options.ttsBaseline ?? 0.5,
    options.baseHeldout ?? 0.4,
    options.day ?? "2026-10-18",
  );
  const child = lineage.nodes.get("c1");
  writeRunState(state, {
    phase,
    selector: "GreedySelector",
    bestId: lineage.best().id,
    submit: gate.submit,
    heldout: gate.heldout,
    childStatus: child?.status ?? "missing",
    liveSubmitCalled,
    heldOutSealed: heldOut.size,
  });
  writeRoleFile(options.out, "orchestrator", "state/schedule.log", phase);
  return {
    bestId: lineage.best().id,
    submit: gate.submit,
    heldout: gate.heldout,
    selector: "GreedySelector",
    phase,
    childStatus: child?.status ?? "missing",
    liveSubmitCalled,
  };
}

function writeCandidate(root: string, id: string, body: unknown): void {
  const dir = join(root, "candidates", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(body, null, 2)}\n`);
}
