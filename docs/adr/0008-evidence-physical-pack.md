---
status: accepted
---

# 0008 — Physical `src/evidence/` pack (ET-A1 / #121)

Physical cut of the evidence package. Logical ownership stays the six-pack
map in [ADR-0007](0007-six-pack-ownership.md). No gate, T48, hang, or Broker
predicate change.

## Decision

Gate-authority modules live under `src/evidence/`:

- ledger: `hypothesis-ledger` (write/projection in the same module), `ledger-kinds`
- hang: `kill-test-hang`
- methodology: `methodology`, `methodology-contracts`, `methodology-acceptance`, ME-1 seam tests
- gates: `verification-gates`, `validation-ladder`
- Broker simulation: `submission-broker`

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

**Boundary:** evidence 独占门权威；search 持结构；mission 只读摘要 / 挂 hang.

Methodology fixtures stay at `src/fixtures/methodology/` with an ownership
pin. True contest External Submission stays frozen. Elite / Team Fan-Out are
not Promotion keys. Pattern C is not thickened.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No real contest submit path enabled.
- No move of `search-selection-port` / Progressive, `runGoldenPath` / mission-*,
  `llm-comp-arm*` runtime, or Team orchestra.
- No `#40` / default `fixed_uct` / Progressive default change.
