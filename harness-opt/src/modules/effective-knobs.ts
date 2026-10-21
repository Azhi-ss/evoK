/**
 * Knobs the patched company harness reads. One list: the innovator prompt,
 * candidate validation, and the harness-patch test all use this array.
 * `agent-loop.maxSteps` caps agent_end steps (`stats.turns`, `run_end.steps`).
 * `goal.maxContinuationTurns` caps continuation turns: pi-goal automatic model
 * responses. That same number is `continuationLimits.automaticTurns` and
 * `run_end.goalContinuationTurns`. A relay call is an `assistant_message` or
 * `auto_retry_start` trace line. It is not a knob and neither cap applies to it.
 */
export const EFFECTIVE_KNOBS = [
  "agent-loop.maxSteps",
  "agent-loop.noProgressTurns",
  "agent-loop.maxNudges",
  "agent-loop.requireWrite",
  "context.window",
  "context.maxTokens",
  "context.compaction.enabled",
  "context.compaction.reserveTokens",
  "context.compaction.keepRecentTokens",
  "toolchain.tools.enabled",
  "toolchain.bashTimeoutSec",
  "toolchain.subagents",
  "toolchain.checker",
  "skills.maxChars",
  "skills.pack",
  "skills.selector.weight",
  "skills.selector.bias",
  "memory.enabled",
  "memory.scope",
  "memory.recall",
  "memory.maxItems",
  "goal.maxContinuationTurns",
] as const;

const EFFECTIVE_KNOB_SET = new Set<string>(EFFECTIVE_KNOBS);

export function isEffectiveKnob(path: string): boolean {
  return EFFECTIVE_KNOB_SET.has(path);
}

/** Keys the harness reads as `effective["..."]`. Order follows the file. */
export function harnessEffectiveKeys(source: string): string[] {
  return [...source.matchAll(/effective\["([^"]+)"\]/g)].map((match) => match[1] ?? "");
}

/** Leaf paths in an innovator `parts` object. Arrays and scalars are leaves. */
export function leafKnobPaths(parts: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix === "" ? key : `${prefix}.${key}`, child);
      }
      return;
    }
    if (prefix !== "") out.push(prefix);
  };
  walk("", parts);
  return out;
}
