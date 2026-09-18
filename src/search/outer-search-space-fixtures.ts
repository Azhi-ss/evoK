/**
 * Shared outer-E2E search-space fixtures (E3 / #72).
 * Physical home: `src/search/` (ET-A2 / #122). Fixtures/tests only.
 *
 * Consumers take mapped `{kind,id}` refs only. Raw near-dup / MMD scores
 * must not be used as promotion / Broker / Kill-test keys.
 */
import {
  T48MappedCatalog,
  type T48MappedRef,
} from "../hypothesis-ledger";
import { EvidenceMemory, type ResearchTask } from "../research-loop";
import { deepFreeze } from "../security-boundary";
import {
  attachDiversityDiag,
  attachSearchSpaceDiagnosis,
  bindTaskSearchSpace,
  diagnoseDiversity,
  diagnoseNearDup,
  mapSearchSpaceEvidence,
  type DiversityDiag,
  type DiversityDiagDump,
  type NearDupDiagnosis,
  type SearchSpaceArtifact,
  type SearchSpaceBinding,
  type SearchSpaceCandidate,
  type SearchSpaceProfile,
} from "./search-space-profile";

export const OUTER_SEARCH_SPACE_SEED = 42;

/** Attach + map hooks feed the existing S1/S2 APIs; they are not a new diagnosis surface. */
export const OUTER_SEARCH_SPACE_ATTACH_HOOKS = Object.freeze({
  attachSearchSpaceDiagnosis,
  attachDiversityDiag,
  mapSearchSpaceEvidence,
});

export const OUTER_NEAR_DUP_PROFILE: SearchSpaceProfile = deepFreeze({
  featureDims: [{ name: "lr" }, { name: "width" }],
  nearDup: { maxDistance: 0.05 },
});

export const OUTER_MMD_PROFILE: SearchSpaceProfile = deepFreeze({
  featureDims: [{ name: "lr" }, { name: "width" }],
  nearDup: { maxDistance: 0.05 },
  mmd: {
    kernel: { name: "rbf", bandwidth: 1, seed: OUTER_SEARCH_SPACE_SEED },
    collapseThreshold: 0.05,
    windowSize: 4,
  },
});

export const OUTER_NEAR_DUP_PAIR: readonly SearchSpaceCandidate[] = deepFreeze([
  { candidateId: "cand-a", features: { lr: 0.01, width: 64 } },
  { candidateId: "cand-b", features: { lr: 0.012, width: 64.01 } },
]);

export const OUTER_COLLAPSE_WINDOW: readonly SearchSpaceCandidate[] = deepFreeze([
  { candidateId: "c1", features: { lr: 0.01, width: 64 } },
  { candidateId: "c2", features: { lr: 0.01, width: 64 } },
  { candidateId: "c3", features: { lr: 0.01, width: 64 } },
  { candidateId: "c4", features: { lr: 0.01, width: 64 } },
]);

export const OUTER_DIVERSE_WINDOW: readonly SearchSpaceCandidate[] = deepFreeze([
  { candidateId: "d1", features: { lr: 0, width: 0 } },
  { candidateId: "d2", features: { lr: 10, width: 0 } },
  { candidateId: "d3", features: { lr: 0, width: 10 } },
  { candidateId: "d4", features: { lr: 10, width: 10 } },
]);

export const OUTER_MISSING_FEATURE_WINDOW: readonly SearchSpaceCandidate[] = deepFreeze([
  { candidateId: "c1", features: { lr: 0.01 } },
  { candidateId: "c2", features: { lr: 0.01, width: 64 } },
  { candidateId: "c3", features: { lr: 0.01, width: 64 } },
  { candidateId: "c4", features: { lr: 0.01, width: 64 } },
]);

export interface OuterSearchSpaceFixtureTask extends ResearchTask {
  readonly searchSpaceProfile: SearchSpaceProfile;
}

export interface OuterSearchSpaceFixtureOptions {
  readonly catalog?: T48MappedCatalog;
  readonly collapseThreshold?: number;
  readonly seed?: number;
  readonly taskId?: string;
}

