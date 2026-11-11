/**
 * B3: the harness MEASURES raw usage. It never decides whose usage it is —
 * attribution and budget settlement stay in Mission — so the numbers below are
 * pinned against what the two backends already measure.
 */
import { describe, expect, test } from "bun:test";
import { addUsage, measureResponseUsage, measureUsage } from "./metering";

describe("raw usage measurement (B3)", () => {
  test("an SDK message reports its usage and cost", () => {
    const measured = measureUsage({
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
    });
    expect(measured).toEqual({
      tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    });
  });

  test("session stats report tokens, and a numeric cost is a total", () => {
    const tokens = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 };
    expect(measureUsage({ tokens, cost: 0.25 })).toEqual({
      tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
    const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 };
    expect(measureUsage({ tokens, cost })).toEqual({ tokens, cost });
  });

  test("a delegated child reports input/output/cost and no cache", () => {
    expect(measureUsage({ input: 7, output: 3, cost: 0.5 })).toEqual({
      tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    });
  });

  test("anything unmeasurable is undefined, never a zero", () => {
    for (const value of [undefined, null, 0, "usage", {}, { tokens: {} }, { tokens: { input: 1 } }, { usage: { input: 1 } }])
      expect(measureUsage(value)).toBeUndefined();
    expect(measureUsage({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: Number.NaN }, cost: 0 })).toBeUndefined();
  });

  test("adding usage accumulates one execution, and starts from nothing", () => {
    const one = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };
    const two = { tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 }, cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8 } };
    expect(addUsage(undefined, one)).toEqual(one);
    expect(addUsage(one, two)).toEqual({
      tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
      cost: { input: 3, output: 3, cacheRead: 3, cacheWrite: 3, total: 12 },
    });
    // Measurement is a pure fold: the same inputs twice are the same number.
    expect(addUsage(one, two)).toEqual(addUsage(one, two));
  });

  test("a streamed provider response reports the highest counts it saw in one request", () => {
    const body = [
      'data: {"usage":{"input_tokens":5,"output_tokens":1}}',
      'data: {"message":{"usage":{"input_tokens":5,"output_tokens":2}}}',
      'data: {"response":{"usage":{"prompt_tokens":6,"completion_tokens":3}}}',
      "data: [DONE]",
      '{"type":"not-usage"}',
    ].join("\n");
    expect(measureResponseUsage(body)).toEqual({ input: 6, output: 3 });
    expect(measureResponseUsage("")).toEqual({ input: 0, output: 0 });
    expect(measureResponseUsage("data: {not json}\n")).toEqual({ input: 0, output: 0 });
  });
});
