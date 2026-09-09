import { describe, expect, test } from "bun:test";
import {
  auditMethodology,
  compileMethodologyBlock,
  oofEnsembleGate,
  readMethodologyManifest,
  resolveMethodologyContracts,
  type MethodologyContracts,
  type MethodologyEvidence,
} from "./methodology";

const DIGEST = "sha256:toy-split-ref-v1";
const OTHER_DIGEST = "sha256:different-split";

function toyContracts(): MethodologyContracts {
  return resolveMethodologyContracts({
    splitContract: {
      scheme: "kfold",
      nSplits: 5,
      seed: 42,
      shuffle: true,
      splitRef: { id: "cv-v1", digest: DIGEST },
    },
    oofEnsemble: { required: true, strategy: "stacking" },
    featurePipeline: {
      fitScope: "train_fold",
      steps: ["impute", "scale"],
      forbidTargetLeak: true,
    },
  })!;
}

describe("methodology contract compile", () => {
  test("emits a snake_case plugin task methodology block from resolved contracts", () => {
    const block = compileMethodologyBlock(toyContracts());
    expect(block).toEqual({
      split_contract: {
        scheme: "kfold",
        n_splits: 5,
        seed: 42,
        shuffle: true,
        split_ref: { id: "cv-v1", digest: DIGEST },
      },
      oof_ensemble: { required: true, strategy: "stacking" },
      feature_pipeline: {
        fit_scope: "train_fold",
        steps: ["impute", "scale"],
        forbid_target_leak: true,
      },
    });
    expect(Object.keys(block!)).toEqual(["split_contract", "oof_ensemble", "feature_pipeline"]);
    expect(Object.isFrozen(block)).toBe(true);
  });

  test("resolves snake_case input the same way as camelCase before compile", () => {
    const fromSnake = resolveMethodologyContracts({
      split_contract: {
        scheme: "holdout",
        n_splits: 1,
        split_ref: { digest: DIGEST },
      },
      oof_ensemble: { required: false },
      feature_pipeline: { fit_scope: "train_only", forbid_target_leak: true },
    });
    const block = compileMethodologyBlock(fromSnake);
    expect(block).toEqual({
      split_contract: {
        scheme: "holdout",
        n_splits: 1,
        split_ref: { digest: DIGEST },
      },
      oof_ensemble: { required: false },
      feature_pipeline: {
        fit_scope: "train_only",
        forbid_target_leak: true,
      },
    });
  });

  test("returns undefined when there is no methodology contract", () => {
    expect(resolveMethodologyContracts(undefined)).toBeUndefined();
    expect(resolveMethodologyContracts({})).toBeUndefined();
    expect(compileMethodologyBlock(undefined)).toBeUndefined();
    expect(compileMethodologyBlock(resolveMethodologyContracts({}))).toBeUndefined();
  });
});

describe("methodology manifest read", () => {
  test("maps a matching fake plugin manifest into audit-feedable evidence", () => {
    const contracts = toyContracts();
    const block = compileMethodologyBlock(contracts);
    const manifest = {
      split_ref: block!.split_contract!.split_ref,
      oof_present: true,
    };
    const evidence = readMethodologyManifest(manifest, contracts);
    expectFeedable(evidence, {
      splitRefDigest: DIGEST,
      splitDigestAgreement: "agree",
      oofPresent: true,
    });
  });

  test("records digest disagreement and missing OOF without relaxing the mapping", () => {
    const contracts = toyContracts();
    const evidence = readMethodologyManifest({
      splitRef: { digest: OTHER_DIGEST },
      oofPresent: false,
    }, contracts);
    expectFeedable(evidence, {
      splitRefDigest: OTHER_DIGEST,
      splitDigestAgreement: "disagree",
      oofPresent: false,
    });
  });

  test("accepts snake or camel manifest fields and never treats a missing digest as agree", () => {
    const contracts = toyContracts();
    const camel = readMethodologyManifest({
      methodology: { oof: { present: true } },
    }, contracts);
    expect(camel.splitDigestAgreement).toBe("unknown");
    expect(camel.splitRefDigest).toBeUndefined();
    expect(camel.oofPresent).toBe(true);

    const echoedContractOnly = readMethodologyManifest({
      methodology: compileMethodologyBlock(contracts),
    }, contracts);
    expect(echoedContractOnly.splitDigestAgreement).toBe("unknown");
    expect(echoedContractOnly.oofPresent).toBe(false);
  });

  test("maps algorithm-evolve protocol fixtures into the same evidence surface", () => {
    const contracts = toyContracts();
    const protocol = readMethodologyManifest({
      feature_pipeline: { steps: [{ name: "impute" }] },
      oof_ensemble: { members: ["baseline", "tree"], oof: { protocol: "kfold" } },
      split_ref: { digest_summary: DIGEST },
    }, contracts);
    expectFeedable(protocol, {
      splitRefDigest: DIGEST,
      splitDigestAgreement: "agree",
      oofPresent: true,
    });

    const declared = readMethodologyManifest({
      split_ref: { digestSummary: DIGEST },
      oof_ensemble: { declared_equivalent: true },
    }, contracts);
    expect(declared.oofPresent).toBe(true);

    const missingOof = readMethodologyManifest({
      split_ref: { digest_summary: DIGEST },
      oof_ensemble: { members: ["baseline", "tree"] },
    }, contracts);
    expect(missingOof.oofPresent).toBe(false);
  });

  test("round-trips compile shape into evidence without inventing gate passage", () => {
    const contracts = toyContracts();
    const block = compileMethodologyBlock(contracts);
    const matching = readMethodologyManifest({
      split_ref: { digest: block!.split_contract!.split_ref.digest },
      oof_ensemble: { present: true },
    }, contracts);
    const mismatch = readMethodologyManifest({
      split_ref_digest: OTHER_DIGEST,
      oof: { present: false },
    }, contracts);

    expect(matching.splitDigestAgreement).toBe("agree");
    expect(mismatch.splitDigestAgreement).toBe("disagree");
    expect(matching.oofPresent).toBe(true);
    expect(mismatch.oofPresent).toBe(false);
    expect(block).not.toHaveProperty("pass");
    expect(matching).not.toHaveProperty("ok");
    expect(matching).not.toHaveProperty("promoted");
  });
});

describe("methodology T44 gates", () => {
  test("auditMethodology fails closed on split disagreement and sleeps without a split contract", () => {
    const contracts = toyContracts();
    expect(auditMethodology({
      splitRefDigest: OTHER_DIGEST,
      splitDigestAgreement: "disagree",
      oofPresent: true,
    }, contracts).ok).toBe(false);
    expect(auditMethodology({
      splitRefDigest: DIGEST,
      splitDigestAgreement: "agree",
      oofPresent: true,
    }, contracts).ok).toBe(true);
    expect(auditMethodology({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
  });

  test("oofEnsembleGate rejects missing OOF with a leak/OOF reason and sleeps when not required", () => {
    const required = toyContracts();
    const rejected = oofEnsembleGate({ splitDigestAgreement: "agree", oofPresent: false }, required);
    expect(rejected.ok).toBe(false);
    expect(rejected.objections.join(" ")).toMatch(/leak|OOF/i);
    expect(oofEnsembleGate({ splitDigestAgreement: "agree", oofPresent: true }, required).ok).toBe(true);
    expect(oofEnsembleGate({ splitDigestAgreement: "unknown", oofPresent: false }).ok).toBe(true);
  });
});

function expectFeedable(evidence: MethodologyEvidence, expected: MethodologyEvidence): void {
  expect(evidence).toEqual(expected);
  expect(Object.isFrozen(evidence)).toBe(true);
}
