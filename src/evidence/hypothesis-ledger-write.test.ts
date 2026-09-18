import { describe, expect, test } from "bun:test";
import {
  HypothesisLedger,
  T48MappedCatalog,
  projectHypothesisLedger,
  type HypothesisLedgerOptions,
} from "./hypothesis-ledger";
import {
  EvidenceMemory,
  MissionDirector,
  type ResearchTask,
} from "../research-loop";

const TASKS: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
];

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  const options = {
    catalog: catalogWithMappedIds(),
    selectionPolicy: {
      select() {
        calls.select += 1;
        throw new Error("SelectionPolicy must not run on expand_requested");
      },
    },
    uct: {
      uct() {
        calls.uct += 1;
        throw new Error("UCT must not run on expand_requested");
      },
    },
    searchNodes: {
      write() {
        calls.write += 1;
        throw new Error("search nodes must not be written on expand_requested");
      },
      nodes() {
        return [{ nodeId: "should-not-exist" }];
      },
    },
  };
  return {
    calls,
    ledger: new HypothesisLedger(options as HypothesisLedgerOptions),
  };
}

describe("H2 hypothesis ledger write / projection", () => {
  test("create, status_changed, then expand_requested is observable on the write log and the projection", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    const created = ledger.createHypothesis({
      hypothesisId: "h-write",
      statement: "a cheaper preprocessor keeps the hold-out honest",
      evidenceRefs: ["ev-holdout", "art-score"],
    });
    const supported = ledger.changeStatus("h-write", "supported");
    const queued = {
      campaignId: "campaign-expand",
      task: { taskId: "expand-task", objective: "try the cheaper preprocessor", estimatedCost: 1 },
    };
    ledger.requestExpand("h-write", { enqueue: queued });

    expect(created.status).toBe("open");
    expect(supported.status).toBe("supported");
    expect(ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "hypothesis.status_changed",
      "hypothesis.expand_requested",
    ]);

    const projected = projectHypothesisLedger(ledger.events());
    expect(projected.eventOrder).toEqual([
      "hypothesis.created",
      "hypothesis.status_changed",
      "hypothesis.expand_requested",
    ]);
    expect(projected.hypotheses["h-write"]?.status).toBe("supported");
    expect(projected.hypotheses["h-write"]?.evidenceRefs).toEqual([
      { kind: "evidence", id: "ev-holdout" },
      { kind: "artifact", id: "art-score" },
    ]);
    expect(projected.queuedCampaignTasks).toEqual([queued]);
    expect(projected.expandQueue).toEqual([{ hypothesisId: "h-write", task: queued }]);
    expect(projected.searchNodes).toEqual([]);

    expect(HypothesisLedger.replay(ledger.events())).toEqual(projected);
    expect(ledger.state()).toEqual(projected);

    const replayed = HypothesisLedger.fromEvents({ catalog: catalogWithMappedIds() }, ledger.events());
    expect(replayed.events().map((event) => event.type)).toEqual(projected.eventOrder);
    expect(replayed.state().hypotheses["h-write"]?.status).toBe("supported");
    expect(replayed.queuedCampaignTasks()).toEqual([queued]);
    expect(replayed.searchNodes()).toEqual([]);
  });

  test("writes Hypothesis, KillTestPlan, and KillTestResult and projects their status transitions", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    ledger.createHypothesis({
      hypothesisId: "h-kill",
      statement: "shared preprocessing leaks the hold-out",
      evidenceRefs: ["ev-holdout"],
    });
    const plan = ledger.planKillTest({
      planId: "kt-write",
      hypothesisId: "h-kill",
      predicate: "retrain without the shared step; hold-out must not move",
      evidenceRefs: ["ev-holdout"],
    });
    const result = ledger.finishKillTest({
      resultId: "ktr-write",
      planId: plan.planId,
      outcome: "fail",
      evidenceRefs: ["ev-kill"],
    });

    const projected = projectHypothesisLedger(ledger.events());
    expect(projected.eventOrder).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
      "hypothesis.status_changed",
    ]);
    expect(projected.plans["kt-write"]?.hypothesisId).toBe("h-kill");
    expect(projected.results["ktr-write"]?.outcome).toBe("fail");
    expect(result.outcome).toBe("fail");
    expect(projected.hypotheses["h-kill"]?.status).toBe("killed");
    expect(projected.hypotheses["h-kill"]?.killTestPlanIds).toEqual(["kt-write"]);
  });
});

