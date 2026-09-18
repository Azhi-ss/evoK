/**
 * E2E.1 outer-min control-plane fixture + runner.
 *
 * Wires steps 0–5 only: catalog → Hypothesis → T48-mapped SearchSpace
 * attachments → KillTestPlan. Does not run hang, Broker, UCT, or #40.
 * Side-slot / MMD / near-dup scalars never enter evidence_refs.
 */
import { deepFreeze } from "../security-boundary";
import {
  HypothesisLedger,
  T48MappedCatalog,
  type CampaignTask,
  type Hypothesis,
  type HypothesisEvent,
  type KillTestPlan,
  type T48MappedRef,
} from "../hypothesis-ledger";
import type { MethodologyContracts } from "../methodology";
import { EvidenceMemory } from "./research-loop";
import {
  attachDiversityDiag,
  attachSearchSpaceDiagnosis,
  bindSearchSpace,
  diagnoseDiversity,
  diagnoseNearDup,
  projectHypothesisSearchSpaceRefs,
  type SearchSpaceArtifact,
  type SearchSpaceCandidate,
  type SearchSpaceProfile,
} from "../search-space-profile";

export const OUTER_MIN_HYPOTHESIS_ID = "h-outer-min";
export const OUTER_MIN_PLAN_ID = "kt-outer-min";
export const OUTER_MIN_HOLD_OUT_EVIDENCE_ID = "ev-holdout";
export const OUTER_MIN_KILL_EVIDENCE_ID = "ev-kill";

const STUB_PROFILE: SearchSpaceProfile = {
  featureDims: [{ name: "lr" }, { name: "width" }],
  nearDup: { maxDistance: 0.05 },
  mmd: {
    kernel: { name: "rbf", bandwidth: 1, seed: 42 },
    collapseThreshold: 0.05,
    windowSize: 4,
  },
};

const STUB_NEAR_DUP: readonly SearchSpaceCandidate[] = [
  { candidateId: "outer-min-a", features: { lr: 0.01, width: 64 } },
  { candidateId: "outer-min-b", features: { lr: 0.012, width: 64.01 } },
];

const STUB_WINDOW: readonly SearchSpaceCandidate[] = [
  { candidateId: "outer-min-c1", features: { lr: 0.01, width: 64 } },
  { candidateId: "outer-min-c2", features: { lr: 0.01, width: 64 } },
  { candidateId: "outer-min-c3", features: { lr: 0.01, width: 64 } },
  { candidateId: "outer-min-c4", features: { lr: 0.01, width: 64 } },
];

export interface OuterMinSearchSpaceAttach {
  readonly catalog: T48MappedCatalog;
  readonly artifact: SearchSpaceArtifact;
  readonly mapped: readonly T48MappedRef[];
}

export interface OuterMinFixture {
  readonly memory: EvidenceMemory;
  readonly catalog: T48MappedCatalog;
  /** Empty by default so T44 gates sleep. */
  readonly contracts: MethodologyContracts;
  readonly nearDup: OuterMinSearchSpaceAttach;
  readonly diversity: OuterMinSearchSpaceAttach;
}

export interface OuterMinFixtureOptions {
  readonly contracts?: MethodologyContracts;
}

export interface AssembleOuterMinPathInput {
  readonly fixture?: OuterMinFixture;
  readonly hypothesisId?: string;
  readonly planId?: string;
  readonly statement?: string;
  readonly predicate?: string;
  readonly evidenceRefs?: readonly unknown[];
}

export interface OuterMinPathAssembly {
  readonly fixture: OuterMinFixture;
  readonly ledger: HypothesisLedger;
  readonly hypothesis: Hypothesis;
  readonly plan: KillTestPlan;
  readonly hypothesisId: string;
  readonly planId: string;
  readonly evidenceRefs: readonly T48MappedRef[];
  readonly events: readonly HypothesisEvent[];
  readonly projected: Hypothesis;
  requestExpand(options?: { readonly enqueue?: CampaignTask; readonly operationId?: string }): Hypothesis;
}

