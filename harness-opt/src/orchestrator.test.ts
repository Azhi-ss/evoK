import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "./budget";
import { FIXED_MODEL_ID } from "./fixed-model";
import { Lineage, Node, type RoleLineage } from "./lineage";
import { GreedySelector } from "./modules/selector";
import { Orchestrator, Phase, type Roles, type SubmitGateRequest } from "./orchestrator";

function gateRequest(heldout: number, extra: Partial<SubmitGateRequest> = {}): SubmitGateRequest {
  return {
    heldoutEval: () => heldout,
    ttsBaseline: 0.5,
    baseHeldout: 0.4,
    day: "2026-10-18",
    modelId: FIXED_MODEL_ID,
    tracePackComplete: true,
    changeNotePresent: true,
    tokenBudget: 1000,
    tokensSpent: 10,
    dryRun: () => ({ status: "passed", detail: "playground submit --dry-run succeeded" }),
    ...extra,
  };
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), "harness-opt-orch-"));
}

function machine(scores: number[], options?: {
  readonly summary?: string;
  readonly accept?: boolean;
  readonly fullScores?: number[];
  readonly gap?: Record<string, unknown>;
  readonly throwAt?: "gap" | "runner";
  readonly patience?: number;
  readonly budget?: Budget;
  readonly onInnovator?: (gaps: Record<string, unknown>, tried: readonly string[]) => void;
  readonly heldOut?: (configPath: string) => number;
  readonly skipMilestone?: boolean;
  readonly onGap?: (parent: Node, view: RoleLineage) => void;
  readonly maxConsecutiveStalls?: number;
}) {
  const lin = new Lineage(dir());
  lin.put(new Node({
    id: "root",
    parentId: null,
    configPath: "candidates/root/config.json",
    status: "evaluated",
    devScores: [0.5],
    stage: "full",
  }));
  const calls: string[] = [];
  let innovatorCalls = 0;
  const roles: Roles = {
    gapFinder: (parent, view) => {
      options?.onGap?.(parent, view);
      if (options?.throwAt === "gap") throw new Error("gap failed");
      return options?.gap ?? { gaps: [{ id: "g1", summary: "idle" }] };
    },
    innovator: (_parent, gaps, tried) => {
      innovatorCalls += 1;
      options?.onInnovator?.(gaps, tried);
      return { summary: options?.summary ?? "patch-a", configPath: "candidates/child/config.json", tokens: 10 };
    },
    runner: (_config, subset) => {
      calls.push(subset);
      if (options?.throwAt === "runner") return [];
      if (subset === "dev_full") return options?.fullScores ?? scores;
      return scores;
    },
    reviewer: () => ({ accept: options?.accept ?? true, reason: "fixture" }),
  };
  const orchestrator = new Orchestrator(lin, roles, new GreedySelector(), options?.budget ?? new Budget(), {
    patience: options?.patience ?? 15,
    ids: () => "child",
    ...(options?.maxConsecutiveStalls !== undefined ? { maxConsecutiveStalls: options.maxConsecutiveStalls } : {}),
    ...(options?.skipMilestone ? {} : { heldOutAtMilestone: options?.heldOut ?? (() => 0.5) }),
  });
  return { lin, orchestrator, calls, innovatorCalls: () => innovatorCalls };
}

