import { deepFreeze, digestValue } from "./security-boundary";

export type ReconcileStatus = "confirmed" | "refuted" | "inconclusive";

export interface PredictionMetricExpectation {
  readonly name: string;
  readonly expected?: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
  readonly tolerance?: number;
}

export interface PredictionArtifact {
  readonly predictionId: string;
  readonly hypothesis: string;
  readonly expectedObservation: string;
  readonly expectedObservations?: readonly string[];
  readonly expectedMetrics?: readonly PredictionMetricExpectation[];
  readonly failureModes: readonly string[];
}

export interface ClaimCard {
  readonly claimId: string;
  readonly hypothesis: string;
  readonly expectedObservation: string;
  readonly expectedObservations: readonly string[];
  readonly expectedMetrics: readonly PredictionMetricExpectation[];
  readonly reconcileStatus: ReconcileStatus;
  readonly evidenceRefs: readonly string[];
  readonly observationRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly predictionId: string;
  readonly evaluatorId?: string;
  readonly evidenceGatePassed: boolean;
}

export interface ReconcileInput {
  readonly reconcileId?: string;
  readonly taskId?: string;
  readonly status?: ReconcileStatus;
  readonly observationRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly evaluatorId?: string;
  readonly independentEvaluator?: boolean;
  readonly evidenceGatePassed?: boolean;
}

export interface ReconcileRecord {
  readonly reconcileId: string;
  readonly taskId?: string;
  readonly predictionId: string;
  readonly status: ReconcileStatus;
  readonly observationRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly evaluatorId?: string;
  readonly independentEvaluator: boolean;
  readonly evidenceGatePassed: boolean;
  readonly claim: ClaimCard;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function strings(name: string, value: unknown, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    || new Set(value).size !== value.length) throw new TypeError(`${name} must contain unique, non-empty strings`);
  return [...value] as string[];
}

function metric(value: unknown, index: number): PredictionMetricExpectation {
  if (!record(value)) throw new TypeError(`prediction metric ${index} must be an ordinary object`);
  nonEmpty(`prediction metric ${index} name`, value.name);
  const expected = value.expected;
  if (expected !== undefined && typeof expected !== "string" && typeof expected !== "number" && typeof expected !== "boolean") {
    throw new TypeError(`prediction metric ${index} expected value is invalid`);
  }
  for (const key of ["min", "max", "tolerance"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key])
      || key === "tolerance" && value[key] < 0)) throw new RangeError(`prediction metric ${index} ${key} must be finite`);
  }
  const min = value.min as number | undefined;
  const max = value.max as number | undefined;
  if (min !== undefined && max !== undefined && min > max) throw new RangeError(`prediction metric ${index} min exceeds max`);
  if (expected === undefined && min === undefined && max === undefined) throw new Error(`prediction metric ${index} needs an expectation`);
  return Object.freeze({
    name: value.name,
    ...(expected === undefined ? {} : { expected }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(value.tolerance === undefined ? {} : { tolerance: value.tolerance as number }),
  });
}

export function normalizePrediction(value: unknown, fallbackId?: string): PredictionArtifact {
  if (!record(value)) throw new TypeError("prediction artifact is required and must be an ordinary object");
  const predictionId = value.predictionId ?? fallbackId;
  nonEmpty("predictionId", predictionId);
  nonEmpty("prediction hypothesis", value.hypothesis);
  const expectedObservations = strings("prediction expectedObservations", value.expectedObservations ?? [value.expectedObservation], true);
  if (value.expectedObservation !== undefined && value.expectedObservation !== expectedObservations[0]) throw new Error("conflicting expected observation");
  const failureModes = strings("prediction failureModes", value.failureModes, true);
  if (value.expectedMetrics !== undefined && !Array.isArray(value.expectedMetrics)) throw new TypeError("prediction expectedMetrics must be an array");
  const expectedMetrics = [...(value.expectedMetrics as unknown[] | undefined ?? [])].map((entry, index) => metric(entry, index));
  if (new Set(expectedMetrics.map((entry) => entry.name)).size !== expectedMetrics.length) throw new Error("prediction metric names must be unique");
  const normalized = {
    predictionId,
    hypothesis: value.hypothesis,
    expectedObservation: expectedObservations[0]!,
    expectedObservations,
    ...(expectedMetrics.length === 0 ? {} : { expectedMetrics }),
    failureModes,
  };
  const digest = digestValue(normalized);
  if (value.digest !== undefined && value.digest !== digest) throw new Error("prediction digest mismatch");
  return deepFreeze(normalized) as PredictionArtifact;
}

