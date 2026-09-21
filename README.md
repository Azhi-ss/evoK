# evoK — Competition Research Harness

Standalone harness for unattended autonomous research and verifiable Method Improvement (task-internal RSI) inside one Mission: mission control, task DAG, isolated experiments (Pi SDK AgentSession as replaceable agent runtime), independent evaluation, evidence-gated promotion, and a submission broker. Compatible with existing competition arms. Product baseline: [ADR-0014](docs/adr/0014-prd-rsi-baseline.md).

- How to use: [docs/how-to-use.md](docs/how-to-use.md) — Explore → intake → review → start → research
- Chord multi-plugin pilot (experimental; **not** a changelog promise): [docs/chord-plugins.md](docs/chord-plugins.md)
- Spec: https://github.com/Azhi-ss/evoK/issues/1
- Status: spec phase (阶段 0 契约固化)

## Model tiers (Orchestra)

Model/provider definitions live in Pi's model catalog — `~/.pi/agent/models.json`, managed with Pi's `/model` and `/login` flows. evoK never duplicates provider API configuration.

The Orchestra config (RunPolicy) only **binds tiers to model ids already registered in that catalog** — the ids must resolve in `models.json`:

```json
{ "fast": "acme/flash-2", "deep": "acme/pro-2", "mid": "acme/mid-1" }
```