export interface OuterSearchSpaceFixtures {
  readonly binding: SearchSpaceBinding;
  readonly task: OuterSearchSpaceFixtureTask;
  readonly profile: SearchSpaceProfile;
  readonly seed: number;
  readonly nearDupPair: readonly SearchSpaceCandidate[];
  readonly collapseWindow: readonly SearchSpaceCandidate[];
  readonly diverseWindow: readonly SearchSpaceCandidate[];
  readonly missingFeatureWindow: readonly SearchSpaceCandidate[];
  readonly nearDup: NearDupDiagnosis;
  readonly collapse: DiversityDiag;
  readonly missingFeatures: DiversityDiag;
  readonly catalog: T48MappedCatalog;
  readonly nearDupArtifact: SearchSpaceArtifact;
  readonly diversityArtifact: SearchSpaceArtifact;
  readonly diversityDump: DiversityDiagDump;
  readonly mappedNearDup: T48MappedRef;
  readonly mappedDiversity: T48MappedRef;
  readonly mappedRefs: readonly T48MappedRef[];
  readonly hooks: typeof OUTER_SEARCH_SPACE_ATTACH_HOOKS;
}

export function buildOuterSearchSpaceCatalog(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function profileFor(options: OuterSearchSpaceFixtureOptions): SearchSpaceProfile {
  const seed = options.seed ?? OUTER_SEARCH_SPACE_SEED;
  const collapseThreshold = options.collapseThreshold ?? OUTER_MMD_PROFILE.mmd!.collapseThreshold;
  if (seed === OUTER_SEARCH_SPACE_SEED && collapseThreshold === OUTER_MMD_PROFILE.mmd!.collapseThreshold) {
    return OUTER_MMD_PROFILE;
  }
  return deepFreeze({
    featureDims: OUTER_MMD_PROFILE.featureDims,
    nearDup: OUTER_MMD_PROFILE.nearDup,
    mmd: {
      kernel: { name: "rbf", bandwidth: 1, seed },
      collapseThreshold,
      windowSize: OUTER_MMD_PROFILE.mmd!.windowSize,
    },
  });
}

/**
 * Task-shaped SearchSpaceProfile plus the S1/S2 candidate fragments, already
 * diagnosed and T48-mapped. Binding stays `diagnostic_only`.
 */
export function buildOuterSearchSpaceFixtures(
  options: OuterSearchSpaceFixtureOptions = {},
): OuterSearchSpaceFixtures {
  const seed = options.seed ?? OUTER_SEARCH_SPACE_SEED;
  const profile = profileFor(options);
  const task = deepFreeze({
    taskId: options.taskId ?? "explore-lr",
    objective: "explore nearby learning rates",
    searchSpaceProfile: profile,
  }) as OuterSearchSpaceFixtureTask;
  const binding = bindTaskSearchSpace(task);
  const nearDup = diagnoseNearDup(binding, OUTER_NEAR_DUP_PAIR);
  const collapse = diagnoseDiversity(binding, OUTER_COLLAPSE_WINDOW);
  const missingFeatures = diagnoseDiversity(binding, OUTER_MISSING_FEATURE_WINDOW);
  const attachedNearDup = attachSearchSpaceDiagnosis({
    catalog: options.catalog ?? buildOuterSearchSpaceCatalog(),
    diagnosis: nearDup,
  });
  const attachedDiversity = attachDiversityDiag({
    catalog: attachedNearDup.catalog,
    diag: collapse,
  });
  const mappedRefs = mapSearchSpaceEvidence(attachedDiversity.catalog, [
    attachedNearDup.artifact.artifactId,
    attachedDiversity.artifact.artifactId,
  ]);
  return deepFreeze({
    binding,
    task,
    profile,
    seed,
    nearDupPair: OUTER_NEAR_DUP_PAIR,
    collapseWindow: OUTER_COLLAPSE_WINDOW,
    diverseWindow: OUTER_DIVERSE_WINDOW,
    missingFeatureWindow: OUTER_MISSING_FEATURE_WINDOW,
    nearDup,
    collapse,
    missingFeatures,
    catalog: attachedDiversity.catalog,
    nearDupArtifact: attachedNearDup.artifact,
    diversityArtifact: attachedDiversity.artifact,
    diversityDump: attachedDiversity.dump,
    mappedNearDup: mappedRefs[0]!,
    mappedDiversity: mappedRefs[1]!,
    mappedRefs,
    hooks: OUTER_SEARCH_SPACE_ATTACH_HOOKS,
  }) as OuterSearchSpaceFixtures;
}
