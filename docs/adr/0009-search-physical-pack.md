---
status: accepted
---

# 0009 — Physical `src/search/` pack (ET-A2 / #122)

Physical cut of the search package. Logical ownership stays the six-pack
map in [ADR-0007](0007-six-pack-ownership.md). No selection-math, gate,
T48, hang, or `#40` change.

## Decision

Search-structure modules live under `src/search/`:

- selection: `search-selection-port`
- search-space: `search-space-profile`, `outer-search-space-fixtures`
- fixtures/tests only: `fixtures/toy-harness`, `fixtures/second-toy-adapter`

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

**Boundary:** search 持结构；evidence 独占门权威；Mission 只读摘要。
`ToyHarness` is fixtures and tests only — not a second control plane.
Do not route new Mission / orchestration authority through it.

Default parent selection remains `fixed_uct`. Progressive
(`progressive_mcgs_optin`) is explicit opt-in only; environment variables
must not silently override the default. `#40` SelectionPolicy stays off.
Elite / MMD / near-dup / side-slot scores are not Promotion, hang, or
Broker keys. The port does not call ledger / hang / Broker.

## Out of scope / freezes

- No weld of Progressive or `#40` as product default.
- No change to gate three-state, T48, hang, or Broker predicates.
- No real contest submit path enabled.
- No move of `Azhi-ss/algorithm-evolve`, `runGoldenPath` hang semantics,
  `llm-comp-arm*` runtime, or Team orchestra.
- No C thicken of the execution roster.
- No FAISS / Retrospective Memory / Procedural Graph implementation.
