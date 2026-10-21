/**
 * Knobs the signed baseline harness reads as `effective["..."]`.
 * That file is sha 4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c.
 * One list: the innovator prompt, candidate validation, and the startup check
 * all use this array. The branch harness source may wire more keys. Those stay
 * off this list while the signed baseline does not read them.
 * `agent-loop.maxSteps` caps agent_end steps (`stats.turns`, `run_end.steps`).
 * A relay call is an `assistant_message` or `auto_retry_start` trace line.
 * It is not a knob and this cap does not apply to it.
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

/**
 * Object keys that themselves contain a dot.
 * The harness splits a leaf on `.` and walks nested objects. A key named
 * `selector.weight` is never read, even though joining it looks like a whitelist path.
 */
export function flatDottedKeys(parts: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (key.includes(".")) out.push(path);
      walk(path, child);
    }
  };
  walk("", parts);
  return out;
}

/**
 * Unset `HARNESS_CONTEXT_WINDOW` / `MODEL_MAX_TOKENS` in the signed harness.
 * The catalog uses those literals and does not read the process environment.
 */
const CONTEXT_WINDOW_DEFAULT = 131072;
const MAX_TOKENS_DEFAULT = 8192;
const SAFE_INT = Number.MAX_SAFE_INTEGER;
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface KnobFact {
  readonly key: (typeof EFFECTIVE_KNOBS)[number];
  readonly current: unknown;
  readonly type: "positiveInt" | "nonNegativeInt" | "finiteNumber" | "boolean" | "string" | "string[]" | "enum";
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
}

/**
 * Current effective value of every whitelist key.
 * That value is the 4d4e12e5 default after the harness coercion of the control leaf.
 */
export function knobCatalog(control: unknown): readonly KnobFact[] {
  const parts = controlParts(control);
  return SPECS.map((spec) => {
    const current = spec.coerce(readLeaf(parts, spec.key));
    return {
      key: spec.key,
      current,
      type: spec.type,
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(spec.values ? { values: spec.values } : {}),
    };
  });
}

/** One prompt line: key, current effective value, type, and bounds when the harness has them. */
export function formatKnobLine(fact: KnobFact): string {
  let line = `${fact.key} current=${JSON.stringify(fact.current)} type=${fact.type}`;
  if (fact.min !== undefined) line += ` min=${fact.min}`;
  if (fact.max !== undefined) line += ` max=${fact.max}`;
  if (fact.values !== undefined) line += ` values=${fact.values.join(",")}`;
  return line;
}

/**
 * Changed leaves whose harness-effective value already equals the current effective value.
 * The written leaf is run through the same coercion the 4d4e12e5 harness uses:
 * out-of-range and non-numbers, including the string `"25"`, fall back to the default.
 * That fallback is what the harness runs. It is not a parse of the string.
 * One such leaf invalidates the whole candidate, including a candidate whose every
 * change is a no-op and a partial no-op. The caller names these keys and does not
 * strip them to keep the other edits.
 * `previousEffective` is the previous round's run_start effective map. It counts
 * even when that round was not accepted and the signed control was left in place.
 */
export function noopKeys(
  parts: Readonly<Record<string, unknown>>,
  control: unknown,
  previousEffective?: Readonly<Record<string, unknown>> | null,
): readonly string[] {
  const current = new Map<string, unknown>(knobCatalog(control).map((fact) => [fact.key, fact.current]));
  const coerce = new Map<string, (value: unknown) => unknown>(SPECS.map((spec) => [spec.key, spec.coerce]));
  const named: string[] = [];
  for (const path of leafKnobPaths(parts)) {
    const apply = coerce.get(path);
    if (!apply || !current.has(path)) continue;
    const effective = apply(readLeaf(parts, path));
    const matchesControl = JSON.stringify(effective) === JSON.stringify(current.get(path));
    const matchesPrevious = previousEffective !== null
      && previousEffective !== undefined
      && Object.prototype.hasOwnProperty.call(previousEffective, path)
      && JSON.stringify(effective) === JSON.stringify(previousEffective[path]);
    if (matchesControl || matchesPrevious) named.push(path);
  }
  return named;
}

