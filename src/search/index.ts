/**
 * Physical search pack (ET-A2 / #122).
 *
 * Owns parent selection and search-space / neighborhood structure.
 * ToyHarness and the second toy adapter are fixtures/tests only under
 * `./fixtures` — not a second control plane, and not re-exported here.
 *
 * Default selection stays `fixed_uct`. Progressive
 * (`progressive_mcgs_optin`) is explicit opt-in only. `#40` stays off.
 */
export * from "./search-selection-port";
export * from "./search-space-profile";
export * from "./outer-search-space-fixtures";
