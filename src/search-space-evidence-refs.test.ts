import { describe, expect, test } from "bun:test";
import {
  HypothesisLedger,
  T48MappedCatalog,
} from "./hypothesis-ledger";
import {
  auditMethodology,
  oofEnsembleGate,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";
import { EvidenceMemory, MissionDirector, type ResearchTask } from "./research-loop";
import { runKillTestHang } from "./kill-test-hang";
import { verificationRoleContract } from "./verification-gates";
import {
  OUTER_COLLAPSE_WINDOW,
  OUTER_MMD_PROFILE,
  OUTER_NEAR_DUP_PAIR,
  OUTER_NEAR_DUP_PROFILE,
} from "./outer-search-space-fixtures";
import {
  SEARCH_SPACE_BINDING,
  attachDiversityDiag,
  attachSearchSpaceDiagnosis,
  bindSearchSpace,
  diagnoseDiversity,
  diagnoseNearDup,
  dumpDiversityDiag,
  projectHypothesisSearchSpaceRefs,
  readSearchSpaceEvidenceRefs,
} from "./search-space-profile";

const PROFILE = OUTER_NEAR_DUP_PROFILE;
const MMD_PROFILE = OUTER_MMD_PROFILE;
const NEAR_DUP_PAIR = OUTER_NEAR_DUP_PAIR;
const COLLAPSED_WINDOW = OUTER_COLLAPSE_WINDOW;

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function attachMappedDiagnoses(catalog: T48MappedCatalog) {
  const nearDup = attachSearchSpaceDiagnosis({
    catalog,
    diagnosis: diagnoseNearDup(bindSearchSpace({ taskId: "explore-lr", profile: PROFILE }), NEAR_DUP_PAIR),
  });
  const diversity = attachDiversityDiag({
    catalog: nearDup.catalog,
    diag: diagnoseDiversity(bindSearchSpace({ taskId: "explore-lr", profile: MMD_PROFILE }), COLLAPSED_WINDOW),
  });
  return { nearDup, diversity, catalog: diversity.catalog };
}

function smuggledSearchPorts() {
  const calls = { select: 0, uct: 0, write: 0 };
  return {
    calls,
    select_node() {
      calls.select += 1;
      throw new Error("select_node / default inner A must not run for S3");
    },
    uct() {
      calls.uct += 1;
      throw new Error("UCT / #40 must not run for S3");
    },
    writeSearchNode() {
      calls.write += 1;
      throw new Error("search nodes must not be written for S3");
    },
  };
}

describe("S3 outer read-only search-space evidence_refs", () => {
  test("read-only mapped DiversityDiag and near-dup artifacts are accepted onto Hypothesis.evidence_refs", () => {
    const attached = attachMappedDiagnoses(catalogWithMappedIds());
    const refs = readSearchSpaceEvidenceRefs(attached.catalog, [
      attached.nearDup.artifact,
      attached.diversity.dump,
    ]);

    expect(refs).toEqual([
      { kind: "artifact", id: attached.nearDup.artifact.artifactId },
      { kind: "artifact", id: attached.diversity.artifact.artifactId },
    ]);
    expect(attached.nearDup.artifact.kind).toBe("near_dup_diagnosis");
    expect(attached.diversity.artifact.kind).toBe("diversity_diag");

    const ledger = new HypothesisLedger({ catalog: attached.catalog });
    const created = ledger.createHypothesis({
      hypothesisId: "h-s3",
      statement: "mapped search-space diagnoses are evidence refs, not scores",
      evidenceRefs: ["ev-holdout"],
    });
    const eventCount = ledger.events().length;

    const projected = projectHypothesisSearchSpaceRefs({
      catalog: attached.catalog,
      hypothesis: created,
      sources: [attached.nearDup, attached.diversity],
    });

    expect(projected.hypothesisId).toBe("h-s3");
    expect(projected.status).toBe("open");
    expect(projected.evidenceRefs).toEqual([
      { kind: "evidence", id: "ev-holdout" },
      { kind: "artifact", id: attached.nearDup.artifact.artifactId },
      { kind: "artifact", id: attached.diversity.artifact.artifactId },
    ]);
    expect(ledger.events()).toHaveLength(eventCount);
    expect(ledger.state().hypotheses["h-s3"]?.evidenceRefs).toEqual([{ kind: "evidence", id: "ev-holdout" }]);

    const written = new HypothesisLedger({ catalog: attached.catalog }).createHypothesis({
      statement: "ledger write still accepts the same mapped refs",
      evidenceRefs: refs,
    });
    expect(written.evidenceRefs).toEqual(refs);
    expect(written.status).toBe("open");
  });

  test("unmapped DiversityDiag / near-dup diagnoses and unknown ids are rejected", () => {
    const catalog = catalogWithMappedIds();
    const diagnosis = diagnoseNearDup(bindSearchSpace({ taskId: "explore-lr", profile: PROFILE }), NEAR_DUP_PAIR);
    const diag = diagnoseDiversity(bindSearchSpace({ taskId: "explore-lr", profile: MMD_PROFILE }), COLLAPSED_WINDOW);
    const dump = dumpDiversityDiag(diag);
    const ledger = new HypothesisLedger({ catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "open hypothesis with mapped evidence only",
      evidenceRefs: ["ev-holdout"],
    });

    expect(() => readSearchSpaceEvidenceRefs(catalog, [diagnosis])).toThrow(/unmapped|T48/i);
    expect(() => readSearchSpaceEvidenceRefs(catalog, [diag])).toThrow(/unmapped|T48/i);
    expect(() => readSearchSpaceEvidenceRefs(catalog, [dump])).toThrow(/unknown|unmapped|T48/i);
    expect(() => readSearchSpaceEvidenceRefs(catalog, ["near-dup:not-in-catalog"])).toThrow(/unknown|unmapped|T48/i);
    expect(() => projectHypothesisSearchSpaceRefs({
      catalog,
      hypothesis,
      sources: [diagnosis],
    })).toThrow(/unmapped|T48/i);
    expect(() => ledger.createHypothesis({
      statement: "illegal unmapped diagnosis",
      evidenceRefs: readSearchSpaceEvidenceRefs(catalog, [diag]),
    })).toThrow(/unmapped|T48/i);
  });

  test("side-slot / MMD / near-dup scalar scores are not promotion keys", () => {
    const catalog = catalogWithMappedIds();
    const ledger = new HypothesisLedger({ catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "scalars cannot be attached",
      evidenceRefs: ["ev-holdout"],
    });
    const scalars: unknown[] = [
      0.91,
      "0.12",
      { mmd: 0.12 },
      { mmdScore: 0.12 },
      { near_dup: 0.01 },
      { nearDup: 0.01 },
      { sideSlot: 0.8 },
      { diversity: 1 },
    ];

    for (const key of scalars) {
      expect(() => readSearchSpaceEvidenceRefs(catalog, [key])).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
      expect(() => projectHypothesisSearchSpaceRefs({
        catalog,
        hypothesis,
        sources: [key],
      })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
      expect(() => ledger.createHypothesis({
        statement: "scalar is not a promotion key",
        evidenceRefs: [key],
      })).toThrow(/T48|promotion key|side-slot|MMD|near-dup|diversity/i);
    }
  });

  test("does not change Broker / before-promotion / auditMethodology / oofEnsembleGate semantics", () => {
    const attached = attachMappedDiagnoses(catalogWithMappedIds());
    const contracts: MethodologyContracts = {
      splitContract: { splitRef: { digest: "sha256:toy-split-ref-v1" } },
      oofEnsemble: { required: true },
    };
    const agree: MethodologyEvidence = {
      splitRefDigest: "sha256:toy-split-ref-v1",
      splitDigestAgreement: "agree",
      oofPresent: true,
    };
    const disagree: MethodologyEvidence = {
      splitRefDigest: "sha256:other",
      splitDigestAgreement: "disagree",
      oofPresent: false,
    };
    const missing: MethodologyEvidence = {
      splitDigestAgreement: "unknown",
      oofPresent: false,
    };

    expect(auditMethodology(agree, contracts).ok).toBe(true);
    expect(auditMethodology(disagree, contracts).ok).toBe(false);
    expect(auditMethodology(missing, contracts).ok).toBe(false);
    expect(auditMethodology(agree).ok).toBe(true);
    expect(oofEnsembleGate(agree, contracts).ok).toBe(true);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(oofEnsembleGate(agree).ok).toBe(true);
    expect(verificationRoleContract("SuccessAuditor").trigger).toBe("before-promotion");
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");

    const ledger = new HypothesisLedger({ catalog: attached.catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "projection must not relax gates",
      evidenceRefs: ["ev-holdout"],
    });
    const projected = projectHypothesisSearchSpaceRefs({
      catalog: attached.catalog,
      hypothesis,
      sources: [attached.nearDup.artifact.artifactId, attached.diversity.artifact.artifactId],
    });
    expect(projected.status).toBe("open");
    expect(projected.status).not.toBe("killed");

    expect(auditMethodology(agree, contracts).ok).toBe(true);
    expect(auditMethodology(disagree, contracts).ok).toBe(false);
    expect(oofEnsembleGate(missing, contracts).ok).toBe(false);
    expect(verificationRoleContract("KillTester").trigger).toBe("before-promotion");

    const hang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog: attached.catalog,
      contracts,
      methodologyEvidence: agree,
    });
    expect(hang.ok).toBe(true);
    expect(hang.blocksPromotion).toBe(false);
    expect(hang.blocksBroker).toBe(false);

    const scalarHang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: [{ mmd: attached.diversity.dump.mmd }],
      catalog: attached.catalog,
    });
    expect(scalarHang.ok).toBe(false);
    expect(scalarHang.blocksPromotion).toBe(true);
    expect(scalarHang.blocksBroker).toBe(true);

    const disagreeHang = runKillTestHang({
      outcome: "pass",
      evidenceRefs: ["ev-kill"],
      catalog: attached.catalog,
      contracts,
      methodologyEvidence: disagree,
    });
    expect(disagreeHang.ok).toBe(false);
    expect(disagreeHang.blocksBroker).toBe(true);
  });

  test("does not change default parent selection A and leaves #40 SelectionPolicy off", () => {
    const ports = smuggledSearchPorts();
    const tasks: readonly ResearchTask[] = [
      { taskId: "baseline", objective: "measure the baseline", estimatedCost: 2, priority: 3 },
      { taskId: "cheap-check", objective: "check a cheap alternative", estimatedCost: 1, priority: 2 },
    ];
    const before = new MissionDirector({
      missionId: "s3-before",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });
    const attached = attachMappedDiagnoses(catalogWithMappedIds());
    const ledger = new HypothesisLedger({ catalog: attached.catalog });
    const hypothesis = ledger.createHypothesis({
      statement: "search defaults stay tree+fixed_uct / #40 off",
      evidenceRefs: ["ev-holdout"],
    });
    projectHypothesisSearchSpaceRefs({
      catalog: attached.catalog,
      hypothesis,
      sources: [attached.nearDup.mapped[0], attached.diversity.mapped[0]],
      select_node: ports.select_node,
      uct: ports.uct,
      selectionPolicy: { select: ports.select_node },
    } as Parameters<typeof projectHypothesisSearchSpaceRefs>[0] & {
      readonly select_node: () => never;
      readonly uct: () => never;
      readonly selectionPolicy: { readonly select: () => never };
    });
    const after = new MissionDirector({
      missionId: "s3-after",
      objective: "improve the competition result",
      budget: 10,
      tasks,
    });

    expect(SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(before.selectNextTask()?.taskId).toBe("baseline");
    expect(after.selectNextTask()?.taskId).toBe("baseline");
    expect(before.readyTasks().map((task) => task.taskId)).toEqual(
      after.readyTasks().map((task) => task.taskId),
    );
    expect(ports.calls).toEqual({ select: 0, uct: 0, write: 0 });
  });
});
