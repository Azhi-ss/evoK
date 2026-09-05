import { clone, digestValue, deepFreeze, type SnapshotManifest } from "./security-boundary";
import type { CandidateSnapshot, ScoreFact } from "./toy-harness";

export type EvaluationStage = "single" | "best-of-n" | "symmetric-a-b";
export type EvaluationSide = "candidate" | "control";

export interface EvaluationNoiseModelInput {
  readonly kind?: string;
  readonly type?: string;
  readonly model?: string;
  readonly tolerance?: number;
  readonly scoreTolerance?: number;
  readonly score_tolerance?: number;
  readonly [key: string]: unknown;
}

export interface EvaluationLadderStepInput {
  readonly stage?: string;
  readonly type?: string;
  readonly name?: string;
  readonly repeats?: number;
  readonly n?: number;
  readonly requiredRepeats?: number;
  readonly required_repeats?: number;
  readonly required?: boolean;
  readonly [key: string]: unknown;
}

export interface EvaluationMarginPolicyInput {
  readonly microGain?: number;
  readonly micro_gain?: number;
  readonly tightMargin?: number;
  readonly tight_margin?: number;
  readonly bankMicroGains?: boolean;
  readonly bank_micro_gains?: boolean;
  readonly requireAgreement?: boolean;
  readonly require_agreement?: boolean;
  readonly [key: string]: unknown;
}

/** Adapter-owned input. Snake-case aliases are accepted at this boundary. */
export interface EvaluationContract {
  readonly version?: string | number;
  readonly protocolVersion?: string | number;
  readonly protocol_version?: string | number;
  readonly noiseModel?: EvaluationNoiseModelInput | string;
  readonly noise_model?: EvaluationNoiseModelInput | string;
  readonly tolerance?: number;
  readonly scoreTolerance?: number;
  readonly score_tolerance?: number;
  readonly requiredRepeats?: number;
  readonly required_repeats?: number;
  readonly escalationLadder?: readonly (EvaluationLadderStepInput | string)[];
  readonly escalation_ladder?: readonly (EvaluationLadderStepInput | string)[];
  readonly ladder?: readonly (EvaluationLadderStepInput | string)[];
  readonly marginPolicy?: EvaluationMarginPolicyInput;
  readonly margin_policy?: EvaluationMarginPolicyInput;
  readonly seed?: number;
  readonly seedBase?: number;
  readonly seed_base?: number;
  readonly evaluatorVersion?: string;
  readonly evaluator_version?: string;
  readonly [key: string]: unknown;
}

export interface NormalizedEvaluationNoiseModel {
  readonly kind: string;
  readonly tolerance: number;
  readonly [key: string]: unknown;
}

export interface NormalizedEvaluationLadderStep {
  readonly stage: EvaluationStage;
  readonly repeats: number;
  readonly required: boolean;
  readonly [key: string]: unknown;
}

export interface NormalizedEvaluationMarginPolicy {
  readonly microGain: number;
  readonly tightMargin: number;
  readonly bankMicroGains: boolean;
  readonly requireAgreement: boolean;
  readonly [key: string]: unknown;
}

export interface NormalizedEvaluationContract {
  readonly version: string;
  readonly protocolVersion: string;
  readonly protocol_version: string;
  readonly noiseModel: NormalizedEvaluationNoiseModel;
  readonly noise_model: NormalizedEvaluationNoiseModel;
  readonly tolerance: number;
  readonly requiredRepeats: number;
  readonly required_repeats: number;
  readonly escalationLadder: readonly NormalizedEvaluationLadderStep[];
  readonly escalation_ladder: readonly NormalizedEvaluationLadderStep[];
  readonly marginPolicy: NormalizedEvaluationMarginPolicy;
  readonly margin_policy: NormalizedEvaluationMarginPolicy;
  readonly seed: number;
  readonly seed_base: number;
  readonly evaluatorVersion?: string;
  readonly evaluator_version?: string;
  readonly [key: string]: unknown;
}

