/**
 * Stage 3 / B4: `harness/execution.ts` DRIVES the one execution protocol. It
 * measures raw usage, collects artifact receipts and closes the receipt — one
 * place, no research decision (no score, promotion, admission, budget or
 * continue) added on top of the protocol.
 */
import { describe, expect, test } from "bun:test";
import { closeExecution, type ExecutionRequest } from "../execution/execution-protocol";
import { closeHarnessExecution } from "./execution";
import { createEnvironmentSnapshot, environmentRefsOf } from "./snapshot";

const environment = createEnvironmentSnapshot({
  backend: "pi-agent-runtime",
  workspace: "/tmp/evok/harness/run-1",
  runtime: "pi-coding-agent",
  model: "anthropic/claude-sonnet",
  tools: ["read", "grep"],
});

const request: ExecutionRequest = Object.freeze({
  executionId: "run-1",
  inputs: { inputDigest: "a".repeat(64) },
  environment: environmentRefsOf(environment),
  capabilities: { tools: ["read", "grep"] },
  limits: { toolTurns: 3 },
});

const measured = {
  tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 },
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

describe("the harness closes one execution (B2, B3, B4)", () => {
  test("measures the raw usage the backend reported and attributes it as declared", () => {
    const receipt = closeHarnessExecution(request, environment, {
      outcome: "succeeded",
      toolTurns: { spent: 2, limit: 3 },
      usage: { usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: measured.cost } },
      usageAttribution: "own",
    });
    expect(receipt.usage).toEqual({ ...measured, attribution: "own" });
    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.toolTurns).toEqual({ spent: 2, limit: 3 });
    expect(receipt.artifacts).toEqual([]);
    expect(receipt.environment).toEqual(request.environment);
  });

  test("adds measurement only: the protocol alone yields the same receipt", () => {
    const receipt = closeHarnessExecution(request, environment, {
      outcome: "failed",
      toolTurns: { spent: 0 },
      usage: { tokens: measured.tokens, cost: measured.cost },
      usageAttribution: "own",
      diagnostics: { status: "failed", error: "boom" },
      artifacts: [{ producer: "run-1", digest: "b".repeat(64) }],
    });
    expect(receipt).toEqual(
      closeExecution(request, {
        outcome: "failed",
        toolTurns: { spent: 0 },
        usage: { ...measured, attribution: "own" },
        diagnostics: { status: "failed", error: "boom" },
        artifacts: [{ producer: "run-1", digest: "b".repeat(64) }],
      }),
    );
  });

  test("an unconfirmed cancellation stays unknown — the harness never raises it", () => {
    expect(
      closeHarnessExecution(request, environment, { outcome: "unknown", toolTurns: { spent: 0 } }).outcome,
    ).toBe("unknown");
  });

  test("no measured usage means no usage field, never a zero", () => {
    const receipt = closeHarnessExecution(request, environment, { outcome: "unknown", toolTurns: { spent: 1 } });
    expect(receipt.usage).toBeUndefined();
    expect(receipt.artifacts).toEqual([]);
  });

  test("usage that is not measurable fails closed instead of reporting zero", () => {
    expect(() =>
      closeHarnessExecution(request, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 1 },
        usage: { nonsense: true },
        usageAttribution: "own",
      }),
    ).toThrow(/usage/);
  });

  test("attribution is the caller's decision, never the harness's default (B3)", () => {
    expect(() =>
      closeHarnessExecution(request, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 1 },
        usage: measured,
      }),
    ).toThrow(/attribution/);
    // A parent aggregate already carrying a child's number is not re-counted here.
    expect(
      closeHarnessExecution(request, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 1 },
        usage: measured,
        usageAttribution: "included-in-parent",
      }).usage?.attribution,
    ).toBe("included-in-parent");
  });

  test("an artifact belongs to the execution that produced it", () => {
    expect(() =>
      closeHarnessExecution(request, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 1 },
        artifacts: [{ producer: "another-run", digest: "c".repeat(64) }],
      }),
    ).toThrow(/producer/);
    expect(() =>
      closeHarnessExecution(request, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 1 },
        artifacts: [{ producer: "run-1", digest: "not-a-digest" }],
      }),
    ).toThrow(/digest/);
  });

  test("a request whose declared environment disagrees with the frozen one is refused", () => {
    expect(() =>
      closeHarnessExecution({ ...request, environment: { ...request.environment, workspace: "/tmp/elsewhere" } }, environment, {
        outcome: "succeeded",
        toolTurns: { spent: 0 },
      }),
    ).toThrow(/environment/);
  });
});
