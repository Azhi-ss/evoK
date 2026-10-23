import { HARNESS_PARTS, type HarnessPart } from "./types";

/**
 * Leaves the harness config actually stores. A patch key is legal only when
 * its normalized full path is one of these leaves. The list is walked from
 * this object; a segment named `id` is not rejected on its own.
 *
 * Every part leaf is read by the patched harness when `HARNESS_CANDIDATE_CONFIG`
 * is set. `toolchain.tools.check.id` and `skills.trigger` are absent: the
 * harness source has no read of either. `search.*` is consumed by `runDev`.
 */
type ShapeNode = true | { readonly [key: string]: ShapeNode };

export const PART_CONFIG_SHAPE: Record<HarnessPart, ShapeNode> = {
  "agent-loop": {
    maxSteps: true,
    maxContinuationTurns: true,
    noProgressTurns: true,
    maxNudges: true,
    requireWrite: true,
  },
  context: {
    window: true,
    maxTokens: true,
    compaction: { enabled: true, reserveTokens: true, keepRecentTokens: true },
  },
  memory: { enabled: true, scope: true, recall: true, maxItems: true },
  toolchain: {
    checker: true,
    bashTimeoutSec: true,
    subagents: true,
    tools: { enabled: true },
  },
  skills: {
    maxChars: true,
    pack: true,
    selector: { weight: true, bias: true },
  },
};

/**
 * Where the patched harness reads each part leaf. The test checks that the
 * leaf string is present in the patched source.
 */
export const HARNESS_LEAF_CONSUMPTION: Readonly<Record<string, string>> = {
  "agent-loop.maxSteps": "session agent_end step cap (stats.turns)",
  "agent-loop.maxContinuationTurns": "pi-goal.json continuationLimits.automaticTurns and maxContinuationTurns; host cancel when goalContinuationTurns reaches it",
  "agent-loop.noProgressTurns": "pi-goal.json continuationLimits.noProgressTurns",
  "agent-loop.maxNudges": "missing-output nudge loop bound",
  "agent-loop.requireWrite": "missing-output nudge loop gate",
  "context.window": "models.json contextWindow",
  "context.maxTokens": "models.json maxTokens",
  "context.compaction.enabled": "SettingsManager compaction.enabled",
  "context.compaction.reserveTokens": "SettingsManager compaction.reserveTokens",
  "context.compaction.keepRecentTokens": "SettingsManager compaction.keepRecentTokens",
  "toolchain.tools.enabled": "SettingsManager defaultTools",
  "toolchain.bashTimeoutSec": "safeBashTool default timeout",
  "toolchain.subagents": "pi-subagents extension load",
  "toolchain.checker": "output-contract verification gate",
  "skills.maxChars": "selectRelevantSkills char budget",
  "skills.pack": "selectRelevantSkills forced include",
  "skills.selector.weight": "selectRelevantSkills score multiplier",
  "skills.selector.bias": "selectRelevantSkills score cutoff",
  "memory.enabled": "read-only notes injected into the system prompt",
  "memory.scope": "readMemoryNotes scope filter",
  "memory.recall": "readMemoryNotes recall filter",
  "memory.maxItems": "readMemoryNotes item cap",
};

/** Search genes are runner knobs, not harness.mjs knobs. */
export const SEARCH_LEAF_CONSUMPTION: Readonly<Record<string, string>> = {
  "search.samples": "runDev config.search.samples",
  "search.selfChecks": "runDev config.search.selfChecks",
  "search.retries": "runDev config.search.retries",
};

const SEARCH_FIELDS = ["samples", "selfChecks", "retries"] as const;

function walk(node: ShapeNode, prefix: string, out: Set<string>): void {
  if (node === true) {
    out.add(prefix);
    return;
  }
  for (const key of Object.keys(node)) {
    walk(node[key] as ShapeNode, prefix === "" ? key : `${prefix}.${key}`, out);
  }
}

function buildWhitelist(): Set<string> {
  const out = new Set<string>();
  for (const part of HARNESS_PARTS) walk(PART_CONFIG_SHAPE[part], part, out);
  for (const field of SEARCH_FIELDS) out.add(`search.${field}`);
  return out;
}

/** Full paths: `skills.selector.weight`, `toolchain.checker`, `search.samples`. */
export const CONFIG_PATHS: ReadonlySet<string> = buildWhitelist();

export function isWhitelistedConfigPath(part: HarnessPart, relative: string): boolean {
  return CONFIG_PATHS.has(`${part}.${relative}`);
}

export function isWhitelistedConfigPrefix(part: HarnessPart, relative: string): boolean {
  const full = `${part}.${relative}.`;
  for (const path of CONFIG_PATHS) {
    if (path.startsWith(full)) return true;
  }
  return false;
}