function catalogMemory(): EvidenceMemory {
  const memory = new EvidenceMemory();
  memory.addEvidence({
    id: OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
    kind: "observation",
    summary: "hold-out split is isolated",
    verified: true,
  });
  memory.addEvidence({
    id: OUTER_MIN_KILL_EVIDENCE_ID,
    kind: "experiment",
    summary: "kill-test observation",
    verified: true,
    refs: [OUTER_MIN_HOLD_OUT_EVIDENCE_ID],
  });
  return memory;
}

function stubSearchSpaceAttachments(catalog: T48MappedCatalog): {
  readonly nearDup: OuterMinSearchSpaceAttach;
  readonly diversity: OuterMinSearchSpaceAttach;
  readonly catalog: T48MappedCatalog;
} {
  const binding = bindSearchSpace({ taskId: "outer-min", profile: STUB_PROFILE });
  const nearDup = attachSearchSpaceDiagnosis({
    catalog,
    diagnosis: diagnoseNearDup(binding, STUB_NEAR_DUP),
  });
  const diversity = attachDiversityDiag({
    catalog: nearDup.catalog,
    diag: diagnoseDiversity(binding, STUB_WINDOW),
  });
  return {
    nearDup: {
      catalog: nearDup.catalog,
      artifact: nearDup.artifact,
      mapped: nearDup.mapped,
    },
    diversity: {
      catalog: diversity.catalog,
      artifact: diversity.artifact,
      mapped: diversity.mapped,
    },
    catalog: diversity.catalog,
  };
}

/** Shared fixture: T48 catalog, empty methodology contracts, stub SearchSpace attaches. */
export function createOuterMinFixture(options: OuterMinFixtureOptions = {}): OuterMinFixture {
  const memory = catalogMemory();
  const attached = stubSearchSpaceAttachments(
    T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]),
  );
  return deepFreeze({
    memory,
    catalog: attached.catalog,
    contracts: options.contracts ?? {},
    nearDup: attached.nearDup,
    diversity: attached.diversity,
  }) as OuterMinFixture;
}

function defaultEvidenceSources(fixture: OuterMinFixture): readonly unknown[] {
  return [
    OUTER_MIN_HOLD_OUT_EVIDENCE_ID,
    fixture.nearDup.artifact.artifactId,
    fixture.diversity.artifact.artifactId,
  ];
}

/**
 * One-call assembly: create Hypothesis, attach T48-mapped evidence_refs,
 * planKillTest. Unmapped ids and side-slot/MMD/near-dup scalars fail closed.
 */
export function assembleOuterMinPath(input: AssembleOuterMinPathInput = {}): OuterMinPathAssembly {
  const fixture = input.fixture ?? createOuterMinFixture();
  const ledger = new HypothesisLedger({ catalog: fixture.catalog });
  const sources = input.evidenceRefs ?? defaultEvidenceSources(fixture);
  const evidenceRefs = fixture.catalog.mapAll(sources);
  const hypothesis = ledger.createHypothesis({
    hypothesisId: input.hypothesisId ?? OUTER_MIN_HYPOTHESIS_ID,
    statement: input.statement ?? "outer-min path: mapped catalog and search-space refs only",
    evidenceRefs,
  });
  const plan = ledger.planKillTest({
    planId: input.planId ?? OUTER_MIN_PLAN_ID,
    hypothesisId: hypothesis.hypothesisId,
    predicate: input.predicate ?? "retrain without the shared step; hold-out must not move",
    evidenceRefs: [OUTER_MIN_HOLD_OUT_EVIDENCE_ID],
  });
  const projected = projectHypothesisSearchSpaceRefs({
    catalog: fixture.catalog,
    hypothesis,
    sources: [fixture.nearDup, fixture.diversity],
  });
  return Object.freeze({
    fixture,
    ledger,
    hypothesis,
    plan,
    hypothesisId: hypothesis.hypothesisId,
    planId: plan.planId,
    evidenceRefs: hypothesis.evidenceRefs,
    events: ledger.events(),
    projected,
    requestExpand(options: { readonly enqueue?: CampaignTask; readonly operationId?: string } = {}) {
      return ledger.requestExpand(hypothesis.hypothesisId, options);
    },
  }) as OuterMinPathAssembly;
}

export const runOuterMinPathSetup = assembleOuterMinPath;
