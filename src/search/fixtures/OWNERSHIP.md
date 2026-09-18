# Ownership

These ToyHarness files belong to the **search** package as **fixtures/tests
only** (ET-A2 / #122). They are not a second control plane and cannot
authorize, continue, repair, or stop a Mission.

- `toy-harness.ts` — `ToyCompetitionHarness` and the fixture barrel
- `second-toy-adapter.ts` — second toy competition adapter

Do not route new Mission / orchestration authority through this directory.
Flat `src/toy-harness.ts` and `src/second-toy-adapter.ts` remain
compatibility re-exports.
