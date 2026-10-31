/**
 * pi-subagents fan-out adapter boundary. Physical home: `src/execution/`.
 *
 * pi-subagents is an OPTIONAL fan-out/delegation adapter: the Mission
 * Controller may use it to run short-lived Researcher/Critic/Reviewer agents
 * in parallel, but a delegated agent can never hold Mission authority,
 * allocate resources, evaluate, promote, or submit. Those decisions stay with
 * the Mission Director, the Execution Broker (leases), the trusted Evaluator,
 * and the evidence gates — never with the adapter.
 *
 * This module defines the guard, not the transport: `transport` is injected
 * so the adapter works with the pi-subagents event bus (harness-opt's
 * delegate) or any equivalent, and pi-subagents stays an optional dependency
 * that the core packs do not import.
 */
import { RESEARCHER_CONTEXT_SCHEMA, type ResearcherContext } from "./researcher-context";
import { validateRoleContext, type RoleTaskContext } from "./role-context";
import { validateMemorySlice, type MemorySlice } from "./memory-slice";

/** The only capabilities a delegated subagent may exercise. */
export const DELEGATABLE_CAPABILITIES = ["research", "critique", "review"] as const;
export type DelegatableCapability = (typeof DELEGATABLE_CAPABILITIES)[number];

/** Authorities the adapter must never delegate, even if asked. */
export const FORBIDDEN_DELEGATION_CAPABILITIES = [
  "mission-authority",
  "resource-allocation",
  "evaluation",
  "promotion",
  "admission",
  "submission",
] as const;
export type ForbiddenDelegationCapability = (typeof FORBIDDEN_DELEGATION_CAPABILITIES)[number];

export class SubagentAuthorityError extends Error {
  readonly kind = "subagent-authority" as const;
  constructor(message: string) {
    super(message);
    this.name = "SubagentAuthorityError";
  }
}

export interface SubagentDelegation {
  readonly agent: string;
  readonly capability: string;
  readonly task: string;
  /** Legacy minimal researcher context (always required, still unsanitized-input-proof). */
  readonly context: ResearcherContext;
  /**
   * Optional broker-assembled context for the CHILD's own Run. It is passed
   * explicitly; the child never inherits the parent's prompt or transcript.
   */
  readonly roleContext?: RoleTaskContext;
  /** Optional memory slice handed to the child; never inherited implicitly. */
  readonly memorySlice?: MemorySlice;
  /** The child's own identity; it must not reuse the parent's binding. */
  readonly targetAgentId?: string;
  readonly runId?: string;
  /** Parent binding, checked only to reject identity reuse by the child. */
  readonly parentBinding?: { readonly targetAgentId?: string; readonly runId?: string };
  /** Delegated agents always start fresh; `false` fails closed. */
  readonly freshSession?: boolean;
}

export interface SubagentDelegationResult {
  readonly agent: string;
  readonly value: unknown;
}

export type SubagentTransport = (delegation: SubagentDelegation) => Promise<SubagentDelegationResult>;

/**
 * Fail-closed capability check. Rejects any delegation that asks for a
 * forbidden authority or an undeclared capability, and any delegation whose
 * context is not a researcher-context assembly. Pure — usable standalone.
 */
export function assertDelegationPermitted(delegation: unknown): asserts delegation is SubagentDelegation {
  if (delegation === null || typeof delegation !== "object" || Array.isArray(delegation)) {
    throw new SubagentAuthorityError("delegation must be an object");
  }
  const candidate = delegation as Record<string, unknown>;
  if (typeof candidate.capability === "string"
    && (FORBIDDEN_DELEGATION_CAPABILITIES as readonly string[]).includes(candidate.capability)) {
    throw new SubagentAuthorityError(`delegated agents cannot hold ${candidate.capability}: that authority stays with the Mission/evidence/broker`);
  }
  if (typeof candidate.capability !== "string" || !(DELEGATABLE_CAPABILITIES as readonly string[]).includes(candidate.capability)) {
    throw new SubagentAuthorityError(`delegation capability must be one of ${DELEGATABLE_CAPABILITIES.join(", ")}`);
  }
  if (typeof candidate.agent !== "string" || candidate.agent.trim() === "") {
    throw new SubagentAuthorityError("delegation agent is required");
  }
  if (typeof candidate.task !== "string" || candidate.task.trim() === "") {
    throw new SubagentAuthorityError("delegation task is required");
  }
  const context = candidate.context;
  if (context === null || typeof context !== "object" || Array.isArray(context)
    || (context as Record<string, unknown>).schema !== RESEARCHER_CONTEXT_SCHEMA) {
    throw new SubagentAuthorityError("delegation context must be a researcher-context assembly (minimal context, no rules/credentials/budget)");
  }
  assertFreshChildIdentity(candidate);
}

