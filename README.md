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
- Configured → each tier resolves independently to its registered model. `mid` is a reserved schema slot: it may be bound and is validated, but v0 has no policy that selects it.
- Unknown tier ids, tier values that aren't registered model ids, or ambiguous bare ids **fail closed before a mission starts** (`OrchestraValidationError`).
- To add a model: edit `models.json` (or use Pi's `/model` flow). An evoK command, when it exists, only edits tier bindings.
- Orchestra only picks model tiers — it never schedules tasks, spends budget, or changes the mission objective.
