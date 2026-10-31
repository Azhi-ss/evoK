/**
 * ResourceLease and ResourceUsage: the Execution Broker's grant/record seam.
 * Physical home: `src/execution/`.
 *
 * A lease is what a Task actually received — CPU cores, memory bytes, a
 * deadline, and structured GPU devices selected from a probed HostInventory.
 * A lease never contains a bare scheduler label like `cuda:0`: GPUs are the
 * inventory's GpuDevice objects, so a Run manifest records which physical
 * device ran the work. Capability mismatches (asking for more than the host
 * has, or for an unknown GPU) fail closed with ResourceCapabilityError.
 *
 * This module only grants and records; it does not authorize, evaluate,
 * promote, or submit.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import type { GpuDevice, HostInventory } from "./host-inventory";
import { validateHostInventory } from "./host-inventory";

export const RESOURCE_LEASE_SCHEMA = "evok.resource-lease/v1" as const;
export const RESOURCE_USAGE_SCHEMA = "evok.resource-usage/v1" as const;

export type ResourceCapabilityMismatch =
  | "insufficient-cpus"
  | "insufficient-memory"
  | "insufficient-gpus"
  | "insufficient-storage"
  | "gpu-requirement-mismatch"
  | "unknown-gpu";

export class ResourceCapabilityError extends Error {
  readonly kind = "resource-capability" as const;
  constructor(readonly mismatch: ResourceCapabilityMismatch, message: string) {
    super(message);
    this.name = "ResourceCapabilityError";
  }
}

/** A granted GPU: the structured device from the inventory, not a label. */
export interface GpuLease {
  readonly device: GpuDevice;
}

export interface ResourceRequest {
  /** Logical CPU cores; defaults to 1. */
  readonly cpus?: number;
  readonly memoryBytes?: number;
  /** Count of GPUs, or explicit device selectors (uuid or index). */
  readonly gpus?: number | readonly (string | number)[];
  /** Wall-clock limit; becomes the lease deadline. */
  readonly timeLimitMs?: number;
}

export interface ResourceLease {
  readonly schema: typeof RESOURCE_LEASE_SCHEMA;
  readonly leaseId: string;
  readonly taskId: string;
  readonly grantedAt: string;
  readonly deadlineAt?: string;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly gpus: readonly GpuLease[];
  /** Digest of the inventory the lease was granted against. */
  readonly inventoryDigest: string;
  readonly digest: string;
}

export type ResourceExitReason = "completed" | "timeout" | "oom" | "error" | "cancelled";
export const RESOURCE_EXIT_REASONS: readonly ResourceExitReason[] = ["completed", "timeout", "oom", "error", "cancelled"];

export interface ResourceUsage {
  readonly schema: typeof RESOURCE_USAGE_SCHEMA;
  readonly leaseId: string;
  readonly wallTimeMs: number;
  readonly cpuTimeMs?: number;
  readonly peakMemoryBytes?: number;
  readonly gpu?: {
    readonly peakMemoryBytes?: number;
    readonly utilizationPercent?: number;
  };
  readonly exitReason: ResourceExitReason;
  readonly detail?: string;
}

