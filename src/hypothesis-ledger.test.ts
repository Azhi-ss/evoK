import { describe, expect, test } from "bun:test";
import {
  HypothesisLedger,
  T48MappedCatalog,
  asKillTestPass,
  killTestOutcomeIsPass,
  type KillTestOutcome,
} from "./hypothesis-ledger";
import {
  EvidenceMemory,
  MissionDirector,
  type ResearchTask,
} from "./research-loop";

const TASKS: readonly ResearchTask[] = [
  { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
];

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function requirePass(_outcome: Extract<KillTestOutcome, "pass">): true {
  return true;
}

describe("hypothesis / kill-test ledger schema", () => {
  test("records Hypothesis, KillTestPlan, KillTestResult and their edges as events", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    const hypothesis = ledger.createHypothesis({
      hypothesisId: "h-leak",
      statement: "shared preprocessing leaks the hold-out split",
      evidenceRefs: ["ev-holdout", "art-score"],
    });
    const plan = ledger.planKillTest({
      planId: "kt-1",
      hypothesisId: hypothesis.hypothesisId,
      criterion: "retrain without the shared step; hold-out must not move",
      evidenceRefs: ["ev-holdout"],
    });
    const result = ledger.finishKillTest({
      resultId: "ktr-1",
      planId: plan.planId,
      outcome: "fail",
      evidenceRefs: ["ev-kill"],
    });

    expect(hypothesis.status).toBe("open");
    expect(plan.hypothesisId).toBe("h-leak");
    expect(result.planId).toBe("kt-1");
    expect(result.hypothesisId).toBe("h-leak");
    expect(ledger.plansFor("h-leak").map((entry) => entry.planId)).toEqual(["kt-1"]);
    expect(ledger.resultFor("kt-1")?.resultId).toBe("ktr-1");
    expect(ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "kill_test.planned",
      "kill_test.finished",
    ]);
    expect(ledger.state().hypotheses["h-leak"]?.killTestPlanIds).toEqual(["kt-1"]);
  });

  test("can mark a hypothesis supported, killed, or superseded via status_changed", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    ledger.createHypothesis({ hypothesisId: "h-open", statement: "first claim", evidenceRefs: ["ev-holdout"] });
    ledger.createHypothesis({ hypothesisId: "h-next", statement: "refined claim", evidenceRefs: ["ev-holdout"] });
    expect(ledger.changeStatus("h-open", "supported").status).toBe("supported");
    expect(ledger.changeStatus("h-open", "killed").status).toBe("killed");
    expect(ledger.changeStatus("h-open", "superseded", { supersededBy: "h-next" }).status).toBe("superseded");
    expect(ledger.state().hypotheses["h-open"]?.supersededBy).toBe("h-next");
    expect(ledger.events().filter((event) => event.type === "hypothesis.status_changed")).toHaveLength(3);
  });
});

describe("hypothesis.expand_requested isolation", () => {
  test("stays ledger-only, may enqueue a Campaign Task, and does not select or write search nodes", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    ledger.createHypothesis({ hypothesisId: "h-expand", statement: "try a cheaper preprocessor", evidenceRefs: ["ev-holdout"] });
    const queued = {
      campaignId: "campaign-expand",
      task: { taskId: "expand-task", objective: "run the cheaper preprocessor", estimatedCost: 1 },
    };
    const eventCount = ledger.events().length;
    const hypothesis = ledger.requestExpand("h-expand", { enqueue: queued });

    expect(hypothesis.hypothesisId).toBe("h-expand");
    expect(ledger.events()).toHaveLength(eventCount + 1);
    expect(ledger.events().at(-1)?.type).toBe("hypothesis.expand_requested");
    expect(ledger.events().at(-1)?.payload).toMatchObject({ hypothesisId: "h-expand", enqueue: queued });
    expect(ledger.queuedCampaignTasks()).toEqual([queued]);
    expect(ledger.campaignTasksFor("h-expand")).toEqual([queued]);
    expect(ledger.searchNodes()).toEqual([]);
    expect(ledger.state().searchNodes).toEqual([]);
    expect(ledger.events().map((event) => event.type)).toEqual([
      "hypothesis.created",
      "hypothesis.expand_requested",
    ]);
    expect(ledger.events().some((event) => /uct|selection|search.?node/i.test(event.type))).toBe(false);
  });
});

