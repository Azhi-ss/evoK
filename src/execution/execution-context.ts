/**
 * ExecutionContext: the injectable context for the TRUSTED Executor and
 * Evaluator. Physical home: `src/execution/`.
 *
 * Unlike the researcher-side minimal context, this binds everything a trusted
 * runner needs: contract version + digest, evaluation entry and data-access
 * policy, the host inventory digest and granted lease, the approved
 * workspace, and network/time policy. Data access is fail-closed by role:
 * only the Evaluator may be granted holdout access; an Executor asking for
 * holdout data is refused. Every context is content-addressed and records its
 * injection source for audit.
 *
 * Type-only coupled to the competition pack — no runtime import cycle.
 */
import { deepFreeze, digestValue } from "./security-boundary";
import type { CompetitionContract } from "../competition/competition-contract";
import type { ResourceLease } from "./resource-lease";
import { validateResourceLease } from "./resource-lease";

export const EXECUTION_CONTEXT_SCHEMA = "evok.execution-context/v1" as const;

export type ExecutionAudience = "executor" | "evaluator";
export type EvaluationDataAccess = "none" | "public" | "holdout";

export interface ExecutionContext {
  readonly schema: typeof EXECUTION_CONTEXT_SCHEMA;
  readonly audience: ExecutionAudience;
  /** Version + digest of the CompetitionContract this context binds. */
  readonly contract: { readonly version: string; readonly digest: string };
  /** Evaluation entry point + how much data this audience may touch. */
  readonly evaluation: {
    readonly entry: string;
    readonly dataAccess: EvaluationDataAccess;
  };
  /** Digest of the HostInventory snapshot the lease was granted against. */
  readonly inventoryDigest: string;
  readonly lease: ResourceLease;
  readonly workspace: {
    readonly root: string;
    readonly isolated: boolean;
    readonly readRoots: readonly string[];
  };
  readonly network: "none" | "restricted" | "open";
  readonly timeLimitMs?: number;
  /** Where this context was assembled (audit), e.g. "mission-controller". */
  readonly source: string;
  readonly digest: string;
}

export class ExecutionContextError extends Error {
  readonly kind = "execution-context" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContextError";
  }
}

export interface CreateExecutionContextInput {
  readonly audience: ExecutionAudience;
  readonly contract: CompetitionContract;
  readonly evaluation: { readonly entry: string; readonly dataAccess: EvaluationDataAccess };
  readonly lease: ResourceLease;
  readonly workspace: { readonly root: string; readonly isolated: boolean; readonly readRoots?: readonly string[] };
  readonly network: "none" | "restricted" | "open";
  readonly timeLimitMs?: number;
  readonly source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ExecutionContextError(`${label} is required`);
  return value;
}

function validateBody(body: Omit<ExecutionContext, "schema" | "digest">): void {
  if (body.audience !== "executor" && body.audience !== "evaluator") {
    throw new ExecutionContextError("execution context audience must be executor or evaluator");
  }
  requireNonEmpty("execution context contract.version", body.contract?.version);
  requireNonEmpty("execution context contract.digest", body.contract?.digest);
  if (!isRecord(body.evaluation)) throw new ExecutionContextError("execution context evaluation is required");
  requireNonEmpty("execution context evaluation.entry", body.evaluation.entry);
  if (!["none", "public", "holdout"].includes(body.evaluation.dataAccess)) {
    throw new ExecutionContextError("execution context evaluation.dataAccess must be none, public, or holdout");
  }
  // Fail closed: holdout data is evaluator-only. An executor never touches it.
  if (body.audience === "executor" && body.evaluation.dataAccess === "holdout") {
    throw new ExecutionContextError("an executor context must not grant holdout data access");
  }
  requireNonEmpty("execution context inventoryDigest", body.inventoryDigest);
  const lease = validateResourceLease(body.lease);
  if (lease.inventoryDigest !== body.inventoryDigest) {
    throw new ExecutionContextError("execution context inventoryDigest must match the lease inventoryDigest");
  }
  if (!isRecord(body.workspace)) throw new ExecutionContextError("execution context workspace is required");
  requireNonEmpty("execution context workspace.root", body.workspace.root);
  if (body.workspace.isolated !== true) throw new ExecutionContextError("execution context workspace must be isolated");
  if (!Array.isArray(body.workspace.readRoots) || body.workspace.readRoots.some((root) => typeof root !== "string" || root === "")) {
    throw new ExecutionContextError("execution context workspace.readRoots must be an array of non-empty strings");
  }
  if (!["none", "restricted", "open"].includes(body.network)) {
    throw new ExecutionContextError("execution context network must be none, restricted, or open");
  }
  if (body.timeLimitMs !== undefined && (!Number.isSafeInteger(body.timeLimitMs) || body.timeLimitMs < 1)) {
    throw new ExecutionContextError("execution context timeLimitMs must be an integer >= 1");
  }
  requireNonEmpty("execution context source", body.source);
}

/** Assembles a frozen, content-addressed context for a trusted runner. */
export function createExecutionContext(input: CreateExecutionContextInput): ExecutionContext {
  const lease = validateResourceLease(input.lease);
  const body = {
    audience: input.audience,
    contract: { version: input.contract.version, digest: input.contract.digest },
    evaluation: { entry: input.evaluation.entry, dataAccess: input.evaluation.dataAccess },
    inventoryDigest: lease.inventoryDigest,
    lease,
    workspace: {
      root: input.workspace.root,
      isolated: input.workspace.isolated,
      readRoots: [...(input.workspace.readRoots ?? [])],
    },
    network: input.network,
    ...(input.timeLimitMs !== undefined ? { timeLimitMs: input.timeLimitMs } : {}),
    source: input.source,
  };
  validateBody(body);
  return deepFreeze({ ...body, schema: EXECUTION_CONTEXT_SCHEMA, digest: digestValue({ schema: EXECUTION_CONTEXT_SCHEMA, ...body }) });
}

/** Validates a persisted context, re-checking the lease binding and digest. */
export function validateExecutionContext(raw: unknown): ExecutionContext {
  if (!isRecord(raw)) throw new ExecutionContextError("execution context must be an object");
  if (raw.schema !== EXECUTION_CONTEXT_SCHEMA) throw new ExecutionContextError(`execution context schema must be ${EXECUTION_CONTEXT_SCHEMA}`);
  requireNonEmpty("execution context digest", raw.digest);
  const { digest, ...body } = raw;
  validateBody(body as unknown as Omit<ExecutionContext, "schema" | "digest">);
  if (digestValue({ schema: EXECUTION_CONTEXT_SCHEMA, ...body }) !== digest) {
    throw new ExecutionContextError("execution context digest mismatch");
  }
  return deepFreeze(raw as unknown as ExecutionContext);
}