export interface GrantLeaseOptions {
  readonly taskId: string;
  readonly leaseId?: string;
  readonly now?: () => Date;
  /** Inventory already validated; re-validated here for untrusted callers. */
  readonly inventory: HostInventory;
  readonly request: ResourceRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be an integer >= 1`);
}

function selectGpus(inventory: HostInventory, request: ResourceRequest["gpus"]): GpuDevice[] {
  if (request === undefined) return [];
  const available = inventory.gpus;
  if (typeof request === "number") {
    positiveInteger("resource request gpus", request);
    if (request > available.length) {
      throw new ResourceCapabilityError("insufficient-gpus", `requested ${request} gpus but the host inventory lists ${available.length}`);
    }
    return available.slice(0, request);
  }
  const selected = request.map((selector) => {
    const device = typeof selector === "number"
      ? available.find((gpu) => gpu.index === selector)
      : available.find((gpu) => gpu.uuid === selector);
    if (!device) {
      throw new ResourceCapabilityError("unknown-gpu", `requested gpu ${String(selector)} is not in the host inventory`);
    }
    return device;
  });
  const seen = new Set<string>();
  for (const device of selected) {
    const key = device.uuid ?? `index:${device.index}`;
    if (seen.has(key)) {
      throw new ResourceCapabilityError("unknown-gpu", `gpu ${key} was selected more than once`);
    }
    seen.add(key);
  }
  return selected;
}

/**
 * Grants a lease against a probed inventory. Asking for more than the host
 * has fails closed with a capability mismatch; the broker never over-promises.
 */
export function grantResourceLease(options: GrantLeaseOptions): ResourceLease {
  const inventory = validateHostInventory(options.inventory);
  const { request } = options;
  if (typeof options.taskId !== "string" || options.taskId.trim() === "") {
    throw new ResourceCapabilityError("insufficient-cpus", "taskId is required");
  }
  const cpus = request.cpus ?? 1;
  positiveInteger("resource request cpus", cpus);
  if (cpus > inventory.cpu.cores) {
    throw new ResourceCapabilityError("insufficient-cpus", `requested ${cpus} cpus but the host inventory lists ${inventory.cpu.cores}`);
  }
  const memoryBytes = request.memoryBytes ?? 0;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0) throw new RangeError("resource request memoryBytes must be an integer >= 0");
  if (memoryBytes > inventory.memory.totalBytes) {
    throw new ResourceCapabilityError("insufficient-memory", `requested ${memoryBytes} bytes but the host inventory lists ${inventory.memory.totalBytes}`);
  }
  if (request.timeLimitMs !== undefined) positiveInteger("resource request timeLimitMs", request.timeLimitMs);
  const gpus = selectGpus(inventory, request.gpus).map((device) => ({ device }));
  const now = options.now?.() ?? new Date();
  const body = {
    schema: RESOURCE_LEASE_SCHEMA,
    leaseId: options.leaseId ?? `lease-${digestValue([options.taskId, now.toISOString(), cpus, memoryBytes, gpus]).slice(0, 16)}`,
    taskId: options.taskId,
    grantedAt: now.toISOString(),
    ...(request.timeLimitMs !== undefined ? { deadlineAt: new Date(now.getTime() + request.timeLimitMs).toISOString() } : {}),
    cpus,
    memoryBytes,
    gpus,
    inventoryDigest: inventory.digest,
  };
  return deepFreeze({ ...body, digest: digestValue(body) });
}

/** Validates a persisted lease, including its content digest. */
export function validateResourceLease(raw: unknown): ResourceLease {
  if (!isRecord(raw)) throw new ResourceCapabilityError("insufficient-cpus", "resource lease must be an object");
  if (raw.schema !== RESOURCE_LEASE_SCHEMA) throw new ResourceCapabilityError("insufficient-cpus", `resource lease schema must be ${RESOURCE_LEASE_SCHEMA}`);
  for (const key of ["leaseId", "taskId", "grantedAt", "inventoryDigest", "digest"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string) === "") throw new ResourceCapabilityError("insufficient-cpus", `resource lease ${key} is required`);
  }
  positiveInteger("resource lease cpus", raw.cpus as number);
  if (!Number.isSafeInteger(raw.memoryBytes) || (raw.memoryBytes as number) < 0) {
    throw new ResourceCapabilityError("insufficient-memory", "resource lease memoryBytes must be an integer >= 0");
  }
  if (raw.deadlineAt !== undefined && typeof raw.deadlineAt !== "string") {
    throw new ResourceCapabilityError("insufficient-cpus", "resource lease deadlineAt must be a string");
  }
  if (!Array.isArray(raw.gpus)) throw new ResourceCapabilityError("insufficient-gpus", "resource lease gpus must be an array");
  for (const gpu of raw.gpus) {
    if (!isRecord(gpu) || !isRecord(gpu.device) || typeof gpu.device.index !== "number" || typeof gpu.device.name !== "string") {
      throw new ResourceCapabilityError("unknown-gpu", "resource lease gpus must contain structured devices (index + name), not labels");
    }
  }
  const { digest, ...body } = raw;
  if (digestValue(body) !== digest) throw new ResourceCapabilityError("insufficient-cpus", "resource lease digest mismatch");
  return deepFreeze(raw as unknown as ResourceLease);
}

/** Records real usage for a lease. The leaseId must match the granted lease. */
export function recordResourceUsage(lease: ResourceLease, usage: Omit<ResourceUsage, "schema" | "leaseId">): ResourceUsage {
  const validated = validateResourceLease(lease);
  return validateResourceUsage({ schema: RESOURCE_USAGE_SCHEMA, leaseId: validated.leaseId, ...usage });
}

/** Validates a usage record's shape and exit reason. */
export function validateResourceUsage(raw: unknown): ResourceUsage {
  if (!isRecord(raw)) throw new TypeError("resource usage must be an object");
  if (raw.schema !== RESOURCE_USAGE_SCHEMA) throw new TypeError(`resource usage schema must be ${RESOURCE_USAGE_SCHEMA}`);
  if (typeof raw.leaseId !== "string" || raw.leaseId === "") throw new TypeError("resource usage leaseId is required");
  if (!Number.isSafeInteger(raw.wallTimeMs) || (raw.wallTimeMs as number) < 0) throw new TypeError("resource usage wallTimeMs must be an integer >= 0");
  for (const key of ["cpuTimeMs", "peakMemoryBytes"] as const) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) {
      throw new TypeError(`resource usage ${key} must be an integer >= 0`);
    }
  }
  if (raw.gpu !== undefined) {
    if (!isRecord(raw.gpu)) throw new TypeError("resource usage gpu must be an object");
    if (raw.gpu.utilizationPercent !== undefined) {
      const percent = raw.gpu.utilizationPercent;
      if (typeof percent !== "number" || percent < 0 || percent > 100) throw new TypeError("resource usage gpu.utilizationPercent must be within [0, 100]");
    }
    if (raw.gpu.peakMemoryBytes !== undefined && (!Number.isSafeInteger(raw.gpu.peakMemoryBytes) || (raw.gpu.peakMemoryBytes as number) < 0)) {
      throw new TypeError("resource usage gpu.peakMemoryBytes must be an integer >= 0");
    }
  }
  if (!RESOURCE_EXIT_REASONS.includes(raw.exitReason as ResourceExitReason)) {
    throw new TypeError(`resource usage exitReason must be one of ${RESOURCE_EXIT_REASONS.join(", ")}`);
  }
  return deepFreeze(raw as unknown as ResourceUsage);
}
