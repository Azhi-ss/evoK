# evoK — Competition Research Harness

Standalone harness for unattended, multi-competition autonomous research: mission control, task DAG, isolated experiments (Pi SDK AgentSession as replaceable agent runtime), independent evaluation, evidence-gated promotion, and a submission broker.

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

## Claim-card research loop (Co-Scientist-light)

Steals the **orchestration clarity** of Google Co-Scientist — Generation → Reflection → Ranking/Tournament → Evolution — not its literature/AI-scientist product thickness. The loop turns every candidate/hypothesis into a durable **Claim card** and forces **objection write-back** into the next search step.

- Every candidate/hypothesis carries a **Claim card**: `claim` (one testable sentence) / `prediction` / `status` (`confirmed` / `violated` / `unknown`) / `score` + evidence refs / `objections` / `next` (`refine` / `repair` / `discard` / `promote-eligible`).
- Reflection/Falsifier/Critic/Challenger/Auditor outputs are persisted as structured **objections** and written back onto the card, so the next expansion or Director step reads them — never discarded with the failed candidate.
- **Ranking/promotion consumes gates + uncleared objections + evidence refs, never score alone**: a promotion verdict is refused when the card is missing, `violated`, ungated, or carries uncleared objections.

Implementation: `src/predict-reconcile.ts` (ClaimCard / ClaimObjection schema), `src/toy-harness.ts` (branch `claimCard` + promotion gate), `src/research-loop.ts` (task `claimCard` / WORLD_MODEL admission).

## File Blueprint mission state (Ravi-style)

Long-running Missions keep GOAL, RULES, an experiments log, and SCOREBOARD as content-addressed File Blueprint artifacts plus ledger refs — not as chat memory. Cross-review (author → reviewer) writes the same kind of refs so a later Task can read them.

- Stop is refused while GOAL or SCOREBOARD is missing. A Finding that “feels done” cannot silently stop the Mission.
- SCOREBOARD rows must cite evaluator Evidence. A `championRef` on the file is narrative only and cannot bypass the independent evaluator or promotion gate.
- Checkpoint / restart rebuilds the blueprint from the ledger; file digests must stay aligned with their Evidence refs.

Schema: `docs/file-blueprint.md`. Implementation: `src/file-blueprint.ts`, `MissionDirector.commitBlueprintFile` / `recordCrossReview`.

### Non-goals

- Full literature Co-Scientist / web research engine
- Normative logic / formal claim calculus
- Lean / theorem proving
- EviGraph / paper Chain-of-Evidence product suite
