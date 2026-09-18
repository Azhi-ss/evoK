import { describe, expect, test } from "bun:test";
import {
  resolveMethodologyContracts,
  auditMethodology,
  validateEnsemblePromotion,
  applyComponentFanOut,
  normalizeFeaturePipeline,
  normalizeOofEnsemble,
  normalizeSplitContract,
  MethodologyViolation,
  type MethodologyContracts,
  type MethodologyDeclaration,
} from "./methodology-contracts";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type ToyAgentRuntime,
} from "../toy-harness";

/** A provider exposing all three contracts via the snake_case accessor (adapter face). */
function providerWith(decl: MethodologyDeclaration): Record<string, unknown> {
  return {
    evaluate: () => ({ score: 0 }),
    methodology: () => structuredClone(decl),
  };
}

const FULL_DECL: MethodologyDeclaration = {
  feature_pipeline: {
    id: "fp-tabular-v1",
    steps: [
      { id: "fillna", kind: "impute", params: { strategy: "median" } },
      { id: "onehot", kind: "encode", params: { columns: ["cat_a"] } },
    ],
  },
  oof_ensemble: {
    id: "ens-blend-v1",
    members: ["model_lgbm", "model_linear"],
    method: "blend",
    oof: { protocol: "oof", folds: 5 },
  },
  split_contract: {
    id: "split-time-v1",
    kind: "time",
    folds: 5,
    purge: 2,
    embargo: 1,
    group_column: "week_id",
  },
};

describe("resolveMethodologyContracts", () => {
  test("accepts a plain declaration object (candidate/task face)", () => {
    const c = resolveMethodologyContracts(structuredClone(FULL_DECL))!;
    expect(c).toBeDefined();
    expect(c.split_contract!.kind).toBe("time");
    expect(c.split_contract!.purge).toBe(2);
    expect(c.split_contract!.embargo).toBe(1);
    expect(c.feature_pipeline!.id).toBe("fp-tabular-v1");
    expect(c.oof_ensemble!.method).toBe("blend");
  });

  test("resolves snake_case and camelCase provider accessors", () => {
    const snake = resolveMethodologyContracts(providerWith(FULL_DECL))!;
    const camel = resolveMethodologyContracts({
      evaluate: () => ({ score: 0 }),
      methodologyContracts: () => structuredClone(FULL_DECL),
    })!;
    expect(snake.split_contract!.id).toBe("split-time-v1");
    expect(camel.split_contract!.id).toBe("split-time-v1");
  });

  test("absent contract face → inactive (undefined)", () => {
    expect(resolveMethodologyContracts(undefined)).toBeUndefined();
    expect(resolveMethodologyContracts({ evaluate: () => ({ score: 0 }) })).toBeUndefined();
  });

  test("a declaration with no recognized object is inactive", () => {
    expect(resolveMethodologyContracts({ objective: "x" })).toBeUndefined();
  });

  test("rejects unknown split kind (fails closed)", () => {
    const bad = structuredClone(FULL_DECL);
    (bad.split_contract as unknown as Record<string, unknown>).kind = "random";
    expect(() => resolveMethodologyContracts(bad)).toThrow(/split kind/);
  });

  test("rejects negative purge/embargo", () => {
    const bad = structuredClone(FULL_DECL) as MethodologyDeclaration & {
      split_contract: { kind: string; purge: number };
    };
    bad.split_contract.purge = -1;
    expect(() => resolveMethodologyContracts(bad)).toThrow(/purge/);
  });

  test("group split without a group_column fails closed", () => {
    const bad = structuredClone(FULL_DECL);
    bad.split_contract = { id: "g", kind: "group" };
    expect(() => resolveMethodologyContracts(bad)).toThrow(/group_column/);
  });

  test("rejects an OOF ensemble that declares no leakage-safe protocol", () => {
    const bad = structuredClone(FULL_DECL);
    bad.oof_ensemble = { id: "e", members: ["a", "b"], method: "stack" };
    expect(() => resolveMethodologyContracts(bad)).toThrow(/oof|leakage/i);
  });

  test("accepts an equivalent declared leakage-safe protocol", () => {
    const equivDecl = structuredClone(FULL_DECL) as MethodologyDeclaration & {
      oof_ensemble: { oof: { protocol: string; folds: number; declared_equivalent: boolean } };
    };
    equivDecl.oof_ensemble.oof = { protocol: "nested_cv", folds: 5, declared_equivalent: true };
    const c = resolveMethodologyContracts(equivDecl)!;
    expect(c.oof_ensemble!.oof.protocol).toBe("nested_cv");
  });

  test("feature pipeline with zero steps fails closed", () => {
    const bad = structuredClone(FULL_DECL);
    bad.feature_pipeline = { id: "empty", steps: [] };
    expect(() => resolveMethodologyContracts(bad)).toThrow(/steps/);
  });

  test("camelCase nested aliases resolve (groupColumn, nSplits, oofProtocol, baseModels)", () => {
    const c = resolveMethodologyContracts({
      featurePipeline: { id: "fp", steps: [{ id: "s1", kind: "scale" }] },
      oofEnsemble: { id: "ens", baseModels: ["a", "b"], ensembleMethod: "stacking", oofProtocol: { type: "oof", nSplits: 4 } },
      splitContract: { id: "g", kind: "group", nSplits: 3, groupColumn: "user_id" },
    })!;
    expect(c.split_contract!.group_column).toBe("user_id");
    expect(c.split_contract!.folds).toBe(3);
    expect(c.oof_ensemble!.method).toBe("stack");
    expect(c.oof_ensemble!.members).toEqual(["a", "b"]);
    expect(c.feature_pipeline!.steps[0]!.kind).toBe("scale");
  });
});

