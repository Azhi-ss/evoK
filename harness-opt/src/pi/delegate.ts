import { randomBytes } from "node:crypto";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { LOCAL_MODEL_ID } from "../fixed-model";

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface DelegationValue {
  readonly value: unknown;
  readonly tokens: number;
  readonly agent: string;
}

export interface RoleDelegate {
  (input: { readonly agent: string; readonly task: string; readonly schema: Record<string, unknown> }): Promise<DelegationValue>;
}

const GAP_SCHEMA = {
  type: "object",
  required: ["gaps"],
  properties: { gaps: { type: "array" } },
};
const PATCH_SCHEMA = {
  type: "object",
  required: ["part", "motivation", "expectedFailureClass", "summary"],
};
const REVIEW_SCHEMA = {
  type: "object",
  required: ["accept", "reason"],
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
 */
export function eventBusDelegate(events: EventBus, options?: { readonly cwd?: string; readonly timeoutMs?: number }): RoleDelegate {
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
      timeoutMs: options?.timeoutMs ?? 15000,
      result: { kind: "structured", schema: input.schema },
    };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error(`delegation to ${input.agent} timed out`));
    }, request.timeoutMs);
    const off = events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
      const response = data as SubagentDelegationResponse;
      if (response.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      if (response.status !== "completed" || response.result?.kind !== "structured") {
        reject(new Error(response.error ?? `delegation to ${input.agent} ${response.status}`));
        return;
      }
      const usage = "usage" in response ? response.usage : undefined;
      const tokens = usage ? usage.input + usage.output : 0;
      resolve({ value: response.result.value, tokens, agent: input.agent });
    });
    events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  });
}

export function createMemoryBus(): EventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
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
    return { accept: true, reason: "keep-better" };
  }
  return {};
}
