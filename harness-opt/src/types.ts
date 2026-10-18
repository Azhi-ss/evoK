/**
 * Shared contracts for the harness-opt skeleton (PRD §5–§9).
 *
 * Held-out observations are intentionally absent from proposer-facing types.
 * The evidence gate is the only module that takes a held-out score.
 */

export const HARNESS_PARTS = [
  "agent-loop",
  "context",
  "memory",
  "toolchain",
  "skills",
] as const;

export type HarnessPart = (typeof HARNESS_PARTS)[number];

export const ATTRIBUTION_LABELS = [
  "timeout",
  "idle-loop",
  "tool-misuse",
  "context-overflow",
  "skill-not-triggered",
  "format-invalid",
] as const;

export type AttributionLabel = (typeof ATTRIBUTION_LABELS)[number];

/** TTS genes. These are searchable config, not hidden constants. */
export interface SearchGenes {
  /** Independent samples of the same candidate (multi-sample). */
  readonly samples: number;
  /** Extra self-check passes required before a dev score is trusted. */
  readonly selfChecks: number;
  /** Extra attempts after an infra failure of one sample. */
  readonly retries: number;
}

export const DEFAULT_SEARCH_GENES: SearchGenes = {
  samples: 1,
  selfChecks: 0,
  retries: 0,
};

export interface HarnessParts {
  readonly "agent-loop": Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly memory: Readonly<Record<string, unknown>>;
  readonly toolchain: Readonly<Record<string, unknown>>;
  readonly skills: Readonly<Record<string, unknown>>;
}

export interface HarnessConfig {
  readonly id: string;
  /** Fixed contest model. Patches cannot change this. */
  readonly modelId: string;
  readonly parts: HarnessParts;
  readonly search: SearchGenes;
}

export interface TaskRef {
  readonly id: string;
  readonly split: "dev" | "held-out";
  /** Sandbox-relative path. Never an absolute host path. */
  readonly path: string;
}

export interface TraceRecord {
  readonly taskId: string;
  /** Normalized per-task reward in [0, 1]. Failed tasks contribute 0. */
  readonly reward: number;
  readonly tokens: number;
  readonly failed: boolean;
  readonly labels: readonly AttributionLabel[];
  /** Raw trace text. Proposer may read this; it must not contain held-out. */
  readonly raw: string;
}

export interface Scorecard {
  /** Mean reward × 100, matching the contest's equal-weight scale. */
  readonly devScore: number;
  readonly tokens: number;
  readonly attributionComplete: boolean;
}

export interface GapItem {
  readonly id: string;
  readonly failureClass: AttributionLabel;
  readonly summary: string;
  readonly traceIds: readonly string[];
}

export interface GapReport {
  readonly gaps: readonly GapItem[];
}

export interface PatchProposal {
  readonly part: HarnessPart;
  readonly motivation: string;
  readonly expectedFailureClass: AttributionLabel;
  readonly changes: Readonly<Record<string, unknown>>;
  readonly search?: Partial<SearchGenes>;
}

export interface LineageNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: "accepted" | "rejected";
  readonly config: HarnessConfig;
  readonly devScore: number | null;
  readonly tokens: number | null;
  readonly reason: string;
  readonly criterionId: string | null;
}

export const DEFAULT_MODEL_ALLOWLIST = [
  "deepseek",
  "glm",
  "mimo",
  "minimax",
  "qwen",
] as const;

export function emptyParts(): HarnessParts {
  return {
    "agent-loop": {},
    context: {},
    memory: {},
    toolchain: {},
    skills: {},
  };
}

export function isAttributionLabel(value: string): value is AttributionLabel {
  return (ATTRIBUTION_LABELS as readonly string[]).includes(value);
}

export function isHarnessPart(value: string): value is HarnessPart {
  return (HARNESS_PARTS as readonly string[]).includes(value);
}
