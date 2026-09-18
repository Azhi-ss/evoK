# File Blueprint mission state + Cross-review

Source: ticket #22 [T16], parent spec #1. Reference practice:
[ravi03071991/cholesky-gpu-mode](https://github.com/ravi03071991/cholesky-gpu-mode)
(GOAL / RULES / experiments / SCOREBOARD as workspace-auditable files).

Implementation: `src/mission/file-blueprint.ts` (schema; flat
`src/file-blueprint.ts` re-exports), `src/mission/research-loop.ts`
(`MissionDirector.commitBlueprintFile`, `recordCrossReview`, Stop gate;
flat `src/research-loop.ts` re-exports).

File-blueprint state is **Evidence**, not Evaluation and not Approval. Committing
a SCOREBOARD row, naming a `championRef`, or finishing a Cross-review never
promotes a Candidate and never replaces the independent evaluator.

## Minimal file set

| File | Required to Stop | Meaning |
|---|---|---|
| `GOAL` | yes | Human-owned Research Objective plus success criteria |
| `RULES` | no | Allowed / forbidden actions and optional evaluation-contract ref |
| `EXPERIMENTS` | no | Append-only experiment log |
| `SCOREBOARD` | yes | Observed scores that **cite** evaluator evidence; not a promotion verdict |

Missing `GOAL` or `SCOREBOARD` is not a reason to stop. The Mission Director
refuses `decide({ action: "Stop" })` until both files are committed. A Finding
that recommends Stop is only a suggestion (`suggestedAction`); it does not
change `phase` or write `stopReason`.

## Fields

### GOAL

| field | type | required | meaning |
|---|---|---|---|
| `kind` | `"GOAL"` | yes | discriminator |
| `objective` | string | yes | must equal the Mission Research Objective |
| `successCriteria` | string[] | yes, non-empty | what counts as progress |
| `constraints` | string[] | no | extra limits that do not override Mission Policy |

### RULES

| field | type | required | meaning |
|---|---|---|---|
| `kind` | `"RULES"` | yes | discriminator |
| `competitionId` | string | no | Competition this rule snapshot describes |
| `allowed` | string[] | yes (may be empty) | permitted actions |
| `forbidden` | string[] | yes (may be empty) | prohibited actions |
| `evaluationContractRef` | string | no | evidence / artifact id of the evaluation contract |

### EXPERIMENTS (experiments log)

Each `entries[]` item:

| field | type | required | meaning |
|---|---|---|---|
| `experimentId` | string | yes | unique Experiment identity |
| `hypothesis` | string | yes | the Hypothesis under test |
| `candidateRef` | string | no | Candidate id when the Experiment materializes one |
| `evidenceRefs` | string[] | yes (may be empty) | Evidence the outcome rests on |
| `outcome` | string | yes | observed result |
| `recordedAt` | number | no | epoch ms |

### SCOREBOARD

| field | type | required | meaning |
|---|---|---|---|
| `kind` | `"SCOREBOARD"` | yes | discriminator |
| `rows` | row[] | yes (may be empty) | observed metric rows |
| `championRef` | string | no | **note only** — never creates a Local Champion |

Each row:

| field | type | required | meaning |
|---|---|---|---|
| `candidateId` | string | yes | Candidate the row describes |
| `metric` | string | yes | metric name |
| `value` | number | yes | observed value |
| `evaluationRef` | string | yes | Evidence id of the evaluator observation |
| `evidenceRefs` | string[] | yes (may be empty) | additional Evidence citations |

A SCOREBOARD `championRef` is workspace narrative. Promotion still requires the
independent evaluator proof and the promotion gate.

Re-committing `EXPERIMENTS` or `SCOREBOARD` replaces the Artifact digest at the
same `blueprint:<KIND>` id so the experiment log can grow during a Mission.

SCOREBOARD rows may be empty (Stop still needs the file). A non-empty row's
`evaluationRef` must cite Evidence whose metadata carries an evaluator
`evaluationDigest`. Self-report observations are rejected.

## Cross-review trigger and two-phase loop

`pendingCrossReviewSubjects()` lists committed File Blueprint artifact ids that
do not yet have an author Cross-review. That list is the trigger: a later Task
or the Mission Director calls `recordCrossReview`.

| phase | required `subjectRefs` |
|---|---|
| `author` | committed File Blueprint artifact ids (`blueprint:<KIND>`) |
| `reviewer` | at least one existing author Cross-review artifact (`cross-review:<reviewId>`) |

A reviewer-only record is rejected. `authoritative` is always `false`.

## Ledger events (research loop)

Both events are Evidence: they record file/review artifacts and digests. They
are not Evaluation verdicts.

### `BLUEPRINT_COMMITTED`

| field | meaning |
|---|---|
| `file` | normalized blueprint file |
| `ref.kind` / `ref.artifactId` / `ref.digest` | content-addressed Artifact (`blueprint:<KIND>`) |
| `ref.evidenceRefs` | Evidence ids the file cites; must already exist |

Replay rejects a commit whose digest does not match `file`, whose Evidence refs
are unknown, or whose Artifact digest disagrees with the registry.

### `CROSS_REVIEW_RECORDED`

Two-phase Cross-review (author, then reviewer). Output is a content-addressed
Artifact plus an Evidence id `cross-review:<reviewId>` that later Tasks can
pass to `generateTasks`.

| field | meaning |
|---|---|
| `review.phase` | `author` or `reviewer` |
| `review.subjectRefs` | Artifact / file ids under review |
| `review.findings` | reviewer notes |
| `review.evidenceRefs` | Evidence the notes cite |
| `review.digest` | digest of `{ reviewId, phase, subjectRefs, findings, evidenceRefs }` |
| `review.authoritative` | always `false` |
| `evidence` | `observation` record at `cross-review:<reviewId>` |

Cross-review cannot set `authoritative: true`, cannot admit a WORLD_MODEL claim,
and cannot produce `PROMOTED_LOCAL`.

## Checkpoint / restart

`MissionDirector.checkpoint()` / `fromEvents()` rebuild `state.blueprint` from
the ledger. File and Cross-review digests must stay aligned with the Artifact
registry and with every cited Evidence id; a forged tail is rejected.

## Explicit non-goals

- Markdown workspace export of the four files (schema is the contract)
- Replacing Claim-card objections, Falsifier, or `promotion_cross_model`
- Using SCOREBOARD or Cross-review as the promotion or Stop authority
