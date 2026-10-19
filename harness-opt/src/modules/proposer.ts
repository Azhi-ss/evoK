import {
  HARNESS_PARTS,
  isAttributionLabel,
  isHarnessPart,
  type GapReport,
  type HarnessConfig,
  type HarnessPart,
  type PatchProposal,
  type SearchGenes,
  type TraceRecord,
} from "../types";

export interface ChangeRejection {
  readonly key: string;
  readonly reason: string;
}

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

/**
 * Apply one patch.
 * Legal `changes` keys are a config path (`selector.weight`, `trigger`) or a
 * part name whose value is an object. `search` and `search.samples` update the
 * top-level search genes. Anything else is listed in `rejected` and skipped.
 * A dangerous key such as `__proto__` is an explicit rejection, not a silent drop.
 */
export function applyPatch(
  base: HarnessConfig,
  patch: PatchProposal,
): { readonly config: HarnessConfig; readonly rejected: readonly ChangeRejection[] } {
  validatePatch(patch);
  const rejected: ChangeRejection[] = [];
  notePrototype(patch.changes, rejected);
  let search = base.search;
  const parts: { -readonly [K in keyof HarnessConfig["parts"]]: Record<string, unknown> } = { ...base.parts };
  for (const key of ownKeys(patch.changes)) {
    const value = (patch.changes as Record<string, unknown>)[key];
    if (isDangerousKey(key)) {
      rejected.push({ key, reason: `危险键 ${key} 被拒绝` });
      continue;
    }
    if (isMetadataKey(key)) {
      rejected.push({ key, reason: `元数据键 ${key} 不能写入配置` });
      continue;
    }
    if (isSearchPath(key)) {
      search = applySearchChange(search, key, value, rejected);
      continue;
    }
    const prefixed = partPrefix(key);
    if (prefixed) {
      if (prefixed.rest === "") {
        if (!isRecord(value)) {
          rejected.push({ key, reason: `part 键 ${key} 的值必须是对象` });
          continue;
        }
        notePrototype(value, rejected, key);
        const grouped = applyGroup(parts[prefixed.part], value, prefixed.part, rejected, key, search);
        parts[prefixed.part] = grouped.part;
        search = grouped.search;
        continue;
      }
      const rest = stripPartPrefix(prefixed.rest, prefixed.part);
      if (isSearchPath(rest)) {
        search = applySearchChange(search, rest, value, rejected, key);
        continue;
      }
      const placed = placeConfig(parts[prefixed.part], rest, value, key);
      if (!placed.ok) {
        rejected.push({ key, reason: placed.reason });
        continue;
      }
      parts[prefixed.part] = placed.value;
      continue;
    }
    const placed = placeConfig(parts[patch.part], key, value, key);
    if (!placed.ok) {
      rejected.push({ key, reason: placed.reason });
      continue;
    }
    parts[patch.part] = placed.value;
  }
  return {
    config: {
      id: `${base.id}+${patch.part}`,
      modelId: base.modelId,
      parts,
      search: mergeGenes(search, patch.search),
    },
    rejected,
  };
}

