# Ledger event schema — EdgeTraversal + Approval / Evidence / Evaluation

Source: spec #1 契约增补（2026-09-04）Graph Engineering 对照, ticket #39 [T46].
Implementations: `src/ledger-kinds.ts` (kind classifier), `src/toy-harness.ts`
(authoritative mission ledger `MissionEvent`).

The authoritative mission ledger is append-only; `MissionState` projects refs only.
「图上定义了边」≠「这次 run 实际选了哪条边」——边定义在 plan，traversal 记在 ledger。

## EdgeTraversal — `EDGE_TRAVERSED`

Emitted by the mission seam's fan-in join: once per mission run, at the final quorum
decision, recording which join edge this run actually took. Queryable via
`harness.edgeTraversals()`.

Required fields:

| field | type | meaning |
|---|---|---|
| `edge_id` | string | pattern/join/route identity; main seam: `join:mission-quorum:<missionId>` |
| `condition_ref` | string | the named condition that chose the edge; main seam: `policy:quorum` |
| `condition_version` | number | version of that condition when traversed; v0 ships the quorum condition with the plan, so `condition_version === plan_version` |
| `source_attempt` | number | how many source branches this run attempted |
| `run_id` | string | the mission run identity |
| `target` | string | the edge taken: `MISSION_COMPLETED` or `MISSION_STOPPED` |
| `evidence_ids` | string[] | content-addressed Evidence ids the join verdict rests on (`snapshot:<digest>`, `evaluation:<digest>`) |
| `plan_version` | number | immutable plan/policy version the run executed under (`ToyMissionOptions.planVersion`, default 1; re-plans must bump it) |
| `captured_at` | number | epoch ms when the traversal was recorded |

## Three-way accounting: Approval ≠ Evidence ≠ Evaluation

Every mission ledger event type belongs to exactly one kind (`ledgerEventKind(type)`;
adding an event type without classifying it in `LEDGER_EVENT_KINDS` is a compile error).

### Approval — human gate decisions

Human acceptance, SubmissionBroker gate decisions, and other high-side-effect permission.

Required fields (spec #1 vocabulary → main-seam payload): `who` → `acceptedBy`;
`decision` → `decisionId` plus the approve/reject event type; `target` action digest →
`championDigest` / `artifactDigest`; `policy_version` → v0 has no separately
versioned acceptance policy file yet, so the gate's policy version is implicit in the
immutable gate code and request record (a `policy_version` field must be added when
acceptance policies become versioned config).

Event types: `HUMAN_ACCEPTED`, `SUBMISSION_APPROVED`, `SUBMISSION_REJECTED`.

An Approval can never produce a champion — the projector derives a champion only from
an Evaluation-kind promotion verdict.

### Evidence — observations

Observed facts: artifact digests, evaluator-returned score/rule facts, tool/observation
records. Must be traceable to run / code / data / env digests.

Required fields: observation content (facts / digest / record) plus provenance refs
(`snapshotDigest`, `contractDigest`, `evaluationDigest`, `evidenceIds` where applicable).

Event types: `MISSION_CREATED`, `MISSION_STARTED`, `BRANCH_RESERVED`, `TASK_SELECTED`,
`PREFLIGHT_SELF_CHECK_PASSED`, `PREFLIGHT_SELF_CHECK_FAILED`, `AGENT_COMPLETED`,
`CANDIDATE_GENERATED`, `CANDIDATE_MATERIALIZED`, `SNAPSHOT_COMMITTED`,
`EVALUATION_STARTED`, `EVALUATION_RUN_COMPLETED`, `EVALUATOR_SUCCEEDED`,
`EVALUATOR_FAILED`, `RECONCILED`, `FALSIFIER_COMPLETED`, `CRITIC_COMPLETED`,
`CHALLENGER_COMPLETED`, `AUDITOR_COMPLETED`, `SUCCESS_AUDITOR_COMPLETED`,
`SUBMISSION_REQUESTED`, `SUBMISSION_RESULT`, `RETRY_SCHEDULED`, `MODEL_RESOLVED`,
`CROSS_MODEL_CHECK_COMPLETED`, `LATE_EVENT_REJECTED`, `EDGE_TRAVERSED`.

`EVALUATOR_SUCCEEDED` carries `evidenceIds` (content-addressed: snapshot digest,
evaluation digest, per-run digests, per-fact observation refs) and is itself
content-addressed by `evaluationDigest`.

### Evaluation — verdicts over Evidence ids

Verdicts (promotion / reject / quarantine / stop / fan-in decisions). They must cite
their basis: Evidence ids and/or the Evaluation record they rest on. A human
acceptance or a model's opinion must never be written as an Evaluation.

Required fields: `verdict` (the decision taken), `evidence_ids` (the Evidence ids the
verdict rests on — required on promotion), and for promotions `evaluation_ref`
(content-addressed `evaluationDigest` of the `EVALUATOR_SUCCEEDED` record).
Payload naming: the `EDGE_TRAVERSED` payload uses the snake_case vocabulary of the
spec (`evidence_ids`, `plan_version`, `captured_at`); verdict payloads follow the
ledger's existing camelCase (`evidenceIds`, `evaluationRef`).

Event types: `PROMOTED_LOCAL`, `BRANCH_REJECTED`, `BRANCH_QUARANTINED`,
`GAIN_BANKED`, `MISSION_COMPLETED`, `MISSION_STOPPED`.

Promotion chain, enforced by the projector (`project()`):
1. `PROMOTED_LOCAL` must reference an Evaluation record — `evaluationRef` must match
   the branch's verified evaluation digest; otherwise the event is rejected and no
   champion results.
2. The verdict must cite exactly the Evidence ids of that verified evaluation —
   `evidenceIds` is re-derived from the verified `EVALUATOR_SUCCEEDED` record
   (snapshot digest, evaluation digest, per-run digests, per-fact observation refs)
   and must match the payload order-for-order; forged or foreign ids reject the
   promotion.
3. Approval-only ledgers replay with no champion.

## Explicit non-goals (T46)

- No graph database / GraphRAG / GraphQL-style graph storage — the ledger stays a
  flat append-only event log.
- No second orchestrator or alternative agent runtime (no LangGraph / ADK) — routing
  stays on the existing harness control plane.
- No Scout retrieval backend — gap-driven fan-out records gaps and claims in the
  ledger but v0 implements no retrieval service.