export type EvaluationContractAccessor = EvaluationContract | (() => EvaluationContract);

export interface EvaluationContractProvider {
  readonly evaluation_contract?: EvaluationContractAccessor;
  readonly evaluationContract?: EvaluationContractAccessor;
}

export interface EvaluationRunContext {
  readonly stage: EvaluationStage;
  readonly runId: string;
  readonly seed: number;
  readonly repeat: number;
  readonly side: EvaluationSide;
  readonly missionId: string;
  readonly branchId: string;
  readonly candidateSnapshotDigest: string;
  readonly snapshotDigest: string;
  readonly controlSnapshotDigest?: string;
  readonly controlBranchId?: string;
  /** Frozen snapshots are supplied when the evaluator needs paired inputs. */
  readonly candidateSnapshot?: Readonly<CandidateSnapshot>;
  readonly controlSnapshot?: Readonly<CandidateSnapshot>;
  /** Short aliases for evaluators that use candidate/control terminology. */
  readonly candidate?: Readonly<CandidateSnapshot>;
  readonly control?: Readonly<CandidateSnapshot>;
  readonly taskContractDigest: string;
  readonly evaluationContractDigest: string;
  readonly evaluationContractVersion: string;
  readonly evaluationContract: Readonly<NormalizedEvaluationContract>;
  /** Alias kept for evaluator implementations that call the protocol `contract`. */
  readonly contract: Readonly<NormalizedEvaluationContract>;
  readonly ordinal: number;
}

export interface EvaluationRunInput {
  readonly snapshot: Readonly<CandidateSnapshot>;
  readonly contract: Readonly<NormalizedEvaluationContract>;
  readonly context: Readonly<EvaluationRunContext>;
  readonly run: Readonly<EvaluationRunContext>;
  readonly manifest: Readonly<SnapshotManifest>;
}

export interface EvaluationRunFact {
  readonly runId: string;
  readonly seed: number;
  readonly stage: EvaluationStage;
  readonly side: EvaluationSide;
  readonly repeat: number;
  readonly score: number;
  readonly facts?: readonly ScoreFact[];
  /** The candidate snapshot digest; for a control run, this remains the candidate being compared. */
  readonly candidateSnapshotDigest: string;
  /** The snapshot actually evaluated by this run. */
  readonly snapshotDigest: string;
  readonly controlSnapshotDigest?: string;
  readonly taskContractDigest: string;
  /** Compatibility name for the task-contract digest on EvaluationResult. */
  readonly contractDigest: string;
  readonly evaluationContractDigest: string;
  readonly protocolDigest: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly digest: string;
}

export interface EvaluationStageResult {
  readonly stage: EvaluationStage;
  readonly repeats: number;
  readonly required: boolean;
  readonly complete: boolean;
  readonly scores: readonly number[];
  readonly score: number;
  readonly runIds: readonly string[];
  readonly digest: string;
}

export interface SymmetricABResult {
  readonly candidateScore: number;
  readonly controlScore?: number;
  readonly delta?: number;
  readonly repeats: number;
  readonly candidateRunIds: readonly string[];
  readonly controlRunIds: readonly string[];
  readonly complete: boolean;
  readonly digest: string;
}

export interface EvaluationComparison {
  readonly officialScore: number;
  readonly promotionScore: number;
  readonly championScore?: number;
  readonly officialMargin?: number;
  readonly abScore?: number;
  readonly abDelta?: number;
  readonly tolerance: number;
  readonly tightMargin: number;
  readonly tight: boolean;
  readonly officialAbDisagreement: boolean;
  readonly agreement: boolean;
  readonly digest: string;
}

