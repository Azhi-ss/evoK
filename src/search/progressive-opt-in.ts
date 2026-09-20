/**
 * ET-PROG-40 / #178 — Progressive #40 opt-in resolver.
 *
 * Product default stays `fixed_uct` / `#40` off. Mission or config must
 * explicitly opt in to anneal `c(t)` + Elite soft-switch. Environment
 * variables never flip the default.
 *
 *   c(t) = c0 / (1 + t / tau)
 *   w(t) = min(1, t / tau)
 *
 * Elite scores influence inner parent selection only when opted in.
 * Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deepFreeze } from "../security-boundary";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  PROGRESSIVE_MCGS_OPT_IN_ID,
  SELECTION_POLICY_40,
  SELECTION_POLICY_40_OPT_IN,
  createDefaultSearchSelectionPort,
  createSearchSelectionPort,
  type ProgressiveMcgsOptions,
  type SearchSelectionAdapterId,
  type SearchSelectionPort,
  type SelectionPolicy40State,
} from "./search-selection-port";

/** Elite is never 晋级 / Promotion / Broker / kill-test / Admission authority. */
export const ELITE_IS_NOT_JINJI = true as const;
export const ELITE_ROLE_WHEN_OPTED_IN = "inner-selection-only" as const;

export const SEARCH_SELECTION_CONFIG_RELATIVE_PATH = join(".evok", "search.json");

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

export type SearchSelectionResolveSource = "default" | "mission" | "config";

export interface ProgressiveOptInConfig extends ProgressiveMcgsOptions {
  readonly enabled?: boolean;
  readonly selectionId?: string;
  readonly selectionPolicy40?: string;
  readonly progressive?: boolean;
}

export interface ProgressiveOptInFields extends ProgressiveMcgsOptions {
  readonly progressive?: boolean | ProgressiveOptInConfig;
  readonly searchSelection?: string | ProgressiveOptInConfig;
  readonly selectionId?: string;
  readonly selectionPolicy40?: string;
}

export interface MissionSearchSelectionSource extends ProgressiveOptInFields {
  readonly mission?: ProgressiveOptInFields;
  readonly config?: ProgressiveOptInFields;
}

export interface ResolveSearchSelectionOptions {
  readonly from?: Exclude<SearchSelectionResolveSource, "default">;
}

