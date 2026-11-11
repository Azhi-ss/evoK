# Research Program — verified source map

> Verified against `main` at `d9b9e21` (2026-11-11), after the Research Memory /
SQLite / `memory_read` merges. This is the first deliverable required by
`docs/research-program-prd.md` §13. It is a code map, not an implementation.

## Current production path

```text
CLI start/resume
  → startAuthorizedMission / resumeAuthorizedMission
  → runMissionController
      ├─ baseline / experiment dispatch (PiAgentRuntime)
      ├─ snapshot + independent evaluator
      ├─ Director Blind Proposal → Memory-informed Revision
      └─ stop on policy / budget / director / maxExperiments
```

The mainline is still bounded by `maxExperiments` and explicit start/resume.
The Research Program PRD is **not implemented** by the recent documentation and
memory commits.

## Component classification

| Component | Current evidence | Required action | Notes |
|---|---|---|---|
| `runMissionController` (`src/mission/mission-start.ts`) | Production controller for baseline, experiments, Director, snapshots and stop states | **Modify** | Extend into the only long-running execution loop. Do not add a second controller with dispatch authority. |
| `PiAgentRuntime` / sandbox / snapshot | Production execution and immutable measurement path | **Wire/reuse** | Keep as ResearchNode executor. Program logic must not bypass its preflight or evaluator. |
| Director Blind→Revision (`src/mission/mission-director.ts`) | Already called by the mainline with durable observation projection | **Wire/reuse** | Keep two-stage decision and policy validation. Research planning remains a proposal, never direct dispatch. |
| Campaign + `generateTasks` (`src/mission/research-loop.ts`) | Implemented and tested, but Campaign planning is not consumed by the mainline | **First activation** | Use for evidence-driven plan generation/revision. Validate current semantics before treating it as the Program engine. |
| `CampaignMilestoneState` | Exists in `research-loop.ts`; no mainline consumer | **First activation** | Map to Research Completion Contract and progress projection; do not assume it already drives convergence. |
| `dag-scheduler.ts` | Generic dependency scheduler with tests; no production caller | **First activation** | Treat as new production code. Sequential Ready-node selection only; no parallel fan-out. |
| `file-blueprint.ts` GOAL / EXPERIMENTS / SCOREBOARD | Content-addressed artifacts and schemas exist; mainline does not use them for long-running research | **First activation / wire** | Use as derived Program/report projections, not a separate authority or score channel. |
| Mission `MissionRecord` + `history` | Durable authoritative state for current CLI Missions | **Modify** | Add plan/node/attempt/convergence/terminal records without creating another write authority. |
| `research-loop.ts` `ResearchLedger` | Separate event-sourced in-memory projection used by research/insight code | **Modify/adapt carefully** | Do not activate a second durable store. Supply a Mission-history-backed adapter or derive its state from the canonical Mission ledger. |
| Research Memory (`src/memory/`, SQLite, `memory_read`) | Merged and used for derived, snapshot-pinned memory reads | **Wire/reuse** | Remains derived, read-only and decision-point scoped. It is not the Program store. |
| Convergence Auditor | No production implementation matching the PRD | **New gate, not new controller** | Read-only evidence audit against a pre-declared completion contract; no proposals, dispatch, objective or budget edits. |
| Typed node contracts | Current PRD defines desired schemas; the earlier task/scientific-suite experiment is only stashed | **New validation, optional reuse** | Do not make Research Program depend on the stash. Any salvaged evaluator must be reviewed independently. |

## Canonical ledger warning

There are currently two different representations relevant to this work:

1. Durable `MissionRecord` / `history` used by the CLI controller;
2. Event-sourced `ResearchLedger` used by `research-loop.ts` and Insight/memory projections.

Activating Campaign/DAG by simply persisting the second representation would create
a second control plane and risk divergent state. The implementation must choose a
Mission-history-backed adapter (or an equivalent one-way derivation) so all plan,
node, attempt and convergence facts resolve back to the canonical Mission ledger.
SQLite Research Memory is explicitly outside this authority boundary.

## Minimal vertical slice after this map

1. Introduce versioned ResearchPlan/ResearchNode/NodeAttempt records in the canonical Mission history.
2. Activate Campaign/`generateTasks` for a sequential Literature→Environment→Baseline→Implement→Measure→Analyze→Report slice.
3. Use DAG Scheduler only to compute the next Ready node; `runMissionController` retains every dispatch decision.
4. Add a read-only convergence assessment and explicit terminal states (`supported`, `falsified`, `inconclusive`, `blocked`, `budget_exhausted`, etc.).
5. Verify crash recovery from the ledger without blindly repeating confirmed work or double-charging.

## Required acceptance tests for first activation

- No manual `/resume` between different node types in the sequential slice.
- No dispatch from Campaign, DAG Scheduler, Memory, File Blueprint or Auditor.
- Plan revisions preserve parent versions, evidence reasons and scope checks.
- A protocol change creates a new protocol version; old measurements are not overwritten.
- A direction can terminate as `falsified` or `inconclusive` without being reported as a success.
- Recovery never repeats a confirmed node or duplicates metered cost.

## Current status of the stashed scientific experiment

`task-evaluator` / `scientific-suite` and related earlier patches remain unmerged in
`stash@{1}`. The Research Program PRD explicitly says node types are new work and
must not depend on that stash. Do not restore it wholesale, especially because the
same stash contains unrelated `harness-opt` changes. Salvage only after the Program
source interfaces are stable and each change has an independent regression test.