export interface EvaluationLadderResult {
  readonly complete: boolean;
  readonly protocolVersion: string;
  /** Protocol/evaluation-contract digest. */
  readonly contractDigest: string;
  readonly evaluationContractDigest: string;
  readonly taskContractDigest: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly officialScore: number;
  readonly promotionScore: number;
  readonly requiredStages: readonly EvaluationStage[];
  readonly completedStages: readonly EvaluationStage[];
  readonly stages: readonly EvaluationStageResult[];
  readonly bestOfNScore?: number;
  readonly symmetricAB?: SymmetricABResult;
  readonly comparison: EvaluationComparison;
  readonly runs: readonly EvaluationRunFact[];
  readonly digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function nonEmpty(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function versionValue(name: string, value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmpty(name, value);
}

function copiedFields(source: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  const excludedKeys = new Set(excluded);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => !excludedKeys.has(key) && value !== undefined).map(([key, value]) => [key, clone(value)]));
}

function finiteNumber(name: string, value: unknown, minimum = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new RangeError(`${name} must be finite and >= ${minimum}`);
  return value;
}

function safeInteger(name: string, value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = own(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stageName(value: unknown): EvaluationStage {
  const normalized = String(value).trim().toLowerCase().replace(/[\s_/]+/g, "-");
  if (normalized === "single" || normalized === "one") return "single";
  if (["best-of-n", "bestofn", "best-n", "best", "best-of"].includes(normalized)) return "best-of-n";
  if ([
    "paired", "paired-symmetric-a-b", "paired-symmetric-ab", "symmetric-a-b", "symmetric-ab",
    "symmetric-a-b-test", "a-b", "ab",
  ].includes(normalized)) return "symmetric-a-b";
  throw new RangeError(`unknown evaluation ladder stage: ${String(value)}`);
}

function aliases(target: Record<string, unknown>, entries: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(entries)) {
    Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
  }
}

export function normalizeEvaluationContract(value: EvaluationContract): NormalizedEvaluationContract {
  if (!isPlainRecord(value)) throw new TypeError("evaluation contract must be an ordinary object");
  const version = versionValue(
    "evaluation contract version",
    firstDefined(value, ["version", "protocolVersion", "protocol_version"]) ?? "evaluation-noise-v1",
  );

  const sourceNoise = firstDefined(value, ["noiseModel", "noise_model"]);
  if (sourceNoise !== undefined && typeof sourceNoise !== "string" && !isPlainRecord(sourceNoise)) {
    throw new TypeError("evaluation noise model must be a string or ordinary object");
  }
  const noiseSource = typeof sourceNoise === "string" ? { kind: sourceNoise } : sourceNoise ?? {};
  const kind = nonEmpty(
    "evaluation noise model",
    firstDefined(noiseSource, ["kind", "type", "model"]) ?? firstDefined(value, ["kind", "type", "model"]) ?? "deterministic",
  );
  const tolerance = finiteNumber(
    "evaluation noise tolerance",
    firstDefined(noiseSource, ["tolerance", "scoreTolerance", "score_tolerance"])
      ?? firstDefined(value, ["tolerance", "scoreTolerance", "score_tolerance"])
      ?? 0,
    0,
  );
  const noise: Record<string, unknown> = {
    ...copiedFields(noiseSource, ["kind", "type", "model", "tolerance", "scoreTolerance", "score_tolerance"]),
    kind,
    tolerance,
  };
  aliases(noise, { type: kind, model: kind, scoreTolerance: tolerance, score_tolerance: tolerance });

  const requiredRepeats = safeInteger(
    "evaluation requiredRepeats",
    firstDefined(value, ["requiredRepeats", "required_repeats"]) ?? 1,
  );
  const sourceLadder = firstDefined(value, ["escalationLadder", "escalation_ladder", "ladder"]);
  if (!Array.isArray(sourceLadder) || sourceLadder.length === 0) throw new TypeError("evaluation escalation ladder is required");
  const seen = new Set<EvaluationStage>();
  const ladder = sourceLadder.map((entry, index) => {
    const source = typeof entry === "string" ? { stage: entry } : entry;
    if (!isPlainRecord(source)) throw new TypeError(`evaluation ladder step ${index} must be an object or stage name`);
    const stage = stageName(firstDefined(source, ["stage", "type", "name"]));
    if (seen.has(stage)) throw new RangeError(`evaluation ladder repeats stage ${stage}`);
    seen.add(stage);
    const defaultRepeats = stage === "single" ? 1 : requiredRepeats;
    const repeats = safeInteger(
      `evaluation ladder ${stage} repeats`,
      firstDefined(source, ["repeats", "n", "requiredRepeats", "required_repeats"]) ?? defaultRepeats,
    );
    if (stage !== "single" && repeats < requiredRepeats) throw new RangeError(`evaluation ladder ${stage} must run at least requiredRepeats times`);
    const required = firstDefined(source, ["required"]) ?? true;
    if (required !== true) throw new RangeError(`evaluation ladder ${stage} must be required`);
    const normalized: Record<string, unknown> = {
      ...copiedFields(source, ["stage", "type", "name", "repeats", "n", "requiredRepeats", "required_repeats", "required"]),
      stage,
      repeats,
      required,
    };
    aliases(normalized, { n: repeats });
    return normalized as unknown as NormalizedEvaluationLadderStep;
  });
  if (ladder[0]?.stage !== "single") throw new RangeError("evaluation escalation ladder must start with single");
  const expectedStages: readonly EvaluationStage[] = ["single", "best-of-n", "symmetric-a-b"];
  if (ladder.length !== expectedStages.length || expectedStages.some((stage) => !seen.has(stage))) {
    throw new RangeError("evaluation escalation ladder must include single, best-of-n, and symmetric-a-b stages");
  }
  if (ladder.length !== expectedStages.length || expectedStages.some((stage, index) => ladder[index]?.stage !== stage)) {
    throw new RangeError("evaluation escalation ladder must be exactly single, best-of-n, symmetric-a-b in order");
  }

  const sourceMargin = firstDefined(value, ["marginPolicy", "margin_policy"]);
  if (sourceMargin !== undefined && !isPlainRecord(sourceMargin)) throw new TypeError("evaluation margin policy must be an ordinary object");
  const marginSource = sourceMargin ?? value;
  const microGain = finiteNumber(
    "evaluation margin microGain",
    firstDefined(marginSource, ["microGain", "micro_gain"]) ?? 0,
    0,
  );
  const tightMargin = finiteNumber(
    "evaluation margin tightMargin",
    firstDefined(marginSource, ["tightMargin", "tight_margin"]) ?? tolerance,
    0,
  );
  const bankMicroGains = firstDefined(marginSource, ["bankMicroGains", "bank_micro_gains"]) ?? true;
  const requireAgreement = firstDefined(marginSource, ["requireAgreement", "require_agreement"]) ?? true;
  if (typeof bankMicroGains !== "boolean" || typeof requireAgreement !== "boolean") throw new TypeError("evaluation margin policy flags must be boolean");
  const margin: Record<string, unknown> = {
    ...copiedFields(marginSource, [
      "microGain", "micro_gain", "tightMargin", "tight_margin",
      "bankMicroGains", "bank_micro_gains", "requireAgreement", "require_agreement",
    ]),
    microGain,
    tightMargin,
    bankMicroGains,
    requireAgreement,
  };
  aliases(margin, {
    micro_gain: microGain,
    tight_margin: tightMargin,
    bank_micro_gains: bankMicroGains,
    require_agreement: requireAgreement,
  });

  const seed = safeInteger("evaluation seed", firstDefined(value, ["seed", "seedBase", "seed_base"]) ?? 0, 0);
  const evaluatorVersion = firstDefined(value, ["evaluatorVersion", "evaluator_version"]);
  if (evaluatorVersion !== undefined) nonEmpty("evaluation evaluatorVersion", evaluatorVersion);
  const normalized: Record<string, unknown> = {
    ...copiedFields(value, [
      "version", "protocolVersion", "protocol_version",
      "noiseModel", "noise_model", "kind", "type", "model", "tolerance", "scoreTolerance", "score_tolerance",
      "requiredRepeats", "required_repeats", "escalationLadder", "escalation_ladder", "ladder",
      "marginPolicy", "margin_policy", "microGain", "micro_gain", "tightMargin", "tight_margin",
      "bankMicroGains", "bank_micro_gains", "requireAgreement", "require_agreement",
      "seed", "seedBase", "seed_base", "evaluatorVersion", "evaluator_version",
    ]),
    version,
    noiseModel: noise,
    requiredRepeats,
    escalationLadder: ladder,
    marginPolicy: margin,
    seed,
    ...(evaluatorVersion === undefined ? {} : { evaluatorVersion }),
  };
  aliases(normalized, {
    protocolVersion: version,
    protocol_version: version,
    noise_model: normalized.noiseModel,
    tolerance,
    required_repeats: requiredRepeats,
    escalation_ladder: normalized.escalationLadder,
    margin_policy: normalized.marginPolicy,
    seed_base: seed,
    evaluator_version: evaluatorVersion,
  });
  return deepFreeze(normalized) as NormalizedEvaluationContract;
}

export function resolveEvaluationContract(provider: EvaluationContractProvider): NormalizedEvaluationContract | undefined {
  const source = provider.evaluation_contract ?? provider.evaluationContract;
  if (source === undefined) return undefined;
  const value = typeof source === "function" ? source.call(provider) : source;
  return normalizeEvaluationContract(value);
}

export function evaluationContractDigest(contract: NormalizedEvaluationContract): string {
  return digestValue(contract);
}

export function requiredEvaluationStages(contract: NormalizedEvaluationContract): readonly EvaluationStage[] {
  return Object.freeze(contract.escalationLadder.filter((step) => step.required).map((step) => step.stage));
}

export function evaluationRunId(missionId: string, branchId: string, attempt: number, stage: EvaluationStage, side: EvaluationSide, repeat: number): string {
  return `${missionId}:${branchId}:${attempt}:evaluation:${stage}:${side}:${repeat}`;
}

export function evaluationSeed(
  missionId: string,
  branchId: string,
  snapshotDigest: string,
  contractDigest: string,
  contractSeed: number,
  stage: EvaluationStage,
  repeat: number,
): number {
  const digest = digestValue({ missionId, branchId, snapshotDigest, contractDigest, contractSeed, stage, repeat });
  return Number.parseInt(digest.slice(0, 12), 16) % 2_147_483_646 + 1;
}

/** Which sides a ladder stage evaluates: paired A/B runs both, other stages only the candidate. */
export function evaluationStageSides(stage: EvaluationStage): readonly EvaluationSide[] {
  return stage === "symmetric-a-b" ? ["candidate", "control"] : ["candidate"];
}

/** Stable position in the declared ladder, independent of which runs were already persisted. */
export function evaluationRunOrdinal(
  contract: NormalizedEvaluationContract,
  stage: EvaluationStage,
  side: EvaluationSide,
  repeat: number,
): number {
  let ordinal = 0;
  for (const step of contract.escalationLadder) {
    for (let currentRepeat = 0; currentRepeat < step.repeats; currentRepeat += 1) {
      for (const currentSide of evaluationStageSides(step.stage)) {
        if (step.stage === stage && currentRepeat === repeat && currentSide === side) return ordinal;
        ordinal += 1;
      }
    }
  }
  throw new RangeError(`evaluation run is not declared by the contract: ${stage}/${side}/${repeat}`);
}

function withoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...rest } = value;
  return rest;
}

