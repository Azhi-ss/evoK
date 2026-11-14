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
import { validateResearcherContext, type ResearcherContext } from "./researcher-context";
import { validateRoleContext, type RoleTaskContext } from "./role-context";
import { deriveDelegatedMemorySlice, validateMemorySlice, type MemorySlice } from "../memory";

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
  /**
   * The delegating parent's OWN pinned slice (M1-T8). The child's Delegated
   * Memory Slice is generated from it, so a child can never be handed the
   * parent's slice or a wider snapshot. Required whenever the child's slice
   * carries Research Memory.
   */
  readonly parentMemorySlice?: MemorySlice;
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
  try {
    validateResearcherContext(candidate.context);
  } catch (error) {
    throw new SubagentAuthorityError(`delegation context must be a validated researcher-context assembly: ${error instanceof Error ? error.message : String(error)}`);
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

  let context: RoleTaskContext | undefined;
  if (candidate.roleContext !== undefined) {
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

  const parentSlice = optionalSlice(candidate.parentMemorySlice, "the parent's memory slice");
  const childSlice = optionalSlice(candidate.memorySlice, "delegated memory slice");
  if (parentSlice === undefined && childSlice === undefined) return;
  if (context === undefined) {
    throw new SubagentAuthorityError("a delegated memory slice requires the child's own bound role context");
  }
  if (parentSlice !== undefined) {
    if (parentSlice.runId === runId || parentSlice.targetAgentId === targetAgentId) {
      throw new SubagentAuthorityError("a delegated child must not be handed its parent's own memory slice");
    }
  }
  if (childSlice === undefined) return;
  if (childSlice.runId !== runId) {
    throw new SubagentAuthorityError("delegated memory slice belongs to another run than the delegated child");
  }
  if (childSlice.targetAgentId !== targetAgentId) {
    throw new SubagentAuthorityError("delegated memory slice belongs to another target agent than the delegated child");
  }
  if (context.audit.missionId !== undefined && childSlice.missionId !== context.audit.missionId) {
    throw new SubagentAuthorityError("delegated memory slice belongs to another Mission than the delegated child");
  }
  if (context.audit.taskId !== undefined && childSlice.taskId !== context.audit.taskId) {
    throw new SubagentAuthorityError("delegated memory slice belongs to another Task than the delegated child");
  }
  if (context.audit.memoryDigest !== undefined && context.audit.memoryDigest !== childSlice.digest) {
    throw new SubagentAuthorityError("the child role context was assembled with another memory slice than the delegated one");
  }
  // A research packet is only ever the parent's pinned one: a child slice that
  // carries Research Memory must name the parent slice it was derived from.
  if (childSlice.research !== undefined && parentSlice === undefined) {
    throw new SubagentAuthorityError("a child research memory slice must name the parent's pinned memory slice it was derived from");
  }
  if (parentSlice !== undefined && childSlice.research?.digest !== parentSlice.research?.digest) {
    throw new SubagentAuthorityError("delegated memory slice is not from the parent's pinned snapshot");
  }
}

function optionalSlice(raw: unknown, label: string): MemorySlice | undefined {
  if (raw === undefined) return undefined;
  try {
    return validateMemorySlice(raw);
  } catch (error) {
    throw new SubagentAuthorityError(`${label} is invalid: ${(error as Error).message}`);
  }
}

/**
 * A delegation that names the parent's pinned slice gets its child slice
 * generated here, so the child never inherits the parent's own slice and no
 * caller can substitute a wider snapshot. An explicit child slice is kept (the
 * guard verifies it is the same pinned snapshot).
 */
function withDelegatedMemory(delegation: SubagentDelegation): SubagentDelegation {
  const parent = delegation.parentMemorySlice;
  if (parent === undefined || delegation.memorySlice !== undefined) return delegation;
  const missionId = delegation.roleContext?.audit.missionId;
  const taskId = delegation.roleContext?.audit.taskId;
  if (missionId === undefined || taskId === undefined
    || delegation.runId === undefined || delegation.targetAgentId === undefined) {
    // Never drop memory silently: the child slice needs the child's own binding.
    throw new SubagentAuthorityError(
      "a delegated parent memory slice needs the child's own runId, targetAgentId, and a role context bound to its Mission and Task",
    );
  }
  try {
    return {
      ...delegation,
      memorySlice: deriveDelegatedMemorySlice({
        parent,
        missionId,
        taskId,
        runId: delegation.runId,
        targetAgentId: delegation.targetAgentId,
      }),
    };
  } catch (error) {
    throw new SubagentAuthorityError(`delegated memory slice could not be derived: ${(error as Error).message}`);
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
      const effective = withDelegatedMemory(delegation);
      assertDelegationPermitted(effective);
      return transport(effective);
    },
    fanOut(delegations: readonly SubagentDelegation[]): Promise<SubagentDelegationResult[]> {
      const effective = delegations.map(withDelegatedMemory);
      for (const delegation of effective) assertDelegationPermitted(delegation);
      return Promise.all(effective.map((delegation) => transport(delegation)));
    },
  };
}
