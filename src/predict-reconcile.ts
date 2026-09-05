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
  readonly candidateId?: string;
  readonly runId?: string;
}

/** The durable card shared by prediction, reconciliation, ranking, and promotion. */
export interface ClaimCard {
  readonly claimId: string;
  readonly hypothesis: string;
  readonly expectedObservation: string;
  readonly expectedObservations: readonly string[];
  readonly reconcileStatus: ReconcileStatus;
  readonly evidenceRefs: readonly string[];
  readonly observationRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly predictionId: string;
  readonly evaluatorId?: string;
  readonly evidenceGatePassed: boolean;
}

export interface ReconcileRecord {
  readonly reconcileId: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly predictionId: string;
  readonly status: ReconcileStatus;
  readonly observationRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly evaluatorId?: string;
  readonly independentEvaluator?: boolean;
  readonly evidenceGatePassed: boolean;
  readonly claim: ClaimCard;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function strings(name: string, value: unknown, required = false): string[] {
  if (value === undefined && !required) return [];
  if (typeof value === "string") value = [value];
  if (!Array.isArray(value) || value.length === 0 && required
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
    || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must contain unique, non-empty strings`);
  }
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
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || key === "tolerance" && value[key] < 0)) {
      throw new RangeError(`prediction metric ${index} ${key} must be finite`);
    }
  }
  if (value.expected === undefined && value.min === undefined && value.max === undefined) {
    throw new Error(`prediction metric ${index} requires expected, min, or max`);
  }
  return Object.freeze({
    name: value.name,
    ...(expected === undefined ? {} : { expected }),
    ...(value.min === undefined ? {} : { min: value.min as number }),
    ...(value.max === undefined ? {} : { max: value.max as number }),
    ...(value.tolerance === undefined ? {} : { tolerance: value.tolerance as number }),
  });
}

export function normalizePrediction(value: unknown, fallbackId?: string): PredictionArtifact {
  if (!record(value)) throw new TypeError("prediction artifact must be an ordinary object");
  const predictionId = value.predictionId ?? fallbackId;
  nonEmpty("predictionId", predictionId);
  nonEmpty("prediction hypothesis", value.hypothesis);
  const observations = strings("prediction expectedObservations", value.expectedObservations ?? value.expectedObservation, true);
  const failureModes = strings("prediction failureModes", value.failureModes ?? value.failureMode, true);
  const metrics = value.expectedMetrics === undefined ? undefined : (() => {
    if (!Array.isArray(value.expectedMetrics)) throw new TypeError("prediction expectedMetrics must be an array");
    return value.expectedMetrics.map(metric);
  })();
  if (value.candidateId !== undefined) nonEmpty("prediction candidateId", value.candidateId);
  if (value.runId !== undefined) nonEmpty("prediction runId", value.runId);
  return Object.freeze({
    predictionId,
    hypothesis: value.hypothesis,
    expectedObservation: observations[0]!,
    expectedObservations: Object.freeze(observations),
    ...(metrics === undefined ? {} : { expectedMetrics: Object.freeze(metrics) }),
    failureModes: Object.freeze(failureModes),
    ...(value.candidateId === undefined ? {} : { candidateId: value.candidateId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
  });
}

export function defaultPrediction(id: string, objective: string): PredictionArtifact {
  nonEmpty("prediction id", id);
  nonEmpty("prediction objective", objective);
  return normalizePrediction({
    predictionId: `${id}:prediction`,
    hypothesis: `${objective} is viable`,
    expectedObservation: "the independent evaluator returns a valid observation",
    failureModes: ["evaluation fails", "candidate violates the task contract"],
  });
}

function claimObservations(value: Record<string, unknown>, prediction?: PredictionArtifact): string[] {
  const expectedObservations = prediction?.expectedObservations ?? [prediction?.expectedObservation ?? ""];
  return strings("claim expectedObservations", value.expectedObservations ?? value.expectedObservation ?? expectedObservations, true);
}

export function normalizeClaimCard(value: unknown, prediction?: PredictionArtifact): ClaimCard {
  if (!record(value)) throw new TypeError("claim card must be an ordinary object");
  const predictionId = value.predictionId ?? prediction?.predictionId;
  nonEmpty("claim predictionId", predictionId);
  if (prediction && predictionId !== prediction.predictionId) throw new Error("claim card prediction does not match its prediction artifact");
  nonEmpty("claim id", value.claimId);
  const hypothesis = value.hypothesis ?? prediction?.hypothesis;
  nonEmpty("claim hypothesis", hypothesis);
  const expectedObservations = claimObservations(value, prediction);
  if (!(["confirmed", "refuted", "inconclusive"] as readonly string[]).includes(String(value.reconcileStatus))) {
    throw new RangeError("unknown reconcile status");
  }
  const evidenceRefs = strings("claim evidenceRefs", value.evidenceRefs);
  const observationRefs = strings("claim observationRefs", value.observationRefs);
  const artifactRefs = strings("claim artifactRefs", value.artifactRefs);
  if (typeof value.evidenceGatePassed !== "boolean") throw new TypeError("claim evidenceGatePassed must be boolean");
  if (value.evaluatorId !== undefined) nonEmpty("claim evaluatorId", value.evaluatorId);
  return Object.freeze({
    claimId: value.claimId,
    hypothesis,
    expectedObservation: expectedObservations[0]!,
    expectedObservations: Object.freeze(expectedObservations),
    reconcileStatus: value.reconcileStatus as ReconcileStatus,
    evidenceRefs: Object.freeze(evidenceRefs),
    observationRefs: Object.freeze(observationRefs),
    artifactRefs: Object.freeze(artifactRefs),
    predictionId,
    ...(value.evaluatorId === undefined ? {} : { evaluatorId: value.evaluatorId }),
    evidenceGatePassed: value.evidenceGatePassed,
  });
}

export function normalizeReconcile(value: unknown, prediction?: PredictionArtifact): ReconcileRecord {
  if (!record(value)) throw new TypeError("reconcile record must be an ordinary object");
  nonEmpty("reconcileId", value.reconcileId);
  const predictionId = value.predictionId ?? prediction?.predictionId;
  nonEmpty("reconcile predictionId", predictionId);
  if (prediction && predictionId !== prediction.predictionId) throw new Error("reconcile does not match its prediction artifact");
  if (!(["confirmed", "refuted", "inconclusive"] as readonly string[]).includes(String(value.status))) throw new RangeError("unknown reconcile status");
  const observationRefs = strings("reconcile observationRefs", value.observationRefs);
  const artifactRefs = strings("reconcile artifactRefs", value.artifactRefs);
  const evidenceRefs = strings("reconcile evidenceRefs", value.evidenceRefs);
  if (value.taskId !== undefined) nonEmpty("reconcile taskId", value.taskId);
  if (value.candidateId !== undefined) nonEmpty("reconcile candidateId", value.candidateId);
  if (value.runId !== undefined) nonEmpty("reconcile runId", value.runId);
  if (value.evaluatorId !== undefined) nonEmpty("reconcile evaluatorId", value.evaluatorId);
  if (value.independentEvaluator !== undefined && typeof value.independentEvaluator !== "boolean") throw new TypeError("reconcile independentEvaluator must be boolean");
  if (typeof value.evidenceGatePassed !== "boolean") throw new TypeError("reconcile evidenceGatePassed must be boolean");
  if (value.evidenceGatePassed && (value.independentEvaluator !== true || typeof value.evaluatorId !== "string" || evidenceRefs.length === 0)) {
    throw new Error("world-model evidence requires an independent evaluator and evidence gate");
  }
  const claim = normalizeClaimCard(value.claim ?? {
    claimId: `${value.reconcileId}:claim`, predictionId,
    hypothesis: prediction?.hypothesis ?? value.hypothesis,
    expectedObservations: prediction?.expectedObservations ?? value.expectedObservations ?? value.expectedObservation,
    reconcileStatus: value.status, evidenceRefs, observationRefs, artifactRefs,
    evaluatorId: value.evaluatorId, evidenceGatePassed: value.evidenceGatePassed,
  }, prediction);
  if (claim.reconcileStatus !== value.status || claim.evidenceGatePassed !== value.evidenceGatePassed) {
    throw new Error("reconcile claim card does not match its record");
  }
  return Object.freeze({
    reconcileId: value.reconcileId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.candidateId === undefined ? {} : { candidateId: value.candidateId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    predictionId, status: value.status as ReconcileStatus,
    observationRefs: Object.freeze(observationRefs), artifactRefs: Object.freeze(artifactRefs), evidenceRefs: Object.freeze(evidenceRefs),
    ...(value.evaluatorId === undefined ? {} : { evaluatorId: value.evaluatorId }),
    ...(value.independentEvaluator === undefined ? {} : { independentEvaluator: value.independentEvaluator }),
    evidenceGatePassed: value.evidenceGatePassed, claim,
  });
}

export function reconcilePrediction(input: {
  readonly prediction: PredictionArtifact;
  readonly observations?: Readonly<Record<string, string | number | boolean>>;
  readonly status?: ReconcileStatus;
  readonly observationRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly evaluatorId: string;
  readonly independentEvaluator?: boolean;
  readonly evidenceGatePassed?: boolean;
  readonly reconcileId?: string;
  readonly taskId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
}): ReconcileRecord {
  const observations = input.observations ?? {};
  const expectedObservations = input.prediction.expectedObservations ?? [input.prediction.expectedObservation];
  let status: ReconcileStatus = input.status ?? "inconclusive";
  const metrics = input.prediction.expectedMetrics ?? [];
  if (input.status === undefined && metrics.length > 0) {
    let missing = false;
    let failed = false;
    for (const expected of metrics) {
      const actual = observations[expected.name];
      if (actual === undefined) { missing = true; continue; }
      if (expected.expected !== undefined) {
        const tolerance = expected.tolerance ?? 0;
        if (typeof actual === "number" && typeof expected.expected === "number") {
          if (Math.abs(actual - expected.expected) > tolerance) failed = true;
        } else if (actual !== expected.expected) failed = true;
      }
      if (expected.min !== undefined && (typeof actual !== "number" || actual < expected.min - (expected.tolerance ?? 0))) failed = true;
      if (expected.max !== undefined && (typeof actual !== "number" || actual > expected.max + (expected.tolerance ?? 0))) failed = true;
    }
    status = failed ? "refuted" : missing ? "inconclusive" : "confirmed";
  }
  const evidenceGatePassed = input.evidenceGatePassed ?? true;
  return normalizeReconcile({
    reconcileId: input.reconcileId ?? `${input.prediction.predictionId}:reconcile`,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    predictionId: input.prediction.predictionId, status,
    observationRefs: input.observationRefs ?? [], artifactRefs: input.artifactRefs ?? [], evidenceRefs: input.evidenceRefs ?? [],
    evaluatorId: input.evaluatorId, independentEvaluator: input.independentEvaluator ?? true, evidenceGatePassed,
    claim: {
      claimId: `${input.prediction.predictionId}:claim`, predictionId: input.prediction.predictionId,
      hypothesis: input.prediction.hypothesis, expectedObservations,
      reconcileStatus: status, evidenceRefs: input.evidenceRefs ?? [], observationRefs: input.observationRefs ?? [], artifactRefs: input.artifactRefs ?? [],
      evaluatorId: input.evaluatorId, evidenceGatePassed,
    },
  }, input.prediction);
}
