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

## Amendment (ET-M1-SEA / #146)

W1 SEA skeleton lives in this pack: `sea-plugin.ts` (mount /
unmount) and `method-version-stats.ts` (version-scoped visit/value
rows). Default parent selection remains `fixed_uct`. Progressive /
MCTS / StrongSearch stay explicit opt-in. `#40` stays off. The
default path does not depend on a plugin. Old-version stats are
not new-version authority. Selection math, gate predicates, and
ToyHarness-as-control-plane are unchanged.

## Amendment (ET-PROG-40 / #178)

`#40` Progressive is usable as **explicit opt-in**. Product default
remains `fixed_uct`; `#40` stays off unless Mission or
`.evok/search.json` / config opts in. Env must not silently override
the default. Opt-in enables anneal `c(t) = c0 / (1 + t / tau)` and
Elite soft-switch `w(t) = min(1, t / tau)` for **inner parent
selection only**.

**Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key.**
Gate / T48 / hang / Broker predicates, true submit, and Deploy Arena
are unchanged. Progressive is not welded as the product default.
