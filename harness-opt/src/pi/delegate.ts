import { randomBytes } from "node:crypto";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from "pi-subagents/delegation";
import { LOCAL_MODEL_ID } from "../fixed-model";
import { ATTRIBUTION_LABELS, HARNESS_PARTS } from "../types";
import { EMPTY_USAGE, usageParts, usageTokens, type UsageParts } from "./usage";

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface DelegationValue {
  readonly value: unknown;
  readonly tokens: number;
  readonly usage?: UsageParts;
  readonly agent: string;
}

export interface RoleDelegate {
  (input: { readonly agent: string; readonly task: string; readonly schema: Record<string, unknown> }): Promise<DelegationValue>;
}

/** Covers a real local model. The 15s default timed out gap-finder past 15s. */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000;

/** Window after cancel for a terminal usage snapshot to arrive. */
export const DEFAULT_CANCEL_GRACE_MS = 2_000;

export class DelegationError extends Error {
  readonly tokens: number;
  readonly agent: string;
  readonly responded: boolean;

  constructor(message: string, fields: { readonly tokens: number; readonly agent: string; readonly responded: boolean }) {
    super(message);
    this.name = "DelegationError";
    this.tokens = fields.tokens;
    this.agent = fields.agent;
    this.responded = fields.responded;
  }
}

export interface DelegateOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
  readonly onSettled?: (info: { readonly agent: string; readonly responded: boolean; readonly tokens: number }) => void;
}

const GAP_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "failureClass", "summary", "traceIds"],
  properties: {
    id: { type: "string" },
    failureClass: { type: "string", enum: [...ATTRIBUTION_LABELS] },
    summary: { type: "string" },
    traceIds: { type: "array", items: { type: "string" } },
  },
};

const GAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gaps"],
  properties: {
    gaps: { type: "array", items: GAP_ITEM_SCHEMA },
  },
};

const PATCH_SCHEMA = {
  type: "object",
  required: ["part", "motivation", "expectedFailureClass", "summary"],
  properties: {
    part: { type: "string", enum: [...HARNESS_PARTS] },
    motivation: { type: "string" },
    expectedFailureClass: { type: "string", enum: [...ATTRIBUTION_LABELS] },
    summary: { type: "string" },
    changes: { type: "object" },
    search: { type: "object" },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string" },
  },
};

export function schemaFor(agent: string): Record<string, unknown> {
  if (agent === "gap-finder") return GAP_SCHEMA;
  if (agent === "innovator") return PATCH_SCHEMA;
  if (agent === "reviewer-gate") return REVIEW_SCHEMA;
  return { type: "object" };
}

/**
 * Structured delegation on pi-subagents' event bus.
 * Emits `prompt-template:subagent:request` and waits for the correlated response.
 * On timeout it emits cancel with only the attempt identity, then keeps the
 * tokens already observed on update or on a late terminal response.
 */
export function eventBusDelegate(events: EventBus, options?: DelegateOptions): RoleDelegate {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
  const graceMs = options?.graceMs ?? DEFAULT_CANCEL_GRACE_MS;
  return (input) => new Promise((resolve, reject) => {
    const requestId = randomBytes(8).toString("hex");
    const ownerRunId = "harness-opt";
    const nodeId = `${input.agent}-${requestId}`;
    const request: SubagentDelegationRequest = {
      requestId,
      ownerRunId,
      nodeId,
      agent: input.agent,
      task: input.task,
      context: "fresh",
      cwd: options?.cwd ?? process.cwd(),
      model: LOCAL_MODEL_ID,
      timeoutMs,
      result: { kind: "structured", schema: input.schema },
      ...(input.agent === "reviewer-gate" ? { intercomBridge: { mode: "off" as const } } : {}),
    };
    let settled = false;
    let observed = 0;
    let observedUsage: UsageParts = EMPTY_USAGE;
    let responded = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const note = (parts: UsageParts) => {
      const tokens = usageTokens(parts);
      if (tokens > observed) {
        observed = tokens;
        observedUsage = parts;
      }
    };
    const finish = (error?: DelegationError, value?: DelegationValue) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      offResponse();
      offUpdate();
      options?.onSettled?.({ agent: input.agent, responded, tokens: observed });
      if (error) reject(error);
      else resolve(value as DelegationValue);
    };
    const offUpdate = events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
      const update = data as SubagentDelegationUpdate;
      if (update.requestId !== requestId) return;
      const parts = usageParts(update.usage);
      const fromUsage = usageTokens(parts);
      const fromTokens = typeof update.tokens === "number" && Number.isFinite(update.tokens) ? update.tokens : 0;
      // Update `tokens` is input+output only. Prefer the usage snapshot when it is present. The total counts input, output, and cacheRead.
      if (update.usage && fromUsage >= fromTokens) note(parts);
      else if (fromTokens > observed) note({ input: 0, output: fromTokens, cacheRead: 0, cacheWrite: 0 });
    });
    const offResponse = events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
      const response = data as SubagentDelegationResponse;
      if (response.requestId !== requestId) return;
      responded = true;
      const usage = "usage" in response ? response.usage : undefined;
      note(usageParts(usage));
      if (response.status !== "completed" || response.result?.kind !== "structured") {
        const detail = response.error ?? `delegation to ${input.agent} ${response.status}`;
        finish(new DelegationError(detail, { tokens: observed, agent: input.agent, responded }));
        return;
      }
      finish(undefined, { value: response.result.value, tokens: observed, usage: observedUsage, agent: input.agent });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
      graceTimer = setTimeout(() => {
        finish(new DelegationError(`delegation to ${input.agent} timed out`, {
          tokens: observed,
          agent: input.agent,
          responded,
        }));
      }, graceMs);
    }, timeoutMs);
    events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  });
}

export function createMemoryBus(): EventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

/**
 * In-process stand-in for the pi-subagents bridge. It speaks the same events.
 * The loop still parses the structured value; it does not invent a side channel.
 */
export function attachSampleBridge(events: EventBus): () => void {
  return events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
    const request = data as SubagentDelegationRequest;
    const value = sampleValue(request.agent);
    const response: SubagentDelegationResponse = {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      agent: request.agent,
      model: LOCAL_MODEL_ID,
      result: { kind: "structured", value },
      usage: {
        input: 30,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
        toolCalls: 1,
        durationMs: 1,
      },
    };
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response);
  });
}

function sampleValue(agent: string): unknown {
  if (agent === "gap-finder") {
    return {
      gaps: [{
        id: "g1",
        failureClass: "tool-misuse",
        summary: "the check command exits 1 before the answer file is written",
        traceIds: ["dev-1"],
      }],
    };
  }
  if (agent === "innovator") {
    return {
      part: "agent-loop",
      motivation: "stop the failing check from ending the turn before the write",
      expectedFailureClass: "tool-misuse",
      summary: "require a write after the failed check",
      changes: { maxSteps: 4, requireWrite: true },
    };
  }
  if (agent === "reviewer-gate") {
    return { reason: "keep-better" };
  }
  return {};
}
