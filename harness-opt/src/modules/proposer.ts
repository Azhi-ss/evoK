import { isWhitelistedConfigPath, isWhitelistedConfigPrefix } from "../config-paths";
import {
  emptyParts,
  HARNESS_PARTS,
  isAttributionLabel,
  isHarnessPart,
  type GapReport,
  type HarnessConfig,
  type HarnessPart,
  type HarnessParts,
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

/**
 * Patch pipeline. Parse, normalize, route, and check are one pass.
 *
 * patch.json carries the four required fields, an optional top-level `search`
 * object, optional top-level `search.samples` / `search.selfChecks` /
 * `search.retries`, and `changes`. `parsePatchFile` keeps every one of those.
 * A later `rejected` array is ignored on the way back in.
 *
 * Each change is judged once, against `patch.part` only:
 * - A leading part prefix is removed one time. `skills.selector.weight` becomes
 *   `selector.weight` on skills. `skills.skills.selector.weight` becomes
 *   `skills.selector.weight` and is not stripped again.
 * - A key whose first part name is a different part is a cross-part write and
 *   is rejected. Nothing is written to that other part.
 * - `search` and `search.samples` / `selfChecks` / `retries` update the
 *   top-level search genes.
 * - After that normalization, the full path must be a leaf of the config
 *   whitelist (`toolchain.tools.check.id`, `skills.selector.weight`,
 *   `search.samples`). Anything else, including `foo.bar`, top-level `notes`,
 *   and `candidateId`, is recorded and skipped. A segment named `id` is not
 *   a reason by itself.
 * - An object value is not stored as a blob. Each nested key continues the
 *   path and is checked the same way, at every depth. `notes` or
 *   `candidateId` inside a leaf object is rejected and left out. An empty
 *   object on a whitelist leaf or prefix is rejected and not stored. An
 *   object inside an array is walked the same way; a hollow `{}` is not
 *   left in the array. If a subtree keeps no leaf and records nothing, one
 *   rejection is written for that subtree.
 * - `__proto__`, `constructor`, and `prototype` are recorded and skipped.
 *   They do not throw.
 * - One rejection does not stop the round.
 */
const PATCH_DOCUMENT_KEYS = new Set(["part", "motivation", "expectedFailureClass", "summary", "changes", "rejected"]);
const SEARCH_FIELDS = ["samples", "selfChecks", "retries"] as const;
type SearchField = (typeof SEARCH_FIELDS)[number];

export function parsePatchFile(value: unknown): PatchProposal & { readonly summary: string } {
  if (!isRecord(value)) throw new Error("patch.json must be an object");
  const part = value.part;
  const motivation = value.motivation;
  const expectedFailureClass = value.expectedFailureClass;
  const summary = value.summary;
  if (typeof part !== "string" || !isHarnessPart(part)) throw new Error("patch.json part is not a harness part");
  if (typeof motivation !== "string" || motivation.trim() === "") throw new Error("patch.json motivation is missing");
  if (typeof expectedFailureClass !== "string" || !isAttributionLabel(expectedFailureClass)) {
    throw new Error("patch.json expectedFailureClass is not an attribution label");
  }
  if (typeof summary !== "string" || summary.trim() === "") throw new Error("patch.json summary is missing");
  const changes = isRecord(value.changes) ? copyOwn(value.changes) : {};
  let search: Partial<SearchGenes> | undefined;
  for (const key of ownKeys(value)) {
    if (PATCH_DOCUMENT_KEYS.has(key)) continue;
    if (key === "search" || isDottedSearchKey(key)) {
      search = takeSearch(search, key, value[key], changes);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(changes, key)) defineOwn(changes, key, value[key]);
  }
  const patch: PatchProposal & { readonly summary: string } = {
    part,
    motivation,
    expectedFailureClass,
    summary,
    changes,
    ...(search ? { search } : {}),
  };
  return patch;
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

export function applyPatch(
  base: HarnessConfig,
  patch: PatchProposal,
): { readonly config: HarnessConfig; readonly rejected: readonly ChangeRejection[] } {
  validatePatch(patch);
  const rejected: ChangeRejection[] = [];
  notePrototype(patch.changes, rejected);
  let search = base.search;
  const parts: { -readonly [K in keyof HarnessConfig["parts"]]: Record<string, unknown> } = { ...base.parts };
  const home = patch.part;
  for (const key of ownKeys(patch.changes)) {
    search = applyChange(parts, search, home, key, (patch.changes as Record<string, unknown>)[key], rejected, true);
  }
  if (patch.search) {
    for (const field of SEARCH_FIELDS) {
      if (patch.search[field] !== undefined) {
        search = applySearchChange(search, `search.${field}`, patch.search[field], rejected);
      }
    }
  }
  return {
    config: {
      id: `${base.id}+${home}`,
      modelId: base.modelId,
      parts,
      search,
    },
    rejected,
  };
}

/**
 * Whitelist a config that is about to be inherited. Innovator can write
 * `candidates/<id>/config.json` without `applyPatch`. Those parts and search
 * genes are stripped to the same leaves before a child reads them. Out-of-table
 * keys, metadata, and dangerous keys are removed and listed in `rejected`.
 * Structural gaps (missing model, missing search numbers) stay with the caller.
 */
export function sanitizeStoredConfig(
  parsed: Record<string, unknown>,
  genes: SearchGenes,
): { readonly config: HarnessConfig; readonly rejected: readonly ChangeRejection[] } {
  const rejected: ChangeRejection[] = [];
  notePrototype(parsed, rejected);
  for (const key of ownKeys(parsed)) {
    if (key === "id" || key === "modelId" || key === "parts" || key === "search") continue;
    if (isDangerousKey(key)) {
      if (!rejected.some((item) => item.key === key)) rejected.push({ key, reason: `危险键 ${key} 被拒绝` });
      continue;
    }
    rejected.push({ key, reason: `配置路径 ${key} 不在白名单` });
  }
  const searchRaw = parsed.search;
  if (isRecord(searchRaw)) {
    notePrototype(searchRaw, rejected, "search");
    for (const key of ownKeys(searchRaw)) {
      if ((SEARCH_FIELDS as readonly string[]).includes(key)) continue;
      const shown = `search.${key}`;
      if (isDangerousKey(key)) {
        if (!rejected.some((item) => item.key === shown)) rejected.push({ key: shown, reason: `危险键 ${key} 被拒绝` });
        continue;
      }
      rejected.push({ key: shown, reason: `search 没有参数 ${key}` });
    }
  }
  const partsRaw = parsed.parts;
  const parts: { -readonly [K in keyof HarnessParts]: Record<string, unknown> } = { ...emptyParts() };
  let search = genes;
  if (isRecord(partsRaw)) {
    notePrototype(partsRaw, rejected, "parts");
    for (const key of ownKeys(partsRaw)) {
      if (isDangerousKey(key)) {
        const shown = `parts.${key}`;
        if (!rejected.some((item) => item.key === shown)) rejected.push({ key: shown, reason: `危险键 ${key} 被拒绝` });
        continue;
      }
      if (!isHarnessPart(key)) {
        rejected.push({ key: `parts.${key}`, reason: `配置路径 ${key} 不在白名单` });
        noteClosed(partsRaw[key], `parts.${key}`, rejected, "skills", key);
        continue;
      }
      search = applyChange(parts, search, key, key, partsRaw[key], rejected, true, key);
    }
  }
  const modelId = typeof parsed.modelId === "string" ? parsed.modelId : "";
  const id = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : "parent";
  return { config: { id, modelId, parts, search }, rejected };
}

const DANGEROUS_SEGMENT = new Set(["__proto__", "constructor", "prototype"]);
const FILE_EXTENSION = new Set([
  "md", "markdown", "json", "jsonl", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "txt", "yaml", "yml", "toml", "xml", "html", "htm", "css", "sh", "bash",
  "rs", "go", "java", "kt", "rb", "php", "csv", "tsv", "ini", "env", "lock",
]);

function applyChange(
  parts: { -readonly [K in keyof HarnessConfig["parts"]]: Record<string, unknown> },
  search: SearchGenes,
  home: HarnessPart,
  key: string,
  value: unknown,
  rejected: ChangeRejection[],
  strip: boolean,
  shown = key,
  wrote: { n: number } = { n: 0 },
): SearchGenes {
  if (isDangerousKey(key)) {
    rejected.push({ key: shown, reason: `危险键 ${key} 被拒绝` });
    return search;
  }
  if (isFilePath(key)) {
    rejected.push({ key: shown, reason: `非法键 ${shown} 不是配置路径或 part 名` });
    return search;
  }
  if (isSearchPath(key)) {
    const next = applySearchChange(search, key, value, rejected, shown);
    if (next !== search) wrote.n += 1;
    return next;
  }
  if (strip && (key === home || key.startsWith(`${home}.`))) {
    if (key === home) {
      if (!isRecord(value)) {
        rejected.push({ key: shown, reason: `part 键 ${shown} 的值必须是对象` });
        return search;
      }
      notePrototype(value, rejected, shown);
      let genes = search;
      for (const child of ownKeys(value)) {
        genes = applyChange(parts, genes, home, `${home}.${child}`, value[child], rejected, true, `${shown}.${child}`, wrote);
      }
      return genes;
    }
    return applyChange(parts, search, home, key.slice(home.length + 1), value, rejected, false, shown, wrote);
  }
  const foreign = foreignPart(key, home);
  if (foreign) {
    rejected.push({ key: shown, reason: `跨 part 键 ${shown} 不能写入 ${foreign}` });
    return search;
  }
  if (isRecord(value) && (isWhitelistedConfigPath(home, key) || isWhitelistedConfigPrefix(home, key))) {
    notePrototype(value, rejected, shown);
    const children = ownKeys(value);
    if (children.length === 0) {
      rejected.push({ key: shown, reason: `配置路径 ${shown} 是空对象` });
      return search;
    }
    const mark = rejected.length;
    const before = wrote.n;
    let genes = search;
    for (const child of children) {
      genes = applyChange(parts, genes, home, `${key}.${child}`, value[child], rejected, false, `${shown}.${child}`, wrote);
    }
    if (wrote.n === before && rejected.length === mark) {
      rejected.push({ key: shown, reason: `配置路径 ${shown} 的叶子全部被拒绝` });
    }
    return genes;
  }
  if (isWhitelistedConfigPath(home, key)) {
    const cleaned = sanitizeValue(value, shown, rejected, home, key);
    if (!cleaned.ok) return search;
    if (Array.isArray(value) && value.length > 0 && Array.isArray(cleaned.value) && cleaned.value.length === 0) {
      return search;
    }
    const placed = assignPath(parts[home], key, cleaned.value);
    if (!placed.ok) {
      rejected.push({ key: shown, reason: placed.reason });
      return search;
    }
    parts[home] = placed.value;
    wrote.n += 1;
    return search;
  }
  rejected.push({ key: shown, reason: `配置路径 ${shown} 不在白名单` });
  noteClosed(value, shown, rejected, home, key);
  return search;
}

function takeSearch(
  search: Partial<SearchGenes> | undefined,
  key: string,
  value: unknown,
  changes: Record<string, unknown>,
): Partial<SearchGenes> | undefined {
  if (key === "search") {
    if (!isRecord(value)) {
      defineOwn(changes, key, value);
      return search;
    }
    let next = search;
    const bad: Record<string, unknown> = {};
    for (const child of ownKeys(value)) {
      if (isSearchField(child) && isValidGene(child, value[child])) next = { ...next, [child]: value[child] };
      else defineOwn(bad, child, value[child]);
    }
    if (ownKeys(bad).length > 0) defineOwn(changes, "search", bad);
    return next;
  }
  const field = key.slice("search.".length);
  if (isSearchField(field) && isValidGene(field, value)) return { ...search, [field]: value };
  defineOwn(changes, key, value);
  return search;
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
  if (!isSearchField(field)) {
    rejected.push({ key: shown, reason: `search 没有参数 ${field}` });
    return search;
  }
  if (!isValidGene(field, value)) {
    rejected.push({ key: shown, reason: `search.${field} 不是合法整数` });
    return search;
  }
  return { ...search, [field]: value };
}

function isSearchField(field: string): field is SearchField {
  return (SEARCH_FIELDS as readonly string[]).includes(field);
}

function isValidGene(field: SearchField, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && (field !== "samples" || value >= 1);
}

function isDottedSearchKey(key: string): boolean {
  return key.startsWith("search.") && !key.includes("/") && !key.includes("\\");
}

function isSearchPath(key: string): boolean {
  if (key === "search") return true;
  if (!isDottedSearchKey(key)) return false;
  const last = key.split(".").at(-1) ?? "";
  return !FILE_EXTENSION.has(last);
}

function foreignPart(key: string, home: HarnessPart): HarnessPart | null {
  for (const part of HARNESS_PARTS) {
    if (part === home) continue;
    if (key === part || key.startsWith(`${part}.`)) return part;
  }
  return null;
}

function isDangerousKey(key: string): boolean {
  return key.split(".").some((segment) => DANGEROUS_SEGMENT.has(segment));
}

function isFilePath(key: string): boolean {
  if (key.includes("/") || key.includes("\\")) return true;
  const segments = key.split(".");
  const last = segments[segments.length - 1] ?? "";
  return segments.length >= 2 && FILE_EXTENSION.has(last);
}

function sanitizeValue(
  value: unknown,
  shown: string,
  rejected: ChangeRejection[],
  home?: HarnessPart,
  path?: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const itemShown = `${shown}[${index}]`;
      if (isRecord(item)) {
        if (home === undefined || path === undefined) {
          items.push(item);
          continue;
        }
        const cleaned = sanitizeObject(item, itemShown, rejected, home, path);
        if (!cleaned.ok) return cleaned;
        if (cleaned.kept) items.push(cleaned.value);
        continue;
      }
      const cleaned = sanitizeValue(item, itemShown, rejected, home, path);
      if (!cleaned.ok) return cleaned;
      if (Array.isArray(item) && item.length > 0 && Array.isArray(cleaned.value) && cleaned.value.length === 0) continue;
      items.push(cleaned.value);
    }
    return { ok: true, value: items };
  }
  if (home !== undefined && path !== undefined && isRecord(value)) {
    const cleaned = sanitizeObject(value, shown, rejected, home, path);
    if (!cleaned.ok) return cleaned;
    return { ok: true, value: cleaned.kept ? cleaned.value : {} };
  }
  if (isRecord(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      rejected.push({ key: `${shown}.__proto__`, reason: "危险键 __proto__ 被拒绝" });
      return { ok: false };
    }
  }
  return { ok: true, value };
}

