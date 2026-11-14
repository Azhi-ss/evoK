---
status: accepted
---

# 0011 — Physical `src/execution/` pack (ET-A4 / #124)

Physical cut of the execution package. Logical ownership stays the
six-pack map in [ADR-0007](0007-six-pack-ownership.md). No gate, T48,
hang, `#40`, or thin-default (B) behavior change.

## Decision

Team / runtime / security modules live under `src/execution/`:

- Team: `team-execution` (Coordinator, PolicyGuard, DeterministicScheduler,
  ArtifactFanIn), `dag-scheduler` (Team DAG + MissionQueue)
- Runtime: `pi-agent-runtime`, `model-orchestra`
- Security: `security-boundary`, plus the existing `pi-security*` and
  `team-security*` contracts
- Optional empty-shell Pattern specs: `patterns/contest-loop.md`,
  `dual-arm.md`, `research-thin.md`

Amendment (M1-T1 / #210): Research Memory serving lives here
(`research-memory-provider`, `memory-slice` `evok.memory-slice/v3`). It
stores and serves the evidence-pack projection under the Mission's
git-ignored `memory/` namespace; v2 slices keep their exact shape and
digest. It does not add a context assembler, a second ledger, or any
gate authority.

Amendment (M1-T8 / #217): delegation injection lives here too. A delegated
child agent receives a **Delegated Memory Slice** (`deriveDelegatedMemorySlice`
in `memory-slice`) generated for its own Mission/Task/Run/targetAgent from the
parent's pinned snapshot, served by `createDelegatedResearchMemoryProvider`
(pinned to one child Run, never the active pointer) and enforced by the
`subagents-adapter` guard before any transport/session exists. The parent's own
slice, a sibling's, a previous Run's, or a slice from another snapshot fails
closed; a v2 parent keeps its v2 shape. Trusted Evaluator/Executor contexts stay
uninjected, and nothing here assembles a second context or touches Mission
dispatch.

Amendment (M2-T226 / #226): the child transport's durable records stay under
`src/execution/`. `pi-child-dispatch` holds the single deadline and the confirmed
termination outcome (`termination_unconfirmed` carries the request id), and
`pi-child-records` is the one guard that keeps provider configs, API keys and tool
tokens out of every persisted launch/fence/receipt record. No new gate or
delegation authority.

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

Later note (2026-11-14 layout simplification): those flat re-exports are deleted. Import this pack. See ADR-0013.

**Boundary:** execution owns dynamic Team — Pattern, Team Coordinator,
Roles, runtime, Policy Guard. It does not own gate override or replace
the Evaluator. Hang / T48 stay in `src/evidence/`. Search structure stays
in `src/search/`. Mission authorize / continue / repair / stop stay in
`src/mission/`. CLI stays a thin shell in `src/cli/`.

**Thin execution default (B)** is unchanged:

- `DEFAULT_BRANCH_WIDTH=1`
- Verification Roles run only when callbacks are provided
- PolicyGuard defaults do not force a Falsifier roster

Pattern files are read-only specs (who plays / advance conditions).
They contain no orchestration code and do not force a Coordinator
runtime track-switch. A standing verification roster is not an advance
condition. C thickening (full Antigravity roster as v1 must-have) is
rejected. Elite / side-slots / Team Fan-Out are not Promotion keys.

`evok-model` and `evok-resources` stay at `src/` (shared wiring).
`idea-types` stays at `src/` (P5 may revisit).

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- No weld of `#40` / Progressive as product default.
- No real contest submit path enabled.
- No move of `src/mission/`, `src/cli/`, `src/evidence/`, or `src/search/`.
- No start of ET-A5 (`competition/`).
- No C thicken of the execution roster.
- No Elite / side-slot / Team Fan-Out as Promotion keys.
