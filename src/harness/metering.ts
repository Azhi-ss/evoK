/**
 * Raw usage measurement (PRD §3 B3; #253/#256).
 *
 * B3 has three layers and this module is only the first: the harness measures
 * what a backend consumed. **Attribution** (which Run or agent, including
 * parent/child) and **budget reserve/settle/refund** stay in Mission. That is
 * why nothing here sums across executions — `usage.attribution` and
 * `aggregateUsage` in the protocol are where a cross-execution number is
 * decided, and each execution is counted once there.
 *
 * The shapes below are the ones the two backends already receive; the numbers
 * are unchanged by the move, which is what the existing backend tests pin.
 */
import type { RawUsage } from "./contracts";

type UsageShape = RawUsage["tokens"];

/** Tokens and cost are measured the same five ways; one list, one recipe. */
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A complete token/cost pair, or nothing: a missing field is not a zero. */
function pair(tokens: unknown, cost: unknown): RawUsage | undefined {
  if (!isRecord(tokens) || !isRecord(cost)) return undefined;
  if (!USAGE_KEYS.every((key) => finite(tokens[key])) || !USAGE_KEYS.every((key) => finite(cost[key]))) return undefined;
  return {
    tokens: Object.fromEntries(USAGE_KEYS.map((key) => [key, tokens[key]])) as UsageShape,
    cost: Object.fromEntries(USAGE_KEYS.map((key) => [key, cost[key]])) as RawUsage["cost"],
  };
}

/**
 * Measure one backend payload. The three shapes are what the backends actually
 * answer with, and each is measured the way that backend already reported it:
 *
 * - an SDK completion message (`usage.usage`),
 * - session stats (`tokens`, with a numeric cost understood as a total),
 * - a delegated child's report (`input`/`output`/`cost`, no cache).
 *
 * Anything else is `undefined`: an unmeasured execution has no number, and the
 * caller decides whether that is allowed.
 */
export function measureUsage(source: unknown): RawUsage | undefined {
  if (!isRecord(source)) return undefined;
  // SDK completion message.
  if (isRecord(source.usage)) {
    const u = source.usage;
    if (!isRecord(u.cost)) return undefined;
    return pair(
      { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens },
      u.cost,
    );
  }
  // Session stats.
  if (isRecord(source.tokens)) {
    const cost = source.cost;
    if (finite(cost))
      return pair(source.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost });
    return pair(source.tokens, cost);
  }
  // A delegated child's own report.
  if (finite(source.input) && finite(source.output) && finite(source.cost))
    return {
      tokens: { input: source.input, output: source.output, cacheRead: 0, cacheWrite: 0, total: source.input + source.output },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: source.cost },
    };
  return undefined;
}

/** Fold one execution's own measurements. Never a total across executions. */
export function addUsage(left: RawUsage | undefined, right: RawUsage): RawUsage {
  if (!left) return right;
  return {
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      total: left.tokens.total + right.tokens.total,
    },
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

/**
 * What one streamed provider response reported. Within one request the counts
 * are cumulative, so the highest seen is that request's. Token counts only: the
 * price of them is not this relay's to measure.
 */
export function measureResponseUsage(text: string): { readonly input: number; readonly output: number } {
  const served = { input: 0, output: 0 };
  for (const line of text.split("\n")) {
    const raw = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!raw.startsWith("{")) continue;
    let body: {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
      response?: { usage?: Record<string, unknown> };
    };
    try {
      body = JSON.parse(raw);
    } catch {
      continue;
    }
    const counts = body?.usage ?? body?.message?.usage ?? body?.response?.usage;
    if (!counts) continue;
    const input = counts.input_tokens ?? counts.prompt_tokens;
    const output = counts.output_tokens ?? counts.completion_tokens;
    if (finite(input)) served.input = Math.max(served.input, input);
    if (finite(output)) served.output = Math.max(served.output, output);
  }
  return served;
}