function expectedObservations(prediction: PredictionArtifact): readonly string[] {
  return prediction.expectedObservations ?? [prediction.expectedObservation];
}

function normalizeRefs(name: string, value: unknown): readonly string[] {
  return Object.freeze(strings(name, value));
}

export function normalizeClaimCard(value: unknown, prediction: PredictionArtifact): ClaimCard {
  if (!record(value)) throw new TypeError("claim card must be an ordinary object");
  if (value.predictionId !== prediction.predictionId || value.hypothesis !== prediction.hypothesis
    || value.expectedObservation !== prediction.expectedObservation || value.reconcileStatus !== "confirmed" && value.reconcileStatus !== "refuted" && value.reconcileStatus !== "inconclusive"
    || !Array.isArray(value.evidenceRefs) || !Array.isArray(value.observationRefs) || !Array.isArray(value.artifactRefs)
    || typeof value.evidenceGatePassed !== "boolean") throw new Error("claim card does not match prediction");
  nonEmpty("claimId", value.claimId);
  const evidenceRefs = normalizeRefs("claim evidenceRefs", value.evidenceRefs);
  const observationRefs = normalizeRefs("claim observationRefs", value.observationRefs);
  const artifactRefs = normalizeRefs("claim artifactRefs", value.artifactRefs);
  if (value.evidenceGatePassed && (typeof value.evaluatorId !== "string" || value.evaluatorId.trim() === "" || evidenceRefs.length === 0 || observationRefs.length + artifactRefs.length === 0)) {
    throw new Error("claim evidence gate requires independent evaluator evidence");
  }
  return deepFreeze({
    claimId: value.claimId,
    hypothesis: prediction.hypothesis,
    expectedObservation: prediction.expectedObservation,
    expectedObservations: expectedObservations(prediction),
    expectedMetrics: prediction.expectedMetrics ?? [],
    reconcileStatus: value.reconcileStatus,
    evidenceRefs,
    observationRefs,
    artifactRefs,
    predictionId: prediction.predictionId,
    ...(value.evaluatorId === undefined ? {} : { evaluatorId: value.evaluatorId as string }),
    evidenceGatePassed: value.evidenceGatePassed,
  });
}

export function normalizeReconcile(value: unknown, prediction: PredictionArtifact): ReconcileRecord {
  if (!record(value)) throw new TypeError("reconcile record must be an ordinary object");
  nonEmpty("reconcileId", value.reconcileId);
  if (value.predictionId !== prediction.predictionId) throw new Error("reconcile prediction mismatch");
  if (value.status !== "confirmed" && value.status !== "refuted" && value.status !== "inconclusive") throw new RangeError("unknown reconcile status");
  const observationRefs = normalizeRefs("observationRefs", value.observationRefs);
  const artifactRefs = normalizeRefs("artifactRefs", value.artifactRefs);
  const evidenceRefs = normalizeRefs("evidenceRefs", value.evidenceRefs);
  const independentEvaluator = value.independentEvaluator ?? false;
  if (typeof independentEvaluator !== "boolean" || typeof value.evidenceGatePassed !== "boolean") throw new TypeError("reconcile gate fields must be boolean");
  if (value.evaluatorId !== undefined) nonEmpty("reconcile evaluatorId", value.evaluatorId);
  if (observationRefs.length + artifactRefs.length === 0 && value.status !== "inconclusive") throw new Error("reconcile requires observation or artifact references");
  // The gate and evaluator independence are one fact: a reconcile cannot claim a passed evidence gate
  // without an independent evaluator, and claiming an independent evaluator without a passed gate is
  // contradictory. Callers may not assert one without the other.
  if (value.independentEvaluator !== value.evidenceGatePassed) {
    throw new Error("reconcile evidence gate and independent evaluator must agree");
  }
  if (value.evidenceGatePassed && (value.evaluatorId === undefined || evidenceRefs.length === 0
    || observationRefs.length + artifactRefs.length === 0)) {
    throw new Error("reconcile gate requires independent evaluator evidence");
  }
  const claim: ClaimCard = {
    claimId: `${value.reconcileId}:claim`,
    hypothesis: prediction.hypothesis,
    expectedObservation: prediction.expectedObservation,
    expectedObservations: expectedObservations(prediction),
    expectedMetrics: prediction.expectedMetrics ?? [],
    reconcileStatus: value.status,
    evidenceRefs,
    observationRefs,
    artifactRefs,
    predictionId: prediction.predictionId,
    ...(value.evaluatorId === undefined ? {} : { evaluatorId: value.evaluatorId }),
    evidenceGatePassed: value.evidenceGatePassed,
  };
  if (value.claim !== undefined && digestValue(value.claim) !== digestValue(claim)) throw new Error("claim card does not match reconcile");
  return deepFreeze({
    reconcileId: value.reconcileId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId as string }),
    predictionId: prediction.predictionId,
    status: value.status,
    observationRefs,
    artifactRefs,
    evidenceRefs,
    ...(value.evaluatorId === undefined ? {} : { evaluatorId: value.evaluatorId }),
    independentEvaluator,
    evidenceGatePassed: value.evidenceGatePassed,
    claim,
  });
}

