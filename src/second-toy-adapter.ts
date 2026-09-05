import { deepFreeze, digestValue } from "./security-boundary";
import type {
  CandidateSnapshot,
  CompetitionAdapterDescription,
  CompetitionArtifactReference,
  CompetitionRuleValidation,
  EvaluationResult,
  ToyCompetitionAdapter,
  EvaluationContract,
  EvaluationRunContext,
  NormalizedEvaluationContract,
} from "./toy-harness";
import { normalizeEvaluationContract } from "./evaluation-noise";

export type BinaryLabel = 0 | 1;

const RULES = [
  "predictions must be a JSON array of binary labels",
  "predictions must contain exactly one label per input row",
] as const;

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parsePredictions(snapshot: Readonly<CandidateSnapshot>, file: string): unknown {
  const content = snapshot.files[file];
  if (typeof content !== "string") return undefined;
  try { return JSON.parse(content); } catch { return undefined; }
}

/** A second adapter with row-wise binary predictions and accuracy, not a scalar score file. */
export class BinaryAccuracyToyCompetitionAdapter implements ToyCompetitionAdapter {
  readonly name = "binary-accuracy";
  readonly labels: readonly BinaryLabel[];
  readonly predictionFile: string;

  constructor(labels: readonly BinaryLabel[], predictionFile = "predictions") {
    if (!Array.isArray(labels) || labels.length === 0 || labels.some((label, index) => !Object.hasOwn(labels, index) || label !== 0 && label !== 1)) {
      throw new RangeError("labels must be a non-empty binary array");
    }
    nonEmpty("predictionFile", predictionFile);
    this.labels = Object.freeze([...labels]);
    this.predictionFile = predictionFile;
  }

  describe(): CompetitionAdapterDescription {
    return deepFreeze({
      name: this.name,
      input: {
        format: "JSON array",
        predictionFile: this.predictionFile,
        rows: this.labels.length,
        labels: [...this.labels],
      },
      rules: [...RULES],
      artifacts: [this.predictionFile],
      metric: "accuracy (higher is better)",
    });
  }

  validateRules(snapshot: Readonly<CandidateSnapshot>): CompetitionRuleValidation {
    const predictions = parsePredictions(snapshot, this.predictionFile);
    const violations: string[] = [];
    if (!Array.isArray(predictions)) {
      violations.push(`${this.predictionFile} must be valid JSON containing an array`);
    } else {
      if (predictions.length !== this.labels.length) violations.push(`${this.predictionFile} must contain ${this.labels.length} predictions`);
      if (predictions.some((entry, index) => !Object.hasOwn(predictions, index) || entry !== 0 && entry !== 1)) violations.push(`${this.predictionFile} may contain only 0 or 1`);
    }
    return deepFreeze({ ok: violations.length === 0, violations });
  }

  collectArtifacts(snapshot: Readonly<CandidateSnapshot>): readonly CompetitionArtifactReference[] {
    const content = snapshot.files[this.predictionFile] ?? "";
    const digest = digestValue(content);
    return deepFreeze([{
      artifactId: `${this.predictionFile}:${digest}`,
      address: `artifact://${this.name}/${digest}`,
      digest,
      kind: "predictions",
    }]);
  }

  evaluate(snapshot: Readonly<CandidateSnapshot>): EvaluationResult {
    const validation = this.validateRules(snapshot);
    if (!validation.ok) throw new Error(`rule validation failed: ${validation.violations.join("; ")}`);
    const predictions = parsePredictions(snapshot, this.predictionFile) as BinaryLabel[];
    const correct = predictions.reduce<number>((count, prediction, index) => count + (prediction === this.labels[index] ? 1 : 0), 0);
    const score = correct / this.labels.length;
    return {
      score,
      facts: [
        { name: "accuracy", value: score, source: this.name },
        { name: "correct", value: correct, source: this.name },
        { name: "rows", value: this.labels.length, source: this.name },
      ],
      evaluatorId: this.name,
      evaluatorVersion: "1",
    };
  }
}

