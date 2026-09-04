import { deepFreeze, digestValue } from "./security-boundary";
import type {
  CandidateSnapshot,
  CompetitionAdapterDescription,
  CompetitionArtifactReference,
  CompetitionRuleValidation,
  EvaluationResult,
  ToyCompetitionAdapter,
} from "./toy-harness";

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

export const BinaryClassificationToyCompetitionAdapter = BinaryAccuracyToyCompetitionAdapter;