/**
 * A delegated agent is its own Run: fresh session, own target agent and run
 * id, and a role context/memory slice that agree with that identity. Reusing
 * the parent's binding, or inheriting its prompt/transcript, is refused.
 */
function assertFreshChildIdentity(candidate: Record<string, unknown>): void {
  if (candidate.freshSession === false) {
    throw new SubagentAuthorityError("a delegated agent always starts a fresh session; it never inherits the parent prompt or transcript");
  }
  const targetAgentId = candidate.targetAgentId;
  const runId = candidate.runId;
  if (targetAgentId !== undefined && (typeof targetAgentId !== "string" || targetAgentId.trim() === "")) {
    throw new SubagentAuthorityError("delegation targetAgentId must be a non-empty string when present");
  }
  if (runId !== undefined && (typeof runId !== "string" || runId.trim() === "")) {
    throw new SubagentAuthorityError("delegation runId must be a non-empty string when present");
  }
  const parent = candidate.parentBinding;
  if (parent !== undefined) {
    if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
      throw new SubagentAuthorityError("delegation parentBinding must be an object");
    }
    const binding = parent as Record<string, unknown>;
    if (binding.runId !== undefined && binding.runId === runId) {
      throw new SubagentAuthorityError("a delegated agent must not reuse the parent Run id");
    }
    if (binding.targetAgentId !== undefined && binding.targetAgentId === targetAgentId) {
      throw new SubagentAuthorityError("a delegated agent must not reuse the parent target agent id");
    }
  }

  if (candidate.roleContext !== undefined) {
    let context: RoleTaskContext;
    try {
      context = validateRoleContext(candidate.roleContext);
    } catch (error) {
      throw new SubagentAuthorityError(`delegation role context is invalid: ${(error as Error).message}`);
    }
    if (typeof targetAgentId !== "string" || typeof runId !== "string") {
      throw new SubagentAuthorityError("a delegated role context requires the child's own targetAgentId and runId");
    }
    if (context.audit.targetAgentId !== targetAgentId) {
      throw new SubagentAuthorityError("delegation role context targets another agent than the delegated child");
    }
    if (context.audit.runId !== runId) {
      throw new SubagentAuthorityError("delegation role context is bound to another run than the delegated child");
    }
  }

  if (candidate.memorySlice !== undefined) {
    if (candidate.roleContext === undefined) {
      throw new SubagentAuthorityError("a delegated memory slice requires a bound role context");
    }
    let slice: MemorySlice;
    try {
      slice = validateMemorySlice(candidate.memorySlice);
    } catch (error) {
      throw new SubagentAuthorityError(`delegated memory slice is invalid: ${(error as Error).message}`);
    }
    if (slice.runId !== runId) {
      throw new SubagentAuthorityError("delegated memory slice belongs to another run than the delegated child");
    }
  }
}

/**
 * Wraps a transport (e.g. the pi-subagents event bus) with the authority
 * guard. The guard runs before the transport, so a forbidden delegation is
 * rejected without ever reaching pi-subagents.
 */
export function createPiSubagentsAdapter(transport: SubagentTransport) {
  return {
    async delegate(delegation: SubagentDelegation): Promise<SubagentDelegationResult> {
      assertDelegationPermitted(delegation);
      return transport(delegation);
    },
    fanOut(delegations: readonly SubagentDelegation[]): Promise<SubagentDelegationResult[]> {
      for (const delegation of delegations) assertDelegationPermitted(delegation);
      return Promise.all(delegations.map((delegation) => transport(delegation)));
    },
  };
}
