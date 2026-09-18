---
status: accepted
---

# 0007 — Six-pack ownership and Research Loop authority

Docs-only pin of the ET-A0 / #120 architecture map. No physical package
moves. No Pattern implementation. No code semantics change.

## Decision

evoK's logical ownership is six packages. Agents (the Pi SDK Run runtime)
are replaceable execution and do not own Mission decisions. The chat
transcript is not authority.

| Package | Owns | Does not own |
|---|---|---|
| **mission** | Mission Director, authorize, budget, Task Contract, continue / repair / stop | Business/competition code; search-graph authority; Team blueprint details |
| **evidence** | Ledger, T48, kill/hang, promotion gates, authoritative edge results | Search tree structure; Team Coordinator / Role planning |
| **execution** | Dynamic Team: Pattern, Team Coordinator, Roles, runtime, Policy Guard | Gate override; replacing the Evaluator. Thin execution default already landed — do not reopen C thickening |
| **search** | Pluggable harness, candidate/attempt graph, failure neighborhood, retrieval slicing | Promotion; gate override |
| **competition** | Contest and local Evaluator adapters | True External Submission (still frozen) |
| **cli** | Thin Mission CLI shell | A second control plane |

The product control plane is the Research Loop: authorize, continue,
repair, and stop. Human-owned Research Objective and Mission Policy bound
that loop; a chat transcript cannot authorize, continue, repair, or stop
a Mission.

`ToyHarness` (`ToyCompetitionHarness` and kin) is fixtures and tests only.
It is not a second control plane.

The **Thin execution default** already recorded in `CONTEXT.md` stays in
force: default Branch width is 1; verification Roles are on-demand;
thickening the Pattern library or a full standing roster as v1 must-haves
is rejected (C). This ADR does not reopen that pin.

Physical layout remains a flat `src/` tree in this decision. Package
directory moves are later tickets.

## Amendment (ET-A1 / #121)

The physical `src/evidence/` cut is recorded in
[ADR-0008](0008-evidence-physical-pack.md). This ADR's logical ownership
map is unchanged.

## Amendment (ET-A2 / #122)

The physical `src/search/` cut is recorded in
[ADR-0009](0009-search-physical-pack.md). This ADR's logical ownership
map is unchanged.

## Out of scope / freezes

- No change to gate, T48, hang, or #40 semantics.
- No change to `SearchSelectionPort` or `runGoldenPath` behavior.
- No `src/*.ts` logic change.
- No true contest External Submission.
- No Elite-as-promotion.
- No C thicken of the execution roster.
- No P3 / P4 / P5 physical package moves.

Domain vocabulary for these terms lives in `CONTEXT.md`.
