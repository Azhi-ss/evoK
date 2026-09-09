# evok v1 — minimal implementation plan

Design handoff based on ADR-0004/0005/0006 and `mission-intake-skill.md`. The agreed scope is published as [Spec #108](https://github.com/Azhi-ss/evoK/issues/108), with implementation tickets #109–#114. This document is a roadmap, not implemented behavior. Product decisions are settled; do not reopen them as a questionnaire about file names, commands, or internal types.

## Target

```text
evok → natural-language intake via skill → Mission draft → explicit start
     → baseline → model chooses next experiment from evidence → evaluate → repeat/stop
     → project-local records → explicit recovery after interruption
```

Reuse Pi SDK and `PiAgentRuntime` for model/tool execution, and the existing Mission Director, evidence, evaluation, and promotion contracts for research state and acceptance. The model chooses useful research actions; code enforces durable accounting, execution authority, budget, and evidence checks. Do not add another Agent framework, scripted research workflow, or recovery decision tree.

## Actual integration gaps

- `package.json` has no executable entry. `PiAgentRuntime.defaultSessionFactory` disables skills/context discovery; supplying a custom loader must not drop its security extension.
- `ModelOrchestra` resolves model references, but the harness methods in `PiAgentRuntime` pass the tier without wiring the supplied model into the actual session. The existing proposal helper also requests a toy `score` file and does not propagate the supplied harness workspace into candidate execution. A generic research Run cannot be delivered just by exposing that helper as a CLI.
- `MissionDirector.run()` executes queued Tasks through a caller-provided function; it does not call a model to generate subsequent Tasks on its own. Its existing `generateTasks`, `replan`, and `decide` operations are reusable, but the model-driven decision connection is missing.
- Research events currently use `InMemoryResearchLedger`; `checkpoint()` returns an object, not a persisted Mission. `FileDurableIntentStore` covers execution intents only and currently treats all load failures as a missing file. Recovery needs explicit corruption handling and crash-safe writes, not merely enabling that store.
- Search tools available to the development assistant are not automatically available to evoK. The runtime currently strips custom tools. Retrieval must use an actually configured capability; if absent, the skill reports the limitation rather than fabricating research or bypassing network policy.

## Three delivery slices

### 1. Start evok and complete one real, bounded Run

- Add a thin foreground entry using the installed SDK and the minimum necessary input/output integration. Do not fork Pi's CLI or build a new TUI framework; verify existing interrupt handling before binding any keys.
- Share Pi model/auth stores explicitly. Feed the resolved model into each actual session and report its identity, resource sources, tools, and usage. Missing model/auth configuration must fail clearly rather than silently selecting another provider.
- Load only approved evoK/project skill sources with SDK parsing. Supply the intake skill as an explicit evoK-owned resource, without inheriting personal Pi skills or loading third-party extensions/packages.
- Keep source discovery relative to the research project and execution relative to the Run workspace. Permit read-only skill-directory access without widening candidate writes, credential access, network access, or role authority; preserve safety checks for custom loaders and any configured retrieval tool.
- Replace toy-only assumptions only where needed for the new path, preserving existing mock/Newapi contracts and tests. Produce a real artifact in an approved workspace, not a self-reported score.

**Check:** isolated fixtures verify precedence, no unwanted discovery, read-only skill references, preserved security hooks, and exact model routing. An explicitly authorized live smoke Run reads a skill/reference and produces an inspectable artifact using the selected model. This proves startup/execution, not the autonomous product.

### 2. Turn intake into a durable, authorized Mission

- Activate the single English intake skill; questions and the draft follow the user's language. No mandatory grill/brainstorm/search stages.
- Validate the draft against existing Mission/Task/evaluation structures. Display the objective, data, evaluation method, budget/constraints, initial plan, and unresolved execution prerequisites before starting.
- Natural-language start and `/start` share one validated action; neither treats model-written text as user authorization.
- Persist Mission records under `.evok/missions/<mission-id>/`, using the existing event and artifact structures. Exclude only the Mission directory from Git; never copy credentials there.
- Retain consumed budget and confirmed results as they happen, not only on graceful exit. Fail visibly on invalid records; prevent simultaneous controllers from executing the same Mission.

**Check:** a complete request converges without redundant questions; an incomplete or unauthorized draft cannot dispatch experiments. A separate process reconstructs the same Mission/evidence/budget from disk, and a damaged record is not silently treated as a new Mission.

### 3. Close the evidence-driven loop and recover it

- Provide current authoritative Mission state and relevant evidence to the model through Pi execution. Apply its bounded proposals through existing research operations rather than inventing a second state model.
- Execute and independently evaluate a baseline, then let the model choose subsequent work from observed results. Reuse applicable verification, prediction/reconciliation, and promotion gates; do not confuse external-source claims with measured results.
- Account for model/tool and experiment usage in the declared budget units. A task count is not a wall-clock or currency cap; enforce the limit the user actually authorized, including control-model calls.
- Preserve user interruption and runtime stop checks without hijacking `Ctrl+C`. A budget, permission, or cancellation stop must stop further dispatch even if a successful-outcome report is incomplete.
- On explicit recovery, reuse confirmed outputs and show unresolved execution intents. Let the model investigate and propose a next action, but require evidence before adopting uncertain results or repeating side effects. New attempts use new Runs/sessions.

**Check:** one small real task goes from natural-language intake to baseline and at least one evidence-dependent subsequent experiment without a "continue" prompt. It stops at an authorized bound, retains failures as evidence, and can be reopened without duplicating a confirmed result or resetting budget. A mocked control test verifies that different observations can lead to different next actions; live execution alone does not prove that property.

## Boring defaults; not another design interview

Resolve these during implementation using the simplest existing SDK/repository behavior, and record the result alongside tests:

- Project resources before user resources; SDK-style first-wins collisions with diagnostics. No configurable priority language.
- Discover resources on opening/reopening; no watcher or hot-reload service. Skill bodies remain read in place as agreed, not frozen snapshots.
- No new role-to-skill routing system. Preserve existing role-specific tool and evidence boundaries.
- Use ordinary files with the existing schemas; choose exact filenames/serialization for safe writes and replay. No database service or storage plugin framework.
- Configure only a retrieval capability needed by the actual task; do not build multi-provider orchestration or require retrieval on every intake.

Reopen a user decision only if implementation evidence exposes a real product trade-off: unavailable data/evaluation, an unavoidable new paid service or data disclosure, or a required change to the accepted objective/authority boundaries. File names and internal module names are not such trade-offs.

## Execution protocol

The three delivery slices above are milestones, now divided into six approved, independently verifiable tickets with native blocking links:

| Order | Ticket | Delivers | Blocked by |
| --- | --- | --- | --- |
| T1 | [#109](https://github.com/Azhi-ss/evoK/issues/109) | Foreground CLI with shared Pi model/auth | None |
| T2 | [#110](https://github.com/Azhi-ss/evoK/issues/110) | Research prompts and in-place skill reads | #109 |
| T3 | [#111](https://github.com/Azhi-ss/evoK/issues/111) | Skill-led Mission drafting and saving | #110 |
| T4 | [#112](https://github.com/Azhi-ss/evoK/issues/112) | Authorized, independently measured baseline | #111 |
| T5 | [#113](https://github.com/Azhi-ss/evoK/issues/113) | Evidence-driven autonomous continuation | #112 |
| T6 | [#114](https://github.com/Azhi-ss/evoK/issues/114) | Interrupted-Mission recovery and live acceptance | #113 |

Follow the current tracker frontier and recheck labels, ownership, blockers, and prior stop reports before claiming or dispatching. Implement one ready, unblocked ticket per fresh `/implement` context under `AGENTS.md` and the `orca-ticket-loop` skill; never implement the next ticket in the current context. These development slices are not mandatory stages imposed on the research agent.

Use TDD and the repository gates (`bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check`, `/code-review`) for each implementation ticket. Preserve the existing Mock/Newapi paths unless their retirement is separately justified and authorized. Live model checks need an explicit budget and must report actual execution separately from fixtures.