describe("kill-test outcome tri-state", () => {
  test("records pass, fail, and inconclusive, and treats inconclusive as not pass", () => {
    const ledger = new HypothesisLedger({ catalog: catalogWithMappedIds() });
    ledger.createHypothesis({ hypothesisId: "h-a", statement: "A", evidenceRefs: ["ev-holdout"] });
    ledger.createHypothesis({ hypothesisId: "h-b", statement: "B", evidenceRefs: ["ev-holdout"] });
    ledger.createHypothesis({ hypothesisId: "h-c", statement: "C", evidenceRefs: ["ev-holdout"] });
    ledger.planKillTest({ planId: "p-pass", hypothesisId: "h-a", criterion: "kill A" });
    ledger.planKillTest({ planId: "p-fail", hypothesisId: "h-b", criterion: "kill B" });
    ledger.planKillTest({ planId: "p-inc", hypothesisId: "h-c", criterion: "kill C" });

    expect(ledger.finishKillTest({ planId: "p-pass", outcome: "pass", evidenceRefs: ["ev-kill"] }).outcome).toBe("pass");
    expect(ledger.finishKillTest({ planId: "p-fail", outcome: "fail", evidenceRefs: ["ev-kill"] }).outcome).toBe("fail");
    expect(ledger.finishKillTest({ planId: "p-inc", outcome: "inconclusive", evidenceRefs: ["ev-kill"] }).outcome).toBe("inconclusive");

    expect(killTestOutcomeIsPass("pass")).toBe(true);
    expect(killTestOutcomeIsPass("fail")).toBe(false);
    expect(killTestOutcomeIsPass("inconclusive")).toBe(false);
    expect(asKillTestPass("pass")).toBe("pass");
    expect(() => asKillTestPass("inconclusive")).toThrow(/inconclusive|not pass/i);
    expect(() => asKillTestPass("fail")).toThrow(/not pass/i);

    expect(ledger.state().hypotheses["h-a"]?.status).toBe("killed");
    expect(ledger.state().hypotheses["h-b"]?.status).toBe("open");
    expect(ledger.state().hypotheses["h-c"]?.status).toBe("open");
    expect(requirePass("pass")).toBe(true);
    // @ts-expect-error inconclusive must not satisfy the pass brand
    requirePass("inconclusive");
  });
});

describe("T48-mapped evidence_refs", () => {
  test("accepts only catalog Evidence/Artifact ids and rejects side-slot or MMD scores as promotion keys", () => {
    const catalog = catalogWithMappedIds();
    const ledger = new HypothesisLedger({ catalog });

    const mapped = catalog.mapAll(["ev-holdout", "art-score"]);
    expect(mapped).toEqual([
      { kind: "evidence", id: "ev-holdout" },
      { kind: "artifact", id: "art-score" },
    ]);

    const hypothesis = ledger.createHypothesis({
      statement: "mapped refs only",
      evidenceRefs: ["ev-holdout"],
    });
    expect(hypothesis.evidenceRefs).toEqual([{ kind: "evidence", id: "ev-holdout" }]);

    const rejected: unknown[] = [
      0.91,
      "0.91",
      { mmd: 0.12 },
      { sideSlot: 0.8 },
      { side_slot: 0.4 },
      { score: 1.3 },
    ];
    for (const key of rejected) {
      expect(() => catalog.map(key)).toThrow(/T48|promotion key|side-slot|MMD/i);
      expect(() => ledger.createHypothesis({ statement: "bad key", evidenceRefs: [key] })).toThrow(/T48|promotion key|side-slot|MMD/i);
    }
    expect(() => catalog.map("unknown-id")).toThrow(/unknown|T48/i);
  });

  test("maps MissionDirector evidence and artifacts through the T48 catalog", () => {
    const director = new MissionDirector({
      missionId: "h1-catalog",
      objective: "learn",
      budget: 5,
      tasks: TASKS,
    });
    director.selectNextTask();
    director.completeTask("baseline", {
      evidence: [{ id: "hypothesis-1", kind: "hypothesis", summary: "a cheaper split should hold" }],
      findings: [{
        id: "finding-1",
        statement: "the cheaper split is worth a kill-test",
        evidenceRefs: ["hypothesis-1"],
        verified: true,
      }],
      artifacts: [{ artifactId: "artifact-1", digest: "artifact-digest" }],
    });

    const catalog = T48MappedCatalog.fromMission(director);
    const ledger = new HypothesisLedger({ catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "cheaper split holds",
      evidenceRefs: ["finding-1", "artifact-1"],
    });
    expect(hypothesis.evidenceRefs).toEqual([
      { kind: "evidence", id: "finding-1" },
      { kind: "artifact", id: "artifact-1" },
    ]);
    expect(() => ledger.createHypothesis({ statement: "score key", evidenceRefs: [{ mmd: 0.2 }] })).toThrow();
  });
});