describe("H2 expand_requested stays ledger-only", () => {
  test("may enqueue a Campaign Task and does not call UCT, SelectionPolicy, or write search nodes", () => {
    const { ledger, calls } = smuggledSearchPorts();
    const director = new MissionDirector({
      missionId: "h2-expand",
      objective: "learn",
      budget: 5,
      tasks: TASKS,
    });
    const directorEvents = director.events().length;

    ledger.createHypothesis({
      hypothesisId: "h-expand",
      statement: "try a cheaper preprocessor",
      evidenceRefs: ["ev-holdout"],
    });
    ledger.changeStatus("h-expand", "supported");
    const queued = {
      campaignId: "campaign-expand",
      task: { taskId: "expand-task", objective: "run the cheaper preprocessor", estimatedCost: 1 },
    };
    ledger.requestExpand("h-expand", { enqueue: queued });

    expect(ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "hypothesis.status_changed",
      "hypothesis.expand_requested",
    ]);
    expect(ledger.queuedCampaignTasks()).toEqual([queued]);
    expect(ledger.campaignTasksFor("h-expand")).toEqual([queued]);
    expect(ledger.searchNodes()).toEqual([]);
    expect(projectHypothesisLedger(ledger.events()).searchNodes).toEqual([]);
    expect(calls).toEqual({ select: 0, uct: 0, write: 0 });
    expect(director.events()).toHaveLength(directorEvents);
    expect(director.events().some((event) => event.type === "TASK_SELECTED")).toBe(false);
    expect(director.state().budget.consumed).toBe(0);
    expect(ledger.events().some((event) => /uct|selection|search.?node/i.test(event.type))).toBe(false);
  });

  test("does not accept UCT or SelectionPolicy as ledger options", () => {
    new HypothesisLedger({
      catalog: catalogWithMappedIds(),
      // @ts-expect-error H2 expand must not take a SelectionPolicy port
      selectionPolicy: { select() { return undefined; } },
    });
    new HypothesisLedger({
      catalog: catalogWithMappedIds(),
      // @ts-expect-error H2 expand must not take a UCT port
      uct: { uct() { return 0; } },
    });
    new HypothesisLedger({
      catalog: catalogWithMappedIds(),
      // @ts-expect-error H2 expand must not take a search-node writer
      searchNodes: { write() {}, nodes() { return []; } },
    });
  });
});

describe("H2 evidence_refs write validation", () => {
  test("rejects side-slot and MMD raw scores as promotion keys on every write that accepts evidence_refs", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    const illegal: unknown[] = [
      0.91,
      "0.91",
      { mmd: 0.12 },
      { sideSlot: 0.8 },
      { side_slot: 0.4 },
      { score: 1.3 },
    ];

    for (const key of illegal) {
      expect(() => ledger.createHypothesis({ statement: "bad create", evidenceRefs: [key] })).toThrow(/T48|promotion key|side-slot|MMD/i);
    }

    ledger.createHypothesis({
      hypothesisId: "h-valid",
      statement: "mapped refs only",
      evidenceRefs: ["ev-holdout"],
    });
    for (const key of illegal) {
      expect(() => ledger.planKillTest({
        hypothesisId: "h-valid",
        predicate: "bad plan",
        evidenceRefs: [key],
      })).toThrow(/T48|promotion key|side-slot|MMD/i);
    }

    ledger.planKillTest({
      planId: "kt-valid",
      hypothesisId: "h-valid",
      predicate: "hold-out must not move",
      evidenceRefs: ["ev-holdout"],
    });
    for (const key of illegal) {
      expect(() => ledger.finishKillTest({
        planId: "kt-valid",
        outcome: "pass",
        evidenceRefs: [key],
      })).toThrow(/T48|promotion key|side-slot|MMD/i);
    }
    expect(() => ledger.createHypothesis({ statement: "unknown", evidenceRefs: ["unknown-id"] })).toThrow(/unknown|T48/i);
  });
});