/** Purely reconciles observations; it never writes mission memory or WORLD_MODEL. */
export function deriveReconcileStatus(prediction: PredictionArtifact, observations: Readonly<Record<string, string | number | boolean>>, observationsComplete?: boolean): ReconcileStatus {
  const metrics = prediction.expectedMetrics ?? [];
  let missing = metrics.length === 0 || observationsComplete === false;
  let failed = false;
  for (const expected of metrics) {
    const actual = Object.hasOwn(observations, expected.name) ? observations[expected.name] : undefined;
    if (actual === undefined) { missing = true; continue; }
    const tolerance = expected.tolerance ?? 0;
    if (expected.expected !== undefined) {
      failed ||= typeof actual === "number" && typeof expected.expected === "number"
        ? Math.abs(actual - expected.expected) > tolerance : actual !== expected.expected;
    }
    if (expected.min !== undefined) failed ||= typeof actual !== "number" || actual < expected.min - tolerance;
    if (expected.max !== undefined) failed ||= typeof actual !== "number" || actual > expected.max + tolerance;
  }
  return observationsComplete === false ? "inconclusive" : failed ? "refuted" : missing ? "inconclusive" : "confirmed";
}

export function reconcilePrediction(input: {
  readonly prediction: PredictionArtifact;
  readonly observations?: Readonly<Record<string, string | number | boolean>>;
  readonly observationsComplete?: boolean;
  readonly observationRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly evaluatorId?: string;
  readonly independentEvaluator?: boolean;
  readonly evidenceGatePassed?: boolean;
  readonly reconcileId?: string;
  readonly taskId?: string;
}): ReconcileRecord {
  const prediction = normalizePrediction(input.prediction);
  const observations = input.observations ?? {};
  const observationRefs = input.observationRefs ?? [];
  const artifactRefs = input.artifactRefs ?? [];
  const evidenceGatePassed = input.evidenceGatePassed ?? false;
  const independentEvaluator = input.independentEvaluator ?? false;
  if (evidenceGatePassed && (!independentEvaluator || input.evaluatorId === undefined || input.evidenceRefs?.length === 0)) {
    throw new Error("world-model evidence requires an independent evaluator and evidence refs");
  }
  return normalizeReconcile({
    reconcileId: input.reconcileId ?? `${prediction.predictionId}:reconcile`,
    taskId: input.taskId,
    predictionId: prediction.predictionId,
    status: deriveReconcileStatus(prediction, observations, input.observationsComplete),
    observationRefs,
    artifactRefs,
    evidenceRefs: input.evidenceRefs ?? [],
    evaluatorId: input.evaluatorId,
    independentEvaluator,
    evidenceGatePassed,
  }, prediction);
}
