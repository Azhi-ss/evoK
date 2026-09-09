import {
  auditMethodology,
  compileMethodologyBlock,
  oofEnsembleGate,
  readMethodologyManifest,
  type MethodologyContracts,
  type PluginMethodologyBlock,
} from "./methodology";
import { deepFreeze, digestValue, TrustViolation } from "./security-boundary";
import {
  ToyCompetitionHarness,
  type CandidateSnapshot,
  type CompetitionAdapterDescription,
  type CompetitionArtifactReference,
  type CompetitionRuleValidation,
  type EvaluationResult,
  type MissionEvent,
  type MissionState,
  type ToyAgentRuntime,
  type ToyCompetitionAdapter,
} from "./toy-harness";
import declaredEquivalentManifest from "./fixtures/methodology/manifest-declared-equivalent.json";
import noOofManifest from "./fixtures/methodology/manifest-no-oof.json";
import oofManifest from "./fixtures/methodology/manifest-oof.json";
import splitMismatchManifest from "./fixtures/methodology/manifest-split-mismatch.json";

const METHODOLOGY_MANIFEST_FILE = "methodology.json";

export type FakeInnerVariant = "oof" | "declared-equivalent" | "no-oof" | "split-mismatch";
export type MethodologyComponent = "feature_pipeline" | "oof_ensemble";
export type MethodologyComponentRegion = MethodologyComponent | "split_ref";

/** algorithm-evolve #43/#44 four-field-class Methodology Manifest (fixture-aligned). */
export interface AlgorithmEvolveManifest {
  readonly feature_pipeline?: { readonly steps?: readonly unknown[] };
  readonly oof_ensemble?: Readonly<Record<string, unknown>>;
  readonly split_ref?: Readonly<Record<string, unknown>>;
}

export interface PluginTaskJson {
  readonly id: string;
  readonly goal: string;
  readonly artifact: string;
  readonly evaluation: { readonly mode: "objective"; readonly command: string };
  readonly direction: "maximize";
  readonly methodology?: PluginMethodologyBlock;
}

export interface FakeInnerCandidate {
  readonly task: PluginTaskJson;
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: AlgorithmEvolveManifest;
}

