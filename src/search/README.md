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
only when explicitly selected — env must not silently override the default.
`#40` SelectionPolicy stays off. Elite / MMD / near-dup / side-slot scores
are not Promotion, hang, or Broker keys.

`ToyHarness` (`ToyCompetitionHarness` and kin) lives under `fixtures/` and
is not a product control plane. Do not route new Mission / orchestration
authority through it. `ToyCompetitionAdapter.evaluate` (eval) is not
`SearchSelectionPort.selectParent` (parent selection).
