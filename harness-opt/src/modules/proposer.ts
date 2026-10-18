import {
  isAttributionLabel,
  isHarnessPart,
  type GapReport,
  type HarnessConfig,
  type HarnessPart,
  type PatchProposal,
  type SearchGenes,
  type TraceRecord,
} from "../types";

/** Key names that must not cross into Gap Finder or Innovator context. */
export function isHeldOutField(key: string): boolean {
  const norm = key.toLowerCase().replace(/[_-]/g, "");
  return norm.includes("heldout") || norm.includes("hidden");
}

/** Drop held-out keys anywhere in a JSON-like value. Role-facing views use this. */
export function stripHeldOutFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripHeldOutFields(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isHeldOutField(key)) continue;
      out[key] = stripHeldOutFields(child);
    }
    return out;
  }
  return value;
}

/**
 * Innovator input. There is no held-out field on purpose (PRD §2, §8).
 * A later selector doc must not add one here.
 */
export interface InnovatorInput {
  readonly config: HarnessConfig;
  readonly gaps: GapReport;
  readonly history: readonly { readonly id: string; readonly status: string; readonly reason: string }[];
  readonly traces: readonly TraceRecord[];
}

export interface GapFinderInput {
  readonly traces: readonly TraceRecord[];
}

export function assertNoHeldOutLeak(value: unknown, where: string): void {
  const leaked = findLeak(value);
  if (leaked !== null) {
    throw new Error(`${where} contains held-out material at ${leaked}`);
  }
}

export function buildInnovatorInput(input: InnovatorInput & { readonly heldOut?: unknown }): InnovatorInput {
  if ("heldOut" in input && input.heldOut !== undefined) {
    throw new Error("held-out must not enter proposer context");
  }
  const safe: InnovatorInput = {
    config: input.config,
    gaps: input.gaps,
    history: input.history,
    traces: input.traces,
  };
  assertNoHeldOutLeak(safe, "innovator input");
  return safe;
}

export function validatePatch(patch: PatchProposal): void {
  if (!isHarnessPart(patch.part)) throw new Error(`patch part is not a harness part: ${patch.part}`);
  if (typeof patch.motivation !== "string" || patch.motivation.trim() === "") {
    throw new Error("patch is missing a motivation");
  }
  if (!isAttributionLabel(patch.expectedFailureClass)) {
    throw new Error(`patch expectedFailureClass is not an attribution label: ${patch.expectedFailureClass}`);
  }
  assertNoHeldOutLeak(patch, "patch");
}

export function applyPatch(base: HarnessConfig, patch: PatchProposal): HarnessConfig {
  validatePatch(patch);
  const search = mergeGenes(base.search, patch.search);
  return {
    id: `${base.id}+${patch.part}`,
    modelId: base.modelId,
    parts: {
      ...base.parts,
      [patch.part]: {
        ...base.parts[patch.part],
        ...patch.changes,
      },
    },
    search,
  };
}

export function mergeGenes(base: SearchGenes, overlay: Partial<SearchGenes> | undefined): SearchGenes {
  const next: SearchGenes = {
    samples: overlay?.samples ?? base.samples,
    selfChecks: overlay?.selfChecks ?? base.selfChecks,
    retries: overlay?.retries ?? base.retries,
  };
  for (const [key, value] of Object.entries(next) as [keyof SearchGenes, number][]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`search gene ${key} must be a non-negative integer`);
    }
  }
  if (next.samples < 1) throw new Error("search gene samples must be at least 1");
  return next;
}

function findLeak(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findLeak(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (isHeldOutField(key)) return `${path}.${key}`;
      const found = findLeak(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

export type { HarnessPart };