describe("normalizeSplitContract", () => {
  test("defaults purge/embargo to 0 for a plain kfold", () => {
    const c = normalizeSplitContract({ id: "k", kind: "kfold", folds: 5 })!;
    expect(c.purge).toBe(0);
    expect(c.embargo).toBe(0);
  });

  test("gap alias is honored", () => {
    const c = normalizeSplitContract({ id: "t", kind: "time", folds: 3, gap: 4 })!;
    expect(c.purge).toBe(4);
  });
});

describe("auditMethodology — split_contract violation is a RULE failure", () => {
  const contracts = resolveMethodologyContracts(FULL_DECL)!;

  test("a candidate that honors the declared split has no findings", () => {
    const files = {
      "train.py": "splits = TimeSeriesSplit(n_splits=5, purge=2, embargo=1, group='week_id')",
    };
    expect(auditMethodology(contracts, files)).toEqual([]);
  });

  test("a random split on a declared time/group contract is a split_violation", () => {
    const files = { "train.py": "kf = KFold(n_splits=5, shuffle=True, random_state=42)" };
    const findings = auditMethodology(contracts, files);
    expect(findings.some((f) => f.kind === "split_violation")).toBe(true);
  });

  test("train_test_split with shuffle is flagged as leaking random split", () => {
    const files = { "train.py": "train_test_split(X, y, shuffle=True)" };
    const findings = auditMethodology(contracts, files);
    expect(findings.some((f) => f.kind === "split_violation")).toBe(true);
  });

  test("MethodologyViolation is a hard rule failure (TrustViolation), not a soft score", () => {
    const files = { "train.py": "KFold(shuffle=True)" };
    const findings = auditMethodology(contracts, files);
    const violation = new MethodologyViolation(findings);
    expect(violation).toBeInstanceOf(Error);
    // TrustViolation carries a rule-failure marker used by the harness to quarantine.
    expect(typeof violation.fingerprint()).toBe("string");
    expect(violation.message).toContain("split");
  });

  test("no split_contract declared → no split findings (gate inactive)", () => {
    const c = resolveMethodologyContracts({ feature_pipeline: FULL_DECL.feature_pipeline })!;
    expect(auditMethodology(c, { "train.py": "KFold(shuffle=True)" })).toEqual([]);
  });

  test("inner search silently rewriting the split is a split_violation", () => {
    // The contract pins time discipline; an inner loop re-declaring a random splitter
    // (e.g. split='random' / StratifiedKFold) must be caught, not quietly accepted.
    const files = { "search.py": "skf = StratifiedKFold(n_splits=5, shuffle=True)" };
    const findings = auditMethodology(contracts, files);
    expect(findings.some((f) => f.kind === "split_violation")).toBe(true);
  });
});

