/**
 * ET-ORCH-GAP / #99 — StrongSearch opt-in helpers.
 *
 * StrongSearch is an explicit alias of the existing Progressive /
 * `StrongSearchAdapter` port. The product default stays `fixed_uct`.
 * Progressive stays opt-in / off. Env never flips the default.
 * Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key.
 */
import {
  STRONG_SEARCH_OPT_IN_ID,
  StrongSearchAdapter,
  type ProgressiveMcgsOptions,
  type SearchSelectionPort,
} from "./search-selection-port";
import {
  createSeaHost,
  createStrongSearchSeaPlugin,
  type SeaHost,
} from "./sea-plugin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStrongSearchId(value: unknown): boolean {
  return value === STRONG_SEARCH_OPT_IN_ID;
}

/**
 * Detect an explicit StrongSearch opt-in on one Mission/config layer.
 * Missing / false / empty stays off.
 */
export function layerOptsInStrongSearch(layer: {
  readonly strongSearch?: unknown;
  readonly selectionId?: unknown;
  readonly searchSelection?: unknown;
} | undefined): boolean {
  if (layer === undefined) return false;
  if (layer.strongSearch === true) return true;
  if (isStrongSearchId(layer.selectionId) || isStrongSearchId(layer.searchSelection)) return true;
  if (isRecord(layer.strongSearch) && (
    layer.strongSearch.enabled === true
    || isStrongSearchId(layer.strongSearch.selectionId)
  )) {
    return true;
  }
  if (isRecord(layer.searchSelection) && layer.searchSelection.strongSearch === true) {
    return true;
  }
  return false;
}

/** Construct the StrongSearch port. Does not change the product default factory. */
export function optInStrongSearchPort(options: ProgressiveMcgsOptions = {}): SearchSelectionPort {
  return new StrongSearchAdapter(options);
}

/**
 * Mount the removable StrongSearch SEA plugin and return its opt-in port.
 * `host.defaultSelection()` stays `fixed_uct`.
 */
export function mountStrongSearchOptIn(host: SeaHost = createSeaHost()): {
  readonly host: SeaHost;
  readonly port: SearchSelectionPort;
} {
  if (host.mounted() === undefined) {
    host.mount(createStrongSearchSeaPlugin());
  }
  return { host, port: host.optInSelection() };
}