export interface NoisyScoreToyCompetitionAdapterOptions {
  readonly scoreFile?: string;
  readonly controlScore?: number;
  readonly noise?: readonly number[] | ((context: EvaluationRunContext, snapshot: Readonly<CandidateSnapshot>) => number);
  readonly evaluationContract?: EvaluationContract;
  readonly contract?: EvaluationContract;
  readonly evaluatorVersion?: string;
}

/** A deterministic fixture for proving that one noisy score cannot crown a champion. */
export class NoisyScoreToyCompetitionAdapter implements ToyCompetitionAdapter {
  readonly name = "noisy-score";
  readonly scoreFile: string;
  readonly controlScore?: number;
  readonly noise?: readonly number[] | ((context: EvaluationRunContext, snapshot: Readonly<CandidateSnapshot>) => number);
  readonly evaluatorVersion: string;
  private readonly protocol: NormalizedEvaluationContract;

  constructor(options: NoisyScoreToyCompetitionAdapterOptions | readonly number[] = {}) {
    const source: NoisyScoreToyCompetitionAdapterOptions = Array.isArray(options)
      ? { noise: [...options] }
      : options as NoisyScoreToyCompetitionAdapterOptions;
    this.scoreFile = source.scoreFile ?? "score";
    nonEmpty("scoreFile", this.scoreFile);
    if (source.controlScore !== undefined && (!Number.isFinite(source.controlScore))) throw new RangeError("controlScore must be finite");
    this.controlScore = source.controlScore;
    if (Array.isArray(source.noise) && source.noise.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new RangeError("noise values must be finite numbers");
    }
    this.noise = Array.isArray(source.noise) ? Object.freeze([...source.noise]) : source.noise;
    this.protocol = normalizeEvaluationContract(source.evaluationContract ?? source.contract ?? {
      version: "toy-noise-v1",
      noiseModel: { kind: "stochastic", tolerance: 0.05 },
      requiredRepeats: 3,
      escalationLadder: [
        { stage: "single", repeats: 1 },
        { stage: "best-of-n", repeats: 3 },
        { stage: "symmetric-a-b", repeats: 3 },
      ],
      marginPolicy: { microGain: 0.01, tightMargin: 0.05 },
    });
    this.evaluatorVersion = source.evaluatorVersion ?? "toy-noise-evaluator-v1";
  }

  evaluation_contract(): NormalizedEvaluationContract {
    return this.protocol;
  }

  evaluationContract(): NormalizedEvaluationContract {
    return this.protocol;
  }

  describe(): CompetitionAdapterDescription {
    return deepFreeze({
      name: this.name,
      input: { scoreFile: this.scoreFile, evaluationContract: this.protocol },
      rules: [`${this.scoreFile} must contain a finite numeric score`],
      artifacts: [this.scoreFile],
      metric: "noisy score (higher is better)",
    });
  }

  evaluate(snapshot: Readonly<CandidateSnapshot>, context?: EvaluationRunContext): EvaluationResult {
    const raw = snapshot.files[this.scoreFile];
    const score = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(score) && !(context?.side === "control" && this.controlScore !== undefined)) {
      throw new Error(`${this.scoreFile} is missing or not finite`);
    }
    const base = context?.side === "control" && this.controlScore !== undefined ? this.controlScore : score;
    const noise = typeof this.noise === "function"
      ? (context === undefined ? 0 : this.noise(context, snapshot))
      : this.noise?.[context?.ordinal ?? 0] ?? 0;
    if (typeof noise !== "number" || !Number.isFinite(noise)) throw new RangeError("noise must be finite");
    return {
      score: base + noise,
      evaluatorId: this.name,
      evaluatorVersion: this.evaluatorVersion,
      facts: [
        { name: "base-score", value: base, source: this.name },
        { name: "noise", value: noise, source: this.name },
        ...(context === undefined ? [] : [
          { name: "evaluation-stage", value: context.stage, source: this.name },
          { name: "evaluation-side", value: context.side, source: this.name },
        ]),
      ],
    };
  }
}
