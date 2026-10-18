import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
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
    const review = schemaFor("reviewer-gate") as { properties: { accept: { type: string }; reason: { type: string } } };
    expect(review.properties.accept.type).toBe("boolean");
    expect(review.properties.reason.type).toBe("string");
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
});
