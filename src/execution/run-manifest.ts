/**
 * RunManifest: the durable record of one Run — which competition contract it
 * ran under (version + digest), which host inventory snapshot and resource
 * lease it was granted, what it actually used, and why it exited. Physical
 * home: `src/execution/`.
 *
 * The manifest is evidence plumbing, not a gate: it records facts the
 * evidence pack can later audit. It carries digests, not credentials or
 * hidden data. Validation fails closed on any digest mismatch.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import type { ResourceLease, ResourceUsage } from "./resource-lease";
import { validateResourceLease, validateResourceUsage } from "./resource-lease";

export const RUN_MANIFEST_SCHEMA = "evok.run-manifest/v1" as const;

export type RunOutcome = "completed" | "failed" | "timeout" | "cancelled";

export interface RunManifest {
  readonly schema: typeof RUN_MANIFEST_SCHEMA;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  /** Version + digest of the CompetitionContract this Run ran under. */
  readonly contract: { readonly version: string; readonly digest: string };
  /** Digest of the HostInventory snapshot taken before the Run. */
  readonly inventoryDigest: string;
  readonly lease: ResourceLease;
  /** Filled when the Run settles; absent while the Run is in flight. */
  readonly usage?: ResourceUsage;
  readonly outcome?: RunOutcome;
  readonly createdAt: string;
  readonly digest: string;
}

export class RunManifestError extends Error {
  readonly kind = "run-manifest" as const;
  constructor(message: string) {
    super(message);
    this.name = "RunManifestError";
  }
}

export interface CreateRunManifestInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly contract: { readonly version: string; readonly digest: string };
  readonly inventoryDigest: string;
  readonly lease: ResourceLease;
  readonly now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new RunManifestError(`${label} is required`);
  return value;
}

/** Opens a manifest for a Run that has been granted a lease. */
export function createRunManifest(input: CreateRunManifestInput): RunManifest {
  requireNonEmpty("run manifest runId", input.runId);
  requireNonEmpty("run manifest taskId", input.taskId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new RunManifestError("run manifest attempt must be an integer >= 1");
  requireNonEmpty("run manifest contract.version", input.contract.version);
  requireNonEmpty("run manifest contract.digest", input.contract.digest);
  requireNonEmpty("run manifest inventoryDigest", input.inventoryDigest);
  const lease = validateResourceLease(input.lease);
  if (lease.taskId !== input.taskId) throw new RunManifestError("run manifest taskId must match the lease taskId");
  const body = {
    schema: RUN_MANIFEST_SCHEMA,
    runId: input.runId,
    taskId: input.taskId,
    attempt: input.attempt,
    contract: { version: input.contract.version, digest: input.contract.digest },
    inventoryDigest: input.inventoryDigest,
    lease,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/** Returns a new manifest with the settled usage + outcome attached and the digest recomputed. */
export function completeRunManifest(manifest: RunManifest, usage: ResourceUsage, outcome: RunOutcome): RunManifest {
  const validated = validateRunManifest(manifest);
  if (validated.usage !== undefined) throw new RunManifestError("run manifest is already complete");
  const recorded = validateResourceUsage(usage);
  if (recorded.leaseId !== validated.lease.leaseId) throw new RunManifestError("run manifest usage leaseId must match the granted lease");
  const { digest: _digest, ...body } = validated;
  const settled = { ...body, usage: recorded, outcome };
  return deepFreeze({ ...settled, digest: digestValue(settled) });
}

/** Validates a persisted manifest, re-checking lease/usage and content digests. */
export function validateRunManifest(raw: unknown): RunManifest {
  if (!isRecord(raw)) throw new RunManifestError("run manifest must be an object");
  if (raw.schema !== RUN_MANIFEST_SCHEMA) throw new RunManifestError(`run manifest schema must be ${RUN_MANIFEST_SCHEMA}`);
  requireNonEmpty("run manifest runId", raw.runId);
  requireNonEmpty("run manifest taskId", raw.taskId);
  requireNonEmpty("run manifest inventoryDigest", raw.inventoryDigest);
  requireNonEmpty("run manifest digest", raw.digest);
  requireNonEmpty("run manifest createdAt", raw.createdAt);
  if (!Number.isSafeInteger(raw.attempt) || (raw.attempt as number) < 1) throw new RunManifestError("run manifest attempt must be an integer >= 1");
  if (!isRecord(raw.contract)) throw new RunManifestError("run manifest contract is required");
  requireNonEmpty("run manifest contract.version", raw.contract.version);
  requireNonEmpty("run manifest contract.digest", raw.contract.digest);
  const lease = validateResourceLease(raw.lease);
  if (lease.taskId !== raw.taskId) throw new RunManifestError("run manifest taskId must match the lease taskId");
  let usage: ResourceUsage | undefined;
  if (raw.usage !== undefined) {
    usage = validateResourceUsage(raw.usage);
    if (usage.leaseId !== lease.leaseId) throw new RunManifestError("run manifest usage leaseId must match the granted lease");
  }
  if (raw.outcome !== undefined && !["completed", "failed", "timeout", "cancelled"].includes(raw.outcome as string)) {
    throw new RunManifestError("run manifest outcome must be completed, failed, timeout, or cancelled");
  }
  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new RunManifestError("run manifest digest mismatch");
  return deepFreeze(raw as unknown as RunManifest);
}

/** Minimal JSON persistence: stable, human-auditable, one manifest per file. */
export function serializeRunManifest(manifest: RunManifest): string {
  return `${JSON.stringify(validateRunManifest(manifest), null, 2)}\n`;
}

export function parseRunManifest(text: string): RunManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RunManifestError("run manifest is not valid JSON");
  }
  return validateRunManifest(raw);
}