- Omitted/null/empty orchestra → every RoleSession uses Pi's current/default model (`settings.json` `defaultModel`), reason `unconfigured`.
- Configured → Flash-first binding resolves each session deterministically. `mid` is a reserved schema slot: it may be bound and is validated, but v0 has no policy that selects it.
- Pattern `model_mix`: `flash_only` (always fast) | `flash_primary` (default; everything fast unless a deep gate elevates) | `flash_deep_mix` (orchestration defaults deep as a soft fallback; execution/adversarial stay fast). Default mix is `flash_primary`.
- Named `deep_gates` (registered in the harness gate catalog: `strategy_synthesis`, `join_reduce`, `success_audit`, `cross_model_check`) open deep routing for any role class; unknown gates fail validation.
- `forced_tier` overrides automatic resolution only when Policy Guard (mix feasibility) and budget allow; otherwise the override is rejected — no silent deep.
- Budget pressure (`allowDeep: false`) downgrades automatic deep selections to fast, reason `budget`. Decision reasons: `unconfigured`, `mix`, `role`, `gate`, `forced`, `budget`.
- Unknown tier ids, tier values that aren't registered model ids, or ambiguous bare ids **fail closed before a mission starts** (`OrchestraValidationError`).
- To add a model: edit `models.json` (or use Pi's `/model` flow). An evoK command, when it exists, only edits tier bindings.
- Orchestra only picks model tiers — it never schedules tasks, spends budget, or changes the mission objective.
- `promotion_cross_model: "both"` schedules two tiered evaluation attempts (one fast, one deep ModelConfig) at the promotion gate. Disagreement denies promotion with the runtime's explicit reason; agreement only keeps the candidate eligible for the existing promotion policy — it never auto-promotes and never auto-submits. The Orchestra supplies the two ModelConfigs; the promotion policy and SubmissionBroker keep their authority.
- Cross-model agreement is **model-level independence only**: it is not a sandbox/trust verdict (#7) and does not replace the evaluation noise protocol (#11). Those gates stay separate — a candidate can agree across models and still fail trust verification or noise policy.

## evok foreground CLI (v1 T1, #109)

`bun run evok -- [request] [options]` (or `bun bin/evok.ts`) opens the bounded
foreground entry over the existing `PiAgentRuntime` Pi SDK execution path:

```text
bun run evok "inspect this research project and summarize what you see"
bun run evok --tier deep "compare these two approaches" --project /path/to/project
echo "request text" | bun run evok        # piped stdin; no tty
bun run evok                             # tty: Pi native TUI (SDK InteractiveMode); mode=explore|intake|mission; Pi /model /new /resume stay on Pi; Mission resume is /mission-resume
```

Options: `--project <dir>` (default cwd), `--tier default|fast|deep|mid`
(default `default`), `--orchestra <file.json>` (tier bindings to Pi catalog
refs), `--timeout-ms <n>` (per-Run bound, default 10 min), `-h/--help`.

Mission intake and start (#111/#112):

```text
bun run evok --intake "beat the NDCG baseline on this project"
bun run evok --intake --mission m-ab12 "where were we?"   # reopen a draft
bun run evok /start --mission m-ab12                     # start + continue autonomously
bun run evok /start --mission m-ab12 --baseline-only     # baseline only, no continuation
bun run evok --missions --project /path/to/project       # reopen: list unfinished Missions
bun run evok /resume --mission m-ab12                    # explicit resume after interruption
bun run evok --status --mission m-ab12                   # reopen durable result/usage
```

- `--intake` runs the skill-led interview that saves an unstarted draft under
  `<project>/.evok/missions/<id>/draft.json`; it never dispatches work.
- The independent evaluator contract is declared in
  `<project>/.evok/evaluation.json` (`id`, `version`, the required relative
  `artifact`, optional `metric`/`min`/`max`); the baseline is measured from the
  immutable artifact snapshot, never from a model-supplied score. A missing or
  malformed contract refuses the start instead of running an unmeasurable
  Experiment. A copyable template lives at
  [`templates/evaluation.json`](templates/evaluation.json); a minimal demo
  scaffold is [`examples/demo-start/`](examples/demo-start/README.md). Prefer
  an absolute `--project`. `evok --start --baseline-only` on the demo either
  runs the measured baseline or lists remaining hard gates — it does not
  invent a green pass or authorize true submit.
- An explicit natural-language start ("start the mission baseline") or
  `/start` invokes ONE validated start action for the displayed Mission. It
  checks objective/data/evaluation inputs, supported permissions, an
  enforceable `model-USD` budget, and an evaluator contract; ambiguous intent,
  missing prerequisites, model-authored approval, unenforceable units, a
  conflicting active controller, or an already-started Mission cannot dispatch.
- The accepted Mission and execution intent are persisted atomically BEFORE
  dispatch (`mission.json`, controller lock, history events); the bounded
  baseline runs through the existing Pi runtime in an approved isolated
  workspace with the resolved model. Writes are confined to that workspace;
  controller records, evaluator inputs, credentials, and skill sources stay
  outside candidate authority.
- After the Run, the workspace is frozen into an immutable Candidate snapshot
  (`runs/<runId>/snapshot/`) measured by the INDEPENDENT evaluator — a
  model-supplied score or planted score file can never replace measurement.
  Result, evidence links, model/usage, remaining budget, and stop reason are
  durable and reopenable via `--status`. Unknown cost is never zero: positive
  usage without metering stops the Mission rather than claiming a cap.
- User interruption, budget exhaustion, evaluator failure, and rule failures
  each record a truthful terminal/blocked stop reason. An interrupted in-flight
  Run blocks a second controller until the recovery slice (#114). No External
  Submission or implicit Human Acceptance exists on this path.

Autonomous continuation from measured evidence (#113):

- One explicit `/start` runs the baseline and then CONTINUES without a
  "continue" prompt: after each measured Run, a read-only Mission Director
  decision model receives the trusted Mission projection (objective/policy,
  remaining `model-USD` budget, and real evaluator observations with Positive
  and Negative Evidence refs) and proposes one bounded next action —
  investigate, repair, retry, change-direction, or stop. `--baseline-only`
  restores the single-baseline slice; `--max-experiments <n>` bounds Runs after
  the baseline (default 3).
- The controller, not the model, owns authority: proposals are validated before
  execution and malformed, stale (`stateVersion`), unsupported, or over-budget
  proposals, objective/permission/budget expansion, and model-asserted
  success/score claims are rejected. Up to three bounded correction attempts
  consume real resources; exhausting them stops the Mission explicitly
  (`director-blocked`) rather than guessing. Accepted proposals run through the
  SAME Task/Run/snapshot/evaluator operations as the baseline — there is no
  second state model.
- Every Experiment is a fresh Run with a fresh Pi session, attempt identity,
  and approved workspace while sharing the durable authoritative evidence. Failed
  and inconclusive attempts (dispatch failures and rule failures) are retained
  as Negative Evidence; a model-only claim can never become a measured result,
  and independent evaluation/promotion gates stay outside model authority.
- Decision-model calls are themselves priced in `model-USD` and recorded in a
  separate usage ledger. Budget/permission/interruption boundaries stop the
  next dispatch truthfully even when the model would continue or a success
  report is missing (`budget-exhausted`, `director-stopped`, `decision-failed`,
  `iteration-limit`). No External Submission or Human Acceptance is produced.

### Interruption and explicit recovery (#114, T6)

- `Ctrl+C`/SIGINT keeps its normal meaning: cancel the in-flight Run or
  decision and stop new dispatch; it is NOT rebound to a Mission-pause action.
  Confirmed results persist; any execution whose result was not confirmed is
  recorded `interrupted`, not guessed complete. After an uncatchable kill,
  recovery is from disk, not from process memory.
- Reopen a project with `--missions` (or start `evok` in it): every accepted
  Mission is listed with measured baseline, experiment/negative-evidence
  counts, stop/blocker reason, and consumed/remaining `model-USD` budget.
  Listing never resumes anything, and unstarted drafts are shown separately.
- Only an explicit `/resume` (or e.g. "resume mission m-ab12") resumes the
  selected Mission. Questions, negations, and status chat never resume; intake
  is not repeated and spent budget is never restored.
- Recovery reconstructs ONLY from durable records and confirmed artifacts:
  confirmed Runs are adopted with no duplicate execution, accounting,
  evaluation, or promotion; a durable snapshot without a confirmed result is
  independently RE-MEASURED (the model never asserts a completion); an
  operation dispatched before the interruption with no durable evidence is
  abandoned as Negative Evidence, and a permitted retry uses a FRESH
  Run/session/attempt identity with the remaining budget. Damaged records,
  digest mismatches, or broken budget arithmetic block recovery visibly
  (`reconciliation-blocked`); a live second controller stays fenced, while a
  stale lock left by a dead process is reclaimed.
- A small offline, reproducible end-to-end example lives in
  [`examples/lifecycle/`](examples/lifecycle/README.md)
  (`bun run example:lifecycle`): intake → start → baseline → evidence
  follow-up → persist → stop/reopen → continue, with an independent evaluator.
  The full REAL-provider live acceptance is separate, opt-in, and blocked
  without an explicit test budget + usable config
  ([docs/live-acceptance-t6.md](docs/live-acceptance-t6.md)); missing
  authorization fails the gate instead of passing. No External Submission.

- Models and credentials come **only** from Pi's SDK-resolved stores
  (`~/.pi/agent/models.json`, `auth.json`; honors `PI_CODING_AGENT_DIR`). evoK
  copies, displays, or stores no credentials and adds no login system.
- The resolved default/tier model (and its `ModelRuntime`) is the model that
  actually executes the session; the footer reports its identity, session id,
  stop reason, tokens, and cost. Reporting a tier without using its model is
  not possible on this path.
- Missing model/auth configuration fails before dispatch with distinct exit
  codes (`2` usage, `3` model configuration, `4` authentication, `5` runtime
  error, `130` cancelled). A `--tier fast|deep|mid` request with no matching
  orchestra binding fails closed instead of silently running the default
  model. Provider auth failures stay explicit; there is no silent
  provider/model fallback and no use of the development assistant's own
  connection.
- Each request runs in the selected research project, which is exposed to the
  model **read-only**; writes stay in the request's isolated temp workspace.
  Each request is a fresh Run: fresh SDK session/attempt identity, disposed
  session, existing read-only tool authority, and the runtime policy that keeps
  hidden SDK retry/compaction disabled. A one-shot invocation and a TUI
  turn each create a fresh runtime + intent store, so identical requests never
  replay a stored result. One-shot `Ctrl+C` cancels the in-flight Run only —
  no Mission-pause meaning is bound to it; TUI keybindings stay on Pi.
- The process does not inherit personal Pi prompts, extensions, packages, or
  conversation history (the SDK loader stays in `noSkills/noExtensions/
  noPromptTemplates/noContextFiles` mode). Skills are discovered from the
  Pi native skills root and tag-filtered for Mission/Intake inject and
  `/skills` (ET-SKILL-NS / #152). Approved prompts still come from `.evok`.

Offline contract tests use the SDK faux provider (`src/cli/evok-cli.test.ts`,
`src/evok-model.test.ts`): response path, exact tier routing, usage display,
  missing-configuration/auth failure, and cancellation — no real credentials.
Any live-model smoke check requires a separately authorized budget.

## Claim-card research loop (Co-Scientist-light)

Steals the **orchestration clarity** of Google Co-Scientist — Generation → Reflection → Ranking/Tournament → Evolution — not its literature/AI-scientist product thickness. The loop turns every candidate/hypothesis into a durable **Claim card** and forces **objection write-back** into the next search step.

- Every candidate/hypothesis carries a **Claim card**: `claim` (one testable sentence) / `prediction` / `status` (`confirmed` / `violated` / `unknown`) / `score` + evidence refs / `objections` / `next` (`refine` / `repair` / `discard` / `promote-eligible`).
- Reflection/Falsifier/Critic/Challenger/Auditor outputs are persisted as structured **objections** and written back onto the card, so the next expansion or Director step reads them — never discarded with the failed candidate.
- **Ranking/promotion consumes gates + uncleared objections + evidence refs, never score alone**: a promotion verdict is refused when the card is missing, `violated`, ungated, or carries uncleared objections.

Implementation: `src/predict-reconcile.ts` (ClaimCard / ClaimObjection schema), `src/search/fixtures/toy-harness.ts` (branch `claimCard` + promotion gate; flat `src/toy-harness.ts` re-exports; fixtures/tests only), `src/mission/research-loop.ts` (task `claimCard` / WORLD_MODEL admission; flat `src/research-loop.ts` re-exports).

## File Blueprint mission state (Ravi-style)

Long-running Missions keep GOAL, RULES, an experiments log, and SCOREBOARD as content-addressed File Blueprint artifacts plus ledger refs — not as chat memory. Cross-review (author → reviewer) writes the same kind of refs so a later Task can read them.

- Stop is refused while GOAL or SCOREBOARD is missing. A Finding that “feels done” cannot silently stop the Mission.
- SCOREBOARD rows must cite evaluator Evidence. A `championRef` on the file is narrative only and cannot bypass the independent evaluator or promotion gate.
- Checkpoint / restart rebuilds the blueprint from the ledger; file digests must stay aligned with their Evidence refs.

Schema: `docs/file-blueprint.md`. Implementation: `src/mission/file-blueprint.ts`, `MissionDirector.commitBlueprintFile` / `recordCrossReview`.

### Non-goals

- Full literature Co-Scientist / web research engine
- Normative logic / formal claim calculus
- Lean / theorem proving
- EviGraph / paper Chain-of-Evidence product suite
