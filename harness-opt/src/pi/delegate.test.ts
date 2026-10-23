import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import { ATTRIBUTION_LABELS, HARNESS_PARTS } from "../types";
import {
  attachSampleBridge,
  createMemoryBus,
  DEFAULT_DELEGATION_TIMEOUT_MS,
  eventBusDelegate,
  schemaFor,
} from "./delegate";

describe("delegation schema and timeout", () => {
  test("role schemas name field types and the attribution enum", () => {
    const gap = schemaFor("gap-finder") as {
      properties: { gaps: { items: { properties: { failureClass: { enum: string[] } } } } };
    };
    expect(gap.properties.gaps.items.properties.failureClass.enum).toEqual([...ATTRIBUTION_LABELS]);
    const patch = schemaFor("innovator") as {
      properties: { part: { enum: string[] }; expectedFailureClass: { enum: string[] } };
    };
    expect(patch.properties.part.enum).toEqual([...HARNESS_PARTS]);
    expect(patch.properties.expectedFailureClass.enum).toEqual([...ATTRIBUTION_LABELS]);
    const review = schemaFor("reviewer-gate") as { required: string[]; properties: { reason: { type: string }; accept?: unknown; verdict?: unknown } };
    expect(review.required).toEqual(["reason"]);
    expect(review.properties.reason.type).toBe("string");
    expect(review.properties.accept).toBeUndefined();
    expect(review.properties.verdict).toBeUndefined();
  });

  test("reviewer-gate delegation turns the intercom bridge off", async () => {
    const events = createMemoryBus();
    const seen: { agent?: string; intercomBridge?: { mode?: string } }[] = [];
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as { agent: string; intercomBridge?: { mode?: string }; requestId: string; ownerRunId: string; nodeId: string };
      seen.push({ agent: request.agent, intercomBridge: request.intercomBridge });
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        agent: request.agent,
        result: { kind: "structured", value: { accept: true, reason: "kept" } },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 },
      });
    });
    const delegate = eventBusDelegate(events);
    await delegate({ agent: "reviewer-gate", task: "review", schema: schemaFor("reviewer-gate") });
    await delegate({ agent: "gap-finder", task: "gaps", schema: schemaFor("gap-finder") });
    expect(seen[0]?.intercomBridge).toEqual({ mode: "off" });
    expect(seen[1]?.intercomBridge).toBeUndefined();
  });

  test("the default timeout is at least 300s and a timeout cancels with the tokens already seen", async () => {
    const answered = createMemoryBus();
    let seenTimeout = 0;
    answered.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      seenTimeout = (data as { timeoutMs?: number }).timeoutMs ?? 0;
    });
    attachSampleBridge(answered);
    const delegate = eventBusDelegate(answered);
    const value = await delegate({ agent: "gap-finder", task: "labels", schema: schemaFor("gap-finder") });
    expect(seenTimeout).toBe(DEFAULT_DELEGATION_TIMEOUT_MS);
    expect(seenTimeout).toBeGreaterThanOrEqual(300_000);
    expect(value.tokens).toBe(50);

    const quiet = createMemoryBus();
    const cancels: Record<string, unknown>[] = [];
    quiet.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => cancels.push(data as Record<string, unknown>));
    quiet.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as { requestId: string; ownerRunId: string; nodeId: string };
      quiet.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        usage: { input: 2000, output: 251, cacheRead: 0, cacheWrite: 0, turns: 1 },
      });
    });
    const failing = eventBusDelegate(quiet, { timeoutMs: 20, graceMs: 0 });
    await expect(failing({ agent: "gap-finder", task: "slow", schema: schemaFor("gap-finder") })).rejects.toMatchObject({
      tokens: 2251,
      responded: false,
    });
    expect(cancels).toHaveLength(1);
    expect(Object.keys(cancels[0] as object).sort()).toEqual(["nodeId", "ownerRunId", "requestId"]);
  });

  test("token totals add input, output, and cacheRead", async () => {
    const events = createMemoryBus();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as { requestId: string; ownerRunId: string; nodeId: string; agent: string };
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        agent: request.agent,
        result: { kind: "structured", value: { accept: true, reason: "kept" } },
        usage: { input: 59004, output: 51481, cacheRead: 326912, cacheWrite: 8, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 },
      });
    });
    const value = await eventBusDelegate(events)({ agent: "reviewer-gate", task: "review", schema: schemaFor("reviewer-gate") });
    expect(value.tokens).toBe(437397);
    expect(value.usage).toEqual({ input: 59004, output: 51481, cacheRead: 326912, cacheWrite: 8 });
  });
});