function sanitizeObject(
  value: object,
  shown: string,
  rejected: ChangeRejection[],
  home: HarnessPart,
  path: string,
): { readonly ok: true; readonly kept: boolean; readonly value: Record<string, unknown> } | { readonly ok: false } {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    rejected.push({ key: `${shown}.__proto__`, reason: "危险键 __proto__ 被拒绝" });
    return { ok: false };
  }
  const keys = ownKeys(value);
  if (keys.length === 0) {
    rejected.push({ key: shown, reason: `配置路径 ${shown} 是空对象` });
    return { ok: true, kept: false, value: {} };
  }
  const mark = rejected.length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const childShown = `${shown}.${key}`;
    const childPath = `${path}.${key}`;
    const child = (value as Record<string, unknown>)[key];
    if (isDangerousKey(key)) {
      rejected.push({ key: childShown, reason: `危险键 ${key} 被拒绝` });
      noteClosed(child, childShown, rejected, home, childPath);
      continue;
    }
    const legal = isWhitelistedConfigPath(home, childPath) || isWhitelistedConfigPrefix(home, childPath);
    if (!legal) {
      rejected.push({ key: childShown, reason: `配置路径 ${childShown} 不在白名单` });
      noteClosed(child, childShown, rejected, home, childPath);
      continue;
    }
    if (isRecord(child)) {
      const nested = sanitizeObject(child, childShown, rejected, home, childPath);
      if (!nested.ok) return nested;
      if (nested.kept) out[key] = nested.value;
      continue;
    }
    const cleaned = sanitizeValue(child, childShown, rejected, home, childPath);
    if (!cleaned.ok) return cleaned;
    if (Array.isArray(child) && child.length > 0 && Array.isArray(cleaned.value) && cleaned.value.length === 0) continue;
    out[key] = cleaned.value;
  }
  const kept = ownKeys(out).length > 0;
  if (!kept && rejected.length === mark) {
    rejected.push({ key: shown, reason: `配置路径 ${shown} 的叶子全部被拒绝` });
  }
  return { ok: true, kept, value: out };
}

/** Record nested keys of a value that is already rejected, including empty objects. */
function noteClosed(
  value: unknown,
  shown: string,
  rejected: ChangeRejection[],
  home: HarnessPart,
  path: string,
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      noteClosed(value[index], `${shown}[${index}]`, rejected, home, path);
    }
    return;
  }
  if (!isRecord(value)) return;
  const keys = ownKeys(value);
  if (keys.length === 0) {
    rejected.push({ key: shown, reason: `配置路径 ${shown} 是空对象` });
    return;
  }
  for (const key of keys) {
    const childShown = `${shown}.${key}`;
    const childPath = `${path}.${key}`;
    const child = value[key];
    if (isDangerousKey(key)) rejected.push({ key: childShown, reason: `危险键 ${key} 被拒绝` });
    else if (!isWhitelistedConfigPath(home, childPath) && !isWhitelistedConfigPrefix(home, childPath)) {
      rejected.push({ key: childShown, reason: `配置路径 ${childShown} 不在白名单` });
    }
    noteClosed(child, childShown, rejected, home, childPath);
  }
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

function copyOwn(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ownKeys(value)) defineOwn(out, key, (value as Record<string, unknown>)[key]);
  return out;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
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
