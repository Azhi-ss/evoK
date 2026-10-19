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
  const parts: { -readonly [K in keyof HarnessConfig["parts"]]: Record<string, unknown> } = { ...base.parts };
  const direct: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch.changes)) {
    if (isHarnessPart(key) && isRecord(value)) {
      parts[key] = applyChanges(base.parts[key], value);
      continue;
    }
    direct[key] = value;
  }
  const declared = parts[patch.part];
  parts[patch.part] = applyChanges(declared, direct);
  return {
    id: `${base.id}+${patch.part}`,
    modelId: base.modelId,
    parts,
    search,
  };
}

const REJECTED_SEGMENT = new Set(["__proto__", "constructor", "prototype"]);

/** Filename suffixes. A trailing one means the key is a file path, not a config path. */
const FILE_EXTENSION = new Set([
  "md", "markdown", "json", "jsonl", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "txt", "yaml", "yml", "toml", "xml", "html", "htm", "css", "sh", "bash",
  "rs", "go", "java", "kt", "rb", "php", "csv", "tsv", "ini", "env", "lock",
]);

/**
 * A dotted key such as `a.b.c` is a nested config path.
 * A file path or any other non-config key throws, so it is not merged.
 * A key that is a harness part, with an object value, is applied to that part.
 */
function applyChanges(
  base: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    assertConfigKey(key);
    if (key.includes(".")) assignNested(out, key, value);
    else out[key] = value;
  }
  return out;
}

function assertConfigKey(key: string): void {
  if (key.includes("/") || key.includes("\\")) {
    throw new Error(`patch change key is not a config path: ${key}`);
  }
  const segments = key.split(".");
  const ident = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  if (segments.length === 0 || segments.some((segment) => !ident.test(segment) || REJECTED_SEGMENT.has(segment))) {
    throw new Error(`patch change key is not a config path: ${key}`);
  }
  const last = segments[segments.length - 1] as string;
  if (segments.length >= 2 && FILE_EXTENSION.has(last)) {
    throw new Error(`patch change key is not a config path: ${key}`);
  }
}

function assignNested(out: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split(".");
  let cursor = out;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (isRecord(existing)) {
      const copy = { ...existing };
      cursor[segment] = copy;
      cursor = copy;
    } else if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    } else {
      throw new Error(`patch change key collides with a non-object: ${key}`);
    }
  }
  cursor[segments[segments.length - 1] as string] = value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
