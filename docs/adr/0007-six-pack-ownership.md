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
| **competition** | Contest and local Evaluator adapters; Deploy Arena standby (not mainline) | True External Submission (still frozen) |
| **cli** | Thin Mission CLI shell + Pi native TUI | A second control plane |

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

## Amendment (ET-A3 / #123)

The physical `src/mission/` + `src/cli/` cut is recorded in
[ADR-0010](0010-mission-cli-physical-pack.md). This ADR's logical ownership
map is unchanged.

## Amendment (ET-A4 / #124)

The physical `src/execution/` cut is recorded in
[ADR-0011](0011-execution-physical-pack.md). This ADR's logical ownership
map is unchanged.

## Amendment (ET-A5 / #125)

The physical `src/competition/` cut is recorded in
[ADR-0012](0012-competition-physical-pack.md). This ADR's logical ownership
map is unchanged.

## Amendment (ET-A6 / #132)

Physical six-pack layout is complete. Recorded in
[ADR-0013](0013-six-pack-physical-closeout.md). This ADR's logical
ownership map is unchanged. Remaining pack-shim flat `src/*.ts` files
(not shared wiring such as `evok-model`) are migration-period re-exports
for one more release.

## Amendment (ET-ADR-PRD / #136)

Product baseline is the task-internal RSI PRD v1.0. Recorded in
[ADR-0014](0014-prd-rsi-baseline.md). The six-package list is unchanged.
The Owns notes for **cli** (Pi native TUI) and **competition** (Deploy
Arena standby) are extended in the table above. Interactive surface is
Pi native TUI (#134 / PR #135). `ToyHarness` remains fixtures/tests only
— not a second control plane.

## Out of scope / freezes

- No change to gate, T48, hang, or #40 semantics.
- No change to `SearchSelectionPort` or `runGoldenPath` behavior.
- No `src/*.ts` logic change.
- No true contest External Submission.
- No Elite-as-promotion.
- No C thicken of the execution roster.
- P6 residue cleanup is recorded in ADR-0013 (no second package move).

Domain vocabulary for these terms lives in `CONTEXT.md`.
