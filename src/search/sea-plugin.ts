/**
 * W1 SEA plugin contract skeleton (ET-M1-SEA / #146).
 *
 * Mount / unmount a removable strong-search / MCTS plugin. The default
 * parent-selection path is `fixed_uct` and does not depend on any plugin.
 * Progressive / MCTS / StrongSearch stay explicit opt-in. `#40` stays off.
 *
 * MCTS mount is expressible; selection math is not opened. Progressive
 * opt-in reuses the existing adapter. This module does not call ledger /
 * hang / Broker, does not change EXP Admission or Budget Gate predicates,
 * and does not treat Elite / MMD / near-dup / side-slot as Promotion keys.
 */
import { deepFreeze } from "../security-boundary";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  StrongSearchAdapter,
  createDefaultSearchSelectionPort,
  createSearchSelectionPort,
  type FixedUctSelectionOptions,
  type ProgressiveMcgsOptions,
  type SearchSelectionPort,
} from "./search-selection-port";

export const SEA_PLUGIN_KIND_MCTS = "mcts" as const;
export const SEA_PLUGIN_KIND_PROGRESSIVE = "progressive_mcgs_optin" as const;
export const SEA_PLUGIN_KIND_STRONG = "strong_search" as const;
export type SeaPluginKind =
  | typeof SEA_PLUGIN_KIND_MCTS
  | typeof SEA_PLUGIN_KIND_PROGRESSIVE
  | typeof SEA_PLUGIN_KIND_STRONG;

export type SeaHostRole = "search-plugin-host";

const SEA_KINDS = new Set<SeaPluginKind>([
  SEA_PLUGIN_KIND_MCTS,
  SEA_PLUGIN_KIND_PROGRESSIVE,
  SEA_PLUGIN_KIND_STRONG,
]);

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

export interface SeaPlugin {
  readonly id: string;
  readonly kind: SeaPluginKind;
  createPort?(options?: ProgressiveMcgsOptions): SearchSelectionPort;
}

export interface SeaMount {
  readonly pluginId: string;
  readonly kind: SeaPluginKind;
}

export interface SeaHostDescription {
  readonly defaultSelectionId: typeof DEFAULT_SEARCH_SELECTION_ID;
  readonly selectionPolicy40: typeof SELECTION_POLICY_40;
  readonly pluginMounted: boolean;
  readonly role: SeaHostRole;
  readonly pluginId?: string;
  readonly pluginKind?: SeaPluginKind;
}

export class SeaPluginNotMountedError extends Error {
  readonly kind = "sea-plugin-not-mounted" as const;
  constructor(message = "SEA plugin is not mounted") {
    super(message);
    this.name = "SeaPluginNotMountedError";
  }
}

export class SeaPluginSelectionNotOpenedError extends Error {
  readonly kind = "sea-plugin-selection-not-opened" as const;
  constructor(message = "SEA plugin selection math is not opened — mount contract skeleton only") {
    super(message);
    this.name = "SeaPluginSelectionNotOpenedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertNoPromotionKeys(value: object, label: string): void {
  for (const field of PROMOTION_KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label} must not emit Elite / MMD / near-dup / side-slot promotion keys`);
    }
  }
}

function normalizeId(value: unknown): string {
  nonEmpty("plugin id", value);
  return value.trim();
}

function normalizeKind(value: unknown): SeaPluginKind {
  if (typeof value !== "string" || !SEA_KINDS.has(value as SeaPluginKind)) {
    throw new RangeError(`unknown SEA plugin kind: ${String(value)}`);
  }
  return value as SeaPluginKind;
}

function normalizePlugin(value: unknown): SeaPlugin {
  if (!isPlainRecord(value)) throw new TypeError("SEA plugin must be an ordinary object");
  assertNoPromotionKeys(value, "SEA plugin");
  const id = normalizeId(value.id);
  const kind = normalizeKind(value.kind);
  if (value.createPort !== undefined && typeof value.createPort !== "function") {
    throw new TypeError("SEA plugin createPort must be a function");
  }
  return {
    id,
    kind,
    ...(typeof value.createPort === "function"
      ? { createPort: value.createPort as SeaPlugin["createPort"] }
      : {}),
  };
}

function freezeMount(plugin: SeaPlugin): SeaMount {
  return deepFreeze({ pluginId: plugin.id, kind: plugin.kind }) as SeaMount;
}

export class SeaHost {
  private plugin: SeaPlugin | undefined;

  mount(plugin: SeaPlugin): SeaMount {
    const normalized = normalizePlugin(plugin);
    if (this.plugin !== undefined) {
      throw new RangeError("SEA plugin already mounted; unmount before mounting another");
    }
    this.plugin = normalized;
    return freezeMount(normalized);
  }

  unmount(): void {
    this.plugin = undefined;
  }

  mounted(): SeaMount | undefined {
    return this.plugin === undefined ? undefined : freezeMount(this.plugin);
  }

  /** Product default. Independent of mount state. */
  defaultSelection(options: FixedUctSelectionOptions = {}): SearchSelectionPort {
    return createDefaultSearchSelectionPort(options);
  }

  /**
   * Explicit opt-in. Requires a mounted plugin. MCTS remains a mount-only
   * skeleton — Progressive / StrongSearch reuse the existing opt-in adapter.
   */
  optInSelection(options: ProgressiveMcgsOptions = {}): SearchSelectionPort {
    if (this.plugin === undefined) throw new SeaPluginNotMountedError();
    if (this.plugin.createPort === undefined) {
      throw new SeaPluginSelectionNotOpenedError();
    }
    return this.plugin.createPort(options);
  }

  describe(): SeaHostDescription {
    const mounted = this.plugin !== undefined;
    const description = {
      defaultSelectionId: DEFAULT_SEARCH_SELECTION_ID,
      selectionPolicy40: SELECTION_POLICY_40,
      pluginMounted: mounted,
      role: "search-plugin-host" as const,
      ...(mounted ? { pluginId: this.plugin!.id, pluginKind: this.plugin!.kind } : {}),
    };
    assertNoPromotionKeys(description, "SEA host describe");
    return deepFreeze(description) as SeaHostDescription;
  }
}

export function createSeaHost(): SeaHost {
  return new SeaHost();
}

export function createMctsSeaPlugin(id = SEA_PLUGIN_KIND_MCTS): SeaPlugin {
  return deepFreeze({
    id: normalizeId(id),
    kind: SEA_PLUGIN_KIND_MCTS,
  }) as SeaPlugin;
}

export function createProgressiveSeaPlugin(id = SEA_PLUGIN_KIND_PROGRESSIVE): SeaPlugin {
  return deepFreeze({
    id: normalizeId(id),
    kind: SEA_PLUGIN_KIND_PROGRESSIVE,
    createPort: (options: ProgressiveMcgsOptions = {}) =>
      createSearchSelectionPort("progressive_mcgs_optin", options),
  }) as SeaPlugin;
}

export function createStrongSearchSeaPlugin(id = SEA_PLUGIN_KIND_STRONG): SeaPlugin {
  return deepFreeze({
    id: normalizeId(id),
    kind: SEA_PLUGIN_KIND_STRONG,
    createPort: (options: ProgressiveMcgsOptions = {}) => new StrongSearchAdapter(options),
  }) as SeaPlugin;
}