export interface ResolvedSearchSelection {
  readonly port: SearchSelectionPort;
  readonly selectionId: SearchSelectionAdapterId;
  readonly selectionPolicy40: SelectionPolicy40State;
  readonly productDefault: boolean;
  readonly source: SearchSelectionResolveSource;
  readonly anneal: boolean;
  readonly eliteInnerOnly: typeof ELITE_ROLE_WHEN_OPTED_IN extends "inner-selection-only" ? true : never;
  readonly eliteIsJinji: false;
  readonly eliteIsPromotionKey: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoPromotionKeys(value: object, label: string): void {
  for (const field of PROMOTION_KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label} must not emit Elite / MMD / near-dup / side-slot promotion keys`);
    }
  }
}

function asFields(value: unknown): ProgressiveOptInFields | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) throw new TypeError("search selection source must be an ordinary object");
  assertNoPromotionKeys(value, "search selection source");
  return value as ProgressiveOptInFields;
}

function asConfigObject(value: unknown): ProgressiveOptInConfig | undefined {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string") {
    return undefined;
  }
  if (!isPlainRecord(value)) throw new TypeError("progressive opt-in config must be an ordinary object");
  assertNoPromotionKeys(value, "progressive opt-in config");
  return value as ProgressiveOptInConfig;
}

function isProgressiveId(value: unknown): boolean {
  return value === PROGRESSIVE_MCGS_OPT_IN_ID;
}

function isExplicitOptInPolicy(value: unknown): boolean {
  return value === SELECTION_POLICY_40_OPT_IN || value === "on";
}

function layerOptsIn(layer: ProgressiveOptInFields | undefined): boolean {
  if (layer === undefined) return false;
  if (layer.progressive === true) return true;
  if (isProgressiveId(layer.selectionId) || isProgressiveId(layer.searchSelection)) return true;
  if (isExplicitOptInPolicy(layer.selectionPolicy40)) return true;
  const progressive = asConfigObject(layer.progressive);
  if (progressive?.enabled === true || isProgressiveId(progressive?.selectionId) || isExplicitOptInPolicy(progressive?.selectionPolicy40)) {
    return true;
  }
  const searchSelection = asConfigObject(layer.searchSelection);
  if (searchSelection?.enabled === true || searchSelection?.progressive === true
    || isProgressiveId(searchSelection?.selectionId) || isExplicitOptInPolicy(searchSelection?.selectionPolicy40)) {
    return true;
  }
  return false;
}

function pickOption<K extends keyof ProgressiveMcgsOptions>(
  layers: readonly (ProgressiveOptInFields | undefined)[],
  key: K,
): ProgressiveMcgsOptions[K] | undefined {
  for (const layer of layers) {
    if (layer === undefined) continue;
    const direct = layer[key];
    if (direct !== undefined) return direct;
    const fromProgressive = asConfigObject(layer.progressive)?.[key];
    if (fromProgressive !== undefined) return fromProgressive;
    const fromSearch = asConfigObject(layer.searchSelection)?.[key];
    if (fromSearch !== undefined) return fromSearch;
  }
  return undefined;
}

function adapterOptions(layers: readonly (ProgressiveOptInFields | undefined)[]): ProgressiveMcgsOptions {
  const exploration = pickOption(layers, "exploration");
  const seed = pickOption(layers, "seed");
  const topK = pickOption(layers, "topK");
  const tau = pickOption(layers, "tau");
  return {
    ...(exploration === undefined ? {} : { exploration }),
    ...(seed === undefined ? {} : { seed }),
    ...(topK === undefined ? {} : { topK }),
    ...(tau === undefined ? {} : { tau }),
  };
}

function resolveSource(
  requested: ResolveSearchSelectionOptions["from"],
  source: MissionSearchSelectionSource | undefined,
): SearchSelectionResolveSource {
  if (requested !== undefined) return requested;
  if (source?.mission !== undefined && layerOptsIn(source.mission)) return "mission";
  if (source?.config !== undefined && layerOptsIn(source.config)) return "config";
  return "config";
}

function freezeResolved(input: Omit<ResolvedSearchSelection, "eliteInnerOnly" | "eliteIsJinji" | "eliteIsPromotionKey">): ResolvedSearchSelection {
  const resolved = {
    ...input,
    eliteInnerOnly: true as const,
    eliteIsJinji: false as const,
    eliteIsPromotionKey: false as const,
  };
  assertNoPromotionKeys(resolved, "resolved search selection");
  return deepFreeze(resolved) as ResolvedSearchSelection;
}

/**
 * Resolve parent selection from an explicit Mission or config object.
 * Missing / empty / false stays `fixed_uct`. Env is never consulted.
 */
export function resolveSearchSelection(
  source?: MissionSearchSelectionSource | null,
  options: ResolveSearchSelectionOptions = {},
): ResolvedSearchSelection {
  const root = source === undefined || source === null ? undefined : asFields(source);
  const mission = source === undefined || source === null ? undefined : asFields(source.mission);
  const config = source === undefined || source === null ? undefined : asFields(source.config);
  const layers = [root, mission, config];
  const optedIn = layers.some(layerOptsIn);

  if (!optedIn) {
    const port = createDefaultSearchSelectionPort();
    return freezeResolved({
      port,
      selectionId: DEFAULT_SEARCH_SELECTION_ID,
      selectionPolicy40: SELECTION_POLICY_40,
      productDefault: true,
      source: "default",
      anneal: false,
    });
  }

  const port = createSearchSelectionPort(PROGRESSIVE_MCGS_OPT_IN_ID, adapterOptions(layers));
  return freezeResolved({
    port,
    selectionId: PROGRESSIVE_MCGS_OPT_IN_ID,
    selectionPolicy40: SELECTION_POLICY_40_OPT_IN,
    productDefault: false,
    source: resolveSource(options.from, source ?? undefined),
    anneal: true,
  });
}

/**
 * Explicit project config (`.evok/search.json`). A missing file is default-off.
 * Env vars never substitute for the file.
 */
export function readSearchSelectionConfig(projectRoot: string): ProgressiveOptInFields | undefined {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("projectRoot must be a non-empty string");
  }
  const file = join(projectRoot, SEARCH_SELECTION_CONFIG_RELATIVE_PATH);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new TypeError(`search.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainRecord(parsed)) throw new TypeError("search.json must be an ordinary object");
  assertNoPromotionKeys(parsed, "search.json");
  return parsed as ProgressiveOptInFields;
}
