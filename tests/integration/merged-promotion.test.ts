import { describe, expect, test } from "bun:test";
import { runLlmCompArmBeforePromotion } from "../../src/llm-comp-arm-before-promotion";
import { MockLlmCompetitionRuntime } from "../../src/llm-competition-runtime";
import { RESEARCH_PREDICTION as prediction } from "../../src/fixtures/research";
import { MethodologyToyCompetitionAdapter, fakeInnerCandidate } from "../../src/methodology-acceptance";
import { readMethodologyManifest, resolveMethodologyContracts as resolveManifestContracts } from "../../src/methodology";
import { assembleOuterE2eMinPath } from "../../src/outer-e2e-min-path";
import {
  ToyCompetitionHarness,
  auditMethodology,
  digestValue,
  ledgerEventKind,
  methodologyManifest,
  resolveMethodologyContracts,
  type CandidateSnapshot,
  type ValidationLevel,
} from "../../src/toy-harness";

const legacyContracts = resolveMethodologyContracts({
  split_contract: { id: "time-split", kind: "time", folds: 5, purge: 2, embargo: 1 },
  oof_ensemble: { id: "ensemble", members: ["a", "b"], method: "stack", oof: { protocol: "oof" } },
})!;
const manifestContracts = resolveManifestContracts({
  splitContract: { splitRef: { digest: digestValue(legacyContracts.split_contract) }, scheme: "time" },
  oofEnsemble: { required: true },
})!;

class CombinedAdapter extends MethodologyToyCompetitionAdapter {
  constructor(readonly oof: boolean, readonly level: ValidationLevel) { super(manifestContracts); }
  methodology_contracts() { return { ...legacyContracts }; }
  validation_ladder() { return { public_probe_cap: 0 }; }
  override evaluate(snapshot: Readonly<CandidateSnapshot>) {
    const result = super.evaluate(snapshot);
    return {
      ...result,
      validationLevel: this.level,
      facts: [...result.facts!, { name: "component", value: "ensemble" }, { name: "oof_present", value: this.oof }],
    };
  }
}

function setup(outcome: "pass" | "fail" | "inconclusive", oof = true, level: ValidationLevel = "outer_holdout") {
  const inner = fakeInnerCandidate({ contracts: manifestContracts, variant: "oof" });
  const path = assembleOuterE2eMinPath({
    outcome,
    contracts: manifestContracts,
    methodologyEvidence: readMethodologyManifest(inner.manifest, manifestContracts),
  });
  const options = {
    missionId: `combined-${outcome}-${oof}-${level}`,
    prediction,
    taskContract: { objective: "pass both methodology and promotion contracts" },
    branchIds: ["candidate"],
    adapter: new CombinedAdapter(oof, level),
    runtime: {
      selfVerify: () => ({ ok: true }),
      propose: () => ({ files: { ...inner.files } }),
      falsify: () => ({ ok: true, objections: [] }),
    },
    verification: { successAuditor: () => ({ ok: true, objections: [] }), killTestHang: path.killTestHang },
  };
  return { path, options, harness: new ToyCompetitionHarness(options) };
}

describe("merged methodology and promotion boundaries", () => {
  test("LLM assembly proposes once, only after prediction and self-verification", async () => {
    const order: string[] = [];
    class Runtime extends MockLlmCompetitionRuntime {
      override selfVerify() {
        order.push("selfVerify");
        return { ok: true, objections: [] };
      }
      override propose() {
        expect(order).toEqual(["selfVerify"]);
        order.push("propose");
        return { files: { score: "3" } };
      }
    }
    const run = await runLlmCompArmBeforePromotion({ runtime: new Runtime() });
    expect(order).toEqual(["selfVerify", "propose"]);
    expect(run.harness.events()[0]?.payload.predictions).toBeDefined();
    expect(run.state.champion?.snapshot.files).toEqual(run.arm.proposal.files);
  });

  test("an invalid prediction makes zero LLM proposal calls", async () => {
    let calls = 0;
    class Runtime extends MockLlmCompetitionRuntime {
      override propose() { calls += 1; return { files: { score: "3" } }; }
    }
    await expect(runLlmCompArmBeforePromotion({
      runtime: new Runtime(), prediction: { ...prediction, hypothesis: "" },
    })).rejects.toThrow(/prediction hypothesis/);
    expect(calls).toBe(0);
  });

  test("barrel keeps the static audit and exposes manifest contracts without name shadowing", () => {
    expect(auditMethodology(legacyContracts, { "train.py": "KFold(shuffle=True)" })).toHaveLength(1);
    const evidence = methodologyManifest.readMethodologyManifest({ split_ref_digest: "other" }, manifestContracts);
    expect(methodologyManifest.auditMethodology(evidence, manifestContracts).ok).toBe(false);
    expect(methodologyManifest.resolveMethodologyContracts({ oofEnsemble: { required: true } })).toEqual({ oofEnsemble: { required: true } });
    expect(ledgerEventKind("KILL_TESTER_COMPLETED")).toBe("Evidence");
  });

  test("local OOF and holdout requirements refuse before the kill-test writes a result", async () => {
    for (const [oof, level, reason] of [[false, "outer_holdout", /OOF/i], [true, "inner_cv", /outer-holdout/]] as const) {
      const { harness, path } = setup("pass", oof, level);
      const state = await harness.run();
      expect(state.branches.candidate.status).toBe("REJECTED");
      expect(state.branches.candidate.rejectionReason).toMatch(reason);
      expect(path.setup.ledger.resultFor(path.setup.planId)).toBeUndefined();
      expect(state.champion).toBeUndefined();
    }
  });

  test("passing local gates cannot bypass a failed or inconclusive KillTester", async () => {
    for (const outcome of ["pass", "fail", "inconclusive"] as const) {
      const { harness, path } = setup(outcome);
      const state = await harness.run();
      expect(path.setup.ledger.resultFor(path.setup.planId)?.outcome).toBe(outcome);
      expect(state.branches.candidate.status).toBe(outcome === "pass" ? "PROMOTED_LOCAL" : "REJECTED");
      expect(ToyCompetitionHarness.replay(harness.events()).champion).toEqual(state.champion);
      if (outcome !== "pass") expect(() => harness.acceptChampion({ acceptedBy: "operator" })).toThrow(/champion/);
    }
  });

  test("resume after a recorded KillTester does not repeat the ledger write", async () => {
    const { harness, options, path } = setup("pass");
    await harness.run();
    const events = harness.events();
    const killAt = events.findIndex((event) => event.type === "KILL_TESTER_COMPLETED");
    const resumed = ToyCompetitionHarness.fromEvents(options, events.slice(0, killAt + 1));
    expect((await resumed.run()).branches.candidate.status).toBe("PROMOTED_LOCAL");
    expect(path.setup.ledger.events().filter((event) => event.type === "kill_test.finished")).toHaveLength(1);
    expect(resumed.events().filter((event) => event.type === "KILL_TESTER_COMPLETED")).toHaveLength(1);
  });
});