const DANGEROUS_SEGMENT = new Set(["__proto__", "constructor", "prototype"]);
const METADATA_KEY = new Set([
  "candidateId",
  "id",
  "modelId",
  "part",
  "motivation",
  "expectedFailureClass",
  "summary",
  "configPath",
  "parentId",
  "metadata",
]);
const FILE_EXTENSION = new Set([
  "md", "markdown", "json", "jsonl", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "txt", "yaml", "yml", "toml", "xml", "html", "htm", "css", "sh", "bash",
  "rs", "go", "java", "kt", "rb", "php", "csv", "tsv", "ini", "env", "lock",
]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function applyGroup(
  base: Readonly<Record<string, unknown>>,
  group: Readonly<Record<string, unknown>>,
  part: HarnessPart,
  rejected: ChangeRejection[],
  prefix: string,
  search: SearchGenes,
): { readonly part: Record<string, unknown>; readonly search: SearchGenes } {
  let out: Record<string, unknown> = { ...base };
  let genes = search;
  for (const key of ownKeys(group)) {
    const shown = `${prefix}.${key}`;
    const value = group[key];
    if (isDangerousKey(key)) {
      rejected.push({ key: shown, reason: `危险键 ${key} 被拒绝` });
      continue;
    }
    if (isMetadataKey(key)) {
      rejected.push({ key: shown, reason: `元数据键 ${key} 不能写入配置` });
      continue;
    }
    if (isSearchPath(key)) {
      genes = applySearchChange(genes, key, value, rejected, shown);
      continue;
    }
    const rest = stripPartPrefix(key, part);
    if (isSearchPath(rest)) {
      genes = applySearchChange(genes, rest, value, rejected, shown);
      continue;
    }
    const placed = placeConfig(out, rest, value, shown);
    if (!placed.ok) {
      rejected.push({ key: shown, reason: placed.reason });
      continue;
    }
    out = placed.value;
  }
  return { part: out, search: genes };
}

function applySearchChange(
  search: SearchGenes,
  key: string,
  value: unknown,
  rejected: ChangeRejection[],
  shown = key,
): SearchGenes {
  if (key === "search") {
    if (!isRecord(value)) {
      rejected.push({ key: shown, reason: "search 的值必须是对象" });
      return search;
    }
    notePrototype(value, rejected, shown);
    let next = search;
    for (const child of ownKeys(value)) {
      next = applySearchChange(next, `search.${child}`, value[child], rejected, `${shown}.${child}`);
    }
    return next;
  }
  const field = key.slice("search.".length);
  if (field !== "samples" && field !== "selfChecks" && field !== "retries") {
    rejected.push({ key: shown, reason: `search 没有参数 ${field}` });
    return search;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (field === "samples" && value < 1)) {
    rejected.push({ key: shown, reason: `search.${field} 不是合法整数` });
    return search;
  }
  return { ...search, [field]: value };
}

function isSearchPath(key: string): boolean {
  if (key === "search") return true;
  if (!key.startsWith("search.") || key.includes("/") || key.includes("\\")) return false;
  const last = key.split(".").at(-1) ?? "";
  return !FILE_EXTENSION.has(last);
}

function placeConfig(
  base: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown,
  shown: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const danger = dangerousData(value);
  if (danger) return { ok: false, reason: `危险键 ${shown}.${danger} 被拒绝` };
  if (!isConfigPath(key) || !isPlainData(value)) return { ok: false, reason: `非法键 ${shown} 不是配置路径或 part 名` };
  return assignPath(base, key, value);
}

/** Own `__proto__` / `constructor` / `prototype`, or a value whose prototype was replaced. */
function dangerousData(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = dangerousData(entry);
      if (found) return found;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "__proto__";
  for (const key of ownKeys(value)) {
    if (isDangerousKey(key)) return key;
    const found = dangerousData((value as Record<string, unknown>)[key]);
    if (found) return found;
  }
  return null;
}

function partPrefix(key: string): { readonly part: HarnessPart; readonly rest: string } | null {
  for (const part of HARNESS_PARTS) {
    if (key === part) return { part, rest: "" };
    if (key.startsWith(`${part}.`)) return { part, rest: key.slice(part.length + 1) };
  }
  return null;
}

function stripPartPrefix(key: string, part: HarnessPart): string {
  if (key === part) return "";
  if (key.startsWith(`${part}.`)) return key.slice(part.length + 1);
  return key;
}

function isDangerousKey(key: string): boolean {
  return key.split(".").some((segment) => DANGEROUS_SEGMENT.has(segment));
}

function isMetadataKey(key: string): boolean {
  const head = key.split(".")[0] ?? key;
  return METADATA_KEY.has(head);
}

function isConfigPath(key: string): boolean {
  if (key === "" || key.includes("/") || key.includes("\\")) return false;
  const segments = key.split(".");
  if (segments.some((segment) => !IDENT.test(segment) || DANGEROUS_SEGMENT.has(segment) || METADATA_KEY.has(segment))) {
    return false;
  }
  const last = segments[segments.length - 1] ?? "";
  return !(segments.length >= 2 && FILE_EXTENSION.has(last));
}

function notePrototype(value: object, rejected: ChangeRejection[], prefix = ""): void {
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return;
  const key = prefix === "" ? "__proto__" : `${prefix}.__proto__`;
  if (rejected.some((item) => item.key === key)) return;
  rejected.push({ key, reason: "危险键 __proto__ 被拒绝" });
}

function ownKeys(value: object): string[] {
  return Object.getOwnPropertyNames(value);
}

function isPlainData(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every((entry) => isPlainData(entry));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return ownKeys(value).every((key) => !isDangerousKey(key) && isPlainData((value as Record<string, unknown>)[key]));
}

function assignPath(
  base: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  const segments = key.split(".");
  const root: Record<string, unknown> = { ...base };
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const existing = cursor[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
      continue;
    }
    if (!isRecord(existing)) return { ok: false, reason: `配置路径 ${key} 中间不是对象` };
    const copy = { ...existing };
    cursor[segment] = copy;
    cursor = copy;
  }
  cursor[segments[segments.length - 1] as string] = value;
  return { ok: true, value: root };
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