/** Adapter T44 contracts → inner plugin task JSON (`methodology` via existing compile). */
export function compilePluginTask(contracts: MethodologyContracts): PluginTaskJson {
  const methodology = compileMethodologyBlock(contracts);
  return deepFreeze({
    id: "toy-methodology",
    goal: "Maximize toy score under methodology contracts",
    artifact: "toy://methodology",
    evaluation: { mode: "objective", command: "true" },
    direction: "maximize",
    ...(methodology === undefined ? {} : { methodology }),
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const VARIANT_MANIFESTS: Readonly<Record<FakeInnerVariant, AlgorithmEvolveManifest>> = {
  oof: oofManifest as AlgorithmEvolveManifest,
  "declared-equivalent": declaredEquivalentManifest as AlgorithmEvolveManifest,
  "no-oof": noOofManifest as AlgorithmEvolveManifest,
  "split-mismatch": splitMismatchManifest as AlgorithmEvolveManifest,
};

export function applyFakeInnerComponent(
  parent: AlgorithmEvolveManifest,
  component: MethodologyComponent,
): AlgorithmEvolveManifest {
  const result = cloneJson(parent);
  if (component === "feature_pipeline") {
    const steps = [...(result.feature_pipeline?.steps ?? []), { name: "scripted_select" }];
    return deepFreeze({ ...result, feature_pipeline: { ...result.feature_pipeline, steps } });
  }
  const members = [...((result.oof_ensemble?.members as readonly unknown[] | undefined) ?? ["baseline", "tree"])];
  if (!members.includes("scripted_linear")) {
    if (members.length >= 2) members[members.length - 1] = "scripted_linear";
    else members.push("scripted_linear");
  }
  return deepFreeze({
    ...result,
    oof_ensemble: { ...result.oof_ensemble, members },
  });
}

export function componentRegionHash(
  manifest: AlgorithmEvolveManifest,
  region: MethodologyComponentRegion,
): string {
  return digestValue(manifest[region]);
}

function manifestFromCompiledTask(
  variant: FakeInnerVariant,
  task: PluginTaskJson,
  component?: MethodologyComponent,
): AlgorithmEvolveManifest {
  const compiledDigest = task.methodology?.split_contract?.split_ref.digest;
  const base = cloneJson(VARIANT_MANIFESTS[variant]);
  const digest = variant === "split-mismatch"
    ? String(base.split_ref?.digest_summary ?? "sha256:different-split")
    : compiledDigest ?? String(base.split_ref?.digest_summary ?? "");
  const stamped = {
    ...base,
    split_ref: { ...base.split_ref, digest_summary: digest },
  };
  return component === undefined ? deepFreeze(stamped) : applyFakeInnerComponent(stamped, component);
}

/**
 * Fake inner loop: compile the plugin task, then emit a candidate plus an
 * algorithm-evolve-shaped methodology manifest. No real models.
 */
export function fakeInnerCandidate(input: {
  readonly contracts: MethodologyContracts;
  readonly variant: FakeInnerVariant;
  readonly score?: string;
  readonly component?: MethodologyComponent;
}): FakeInnerCandidate {
  const task = compilePluginTask(input.contracts);
  const manifest = manifestFromCompiledTask(input.variant, task, input.component);
  return deepFreeze({
    task,
    manifest,
    files: {
      score: input.score ?? "1",
      [METHODOLOGY_MANIFEST_FILE]: JSON.stringify(manifest),
    },
  });
}

function parseCandidateManifest(snapshot: Readonly<CandidateSnapshot>): unknown {
  const raw = snapshot.files[METHODOLOGY_MANIFEST_FILE];
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Toy adapter that carries T44 contracts and uses existing audit / OOF gates as-is. */
export class MethodologyToyCompetitionAdapter implements ToyCompetitionAdapter {
  readonly name = "methodology-toy";
  evaluations = 0;

  constructor(
    readonly contracts: MethodologyContracts,
    readonly scoreFile = "score",
  ) {}

  pluginTask(): PluginTaskJson {
    return compilePluginTask(this.contracts);
  }

  describe(): CompetitionAdapterDescription {
    return deepFreeze({
      name: this.name,
      input: { scoreFile: this.scoreFile, methodology: this.pluginTask().methodology },
      rules: [
        "candidate methodology manifest split_ref must agree with the task split_contract",
        "ensemble candidates must declare OOF or declared_equivalent",
        `${this.scoreFile} must contain a finite numeric score`,
      ],
      artifacts: [this.scoreFile, METHODOLOGY_MANIFEST_FILE],
      metric: "score (higher is better)",
    });
  }

  private evidence(snapshot: Readonly<CandidateSnapshot>) {
    return readMethodologyManifest(parseCandidateManifest(snapshot), this.contracts);
  }

  validateRules(snapshot: Readonly<CandidateSnapshot>): CompetitionRuleValidation {
    const audit = auditMethodology(this.evidence(snapshot), this.contracts);
    if (!audit.ok) throw new TrustViolation(audit.objections.join("; "));
    return deepFreeze({ ok: true, violations: [] });
  }

  collectArtifacts(snapshot: Readonly<CandidateSnapshot>): readonly CompetitionArtifactReference[] {
    const content = snapshot.files[this.scoreFile] ?? "";
    const digest = digestValue(content);
    return deepFreeze([{
      artifactId: `${this.scoreFile}:${digest}`,
      address: `artifact://${this.name}/${digest}`,
      digest,
      kind: "score",
    }]);
  }

  evaluate(snapshot: Readonly<CandidateSnapshot>): EvaluationResult {
    this.evaluations += 1;
    const oof = oofEnsembleGate(this.evidence(snapshot), this.contracts);
    if (!oof.ok) throw new Error(oof.objections.join("; "));
    const raw = snapshot.files[this.scoreFile];
    const score = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(score)) throw new Error(`${this.scoreFile} is missing or not finite`);
    return deepFreeze({
      score,
      facts: [{ name: "score-file", value: score, source: this.scoreFile }],
      evaluatorId: this.name,
      evaluatorVersion: "1",
    });
  }
}

function fakeInnerRuntime(files: Readonly<Record<string, string>>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { ...files } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

export interface MethodologyAcceptanceResult {
  readonly adapter: MethodologyToyCompetitionAdapter;
  readonly task: PluginTaskJson;
  readonly state: MissionState;
  readonly events: readonly MissionEvent[];
  readonly evaluations: number;
}

export async function runMethodologyAcceptance(input: {
  readonly missionId: string;
  readonly contracts: MethodologyContracts;
  readonly variant: FakeInnerVariant;
  readonly score?: string;
  readonly component?: MethodologyComponent;
}): Promise<MethodologyAcceptanceResult> {
  const adapter = new MethodologyToyCompetitionAdapter(input.contracts);
  const inner = fakeInnerCandidate(input);
  const harness = new ToyCompetitionHarness({
    missionId: input.missionId,
    prediction: {
      predictionId: `${input.missionId}:methodology-prediction`,
      hypothesis: "the candidate complies with the task methodology contracts",
      expectedObservation: "the evaluator returns a score after split and OOF validation",
      failureModes: ["split digest mismatch", "missing OOF evidence"],
    },
    taskContract: { objective: "maximize the score under methodology contracts" },
    branchIds: ["candidate"],
    runtime: fakeInnerRuntime(inner.files),
    adapter,
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
  });
  const state = await harness.run();
  return deepFreeze({
    adapter,
    task: inner.task,
    state,
    events: harness.events(),
    evaluations: adapter.evaluations,
  });
}
