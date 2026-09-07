import { describe, expect, test } from "bun:test";
import {
  HypothesisLedger,
  T48MappedCatalog,
} from "./hypothesis-ledger";
import {
  EvidenceMemory,
  MissionDirector,
  type ResearchTask,
} from "./research-loop";
import { runKillTestHang } from "./kill-test-hang";
import {
  SEARCH_SPACE_BINDING,
  attachSearchSpaceDiagnosis,
  bindSearchSpace,
  bindTaskSearchSpace,
  diagnoseNearDup,
  extractSearchFeatures,
  mapSearchSpaceEvidence,
  type SearchSpaceCandidate,
  type SearchSpaceProfile,
} from "./search-space-profile";

const PROFILE: SearchSpaceProfile = {
  featureDims: [{ name: "lr" }, { name: "width" }],
  nearDup: { maxDistance: 0.05 },
};

const NEAR_DUP_PAIR: readonly SearchSpaceCandidate[] = [
  { candidateId: "cand-a", features: { lr: 0.01, width: 64 } },
  { candidateId: "cand-b", features: { lr: 0.012, width: 64.01 } },
];

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for S1");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for S1");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for S1");
    },
  };
}

describe("SearchSpaceProfile near-dup detection", () => {
  test("two near-dup fake candidates produce measurable non-empty hits", () => {
    const task: ResearchTask & { readonly searchSpaceProfile?: SearchSpaceProfile } = {
      taskId: "explore-lr",
      objective: "explore nearby learning rates",
      searchSpaceProfile: PROFILE,
    };
    const binding = bindTaskSearchSpace(task);
    const diagnosis = diagnoseNearDup(binding, NEAR_DUP_PAIR);

    expect(diagnosis.hits.length).toBeGreaterThan(0);
    expect(diagnosis.status).toBe("hits");
    expect(diagnosis.hits[0]).toMatchObject({
      leftId: "cand-a",
      rightId: "cand-b",
    });
    expect(diagnosis.hits[0]!.distance).toBeGreaterThanOrEqual(0);
    expect(diagnosis.hits[0]!.distance).toBeLessThanOrEqual(PROFILE.nearDup.maxDistance);
    expect(extractSearchFeatures(PROFILE, NEAR_DUP_PAIR[0]!).missing).toEqual([]);
  });

  test("binding is diagnostic_only and does not change select_node or default inner A", () => {
    const ports = smuggledSearchPorts();
    const binding = bindSearchSpace({
      taskId: "explore-lr",
      profile: PROFILE,
      select_node: ports.select_node,
      uct: ports.uct,
      selectionPolicy: { select: ports.select_node },
    } as Parameters<typeof bindSearchSpace>[0] & {
      readonly select_node: () => never;
      readonly uct: () => never;
      readonly selectionPolicy: { readonly select: () => never };
    });

    expect(binding.mode).toBe("diagnostic_only");
    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect("select_node" in binding).toBe(false);
    expect("uct" in binding).toBe(false);
    expect("selectionPolicy" in binding).toBe(false);

    const diagnosis = diagnoseNearDup(binding, NEAR_DUP_PAIR);
    expect(diagnosis.binding).toBe("diagnostic_only");
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
    expect(() => bindSearchSpace({
      taskId: "explore-lr",
      profile: PROFILE,
      mode: "select_node" as "diagnostic_only",
    })).toThrow(/diagnostic_only/);
  });

  test("missing feature dims are inconclusive and never silent diversity ok", () => {
    const binding = bindSearchSpace({ taskId: "explore-lr", profile: PROFILE });
    const incomplete: readonly SearchSpaceCandidate[] = [
      { candidateId: "cand-a", features: { lr: 0.01 } },
      { candidateId: "cand-b", features: { lr: 0.012, width: 64 } },
    ];
    const diagnosis = diagnoseNearDup(binding, incomplete);

    expect(diagnosis.status).toBe("inconclusive");
    expect(diagnosis.missingDims).toEqual(["width"]);
    expect(diagnosis.diversityOk).not.toBe(true);
    expect(diagnosis).not.toHaveProperty("diversityOk", true);
    expect(extractSearchFeatures(PROFILE, incomplete[0]!).missing).toEqual(["width"]);
  });

  test("no profile leaves research selection identical to today and skips diagnosis", () => {
    const tasks: readonly ResearchTask[] = [
      { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
      { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
    ];
    const without = new MissionDirector({
      missionId: "s1-no-profile",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    const withSkipped = new MissionDirector({
      missionId: "s1-skipped-profile",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    const skipped = diagnoseNearDup(bindTaskSearchSpace(tasks[0]!), NEAR_DUP_PAIR);

    expect(skipped.status).toBe("skipped");
    expect(skipped.hits).toEqual([]);
    expect(skipped.diversityOk).toBeUndefined();
    expect(without.selectNextTask()?.taskId).toBe("baseline");
    expect(withSkipped.selectNextTask()?.taskId).toBe("baseline");
    expect(without.readyTasks().map((task) => task.taskId)).toEqual(
      withSkipped.readyTasks().map((task) => task.taskId),
    );
  });
});

describe("SearchSpaceProfile T48 / promotion isolation", () => {
  test("diagnostic artifacts enter Hypothesis evidence_refs only after T48 mapping", () => {
    const catalog = catalogWithMappedIds();
    const binding = bindSearchSpace({ taskId: "explore-lr", profile: PROFILE });
    const diagnosis = diagnoseNearDup(binding, NEAR_DUP_PAIR);
    const ledger = new HypothesisLedger({ catalog });

    expect(() => ledger.createHypothesis({
      statement: "raw near-dup score is not evidence",
      evidenceRefs: [{ near_dup: diagnosis.hits[0]!.distance }],
    })).toThrow(/T48|promotion key|side-slot|MMD|near-dup/i);

    const attached = attachSearchSpaceDiagnosis({ catalog, diagnosis });
    const mapped = mapSearchSpaceEvidence(attached.catalog, [attached.artifact.artifactId]);
    expect(mapped).toEqual([{ kind: "artifact", id: attached.artifact.artifactId }]);

    const mappedLedger = new HypothesisLedger({ catalog: attached.catalog });
    const hypothesis = mappedLedger.createHypothesis({
      statement: "near-dup diagnosis is an artifact, not a score",
      evidenceRefs: mapped,
    });
    expect(hypothesis.evidenceRefs).toEqual([{ kind: "artifact", id: attached.artifact.artifactId }]);
  });

  test("near-dup and side-slot scores are not PROMOTED_*/Broker/Kill-test sole keys", () => {
    const catalog = catalogWithMappedIds();
    const scalars: unknown[] = [
      { near_dup: 0.01 },
      { nearDup: 0.01 },
      { sideSlot: 0.8 },
      { diversity: 1 },
    ];
    for (const key of scalars) {
      expect(() => mapSearchSpaceEvidence(catalog, [key])).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
      const hang = runKillTestHang({
        outcome: "pass",
        evidenceRefs: [key],
        catalog,
      });
      expect(hang.ok).toBe(false);
      expect(hang.blocksPromotion).toBe(true);
      expect(hang.blocksBroker).toBe(true);
      expect(hang.objections.join(" ")).toMatch(/side-slot|MMD|near-dup|diversity|scalar|T48|promotion key/i);
    }
  });
});