describe("orchestrator", () => {
  test("runs the full dev subset only after the small mean clears the parent bar", () => {
    const good = machine([0.6]);
    expect(good.orchestrator.step()).toBe(Phase.SELECT);
    expect(good.calls).toEqual(["dev_small", "dev_full"]);
    expect(good.lin.nodes.get("child")?.stage).toBe("full");
    expect(good.lin.nodes.get("child")?.status).toBe("evaluated");
    expect(good.lin.best().id).toBe("child");

    const split = machine([1], { fullScores: [0.1] });
    split.orchestrator.step();
    const scored = split.lin.nodes.get("child");
    expect(scored?.devSmallScores).toEqual([1]);
    expect(scored?.devFullScores).toEqual([0.1]);
    expect(scored?.devScores).toEqual([0.1]);
    expect(scored?.devMean).toBeCloseTo(0.1);

    const weak = machine([0.2]);
    weak.orchestrator.step();
    expect(weak.calls).toEqual(["dev_small"]);
    expect(weak.lin.nodes.get("child")?.stage).toBe("small");
  });

  test("a repeated patch summary is dropped and the parent lock is released", () => {
    const { lin, orchestrator } = machine([0.9], { summary: "same" });
    const root = lin.rootNode();
    const prior = new Node({
      id: "old",
      parentId: "root",
      configPath: "candidates/old/config.json",
      patchSummary: "same",
      status: "rejected",
    });
    root.children.push("old");
    lin.put(root);
    lin.put(prior);
    expect(orchestrator.step()).toBe(Phase.SELECT);
    expect(lin.nodes.has("child")).toBe(false);
    expect(lin.rootNode().locked).toBe(false);
    expect(lin.events().some((event) => event.kind === "dup_patch")).toBe(true);
  });

  test("submit gate ANDs the evidence checklist, held-out, TTS, and dry-run", () => {
    const { lin, orchestrator } = machine([0.2]);
    orchestrator.step();
    const low = orchestrator.submitGate(gateRequest(0.2));
    expect(low.submit).toBe(false);
    expect(low.heldout).toBe(0.2);
    expect(low.checks.map((check) => check.id)).toEqual([
      "model", "held-out", "trace-pack", "change-note", "tts", "quota", "budget", "playground-submit-dry-run",
    ]);
    expect(orchestrator.budget.canSubmit("2026-10-18")).toBe(true);
    expect(lin.events().some((event) => event.kind === "gate" && event.ok === false)).toBe(true);
    expect(lin.events().some((event) => "heldout" in event || "heldOut" in event)).toBe(false);
    expect(lin.gateEvents()[0]).toMatchObject({ node: "root", heldout: 0.2, ok: false });
    expect(readFileSync(join(lin.root, "lineage.jsonl"), "utf8")).not.toContain("heldout");
    const missing = orchestrator.submitGate(gateRequest(0.8));
    expect(missing.submit).toBe(false);
    expect(missing.checks.find((check) => check.id === "held-out")?.detail).toContain("sigma");
    const zero = orchestrator.submitGate(gateRequest(0.8, { minDelta: 0 }));
    expect(zero.submit).toBe(false);
    expect(zero.checks.find((check) => check.id === "held-out")?.detail).toContain("sigma");
    const open = orchestrator.submitGate(gateRequest(0.8, { minDelta: 0.1 }));
    expect(open.submit).toBe(true);
    expect(open.checks.every((check) => check.ok)).toBe(true);
    const prefix = orchestrator.submitGate(gateRequest(0.8, { minDelta: 0.1, modelId: "qwen-max" }));
    expect(prefix.submit).toBe(false);
    expect(prefix.checks.find((check) => check.id === "model")?.ok).toBe(false);
    const unread = orchestrator.submitGate(gateRequest(0.8, { minDelta: 0.1, tts: "not-run" }));
    expect(unread.submit).toBe(false);
    const noDry = orchestrator.submitGate(gateRequest(0.8, {
      minDelta: 0.1,
      dryRun: () => ({ status: "unsupported", detail: "not-run: playground submit --dry-run is unsupported" }),
    }));
    expect(noDry.submit).toBe(false);
    expect(noDry.checks.find((check) => check.id === "playground-submit-dry-run")?.detail).toContain("not-run");
    expect(orchestrator.budget.canSubmit("2026-10-18")).toBe(true);
  });

  test("a dev rise with a held-out drop is refused and stays out of the innovator", () => {
    let parentKeys: string[] = [];
    const run = machine([0.9], {
      heldOut: (configPath) => configPath.endsWith("child/config.json") ? 0.2 : 0.8,
      onGap: (parent) => {
        parentKeys = Object.keys(parent.toJSON());
      },
    });
    expect(run.orchestrator.step()).toBe(Phase.SELECT);
    expect(run.lin.nodes.get("child")?.status).toBe("rejected");
    expect(run.lin.events().some((event) => event.kind === "review" && event.regressed === true && event.reason === "regressed")).toBe(true);
    expect(JSON.stringify(run.lin.events())).not.toMatch(/heldout|held-out/i);
    expect(parentKeys).not.toContain("heldOut");
    expect(run.lin.best().id).toBe("root");
  });

  test("plateau, budget, and a gap-finder failure stay inside the state machine", () => {
    const plateau = machine([0.1], { patience: 1 });
    expect(plateau.orchestrator.step()).toBe(Phase.STOP);
    expect(plateau.lin.events().some((event) => event.kind === "plateau")).toBe(true);
    expect(plateau.lin.nodes.get("child")?.status).toBe("rejected");
    expect(plateau.lin.rootNode().visits).toBe(1);

    const budget = new Budget({ maxLocalRuns: 0 });
    const stopped = machine([0.9], { budget });
    expect(stopped.orchestrator.step()).toBe(Phase.STOP);
    expect(stopped.lin.events().some((event) => event.kind === "select")).toBe(false);

    const broken = machine([0.9], { throwAt: "gap" });
    expect(broken.orchestrator.step()).toBe(Phase.SELECT);
    expect(broken.lin.rootNode().locked).toBe(false);
    expect(broken.lin.nodes.has("child")).toBe(false);
    expect(broken.lin.events().some((event) => event.kind === "error")).toBe(true);
  });

  test("held-out in gap output never reaches the innovator", () => {
    const run = machine([0.9], { gap: { heldOut: [0.99] } });
    expect(run.orchestrator.step()).toBe(Phase.SELECT);
    expect(run.innovatorCalls()).toBe(0);
    expect(run.lin.events().some((event) => event.kind === "error" && String(event.err).includes("held-out"))).toBe(true);
  });

  test("an empty runner result is an error, not a divide by zero", () => {
    const run = machine([0.5], { throwAt: "runner" });
    expect(run.orchestrator.step()).toBe(Phase.SELECT);
    expect(run.lin.events().some((event) => String(event.err).includes("no scores"))).toBe(true);
    expect(run.lin.nodes.get("child")?.status).toBe("failed");
    expect(run.lin.rootNode().locked).toBe(false);
  });

  test("a poisoned lineage line is stripped before the gap finder reads it", () => {
    let seen = "";
    const run = machine([0.9], {
      onGap: (_parent, view) => {
        seen = JSON.stringify(view.events());
        expect("gateEvents" in view).toBe(false);
      },
    });
    appendFileSync(join(run.lin.root, "lineage.jsonl"), `${JSON.stringify({ kind: "gate", heldout: 0.13131313, hiddenScore: 1, ok: false })}\n`);
    expect(run.orchestrator.step()).toBe(Phase.SELECT);
    expect(run.innovatorCalls()).toBe(1);
    expect(seen).not.toContain("heldout");
    expect(seen).not.toContain("hiddenScore");
    expect(seen).not.toContain("0.13131313");
    expect(readFileSync(join(run.lin.root, "lineage.jsonl"), "utf8")).toContain("0.13131313");
  });

  test("duplicate patches, pick failures, and runner throws stop after the stall cap", () => {
    const dup = machine([0.9], { summary: "same", maxConsecutiveStalls: 2 });
    const root = dup.lin.rootNode();
    const prior = new Node({
      id: "old",
      parentId: "root",
      configPath: "candidates/old/config.json",
      patchSummary: "same",
      status: "rejected",
    });
    root.children.push("old");
    dup.lin.put(root);
    dup.lin.put(prior);
    expect(dup.orchestrator.run().id).toBe("root");
    expect(dup.orchestrator.phase).toBe(Phase.STOP);
    expect(dup.lin.events().filter((event) => event.kind === "dup_patch")).toHaveLength(2);
    expect(dup.lin.events().some((event) => event.kind === "stall" && event.stalls === 2)).toBe(true);

    const lin = new Lineage(dir());
    lin.put(new Node({
      id: "root",
      parentId: null,
      configPath: "candidates/root/config.json",
      status: "evaluated",
      devScores: [0.5],
      stage: "full",
    }));
    let picks = 0;
    let seq = 0;
    const roles: Roles = {
      gapFinder: () => ({ gaps: [] }),
      innovator: () => ({ summary: `patch-${seq}`, configPath: "candidates/child/config.json", tokens: 1 }),
      runner: () => {
        throw new Error("infra down");
      },
      reviewer: () => ({ accept: true, reason: "fixture" }),
    };
    const pick = new Orchestrator(lin, roles, {
      name: "broken",
      pick: () => {
        picks += 1;
        throw new Error("no parent");
      },
    }, new Budget(), { maxConsecutiveStalls: 2 });
    expect(pick.run().id).toBe("root");
    expect(picks).toBe(2);
    expect(pick.phase).toBe(Phase.STOP);
    expect(lin.events().filter((event) => event.kind === "error")).toHaveLength(2);

    const failed = new Lineage(dir());
    failed.put(new Node({
      id: "root",
      parentId: null,
      configPath: "candidates/root/config.json",
      status: "evaluated",
      devScores: [0.5],
      stage: "full",
    }));
    const runner = new Orchestrator(failed, roles, new GreedySelector(), new Budget(), {
      maxConsecutiveStalls: 2,
      ids: () => `c${seq++}`,
    });
    expect(runner.run().id).toBe("root");
    expect(failed.nodes.get("c0")?.status).toBe("failed");
    expect(failed.nodes.get("c1")?.status).toBe("failed");
    expect(runner.phase).toBe(Phase.STOP);
    expect(seq).toBe(2);
  });

  test("reusing a child id is a stall, not a self-parent loop", () => {
    const run = machine([0.9], { maxConsecutiveStalls: 1 });
    expect(run.orchestrator.step()).toBe(Phase.SELECT);
    expect(run.lin.nodes.get("child")?.parentId).toBe("root");
    expect(run.orchestrator.step()).toBe(Phase.STOP);
    expect(run.lin.nodes.get("child")?.parentId).toBe("root");
    expect(run.lin.events().some((event) => String(event.err).includes("already exists"))).toBe(true);
    expect(run.lin.nodes.get("child")?.visits).toBe(1);
  });

  test("a completed review clears the stall counter", () => {
    const lin = new Lineage(dir());
    const root = new Node({
      id: "root",
      parentId: null,
      configPath: "candidates/root/config.json",
      status: "evaluated",
      devScores: [0.5],
      stage: "full",
    });
    const prior = new Node({
      id: "old",
      parentId: "root",
      configPath: "candidates/old/config.json",
      patchSummary: "same",
      status: "rejected",
    });
    root.children.push("old");
    lin.put(root);
    lin.put(prior);
    let n = 0;
    const roles: Roles = {
      gapFinder: () => ({ gaps: [] }),
      innovator: () => ({
        summary: n === 1 ? "fresh" : "same",
        configPath: "candidates/child/config.json",
        tokens: 1,
      }),
      runner: () => [0.4],
      reviewer: () => ({ accept: true, reason: "fixture" }),
    };
    const orchestrator = new Orchestrator(lin, roles, new GreedySelector(), new Budget(), {
      maxConsecutiveStalls: 2,
      ids: () => "child",
      heldOutAtMilestone: () => 0.5,
    });
    expect(orchestrator.step()).toBe(Phase.SELECT);
    expect(orchestrator.consecutiveStalls).toBe(1);
    n = 1;
    expect(orchestrator.step()).toBe(Phase.SELECT);
    expect(orchestrator.consecutiveStalls).toBe(0);
    n = 0;
    expect(orchestrator.step()).toBe(Phase.SELECT);
    expect(orchestrator.consecutiveStalls).toBe(1);
    expect(orchestrator.phase).toBe(Phase.SELECT);
  });
});