function controlParts(control: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!control || typeof control !== "object" || Array.isArray(control)) return undefined;
  const parts = (control as { readonly parts?: unknown }).parts;
  if (!parts || typeof parts !== "object" || Array.isArray(parts)) return undefined;
  return parts as Readonly<Record<string, unknown>>;
}

function readLeaf(parts: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  const dot = key.indexOf(".");
  if (!parts || dot <= 0) return undefined;
  let cur: unknown = parts[key.slice(0, dot)];
  for (const segment of key.slice(dot + 1).split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, segment)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function positiveInt(value: unknown, fallback: number, max = SAFE_INT): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function enabledTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TOOLS];
  const allowed = new Set<string>(DEFAULT_TOOLS);
  const tools = value.filter((item): item is string => typeof item === "string" && allowed.has(item));
  for (const required of ["read", "write"]) {
    if (!tools.includes(required)) tools.push(required);
  }
  return tools;
}

function skillPack(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

interface KnobSpec {
  readonly key: (typeof EFFECTIVE_KNOBS)[number];
  readonly type: KnobFact["type"];
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
  readonly coerce: (value: unknown) => unknown;
}

const SPECS: readonly KnobSpec[] = [
  { key: "agent-loop.maxSteps", type: "positiveInt", min: 1, max: SAFE_INT, coerce: (value) => positiveInt(value, 25) },
  { key: "agent-loop.noProgressTurns", type: "positiveInt", min: 1, max: SAFE_INT, coerce: (value) => positiveInt(value, 3) },
  { key: "agent-loop.maxNudges", type: "nonNegativeInt", min: 0, max: SAFE_INT, coerce: (value) => nonNegativeInt(value, 2) },
  { key: "agent-loop.requireWrite", type: "boolean", coerce: (value) => boolOr(value, true) },
  { key: "context.window", type: "positiveInt", min: 1, max: SAFE_INT, coerce: (value) => positiveInt(value, CONTEXT_WINDOW_DEFAULT) },
  { key: "context.maxTokens", type: "positiveInt", min: 1, max: SAFE_INT, coerce: (value) => positiveInt(value, MAX_TOKENS_DEFAULT) },
  { key: "context.compaction.enabled", type: "boolean", coerce: (value) => boolOr(value, true) },
  { key: "context.compaction.reserveTokens", type: "nonNegativeInt", min: 0, max: SAFE_INT, coerce: (value) => nonNegativeInt(value, 16384) },
  { key: "context.compaction.keepRecentTokens", type: "nonNegativeInt", min: 0, max: SAFE_INT, coerce: (value) => nonNegativeInt(value, 16000) },
  { key: "toolchain.tools.enabled", type: "string[]", values: DEFAULT_TOOLS, coerce: (value) => enabledTools(value) },
  { key: "toolchain.bashTimeoutSec", type: "positiveInt", min: 1, max: 1800, coerce: (value) => positiveInt(value, 300, 1800) },
  { key: "toolchain.subagents", type: "boolean", coerce: (value) => boolOr(value, true) },
  { key: "toolchain.checker", type: "enum", values: ["none", "contract"], coerce: (value) => (value === "none" ? "none" : "contract") },
  { key: "skills.maxChars", type: "positiveInt", min: 1, max: SAFE_INT, coerce: (value) => positiveInt(value, 24000) },
  { key: "skills.pack", type: "string[]", coerce: (value) => skillPack(value) },
  { key: "skills.selector.weight", type: "finiteNumber", coerce: (value) => finiteNumber(value, 1) },
  { key: "skills.selector.bias", type: "finiteNumber", coerce: (value) => finiteNumber(value, 0) },
  { key: "memory.enabled", type: "boolean", coerce: (value) => value === true },
  { key: "memory.scope", type: "string", coerce: (value) => textOr(value, "all") },
  { key: "memory.recall", type: "string", coerce: (value) => textOr(value, "recent") },
  { key: "memory.maxItems", type: "nonNegativeInt", min: 0, max: SAFE_INT, coerce: (value) => nonNegativeInt(value, 8) },
];
