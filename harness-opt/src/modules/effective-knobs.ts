/**
 * Knobs the patched company harness reads. One list: the innovator prompt,
 * candidate validation, and the harness-patch test all use this array.
 * `goal.maxContinuationTurns` is included because the patched harness stops
 * the continuation loop on it and copies it into run_start.effective.
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
