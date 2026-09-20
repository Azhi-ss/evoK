/**
 * Physical search pack (ET-A2 / #122).
 *
 * Owns parent selection and search-space / neighborhood structure.
 * ToyHarness and the second toy adapter are fixtures/tests only under
 * `./fixtures` — not a second control plane, and not re-exported here.
 *
 * Default selection stays `fixed_uct`. Progressive
 * (`progressive_mcgs_optin`) is explicit Mission/config opt-in only.
 * `#40` stays off unless that opt-in is set. Env never flips the default.
 *
 * W1 SEA (#146): removable plugin mount/unmount + method-version stats
 * isolation live here. The default path does not depend on a plugin.
 */
export * from "./search-selection-port";
export * from "./progressive-opt-in";
export * from "./search-space-profile";
export * from "./outer-search-space-fixtures";
export * from "./sea-plugin";
export * from "./method-version-stats";
export * from "./suite-lift-circle";
