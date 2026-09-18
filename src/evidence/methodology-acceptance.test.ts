import { describe, expect, test } from "bun:test";
import {
  auditMethodology,
  compileMethodologyBlock,
  oofEnsembleGate,
  readMethodologyManifest,
  resolveMethodologyContracts,
} from "./methodology";
import {
  MethodologyToyCompetitionAdapter,
  compilePluginTask,
  componentRegionHash,
  fakeInnerCandidate,
  runMethodologyAcceptance,
} from "./methodology-acceptance";
import oofManifest from "../fixtures/methodology/manifest-oof.json";
import noOofManifest from "../fixtures/methodology/manifest-no-oof.json";
import splitMismatchManifest from "../fixtures/methodology/manifest-split-mismatch.json";
import declaredEquivalentManifest from "../fixtures/methodology/manifest-declared-equivalent.json";
import contractFixture from "../fixtures/methodology/plugin-task.contract.json";

const contracts = resolveMethodologyContracts(contractFixture)!;

describe("T48.5 methodology manifest seam (fake inner)", () => {
  test("runs the full fake chain: adapter contract → plugin task JSON → inner manifest → evoK validate/promote", async () => {
    const task = compilePluginTask(contracts);
    expect(task.methodology).toEqual(compileMethodologyBlock(contracts));
    expect(Object.keys(task.methodology!)).toEqual(["split_contract", "oof_ensemble", "feature_pipeline"]);

    const inner = fakeInnerCandidate({ contracts, variant: "oof", score: "3" });
    expect(inner.task).toEqual(task);
    expect(inner.task.methodology?.split_contract?.split_ref.digest).toBe(contracts.splitContract?.splitRef.digest);
    expect(inner.manifest).toEqual(oofManifest);
    expect(inner.files["methodology.json"]).toBe(JSON.stringify(oofManifest));

    const evidence = readMethodologyManifest(inner.manifest, contracts);
    expect(evidence.splitDigestAgreement).toBe("agree");
    expect(evidence.oofPresent).toBe(true);
    expect(auditMethodology(evidence, contracts).ok).toBe(true);
    expect(oofEnsembleGate(evidence, contracts).ok).toBe(true);

    const result = await runMethodologyAcceptance({
      missionId: "t48-5-chain",
      contracts,
      variant: "oof",
      score: "3",
    });

    expect(result.state.phase).toBe("COMPLETED");
    expect(result.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(result.task.methodology).toEqual(compileMethodologyBlock(contracts));
    expect(result.state.champion?.snapshot.files["methodology.json"]).toBe(JSON.stringify(oofManifest));
    expect(result.adapter.name).toBe("methodology-toy");
    expect(result.evaluations).toBe(1);
  });

  test("Demo A: split-ref disagreement is a rule fail quarantined before evaluation", async () => {
    const inner = fakeInnerCandidate({ contracts, variant: "split-mismatch" });
    expect(inner.manifest).toEqual(splitMismatchManifest);
    expect(readMethodologyManifest(inner.manifest, contracts).splitDigestAgreement).toBe("disagree");
    expect(auditMethodology(readMethodologyManifest(inner.manifest, contracts), contracts).ok).toBe(false);

    const result = await runMethodologyAcceptance({
      missionId: "t48-5-split",
      contracts,
      variant: "split-mismatch",
    });

    expect(result.state.branches.candidate.status).toBe("QUARANTINED");
    expect(result.state.champion).toBeUndefined();
    expect(result.evaluations).toBe(0);
    expect(result.events.some((event) => event.type === "EVALUATION_STARTED")).toBe(false);
    expect(result.events.some((event) => event.type === "BRANCH_QUARANTINED")).toBe(true);
    expect(result.state.branches.candidate.rejectionReason).toMatch(/split/i);
  });

  test("Demo B: OOF ensemble promotes locally; no-OOF ensemble is rejected for leak/OOF", async () => {
    const withOof = await runMethodologyAcceptance({
      missionId: "t48-5-oof",
      contracts,
      variant: "oof",
      score: "2",
    });
    expect(withOof.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(withOof.evaluations).toBe(1);

    const declared = await runMethodologyAcceptance({
      missionId: "t48-5-declared",
      contracts,
      variant: "declared-equivalent",
      score: "2",
    });
    expect(fakeInnerCandidate({ contracts, variant: "declared-equivalent" }).manifest).toEqual(declaredEquivalentManifest);
    expect(declared.state.branches.candidate.status).toBe("PROMOTED_LOCAL");

    const noOofEvidence = readMethodologyManifest(noOofManifest, contracts);
    expect(noOofEvidence.oofPresent).toBe(false);
    expect(oofEnsembleGate(noOofEvidence, contracts).ok).toBe(false);
    expect(oofEnsembleGate(noOofEvidence, contracts).objections.join(" ")).toMatch(/leak|OOF/i);

    const withoutOof = await runMethodologyAcceptance({
      missionId: "t48-5-no-oof",
      contracts,
      variant: "no-oof",
      score: "9",
    });
    expect(withoutOof.state.branches.candidate.status).toBe("REJECTED");
    expect(withoutOof.state.champion).toBeUndefined();
    expect(withoutOof.state.branches.candidate.rejectionReason).toMatch(/leak|OOF/i);
    expect(withoutOof.events.some((event) => event.type === "PROMOTED_LOCAL")).toBe(false);
  });

  test("Demo C: FE-only keeps ensemble+split hash; ensemble-only keeps FE+split hash", async () => {
    const parent = fakeInnerCandidate({ contracts, variant: "oof" });
    const feOnly = fakeInnerCandidate({ contracts, variant: "oof", component: "feature_pipeline" });
    const ensembleOnly = fakeInnerCandidate({ contracts, variant: "oof", component: "oof_ensemble" });
    const parentManifest = JSON.parse(parent.files["methodology.json"]);
    const feManifest = JSON.parse(feOnly.files["methodology.json"]);
    const ensembleManifest = JSON.parse(ensembleOnly.files["methodology.json"]);

    expect(feOnly.task).toEqual(parent.task);
    expect(componentRegionHash(feManifest, "oof_ensemble")).toBe(componentRegionHash(parentManifest, "oof_ensemble"));
    expect(componentRegionHash(feManifest, "split_ref")).toBe(componentRegionHash(parentManifest, "split_ref"));
    expect(componentRegionHash(feManifest, "feature_pipeline")).not.toBe(componentRegionHash(parentManifest, "feature_pipeline"));

    expect(componentRegionHash(ensembleManifest, "feature_pipeline")).toBe(componentRegionHash(parentManifest, "feature_pipeline"));
    expect(componentRegionHash(ensembleManifest, "split_ref")).toBe(componentRegionHash(parentManifest, "split_ref"));
    expect(componentRegionHash(ensembleManifest, "oof_ensemble")).not.toBe(componentRegionHash(parentManifest, "oof_ensemble"));

    const feRun = await runMethodologyAcceptance({
      missionId: "t48-5-fe-only",
      contracts,
      variant: "oof",
      component: "feature_pipeline",
    });
    const ensembleRun = await runMethodologyAcceptance({
      missionId: "t48-5-ensemble-only",
      contracts,
      variant: "oof",
      component: "oof_ensemble",
    });
    expect(feRun.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(ensembleRun.state.branches.candidate.status).toBe("PROMOTED_LOCAL");
  });

  test("does not invent gate passage: compile and echoed contracts still sleep or fail closed", () => {
    const adapter = new MethodologyToyCompetitionAdapter(contracts);
    const echoed = readMethodologyManifest({ methodology: adapter.pluginTask().methodology }, contracts);
    expect(echoed.splitDigestAgreement).toBe("unknown");
    expect(echoed.oofPresent).toBe(false);
    expect(auditMethodology(echoed, contracts).ok).toBe(false);
    expect(oofEnsembleGate(echoed, contracts).ok).toBe(false);

    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }, undefined).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }, undefined).ok).toBe(true);
  });
});
