/**
 * Versioned CompetitionContract: rules, data split, scoring, submission, and
 * limits for one Competition. Physical home: `src/competition/`.
 *
 * The contract is content-addressed: `digest` covers every field except the
 * digest itself, so any rule or limit drift is detectable and a persisted
 * contract that disagrees with its digest fails validation. Researcher agents
 * never receive this object — they get the minimal summary assembled in
 * `src/execution/researcher-context.ts`. The contract holds no credentials
 * and no hidden data; those stay with the trusted Evaluator.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";

export const COMPETITION_CONTRACT_SCHEMA = "evok.competition-contract/v1" as const;

export type CompetitionSplitKind = "kfold" | "time" | "group";

export interface CompetitionDataSplit {
  readonly kind: CompetitionSplitKind;
  readonly folds?: number;
  /** Gap between train and validation windows (time/group splits). */
  readonly purge?: string;
  readonly embargo?: string;
  /** A protected holdout the research loop never reads. */
  readonly holdout: "protected" | "none";
}

export interface CompetitionScoring {
  readonly metric: string;
  readonly direction: "maximize" | "minimize";
  readonly greaterIsBetter?: boolean;
}

export interface CompetitionSubmission {
  readonly format: string;
  readonly maxPerDay?: number;
  /** Total real submissions allowed for the whole competition. */
  readonly quota?: number;
}

export interface CompetitionLimits {
  readonly timeLimitMs?: number;
  readonly network: "none" | "restricted" | "open";
  readonly allowedResources?: readonly string[];
}

export type CompetitionGpuBackend = "cuda" | "rocm" | "metal";
export const COMPETITION_GPU_BACKENDS: readonly CompetitionGpuBackend[] = ["cuda", "rocm", "metal"];

/** Typed GPU need: backend + count, optionally a model family and minimum VRAM. */
export interface CompetitionGpuRequirements {
  readonly backend: CompetitionGpuBackend;
  readonly count: number;
  readonly model?: string;
  readonly minMemoryBytes?: number;
}

/**
 * Versioned typed resource requirements of the competition itself. Optional
 * for backward compatibility; when present it is validated and covered by
 * the contract digest. The Execution Broker checks leases against the host
 * inventory; Researcher agents never see this object — only the lease
 * summary assembled in `researcher-context.ts`.
 */
export interface CompetitionResourceRequirements {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly gpu?: CompetitionGpuRequirements;
  readonly storageBytes?: number;
  /** Max parallel Runs the competition environment allows. */
  readonly maxConcurrency?: number;
}

export interface CompetitionContractInput {
  readonly version: string;
  readonly competitionId: string;
  readonly title?: string;
  readonly objective: string;
  readonly scoring: CompetitionScoring;
  readonly dataSplit: CompetitionDataSplit;
  readonly submission: CompetitionSubmission;
  readonly limits: CompetitionLimits;
  readonly resources?: CompetitionResourceRequirements;
}

export interface CompetitionContract extends CompetitionContractInput {
  readonly schema: typeof COMPETITION_CONTRACT_SCHEMA;
  readonly digest: string;
}

export class CompetitionContractError extends Error {
  readonly kind = "competition-contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "CompetitionContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CompetitionContractError(`${label} is required`);
  }
  return value;
}

function optionalPositiveInteger(label: string, value: unknown): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CompetitionContractError(`${label} must be an integer >= 1`);
  }
}

/** Digest over every contract field except the digest itself. */
export function competitionContractDigest(contract: CompetitionContractInput): string {
  return digestValue({ schema: COMPETITION_CONTRACT_SCHEMA, ...contract });
}

