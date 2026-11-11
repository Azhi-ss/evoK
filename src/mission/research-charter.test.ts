import { describe, expect, test } from "bun:test";
import {
  BASELINE_CATEGORIES,
  RESEARCH_CHARTER_SCHEMA,
  ResearchCharterValidationError,
  assertResearchCharter,
  charterDigest,
  validateResearchCharter,
} from "./research-charter";

/** A minimal charter that passes: every required section is filled with real content. */
function baseCharter(): any {
  return {
    schema: RESEARCH_CHARTER_SCHEMA,
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
        simple: { entries: [baseline("b-simple", "reproduced")] },
        strongest_comparable: {
          entries: [
            baseline("b-strong", "reported_only", "no released code and 8xA100 training budget"),
            baseline("b-strong-repro", "reproduced"),
          ],
        },
        method_specific: { entries: [], emptyReason: "no conditioning mechanism shares the proposed mechanism" },
        internal_ablations: { entries: [baseline("b-ablation", "reproduced")] },
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

function baseline(id: string, status: string, limitation?: string): any {
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

function withCharter(mutate: (charter: any) => void): any {
  const charter = baseCharter();
  mutate(charter);
  return charter;
}

function issuesOf(input: unknown) {
  const result = validateResearchCharter(input);
  if (result.ok) throw new Error("expected validation to reject the charter");
  return result.issues;
}

function pathsOf(input: unknown): string[] {
  return issuesOf(input).map((issue) => issue.path);
}

describe("evok.research-charter/v1 validation", () => {
  test("accepts a complete charter and stamps a deterministic content digest", () => {
    const result = validateResearchCharter(baseCharter());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.charter.schema).toBe(RESEARCH_CHARTER_SCHEMA);
    expect(RESEARCH_CHARTER_SCHEMA).toBe("evok.research-charter/v1");
    expect(result.charter.digest).toMatch(/^[0-9a-f]{64}$/);

    const again = validateResearchCharter(baseCharter());
    if (!again.ok) throw new Error("expected ok");
    expect(again.charter.digest).toBe(result.charter.digest);

    const changed = validateResearchCharter(withCharter((charter) => {
      charter.ambition.target = "a different target bar";
    }));
    if (!changed.ok) throw new Error("expected ok");
    expect(changed.charter.digest).not.toBe(result.charter.digest);
    expect(charterDigest(changed.charter)).toBe(changed.charter.digest);
    expect(Object.isFrozen(result.charter)).toBe(true);
  });

  test("names every missing required section instead of one generic error", () => {
    const paths = pathsOf({ schema: RESEARCH_CHARTER_SCHEMA });
    for (const section of ["charterId", "version", "objective", "ambition", "researchGap", "baselinePortfolio", "evaluation", "constraints", "verdict"]) {
      expect(paths).toContain(section);
    }
    const issues = issuesOf({ schema: RESEARCH_CHARTER_SCHEMA });
    for (const issue of issues) {
      expect(issue.path.length).toBeGreaterThan(0);
      expect(issue.code.length).toBeGreaterThan(0);
      // An agent must be able to locate the field and see what to do from the message alone.
      expect(issue.message).toContain(issue.path);
      expect(issue.message).toMatch(/required|must not|must be/);
    }
    // Distinct problems stay distinct: no single generic "invalid charter" collapse.
    expect(new Set(issues.map((issue) => issue.path)).size).toBe(issues.length);
    expect(issues.length).toBeGreaterThanOrEqual(9);
  });

  test("rejects an unknown schema id", () => {
    const issues = issuesOf(withCharter((charter) => {
      charter.schema = "evok.research-charter/v2";
    }));
    expect(issues.map((issue) => issue.path)).toContain("schema");
    expect(issues[0]!.message).toContain(RESEARCH_CHARTER_SCHEMA);
  });

  test("records the full baseline entry contract", () => {
    const entry = baseline("b-incomplete", "reproduced");
    for (const field of ["paper", "year", "taskDefinition", "conditioning", "dataset", "metrics", "codeAvailable", "dataAvailable", "reproduction", "comparabilityLimits", "selectionRationale"]) {
      delete entry[field];
    }
    const paths = pathsOf(withCharter((charter) => {
      charter.baselinePortfolio.categories.simple.entries = [entry];
    }));
    const prefix = "baselinePortfolio.categories.simple.entries[0]";
    for (const field of ["paper", "year", "taskDefinition", "conditioning", "dataset", "metrics", "codeAvailable", "dataAvailable", "reproduction", "comparabilityLimits", "selectionRationale"]) {
      expect(paths).toContain(`${prefix}.${field}`);
    }
  });

  test("every one of the four baseline categories exists; an empty one needs an explicit reason", () => {
    const result = validateResearchCharter(baseCharter());
    if (!result.ok) throw new Error("expected ok");
    expect(Object.keys(result.charter.baselinePortfolio.categories).sort()).toEqual([...BASELINE_CATEGORIES].sort());

    const issues = issuesOf(withCharter((charter) => {
      charter.baselinePortfolio.categories.method_specific.emptyReason = "   ";
    }));
    expect(issues.map((issue) => issue.path)).toContain("baselinePortfolio.categories.method_specific.emptyReason");

    const missing = issuesOf(withCharter((charter) => {
      delete charter.baselinePortfolio.categories.internal_ablations;
    }));
    expect(missing.map((issue) => issue.path)).toContain("baselinePortfolio.categories.internal_ablations");
  });

  test("a reported_only baseline keeps its limitation, and a portfolio without the separate reproduced baseline is rejected as a silent downgrade", () => {
    const result = validateResearchCharter(baseCharter());
    expect(result.ok).toBe(true);

    const downgraded = withCharter((charter) => {
      delete charter.baselinePortfolio.reproducedBaselineId;
    });
    const issues = issuesOf(downgraded);
    const path = issues.map((issue) => issue.path);
    expect(path).toContain("baselinePortfolio.reproducedBaselineId");
    expect(issues.some((issue) => issue.message.includes("reported_only") && issue.message.includes("reproduced"))).toBe(true);

    const noLimitation = issuesOf(withCharter((charter) => {
      delete charter.baselinePortfolio.categories.strongest_comparable.entries[0].reproduction.limitation;
    }));
    expect(noLimitation.map((issue) => issue.path)).toContain(
      "baselinePortfolio.categories.strongest_comparable.entries[0].reproduction.limitation",
    );
  });

  test("an easy baseline cannot stand in for the reported_only strongest method (silent downgrade)", () => {
    const result = validateResearchCharter(withCharter((charter) => {
      // The strongest method is kept as reported_only, but the only reproduced
      // entries are trivial ones: the exact PRD §1 defect this schema must refuse.
      charter.baselinePortfolio.categories.strongest_comparable.entries = [
        charter.baselinePortfolio.categories.strongest_comparable.entries[0],
      ];
      charter.baselinePortfolio.reproducedBaselineId = "b-simple";
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain("baselinePortfolio.reproducedBaselineId");
    expect(result.issues.some((issue) => issue.message.includes("strongest_comparable"))).toBe(true);
  });

  test("a portfolio with no baseline entry at all is rejected", () => {
    const issues = issuesOf(withCharter((charter) => {
      for (const category of Object.values(charter.baselinePortfolio.categories) as any[]) {
        category.entries = [];
        category.emptyReason = "nothing comparable exists";
      }
      delete charter.baselinePortfolio.reproducedBaselineId;
    }));
    expect(issues.map((issue) => issue.path)).toContain("baselinePortfolio.categories");
    expect(issues.some((issue) => issue.code === "empty_portfolio")).toBe(true);
  });

  test("the separate reproduced baseline must exist, be reproduced, and be a different entry", () => {
    const pointsAtReportedOnly = issuesOf(withCharter((charter) => {
      charter.baselinePortfolio.reproducedBaselineId = "b-strong";
    }));
    expect(pointsAtReportedOnly.map((issue) => issue.path)).toContain("baselinePortfolio.reproducedBaselineId");

    const missingId = issuesOf(withCharter((charter) => {
      charter.baselinePortfolio.reproducedBaselineId = "b-does-not-exist";
    }));
    expect(missingId.map((issue) => issue.path)).toContain("baselinePortfolio.reproducedBaselineId");
  });

  test("no_go_recommended is a valid verdict carrying evidence, and recommending go without evidence is rejected", () => {
    const noGo = validateResearchCharter(withCharter((charter) => {
      charter.verdict = {
        recommendation: "no_go_recommended",
        rationale: "the question is already answered by an independent benchmark",
        evidence: [{ ref: "doi:10.1000/already-done", claim: "the same conditioning mechanism was benchmarked independently" }],
      };
    }));
    expect(noGo.ok).toBe(true);
    if (noGo.ok) expect(noGo.charter.verdict.recommendation).toBe("no_go_recommended");

    const unsupported = issuesOf(withCharter((charter) => {
      charter.verdict = { recommendation: "no_go_recommended", rationale: "feels done", evidence: [] };
    }));
    expect(unsupported.map((issue) => issue.path)).toContain("verdict.evidence");

    const unknownVerdict = issuesOf(withCharter((charter) => {
      charter.verdict.recommendation = "maybe";
    }));
    expect(unknownVerdict.map((issue) => issue.path)).toContain("verdict.recommendation");
  });

  test("the research gap needs source references, not an inferred claim", () => {
    const paths = pathsOf(withCharter((charter) => {
      charter.researchGap.sources = [];
    }));
    expect(paths).toContain("researchGap.sources");

    const sourceless = pathsOf(withCharter((charter) => {
      delete charter.researchGap.sources;
    }));
    expect(sourceless).toContain("researchGap.sources");
  });

  test("an evaluation protocol must declare every frozen element", () => {
    const paths = pathsOf(withCharter((charter) => {
      charter.evaluation = {};
    }));
    for (const field of [
      "protocolVersion",
      "dataset",
      "trainTestIsolation",
      "metrics",
      "generationBudget",
      "seedStrategy",
      "statisticalComparison",
      "independentValidation",
      "reproducibilityArtifacts",
    ]) {
      expect(paths).toContain(`evaluation.${field}`);
    }
  });

  test("independent evaluation is mandatory: a protocol scored only by the method's own reward model is rejected", () => {
    const issues = issuesOf(withCharter((charter) => {
      charter.evaluation.independentValidation.evaluators = [
        { id: "nose-predictor", kind: "method_own_reward_model" },
      ];
    }));
    expect(issues.map((issue) => issue.path)).toContain("evaluation.independentValidation.evaluators");
    expect(issues.some((issue) => issue.message.includes("independent"))).toBe(true);

    const empty = issuesOf(withCharter((charter) => {
      charter.evaluation.independentValidation.evaluators = [];
    }));
    expect(empty.map((issue) => issue.path)).toContain("evaluation.independentValidation.evaluators");
    expect(empty.some((issue) => issue.code === "independent_evaluation_required")).toBe(true);

    const notRequired = issuesOf(withCharter((charter) => {
      charter.evaluation.independentValidation.required = false;
    }));
    expect(notRequired.map((issue) => issue.path)).toContain("evaluation.independentValidation.required");
  });

  test("ambition bars exist but no termination or convergence field can appear anywhere in the charter", () => {
    const result = validateResearchCharter(baseCharter());
    if (!result.ok) throw new Error("expected ok");
    expect(result.charter.ambition.minimum.length).toBeGreaterThan(0);
    expect(result.charter.ambition.target.length).toBeGreaterThan(0);
    expect(result.charter.ambition.stretch.length).toBeGreaterThan(0);

    const keyPaths: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keyPaths.push(path === "" ? key : `${path}.${key}`);
        walk(child, path === "" ? key : `${path}.${key}`);
      }
    };
    walk(result.charter, "");
    const forbidden = /terminat|converg|\bstop|halt|shutdown|abandon/i;
    expect(keyPaths.filter((key) => forbidden.test(key))).toEqual([]);

    // The schema is closed: a termination-shaped field anywhere is an unknown field.
    expect(pathsOf(withCharter((charter) => {
      charter.terminationCriteria = { maxIterations: 10 };
    }))).toContain("terminationCriteria");
    expect(pathsOf(withCharter((charter) => {
      charter.ambition.convergenceTarget = 0.9;
    }))).toContain("ambition.convergenceTarget");
    expect(pathsOf(withCharter((charter) => {
      charter.evaluation.stopOnTargetReached = true;
    }))).toContain("evaluation.stopOnTargetReached");
  });

  test("empty boundaries, empty solved literature, an implausible year and a non-ISO timestamp are named", () => {
    expect(pathsOf(withCharter((charter) => {
      charter.objective.boundaries = [];
    }))).toContain("objective.boundaries");
    expect(pathsOf(withCharter((charter) => {
      charter.researchGap.solved = [];
    }))).toContain("researchGap.solved");
    expect(pathsOf(withCharter((charter) => {
      charter.baselinePortfolio.categories.simple.entries[0].year = 12022;
    }))).toContain("baselinePortfolio.categories.simple.entries[0].year");
    expect(pathsOf(withCharter((charter) => {
      charter.createdAt = "last tuesday";
    }))).toContain("createdAt");
  });

  test("assertResearchCharter throws a typed error carrying every specific issue", () => {
    let caught: unknown;
    try {
      assertResearchCharter({ schema: RESEARCH_CHARTER_SCHEMA });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResearchCharterValidationError);
    const error = caught as ResearchCharterValidationError;
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues.map((issue) => issue.path)).toContain("evaluation");
    expect(error.message).toContain("evaluation");
    // The field path appears once, not twice (prefix + path inside the message).
    expect(error.message.split("evaluation").length - 1).toBe(1);
  });
});
