/**
 * Shared test fixture: one complete `evok.research-charter/v1` charter that
 * passes C1 validation. `research-charter.test.ts` and `charter-ledger.test.ts`
 * both build on it, so a schema change edits one literal instead of several.
 *
 * `any` is deliberate: tests mutate copies to construct invalid inputs.
 */
export function researchCharterBaseline(id: string, status: string, limitation?: string): any {
  return {
    baselineId: id,
    paper: "Conditional Generation of Molecules",
    year: 2022,
    taskDefinition: "generate molecules conditioned on a binding pocket",
    conditioning: "pocket atoms and target coordinates",
    dataset: { name: "crossdocked-2020", split: "test split v1" },
    metrics: ["target-matching", "validity"],
    codeAvailable: status === "reproduced",
    dataAvailable: true,
    reproduction: { status, ...(limitation === undefined ? {} : { limitation }) },
    comparabilityLimits: "reported on a different split; numbers are not directly comparable",
    selectionRationale: "closest comparable conditional-generation method",
  };
}

export function researchCharterFixture(): any {
  return {
    schema: "evok.research-charter/v1",
    charterId: "nose-conditional-generation",
    version: 1,
    createdAt: "2026-11-11T00:00:00.000Z",
    objective: {
      question: "does the proposed conditioning mechanism improve conditional molecular generation?",
      boundaries: ["small-molecule generation under a fixed binding-site conditioning"],
    },
    ambition: {
      minimum: "beat the simple baseline on validity with a reproducible protocol",
      target: "match the strongest comparable reported number under our own evaluation",
      stretch: "improve diversity and validity jointly at equal target matching",
      rigourRequirement: "reproduce the strongest comparable method before claiming comparability",
    },
    researchGap: {
      statement: "conditional generators are scored on target matching while diversity collapses",
      solved: ["unconditional generation matches data statistics"],
      sources: [{ ref: "doi:10.1000/nose", claim: "NOSE reports target matching with self-scoring" }],
    },
    baselinePortfolio: {
      categories: {
        simple: { entries: [researchCharterBaseline("b-simple", "reproduced")] },
        strongest_comparable: {
          entries: [
            researchCharterBaseline("b-strong", "reported_only", "no released code and 8xA100 training budget"),
            researchCharterBaseline("b-strong-repro", "reproduced"),
          ],
        },
        method_specific: { entries: [], emptyReason: "no conditioning mechanism shares the proposed mechanism" },
        internal_ablations: { entries: [researchCharterBaseline("b-ablation", "reproduced")] },
      },
      reproducedBaselineId: "b-strong-repro",
    },
    evaluation: {
      protocolVersion: "p1",
      dataset: { name: "crossdocked-2020", split: "train/test by pocket cluster" },
      trainTestIsolation: "pockets are cluster-split; no test pocket appears in train",
      metrics: [
        { name: "target-matching", direction: "higher_is_better" },
        { name: "validity", direction: "higher_is_better" },
        { name: "diversity", direction: "higher_is_better" },
      ],
      generationBudget: { candidates: 1000, units: "molecules" },
      seedStrategy: { seeds: [1, 2, 3] },
      statisticalComparison: { test: "welch-t", alpha: 0.05 },
      independentValidation: {
        required: true,
        evaluators: [
          { id: "docking-oracle", kind: "independent" },
          { id: "nose-predictor", kind: "method_own_reward_model" },
        ],
      },
      reproducibilityArtifacts: ["frozen config", "seed manifest", "generated candidate set"],
    },
    constraints: {
      compute: "one A100 week",
      data: "crossdocked-2020 is public",
      permissions: [],
      externalAccess: ["no external submissions"],
    },
    verdict: { recommendation: "go", rationale: "the gap is measurable under an independent oracle", evidence: [
      { ref: "doi:10.1000/nose", claim: "diversity collapse is reported but not benchmarked independently" },
    ] },
  };
}