describe("validateEnsemblePromotion — OOF is required for ensemble promotion", () => {
  test("an OOF-backed ensemble is promotable", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    const result = validateEnsemblePromotion(contracts, {
      component: "ensemble",
      oofPredictionsPresent: true,
    });
    expect(result.ok).toBe(true);
  });

  test("an ensemble without OOF predictions is rejected (leakage risk)", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    const result = validateEnsemblePromotion(contracts, {
      component: "ensemble",
      oofPredictionsPresent: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/oof|leakage/i);
  });

  test("no ensemble declared → non-ensemble candidate is not gated by OOF", () => {
    const contracts = resolveMethodologyContracts({
      split_contract: FULL_DECL.split_contract,
    })!;
    const result = validateEnsemblePromotion(contracts, { component: "model", oofPredictionsPresent: false });
    expect(result.ok).toBe(true);
  });

  test("contract with no ensemble at all passes the gate (nothing to enforce)", () => {
    const result = validateEnsemblePromotion(undefined, { component: "ensemble", oofPredictionsPresent: true });
    expect(result.ok).toBe(true);
  });
});

describe("applyComponentFanOut — component-level changes touch only FE or only ensemble", () => {
  test("a feature-pipeline change fans out to FE only, ensemble untouched", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    const next = applyComponentFanOut(contracts, {
      component: "feature_pipeline",
      change: { kind: "add_step", step: { id: "poly", kind: "polyfeatures", params: { degree: 2 } } },
    });
    expect(next.feature_pipeline!.steps.map((s) => s.id)).toContain("poly");
    // Ensemble identity is unchanged.
    expect(next.oof_ensemble!.id).toBe(contracts.oof_ensemble!.id);
    expect(next.oof_ensemble!.members).toEqual(contracts.oof_ensemble!.members);
    expect(next.split_contract!.id).toBe(contracts.split_contract!.id);
  });

  test("an ensemble change fans out to ensemble only, FE untouched", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    const next = applyComponentFanOut(contracts, {
      component: "oof_ensemble",
      change: { kind: "add_member", member: "model_xgb" },
    });
    expect(next.oof_ensemble!.members).toContain("model_xgb");
    expect(next.feature_pipeline!.id).toBe(contracts.feature_pipeline!.id);
    expect(next.feature_pipeline!.steps.length).toBe(contracts.feature_pipeline!.steps.length);
  });

  test("fan-out may never rewrite the split_contract (inner-search discipline)", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    expect(() =>
      applyComponentFanOut(contracts, {
        component: "split_contract" as never,
        change: { kind: "rewrite" } as never,
      }),
    ).toThrow(/split_contract/);
  });

  test("fan-out re-normalizes so a malformed result fails closed", () => {
    const contracts = resolveMethodologyContracts(FULL_DECL)!;
    // Removing all but one member yields an invalid (<2 member) ensemble; the
    // fan-out re-normalizes and refuses rather than silently promoting it.
    expect(() =>
      applyComponentFanOut(contracts, {
        component: "oof_ensemble",
        change: { kind: "remove_member", member: "model_linear" },
      }),
    ).toThrow(/members/);
  });
});

describe("normalized contracts are frozen", () => {
  test("mutating a resolved contract throws in strict mode", () => {
    const c = resolveMethodologyContracts(FULL_DECL)!;
    expect(() => {
      (c.split_contract as { purge: number }).purge = 99;
    }).toThrow();
  });
});

// ── harness wiring (fake/toy layer) ────────────────────────────────────────

const prediction = {
  predictionId: "methodology-prediction",
  hypothesis: "the candidate respects the declared methodology contracts",
  expectedObservation: "split discipline and OOF ensemble rules are enforced",
  expectedObservations: ["split discipline and OOF ensemble rules are enforced"],
  failureModes: ["a split or OOF rule violation is silently accepted"],
} as const;
const taskContract = { objective: "maximize" };
const policy = { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 1, quorum: 1 };