export function evaluationRunDigest(value: Omit<EvaluationRunFact, "digest">): string {
  return digestValue(value);
}

function stable(value: number): number {
  return Number(value.toPrecision(12));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : stable(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sign(value: number, tolerance: number): -1 | 0 | 1 {
  if (Math.abs(value) <= tolerance) return 0;
  return value > 0 ? 1 : -1;
}

function sortedRuns(runs: readonly EvaluationRunFact[], contract: NormalizedEvaluationContract): EvaluationRunFact[] {
  const order = new Map(contract.escalationLadder.map((step, index) => [step.stage, index]));
  return [...runs].sort((left, right) => {
    const stageDifference = (order.get(left.stage) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.stage) ?? Number.MAX_SAFE_INTEGER);
    if (stageDifference !== 0) return stageDifference;
    if (left.repeat !== right.repeat) return left.repeat - right.repeat;
    if (left.side === right.side) return 0;
    return left.side === "candidate" ? -1 : 1;
  });
}

export function buildEvaluationLadder(input: {
  readonly contract: NormalizedEvaluationContract;
  readonly runs: readonly EvaluationRunFact[];
  readonly taskContractDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly controlSnapshotDigest?: string;
  readonly championScore?: number;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
}): EvaluationLadderResult {
  const { contract, taskContractDigest, candidateSnapshotDigest, controlSnapshotDigest, championScore, evaluatorId, evaluatorVersion } = input;
  const runs = sortedRuns(input.runs, contract).map((run) => clone(run));
  const requiredStages = [...requiredEvaluationStages(contract)];
  const stages: EvaluationStageResult[] = [];
  let officialScore = 0;
  let bestOfNScore: number | undefined;
  let symmetricAB: SymmetricABResult | undefined;

  for (const step of contract.escalationLadder) {
    const stageRuns = runs.filter((run) => run.stage === step.stage);
    const candidateRuns = stageRuns.filter((run) => run.side === "candidate");
    const scores = candidateRuns.map((run) => run.score);
    const complete = step.stage === "symmetric-a-b"
      ? candidateRuns.length >= step.repeats && stageRuns.filter((run) => run.side === "control").length >= step.repeats
      : candidateRuns.length >= step.repeats;
    const score = step.stage === "best-of-n" ? (scores.length > 0 ? Math.max(...scores) : 0) : average(scores);
    const stage: Omit<EvaluationStageResult, "digest"> = {
      stage: step.stage,
      repeats: step.repeats,
      required: step.required,
      complete,
      scores,
      score,
      runIds: stageRuns.map((run) => run.runId),
    };
    stages.push({ ...stage, digest: digestValue(stage) });
    if (step.stage === "single") officialScore = score;
    if (step.stage === "best-of-n") bestOfNScore = score;
    if (step.stage === "symmetric-a-b") {
      const controls = stageRuns.filter((run) => run.side === "control");
      const candidateScore = average(scores);
      const controlScore = controls.length > 0 ? average(controls.map((run) => run.score)) : undefined;
      const ab: Omit<SymmetricABResult, "digest"> = {
        candidateScore,
        ...(controlScore === undefined ? {} : { controlScore, delta: stable(candidateScore - controlScore) }),
        repeats: step.repeats,
        candidateRunIds: candidateRuns.map((run) => run.runId),
        controlRunIds: controls.map((run) => run.runId),
        complete,
      };
      symmetricAB = { ...ab, digest: digestValue(ab) };
    }
  }

  const bestStage = stages.find((stage) => stage.stage === "best-of-n");
  const promotionScore = symmetricAB?.candidateScore ?? bestStage?.score ?? officialScore;
  const tolerance = contract.noiseModel.tolerance;
  const tightMargin = contract.marginPolicy.tightMargin;
  const officialMargin = championScore === undefined ? undefined : stable(officialScore - championScore);
  const abScore = symmetricAB?.candidateScore;
  const abDelta = symmetricAB?.delta;
  // Tightness is defined against the current Local Champion; a first Candidate has no margin to defend.
  const tight = championScore !== undefined && Math.abs(officialMargin ?? 0) <= tightMargin;
  const disagreement = officialMargin === undefined || abDelta === undefined ? false : (
    sign(officialMargin, 0) !== 0
      && sign(abDelta, 0) !== 0
      && sign(officialMargin, 0) !== sign(abDelta, 0)
  ) || Math.abs(officialMargin - abDelta) > tolerance;
  const comparisonBase: Omit<EvaluationComparison, "digest"> = {
    officialScore,
    promotionScore,
    ...(championScore === undefined ? {} : { championScore, officialMargin }),
    ...(abScore === undefined ? {} : { abScore }),
    ...(abDelta === undefined ? {} : { abDelta }),
    tolerance,
    tightMargin,
    tight,
    officialAbDisagreement: disagreement,
    agreement: !disagreement,
  };
  const comparison = { ...comparisonBase, digest: digestValue(comparisonBase) };
  const complete = contract.escalationLadder.every((step) => stages.find((entry) => entry.stage === step.stage)?.complete === true);
  const resultBase: Omit<EvaluationLadderResult, "digest"> = {
    complete,
    protocolVersion: contract.version,
    contractDigest: evaluationContractDigest(contract),
    evaluationContractDigest: evaluationContractDigest(contract),
    taskContractDigest,
    evaluatorId,
    evaluatorVersion,
    officialScore,
    promotionScore,
    requiredStages,
    completedStages: stages.filter((stage) => stage.complete).map((stage) => stage.stage),
    stages,
    ...(bestOfNScore === undefined ? {} : { bestOfNScore }),
    ...(symmetricAB === undefined ? {} : { symmetricAB }),
    comparison,
    runs,
  };
  return deepFreeze({ ...resultBase, digest: digestValue(resultBase) }) as EvaluationLadderResult;
}

function validFact(value: unknown): value is ScoreFact {
  return isPlainRecord(value) && typeof value.name === "string"
    && (typeof value.value === "string" || typeof value.value === "boolean" || typeof value.value === "number" && Number.isFinite(value.value))
    && (value.source === undefined || typeof value.source === "string");
}

function validRunShape(value: unknown): value is EvaluationRunFact {
  return isPlainRecord(value)
    && typeof value.runId === "string" && value.runId.trim() !== ""
    && typeof value.seed === "number" && Number.isSafeInteger(value.seed)
    && ["single", "best-of-n", "symmetric-a-b"].includes(String(value.stage))
    && ["candidate", "control"].includes(String(value.side))
    && typeof value.repeat === "number" && Number.isSafeInteger(value.repeat) && value.repeat >= 0
    && typeof value.score === "number" && Number.isFinite(value.score)
    && (value.facts === undefined || Array.isArray(value.facts) && value.facts.every(validFact))
    && typeof value.candidateSnapshotDigest === "string"
    && typeof value.snapshotDigest === "string"
    && (value.controlSnapshotDigest === undefined || typeof value.controlSnapshotDigest === "string")
    && typeof value.taskContractDigest === "string"
    && typeof value.contractDigest === "string"
    && typeof value.evaluationContractDigest === "string"
    && typeof value.protocolDigest === "string"
    && typeof value.evaluatorId === "string" && value.evaluatorId.trim() !== ""
    && typeof value.evaluatorVersion === "string" && value.evaluatorVersion.trim() !== ""
    && typeof value.digest === "string" && value.digest.trim() !== "";
}

function sameDigest(left: unknown, right: unknown): boolean {
  try { return digestValue(left) === digestValue(right); } catch { return false; }
}

/** Strict replay validator for the rich ladder attached to ledger events. */
export function validateEvaluationLadder(value: unknown, input: {
  readonly contract: NormalizedEvaluationContract;
  readonly missionId: string;
  readonly branchId: string;
  readonly attempt: number;
  readonly taskContractDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly controlSnapshotDigest?: string;
  readonly championScore?: number;
}): value is EvaluationLadderResult {
  if (!isPlainRecord(value) || !validRunShapeArray(value.runs)) return false;
  const ladder = value as unknown as EvaluationLadderResult;
  const protocolDigest = evaluationContractDigest(input.contract);
  if (typeof ladder.protocolVersion !== "string" || ladder.protocolVersion !== input.contract.version
    || ladder.contractDigest !== protocolDigest || ladder.evaluationContractDigest !== protocolDigest
    || ladder.taskContractDigest !== input.taskContractDigest
    || typeof ladder.evaluatorId !== "string" || typeof ladder.evaluatorVersion !== "string"
    || typeof ladder.officialScore !== "number" || !Number.isFinite(ladder.officialScore)
    || typeof ladder.promotionScore !== "number" || !Number.isFinite(ladder.promotionScore)
    || !Array.isArray(ladder.requiredStages) || !sameDigest(ladder.requiredStages, requiredEvaluationStages(input.contract))
    || !Array.isArray(ladder.completedStages) || !Array.isArray(ladder.stages)
    || !isPlainRecord(ladder.comparison) || typeof ladder.digest !== "string") return false;
  const expectedRuns = new Map<string, { stage: EvaluationStage; side: EvaluationSide; repeat: number; snapshotDigest: string; seed: number }>();
  for (const step of input.contract.escalationLadder) {
    for (let repeat = 0; repeat < step.repeats; repeat += 1) {
      const seed = evaluationSeed(input.missionId, input.branchId, input.candidateSnapshotDigest, protocolDigest, input.contract.seed, step.stage, repeat);
      expectedRuns.set(evaluationRunId(input.missionId, input.branchId, input.attempt, step.stage, "candidate", repeat), {
        stage: step.stage, side: "candidate", repeat, snapshotDigest: input.candidateSnapshotDigest, seed,
      });
      if (step.stage === "symmetric-a-b") {
        expectedRuns.set(evaluationRunId(input.missionId, input.branchId, input.attempt, step.stage, "control", repeat), {
          stage: step.stage, side: "control", repeat, snapshotDigest: input.controlSnapshotDigest ?? input.candidateSnapshotDigest, seed,
        });
      }
    }
  }
  const seen = new Set<string>();
  for (const run of ladder.runs) {
    if (!validRunShape(run) || seen.has(run.runId)) return false;
    seen.add(run.runId);
    const expected = expectedRuns.get(run.runId);
    if (!expected || run.stage !== expected.stage || run.side !== expected.side || run.repeat !== expected.repeat
      || run.seed !== expected.seed || run.snapshotDigest !== expected.snapshotDigest
      || run.candidateSnapshotDigest !== input.candidateSnapshotDigest
      || run.controlSnapshotDigest !== (input.controlSnapshotDigest ?? input.candidateSnapshotDigest)
      || run.taskContractDigest !== input.taskContractDigest || run.contractDigest !== input.taskContractDigest
      || run.evaluationContractDigest !== protocolDigest || run.protocolDigest !== protocolDigest
      || run.evaluatorId !== ladder.evaluatorId || run.evaluatorVersion !== ladder.evaluatorVersion
      || evaluationRunDigest(withoutDigest(run as unknown as Record<string, unknown>) as Omit<EvaluationRunFact, "digest">) !== run.digest) return false;
  }
  const expectedLadder = buildEvaluationLadder({
    contract: input.contract,
    runs: ladder.runs,
    taskContractDigest: input.taskContractDigest,
    candidateSnapshotDigest: input.candidateSnapshotDigest,
    controlSnapshotDigest: input.controlSnapshotDigest,
    championScore: input.championScore,
    evaluatorId: ladder.evaluatorId,
    evaluatorVersion: ladder.evaluatorVersion,
  });
  if (!sameDigest(withoutDigest(ladder as unknown as Record<string, unknown>), withoutDigest(expectedLadder as unknown as Record<string, unknown>))) return false;
  return true;
}

function validRunShapeArray(value: unknown): value is readonly EvaluationRunFact[] {
  return Array.isArray(value) && value.every(validRunShape);
}

export function aggregateEvaluationFacts(runs: readonly EvaluationRunFact[], ladder: EvaluationLadderResult): ScoreFact[] {
  const facts: ScoreFact[] = [];
  for (const run of runs) for (const fact of run.facts ?? []) facts.push({ ...fact, source: fact.source ?? run.runId });
  facts.push(
    { name: "official-score", value: ladder.officialScore, source: "evaluation-ladder" },
    { name: "promotion-score", value: ladder.promotionScore, source: "evaluation-ladder" },
    { name: "evaluation-ladder-complete", value: ladder.complete, source: "evaluation-ladder" },
  );
  return facts;
}
