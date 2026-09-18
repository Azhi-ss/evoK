# Ownership

These ToyHarness files belong to the **search** package as **fixtures/tests
only** (ET-A2 / #122). They are not a second control plane and cannot
authorize, continue, repair, or stop a Mission.

- `toy-harness.ts` — `ToyCompetitionHarness` and the fixture barrel
- `second-toy-adapter.ts` — second toy competition adapter

Do not route new Mission / orchestration authority through this directory.
Flat `src/toy-harness.ts` remains a migration-period re-export for one
more release (P6 / ADR-0013). The dead `src/second-toy-adapter.ts` shim
is gone — import `./second-toy-adapter` here.
