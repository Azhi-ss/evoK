# search

search 持结构（树 / 尝试边、选父本、邻域诊断）；evidence 写权威边结果；
Mission 只读摘要。

Physical home of `SearchSelectionPort`, SearchSpaceProfile / outer
search-space fixtures, and **fixtures/tests-only** ToyHarness.

P6: physical pack is in place. Remaining flat `src/*.ts` files are
migration-period re-exports for one more release
([ADR-0013](../../docs/adr/0013-six-pack-physical-closeout.md)).
The dead `src/second-toy-adapter.ts` shim is gone; import
`src/search/fixtures/second-toy-adapter` instead.

Default parent selection remains `fixed_uct` (constant exploration √2).
Progressive (`progressive_mcgs_optin` / `StrongSearchAdapter`) is constructed
only when Mission or config explicitly opts in — `{ strongSearch: true }` /
`strong_search` is the same #99 alias. Env must not silently
override the default. `#40` SelectionPolicy stays off unless that opt-in
is set. Anneal `c(t)` + Elite soft-switch are inner selection only.
Elite ≠ 晋级 / Promotion / hang / Broker keys. Spec:
[`docs/progressive-opt-in.md`](../../docs/progressive-opt-in.md).

W1 SEA (`sea-plugin.ts`): mount / unmount a removable MCTS / Progressive /
StrongSearch plugin. The default path does not depend on the plugin. MCTS
is a mount-only skeleton — selection math is not opened. Method-version
stats (`method-version-stats.ts`) isolate visit/value rows after a version
switch; old-version stats are history, not the new authority.

`ToyHarness` (`ToyCompetitionHarness` and kin) lives under `fixtures/` and
is not a product control plane. Do not route new Mission / orchestration
authority through it. `ToyCompetitionAdapter.evaluate` (eval) is not
`SearchSelectionPort.selectParent` (parent selection).
