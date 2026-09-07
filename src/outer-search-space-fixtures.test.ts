import { describe, expect, test } from "bun:test";
import {
  HypothesisLedger,
  T48MappedCatalog,
} from "./hypothesis-ledger";
import { runKillTestHang } from "./kill-test-hang";
import {
  OUTER_SEARCH_SPACE_ATTACH_HOOKS,
  OUTER_SEARCH_SPACE_SEED,
  buildOuterSearchSpaceCatalog,
  buildOuterSearchSpaceFixtures,
} from "./outer-search-space-fixtures";
import {
  EvidenceMemory,
  MissionDirector,
  type ResearchTask,
} from "./research-loop";
import {
  SEARCH_SPACE_BINDING,
  diagnoseDiversity,
  diagnoseNearDup,
  dumpDiversityDiag,
  mapSearchSpaceEvidence,
} from "./search-space-profile";

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for E3");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for E3");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for E3");
    },
  };
}

describe("E3 outer search-space fixtures", () => {
  test("shared fixtures are importable and produce reproducible non-empty near-dup hits", () => {
    const first = buildOuterSearchSpaceFixtures();
    const second = buildOuterSearchSpaceFixtures({ seed: OUTER_SEARCH_SPACE_SEED });
    const replayed = diagnoseNearDup(first.binding, first.nearDupPair);

    expect(first.seed).toBe(42);
    expect(first.profile.mmd?.kernel.seed).toBe(42);
    expect(first.nearDup.status).toBe("hits");
    expect(first.nearDup.hits.length).toBeGreaterThan(0);
    expect(first.nearDup.hits[0]).toMatchObject({
      leftId: "cand-a",
      rightId: "cand-b",
    });
    expect(first.nearDup.hits[0]!.distance).toBeGreaterThanOrEqual(0);
    expect(first.nearDup.hits[0]!.distance).toBeLessThanOrEqual(first.profile.nearDup.maxDistance);
    expect(replayed.hits).toEqual(first.nearDup.hits);
    expect(second.nearDup.hits).toEqual(first.nearDup.hits);
    expect(second.profile.mmd?.kernel.seed).toBe(first.seed);
  });

  test("collapse window yields collapse_suspected; missing features are inconclusive", () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const collapsed = diagnoseDiversity(fixtures.binding, fixtures.collapseWindow);
    const missing = diagnoseDiversity(fixtures.binding, fixtures.missingFeatureWindow);
    const raised = buildOuterSearchSpaceFixtures({ collapseThreshold: 2 });

    expect(fixtures.collapse.verdict).toBe("collapse_suspected");
    expect(collapsed.verdict).toBe("collapse_suspected");
    expect(fixtures.collapse.collapseThreshold).toBe(0.05);
    expect(missing.verdict).toBe("inconclusive");
    expect(fixtures.missingFeatures.verdict).toBe("inconclusive");
    expect(fixtures.missingFeatures.missingDims).toEqual(["width"]);
    expect(fixtures.missingFeatures.diversityOk).not.toBe(true);
    expect(fixtures.missingFeatures).not.toHaveProperty("diversityOk", true);
    expect(fixtures.missingFeatures.verdict).not.toBe("ok");
    expect(raised.collapse.collapseThreshold).toBe(2);
    expect(raised.collapse.verdict).toBe("collapse_suspected");
  });

  test("attach+map exports T48 mapped {kind,id}; scalars and unmapped cannot masquerade as evidence_refs", () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const remapped = fixtures.hooks.mapSearchSpaceEvidence(fixtures.catalog, [
      fixtures.nearDupArtifact.artifactId,
      fixtures.diversityArtifact.artifactId,
    ]);

    expect(fixtures.mappedRefs).toEqual([
      { kind: "artifact", id: fixtures.nearDupArtifact.artifactId },
      { kind: "artifact", id: fixtures.diversityArtifact.artifactId },
    ]);
    expect(fixtures.mappedNearDup).toEqual({ kind: "artifact", id: fixtures.nearDupArtifact.artifactId });
    expect(fixtures.mappedDiversity).toEqual({ kind: "artifact", id: fixtures.diversityArtifact.artifactId });
    expect(remapped).toEqual(fixtures.mappedRefs);
    for (const ref of fixtures.mappedRefs) {
      expect(ref).toEqual({ kind: ref.kind, id: ref.id });
      expect(ref).not.toHaveProperty("mmd");
      expect(ref).not.toHaveProperty("near_dup");
      expect(typeof ref.id).toBe("string");
    }

    const ledger = new HypothesisLedger({ catalog: fixtures.catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "E1 Hypothesis wiring consumes mapped search-space refs only",
      evidenceRefs: fixtures.mappedRefs,
    });
    expect(hypothesis.evidenceRefs).toEqual(fixtures.mappedRefs);

    expect(() => mapSearchSpaceEvidence(fixtures.catalog, [fixtures.nearDup])).toThrow(/unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    expect(() => mapSearchSpaceEvidence(fixtures.catalog, [fixtures.collapse])).toThrow(/unmapped|T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    expect(() => mapSearchSpaceEvidence(fixtures.catalog, [{ mmd: fixtures.collapse.mmd }])).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    expect(() => ledger.createHypothesis({
      statement: "raw near-dup score is not evidence",
      evidenceRefs: [{ near_dup: fixtures.nearDup.hits[0]!.distance }],
    })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
  });

  test("binding stays diagnostic_only and does not change select_node / default inner A / #40", () => {
    const ports = smuggledSearchPorts();
    const fixtures = buildOuterSearchSpaceFixtures({
      select_node: ports.select_node,
      uct: ports.uct,
      selectionPolicy: { select: ports.select_node },
    } as Parameters<typeof buildOuterSearchSpaceFixtures>[0] & {
      readonly select_node: () => never;
      readonly uct: () => never;
      readonly selectionPolicy: { readonly select: () => never };
    });
    const tasks: readonly ResearchTask[] = [
      { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
      { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
    ];
    const before = new MissionDirector({
      missionId: "e3-before",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    const after = new MissionDirector({
      missionId: "e3-after",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(fixtures.binding.mode).toBe("diagnostic_only");
    expect(fixtures.nearDup.binding).toBe("diagnostic_only");
    expect(fixtures.collapse.binding).toBe("diagnostic_only");
    expect("select_node" in fixtures.binding).toBe(false);
    expect("uct" in fixtures.binding).toBe(false);
    expect("selectionPolicy" in fixtures.binding).toBe(false);
    expect("select_node" in fixtures).toBe(false);
    expect("uct" in fixtures).toBe(false);
    expect("selectionPolicy" in fixtures).toBe(false);
    expect(before.selectNextTask()?.taskId).toBe("baseline");
    expect(after.selectNextTask()?.taskId).toBe("baseline");
    expect(before.readyTasks().map((task) => task.taskId)).toEqual(
      after.readyTasks().map((task) => task.taskId),
    );
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
  });

  test("near-dup/MMD are not sole PROMOTED_*/Broker/Kill-test keys; fixture exports no such path", () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const catalog = buildOuterSearchSpaceCatalog();
    const scalars: unknown[] = [
      { mmd: fixtures.collapse.mmd },
      { mmdScore: 0.12 },
      { near_dup: fixtures.nearDup.hits[0]!.distance },
      { nearDup: 0.01 },
      { sideSlot: 0.8 },
      { diversity: 1 },
    ];

    expect(fixtures.hooks).toBe(OUTER_SEARCH_SPACE_ATTACH_HOOKS);
    expect(fixtures.hooks.attachSearchSpaceDiagnosis).toBeDefined();
    expect(fixtures.hooks.attachDiversityDiag).toBeDefined();
    expect(fixtures.hooks.mapSearchSpaceEvidence).toBeDefined();
    expect(fixtures).not.toHaveProperty("promote");
    expect(fixtures).not.toHaveProperty("promoted");
    expect(fixtures).not.toHaveProperty("broker");
    expect(fixtures).not.toHaveProperty("killTestKey");
    expect(fixtures).not.toHaveProperty("promotionKey");

    for (const key of scalars) {
      expect(() => fixtures.hooks.mapSearchSpaceEvidence(catalog, [key])).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
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

    const mappedHang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog: fixtures.catalog,
    });
    expect(mappedHang.ok).toBe(true);
    expect(mappedHang.blocksPromotion).toBe(false);
    expect(mappedHang.blocksBroker).toBe(false);
  });

  test("same seed replays DiversityDiag dump; consumer catalog can be attached through hooks", () => {
    const fixtures = buildOuterSearchSpaceFixtures();
    const replayed = dumpDiversityDiag(diagnoseDiversity(fixtures.binding, fixtures.collapseWindow));
    const memory = new EvidenceMemory();
    memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
    const external = T48MappedCatalog.fromMemory(memory);
    const attachedNearDup = fixtures.hooks.attachSearchSpaceDiagnosis({
      catalog: external,
      diagnosis: fixtures.nearDup,
    });
    const attachedDiversity = fixtures.hooks.attachDiversityDiag({
      catalog: attachedNearDup.catalog,
      diag: fixtures.collapse,
    });
    const mapped = fixtures.hooks.mapSearchSpaceEvidence(attachedDiversity.catalog, [
      attachedNearDup.artifact.artifactId,
      attachedDiversity.artifact.artifactId,
    ]);

    expect(replayed.digest).toBe(fixtures.diversityDump.digest);
    expect(replayed.kernel?.seed).toBe(42);
    expect(mapped).toEqual([
      { kind: "artifact", id: attachedNearDup.artifact.artifactId },
      { kind: "artifact", id: attachedDiversity.artifact.artifactId },
    ]);
  });
});