/** Adapter that exposes methodology contracts via the snake_case accessor and tags ensemble facts. */
class MethodologyAdapter extends ScoreFileToyCompetitionAdapter {
  constructor(private readonly decl: MethodologyDeclaration, private readonly ensembleFacts?: Record<string, string>) {
    super("score");
  }
  methodology_contracts(): MethodologyDeclaration {
    return structuredClone(this.decl);
  }
  override evaluate(snapshot: Readonly<{ files: Record<string, string> }>) {
    const result = super.evaluate(snapshot as never);
    return this.ensembleFacts === undefined ? result : {
      ...result,
      facts: [...(result.facts ?? []), ...Object.entries(this.ensembleFacts).map(([name, value]) => ({ name, value }))],
    };
  }
}

function runtimeWith(files: Record<string, string>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { score: "9", ...files } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

async function runMission(missionId: string, adapter: ScoreFileToyCompetitionAdapter, files: Record<string, string>) {
  const harness = new ToyCompetitionHarness({
    prediction,
    missionId,
    taskContract,
    branchIds: ["candidate-1"],
    runtime: runtimeWith(files),
    adapter,
    policy,
  });
  const result = await harness.run();
  return { status: result.branches["candidate-1"]?.status, events: harness.events() };
}

describe("T44 harness — split_contract violation is a terminal rule failure", () => {
  test("a time-disciplined candidate promotes with the gate active", async () => {
    const adapter = new MethodologyAdapter(FULL_DECL);
    const { status, events } = await runMission("meth-clean", adapter, {
      "train.py": "TimeSeriesSplit(n_splits=5); purge=2; embargo=1; group='week_id'",
    });
    expect(status).toBe("PROMOTED_LOCAL");
    expect(events.some((e) => e.type === "BRANCH_QUARANTINED")).toBe(false);
  });

  test("a random shuffle split against a declared time contract is quarantined (never evaluated)", async () => {
    const adapter = new MethodologyAdapter(FULL_DECL);
    let evaluated = false;
    const originalEvaluate = adapter.evaluate.bind(adapter);
    adapter.evaluate = ((snapshot: never) => { evaluated = true; return originalEvaluate(snapshot); }) as never;
    const { status, events } = await runMission("meth-split-violation", adapter, {
      "train.py": "from sklearn.model_selection import KFold\nkf = KFold(n_splits=5, shuffle=True, random_state=42)",
    });
    expect(status).toBe("QUARANTINED");
    expect(evaluated).toBe(false);
    const quarantined = events.find((e) => e.type === "BRANCH_QUARANTINED");
    expect(quarantined).toBeDefined();
  });

  test("no split_contract declared → a random split is not a methodology failure", async () => {
    const decl = { feature_pipeline: FULL_DECL.feature_pipeline };
    const adapter = new MethodologyAdapter(decl);
    const { status } = await runMission("meth-no-split", adapter, { "train.py": "KFold(shuffle=True)" });
    expect(status).toBe("PROMOTED_LOCAL");
  });
});

describe("T44 harness — ensemble promotion requires OOF", () => {
  test("an ensemble candidate with OOF predictions promotes", async () => {
    const adapter = new MethodologyAdapter(FULL_DECL, { component: "ensemble", oof_predictions: "true" });
    const { status } = await runMission("meth-oof-ok", adapter, { "blend.py": "oof = cross_val_predict(models)" });
    expect(status).toBe("PROMOTED_LOCAL");
  });

  test("an ensemble candidate without OOF is rejected (leakage risk, not a worse score)", async () => {
    const adapter = new MethodologyAdapter(FULL_DECL, { component: "ensemble", oof_predictions: "false" });
    const { status, events } = await runMission("meth-oof-missing", adapter, { "blend.py": "pred = model.predict(X_test)" });
    expect(status).toBe("REJECTED");
    const rejected = events.find((e) => e.type === "BRANCH_REJECTED");
    expect(JSON.stringify(rejected?.payload ?? {})).toMatch(/oof|leakage/i);
  });

  test("a non-ensemble candidate is not gated by OOF", async () => {
    const adapter = new MethodologyAdapter(FULL_DECL, { component: "model", oof_predictions: "false" });
    const { status } = await runMission("meth-non-ensemble", adapter, { "model.py": "fit()" });
    expect(status).toBe("PROMOTED_LOCAL");
  });
});
