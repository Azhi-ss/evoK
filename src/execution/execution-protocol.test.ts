/**
 * The one execution protocol (PRD §3 B4, §4 Stage 2; #255).
 *
 * These are the rules BOTH backends obey. A rule that lives only in one backend
 * is a second execution semantics, which is exactly what this stage removes.
 */
import { expect, test } from "bun:test";
import {
  aggregateUsage,
  cancellationOutcome,
  closeExecution,
  createToolTurnGate,
  type ExecutionReceipt,
  type ExecutionRequest,
  type ExecutionUsage,
} from "./execution-protocol";
import { createToolTurnGate as toolGateFromChildTools } from "./pi-child-tools";
import { ChildRecordSecretError } from "./pi-child-records";

const usage = (total: number, attribution: ExecutionUsage["attribution"] = "own"): ExecutionUsage => ({
  tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  attribution,
});

const receipt = (overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
  executionId: "exec-parent",
  inputs: { inputDigest: "input-digest" },
  environment: { backend: "pi-agent-runtime", workspace: "/workspace" },
  capabilities: { tools: [] },
  limits: {},
  outcome: "succeeded",
  toolTurns: { spent: 0 },
  artifacts: [],
  ...overrides,
});

test("an unconfirmed cancellation is unknown; only a confirmed one is cancelled", () => {
  expect(cancellationOutcome(true)).toBe("cancelled");
  expect(cancellationOutcome(false)).toBe("unknown");
  expect(cancellationOutcome(false)).not.toBe("succeeded");
});

test("tool turns follow one rule, and both backends count with the same implementation", () => {
  // The child path imports this exact function; there is no second counter.
  expect(toolGateFromChildTools).toBe(createToolTurnGate);

  // One tool turn is one model message containing tool calls.
  const gate = createToolTurnGate(2, ["evok_read_file", "evok_deliver"], (name) => name === "evok_deliver");
  gate.turn(["evok_read_file", "evok_read_file"]);
  expect(gate.used).toBe(1);
  gate.turn(["evok_deliver"]);
  // A control-only batch is exempt from the budget, so the terminal action still runs.
  expect(gate.used).toBe(1);
  gate.turn(["evok_read_file"]);
  expect(gate.used).toBe(2);
  gate.turn(["evok_read_file"]);
  // The batch after the budget is blocked and never spends a turn.
  expect(gate.used).toBe(2);
  expect(gate.call("evok_read_file")).toMatchObject({ block: true });
  expect(gate.overBudget()).toBe(true);

  // The main Run path has no control tools; with no limit it only counts.
  const counting = createToolTurnGate(undefined, ["read"], () => false);
  counting.turn(["read", "grep"]);
  counting.turn(["read"]);
  expect(counting.used).toBe(2);
  expect(counting.overBudget()).toBe(false);
  expect(counting.call("read")).toBeUndefined();
});

test("B3: usage already included in a parent aggregate is not counted again", () => {
  // The parent's 10,000 already contains the child's 3,000: counting the child
  // again is the 16,000 bug (or 13,000 where 10,000 was the only truth).
  const parent = receipt({ executionId: "exec-parent", usage: usage(10_000) });
  const included = receipt({
    executionId: "exec-child",
    parentExecutionId: "exec-parent",
    usage: usage(3_000, "included-in-parent"),
  });
  expect(aggregateUsage([parent, included]).tokens.total).toBe(10_000);

  // A child metered on its own provider is additive exactly once.
  const own = receipt({
    executionId: "exec-child",
    parentExecutionId: "exec-parent",
    usage: usage(3_000, "own"),
  });
  expect(aggregateUsage([parent, own]).tokens.total).toBe(13_000);

  // One execution cannot be attributed twice.
  expect(() => aggregateUsage([parent, { ...parent, usage: usage(10_000) }])).toThrow(/twice/);
  // A receipt with no measured usage adds nothing.
  expect(aggregateUsage([receipt({ usage: undefined })]).tokens.total).toBe(0);
});

test("one close builds the receipt from the request and refuses credentials", () => {
  const secret = "sk-live-0123456789abcdef0123456789";
  const request: ExecutionRequest = receipt();
  const large = "token " + secret;

  // The receipt echoes exactly what it answered, so it cannot drift from it.
  const closed = closeExecution(request, {
    outcome: "failed",
    toolTurns: { spent: 1, limit: 4 },
    diagnostics: { status: "failed", error: large },
  });
  expect(closed).toMatchObject({
    executionId: request.executionId,
    inputs: request.inputs,
    environment: request.environment,
    capabilities: request.capabilities,
    limits: request.limits,
    outcome: "failed",
    toolTurns: { spent: 1, limit: 4 },
    artifacts: [],
  });

  // Free-text secrets are redacted; a structural credential is refused outright.
  expect(
    closeExecution(request, { outcome: "failed", toolTurns: { spent: 0 }, diagnostics: { status: "failed", error: "401 for " + secret } })
      .diagnostics?.error,
  ).toBe("401 for [redacted]");
  expect(() =>
    closeExecution({ ...request, provider: { apiKey: secret } } as unknown as ExecutionRequest, {
      outcome: "failed",
      toolTurns: { spent: 0 },
    }),
  ).toThrow(ChildRecordSecretError);
});