function validateBody(raw: CompetitionContractInput): void {
  requireNonEmpty("competition contract version", raw.version);
  requireNonEmpty("competition contract competitionId", raw.competitionId);
  requireNonEmpty("competition contract objective", raw.objective);
  const scoring = raw.scoring;
  if (!isRecord(scoring)) throw new CompetitionContractError("competition contract scoring is required");
  requireNonEmpty("competition contract scoring.metric", scoring.metric);
  if (scoring.direction !== "maximize" && scoring.direction !== "minimize") {
    throw new CompetitionContractError("competition contract scoring.direction must be maximize or minimize");
  }
  const split = raw.dataSplit;
  if (!isRecord(split)) throw new CompetitionContractError("competition contract dataSplit is required");
  if (split.kind !== "kfold" && split.kind !== "time" && split.kind !== "group") {
    throw new CompetitionContractError("competition contract dataSplit.kind must be kfold, time, or group");
  }
  if (split.holdout !== "protected" && split.holdout !== "none") {
    throw new CompetitionContractError("competition contract dataSplit.holdout must be protected or none");
  }
  optionalPositiveInteger("competition contract dataSplit.folds", split.folds);
  const submission = raw.submission;
  if (!isRecord(submission)) throw new CompetitionContractError("competition contract submission is required");
  requireNonEmpty("competition contract submission.format", submission.format);
  optionalPositiveInteger("competition contract submission.maxPerDay", submission.maxPerDay);
  optionalPositiveInteger("competition contract submission.quota", submission.quota);
  const limits = raw.limits;
  if (!isRecord(limits)) throw new CompetitionContractError("competition contract limits is required");
  if (limits.network !== "none" && limits.network !== "restricted" && limits.network !== "open") {
    throw new CompetitionContractError("competition contract limits.network must be none, restricted, or open");
  }
  optionalPositiveInteger("competition contract limits.timeLimitMs", limits.timeLimitMs);
  validateResources(raw.resources);
}

function validateResources(resources: unknown): void {
  if (resources === undefined) return;
  if (!isRecord(resources)) throw new CompetitionContractError("competition contract resources must be an object");
  const label = "competition contract resources";
  if (!Number.isSafeInteger(resources.cpus) || (resources.cpus as number) < 1) {
    throw new CompetitionContractError(`${label}.cpus must be an integer >= 1`);
  }
  if (!Number.isSafeInteger(resources.memoryBytes) || (resources.memoryBytes as number) < 1) {
    throw new CompetitionContractError(`${label}.memoryBytes must be an integer >= 1`);
  }
  optionalPositiveInteger(`${label}.storageBytes`, resources.storageBytes);
  optionalPositiveInteger(`${label}.maxConcurrency`, resources.maxConcurrency);
  if (resources.gpu !== undefined) {
    const gpu = resources.gpu;
    if (!isRecord(gpu)) throw new CompetitionContractError(`${label}.gpu must be an object`);
    if (!COMPETITION_GPU_BACKENDS.includes(gpu.backend as CompetitionGpuBackend)) {
      throw new CompetitionContractError(`${label}.gpu.backend must be one of ${COMPETITION_GPU_BACKENDS.join(", ")}`);
    }
    if (!Number.isSafeInteger(gpu.count) || (gpu.count as number) < 1) {
      throw new CompetitionContractError(`${label}.gpu.count must be an integer >= 1`);
    }
    if (gpu.model !== undefined && (typeof gpu.model !== "string" || gpu.model.trim() === "")) {
      throw new CompetitionContractError(`${label}.gpu.model must be a non-empty string`);
    }
    optionalPositiveInteger(`${label}.gpu.minMemoryBytes`, gpu.minMemoryBytes);
  }
}

/** Creates a frozen, content-addressed contract. */
export function createCompetitionContract(input: CompetitionContractInput): CompetitionContract {
  validateBody(input);
  return deepFreeze({
    schema: COMPETITION_CONTRACT_SCHEMA,
    ...input,
    digest: competitionContractDigest(input),
  });
}

/**
 * Validates a persisted/loaded contract: shape, required version, and the
 * content digest. A tampered or stale contract fails closed.
 */
export function validateCompetitionContract(raw: unknown): CompetitionContract {
  if (!isRecord(raw)) throw new CompetitionContractError("competition contract must be an object");
  if (raw.schema !== COMPETITION_CONTRACT_SCHEMA) {
    throw new CompetitionContractError(`competition contract schema must be ${COMPETITION_CONTRACT_SCHEMA}`);
  }
  requireNonEmpty("competition contract digest", raw.digest);
  const { digest, ...body } = raw;
  validateBody(body as unknown as CompetitionContractInput);
  if (digestValue({ schema: COMPETITION_CONTRACT_SCHEMA, ...body }) !== digest) {
    throw new CompetitionContractError("competition contract digest mismatch");
  }
  return deepFreeze(raw as unknown as CompetitionContract);
}
