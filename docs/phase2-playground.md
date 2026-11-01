# Spec · Phase 2 Playground research + submit adapter (#208)

Competition-specific workflow for **科学场景 Harness 优化赛 · 第二阶段**
(`harness-45c4688b`). Platform deliverable is a Harbor Custom Agent
(`BaseInstalledAgent`) pinned to Harbor-LBG `0.24.0+lbg.13`; evoK owns the
research loop, evidence and submission discipline, not the scientific
runtime itself.

This arm is **separate** from the generic SubmissionBroker, contest-arm
auto-submit and the live S1 path. None of those are changed or called.
Scope and freeze boundaries are recorded in
[ADR-0015](adr/0015-phase2-playground-arm.md).
Local Phase 2 workspace integration (entry wrapper, preflight, kit tools)
is owned by the workspace worker; this repo owns the tracked adapter,
research workflow and CLI contract.

## Seams

| Layer | API | Owns |
|---|---|---|
| Research workflow | `Phase2Research` (`src/mission/phase2-research.ts`) | Immutable revisions, local/cloud evidence, shared budget, Director nomination, ticks, sanitized researcher view |
| Production research hook | `createPhase2WorkspaceRunner` (`src/mission/phase2-workspace-runner.ts`) | Drives `local/evaluate_candidate.py` propose + score; S1-metered costs are never double-booked |
| Competition adapter | `Phase2PlaygroundAdapter` (`src/competition/phase2-playground.ts`) | Official pins, release checks, deterministic submit pipeline, attempt/quota/reconciliation, official status ingestion |
| Real platform | `CliPhase2Platform` (`src/competition/phase2-cli-platform.ts`) | `bohr wenyon` / `playground` 0.1.45 argv; credentials stay in the user's CLI login |
| Offline platform | `FakePhase2Platform` (`src/competition/phase2-fake-platform.ts`) | Scripted kit/quota/timeout/tamper/official responses |
| Entry point | `bun run phase2 <cmd>` (`src/cli/phase2-cli.ts`) | Same classes a running Mission uses programmatically |

State persists in one atomic JSON document (default `.phase2/state.json`,
mode `0600`). Revisions, evidence, budget spend, attempts and the last
observed quota survive restarts and days. `init` is idempotent: an existing
valid state is never reset. `submit`/`reconcile` run under a cross-process
lock file (`<state>.lock`, stale-pid detection) — an atomic rename alone
cannot stop two processes from consuming the same daily quota.

## Research → nomination

1. `proposeRevision({ summary, change })` — content-addressed immutable
   revision (`rev-<sha256>`); the same change is the same revision.
2. `recordEvidence` — `screening`, `withheld-validation`, `noisy-repeat`,
   plus `source-check`, `public-smoke`, `cloud-self-test`. Costs charge the
   shared cap. Cloud self-test evidence requires an explicit cost — an
   unknown cloud cost is not free. `externalBooking: true` marks a cost
   already charged by the S1 meter (workspace evaluator) and writes **no**
   Phase2SpendEntry. `official` evidence is rejected: only adapter
   reconciliation writes it.
3. `nominate()` — strongest **eligible** revision (all three local kinds),
   ranked by withheld validation, then screening, then id. Replacement is
   blocked only while the nominee has an **unconfirmed** attempt
   (submitting/uncertain). While A is evaluating or scored, a stronger B
   can become the NEW nominee; A's revision and its official result stay
   immutable.

## Ticks actually research

`tick(runner?)`: reconcile official attempts → if more research is needed,
invoke the wired runner → re-nominate → recompute `nextAction()`. It never
just prints "keep researching".

Production runner contract (coordinator-owned workspace files):

```bash
python3 local/evaluate_candidate.py --propose PARENT_TREE FEEDBACK_JSON NEW_TREE
python3 local/evaluate_candidate.py CANDIDATE_TREE TASK_ID NEW_RESULT_DIR
# result.json / stdout: { sourceDigest, score, executionExit, costCNY }
```

Each run proposes a revision (`change.tree`, `change.sourceDigest`) and
records evidence (`--kind screening|withheld-validation|noisy-repeat`,
default screening) with `externalBooking: true` — the S1 ledger already
charged it. The CLI exposes the same flag:
`evidence --cost N --external-booking` for S1-metered panel spend. `executionExit != 0` is negative evidence without a score. The
proposal feedback is the researcher view only.

`nextAction()` refreshes quota through the platform whenever the cached
value is missing or exhausted, so a new day is picked up automatically.

## Release checks (all must be green)

| Check | Green | Otherwise |
|---|---|---|
| `harbor-kit` | pinned kit tarball sha256 `7011d989…50` verified | `waiting` + `bohr wenyon dataset download harness-phase2-public-kit --version 3` action |
| `source-check` | passing offline/source validation tied to the revision | `waiting` + run `tools/check_source.py` |
| `public-smoke` | passing public smoke tied to the revision | `waiting` + run the public smoke task |
| `real-validation` | real public-dev-task cloud self-test score | `waiting` + run public dev tasks within the cap |
| `nominee` | target is the current nominee | `red` |

Local, cloud self-test and official scores stay separate channels.

## Submit pipeline (deterministic, one lock)

`submit({ modelName, real, estimatedCost })` for the current nominee only:

1. `--real` **requires** `--estimated-cost`; an unknown cost never defaults
   to 0 against the shared cap.
2. Release checks — otherwise `waiting`.
3. Cross-revision exclusion: any unconfirmed attempt on ANY revision →
   `uncertain`; reconcile the original attempt first.
4. Duplicate prevention: accepted/evaluating/scored attempt on this
   revision returns the original receipt (`duplicate: true`).
5. Real only: fresh `platform.quota()` + budget headroom **before any
   external side effect** (no uploads before the limits are checked).
6. `localTreeDigest(revision)` computed independently and bound to the
   nominated revision: a revision carrying `change.tree` is uploaded from
   THAT tree inside `--workspace`, never a stale `--source-dir` → private
   versioned Wenyon source → organizer read grant → re-download and verify
   against **the local digest** (a self-consistent upload echo cannot
   launder a tampered tree) → `submission.json` (allowlisted model, exactly
   two placeholder envs) → `playground submit --dry-run` on the exact
   bundle. A malformed (non-integer/NaN) platform or operator quota fails
   closed before any external object is created.
7. `real: false` stops here → **`dry-run`**. `real: true` persists the
   attempt, reserves the estimated cost, and submits once with a
   deterministic idempotency key, reusing **`--bundle <validated zip>`**
   (sha256 of the exact bytes, never a repack).
8. Receipt → `accepted` (**`receipt`**, not a score). Timeout/lost response
   → **`uncertain`**; restart-safe, never a blind resubmit.

`reconcile()` polls pending/uncertain attempts. When the receipt was never
persisted, `findAttempt` recovers it automatically: the real submit carries
`--detail evok-phase2/<idempotencyKey>`, and
`playground attempt list --challenge-id ... --json` must yield exactly one
own attempt with that exact marker (zero or ambiguous matches stay
uncertain). Manual fallback: the operator confirms the own attempt and
binds it with `reconcile --bind <localAttemptRef>:<platformAttemptId>`.
Verified official score/cost/status is written back **for its own
revision**, and the reserved cost settles to the official cost. A
`failed`-before-receipt or `not-received` attempt releases its reservation.

### Official status ingestion (real schema, attempt 62146)

`playground status --attempt-id ID` returns top-level `id`/`challengeId`,
`execStatus`, `outcome`, `resultsJson.harbor_reward`,
`harness2_eval_status`, `harness2_raw_result.score_complete`,
`score_status`, `cost`. `parsePhase2OfficialStatus`:

- ingests only the acknowledged own attempt (id + challenge must match);
- `score_complete`/`score_status=complete` → graded, even when
  `outcome=failed`; **numeric zero score and zero cost are preserved**;
- receipt / pending / error stay distinct from graded;
- a complete score without a finite `harbor_reward` fails closed;
- only summary facts leave the parser — the full `tasks` array is never
  read into agent-visible payloads.

`researcherView()` is a whitelist: revision ids, summaries, screening,
cloud self-test and official scores, eligibility. No withheld/noisy-repeat
scores, no dataset ids, attempt internals, quota, budget, credentials or
release rules.

## Offline proof

```bash
bun run phase2 demo --state /tmp/phase2-demo/state.json
bun test src/competition/phase2-playground.test.ts \
         src/competition/phase2-cli-platform.test.ts \
         src/mission/phase2-research.test.ts \
         src/mission/phase2-workspace-runner.test.ts
```

`demo`: two competing revisions, nominee replacement, dry-run, quota
exhausted (research continues), timeout + restart (exactly one platform
submit), reconciliation to the verified official result, budget settlement.

## Real readiness vs a real receipt

- **Dry run**: bundle validated locally. No submission, no quota consumed.
- **Real readiness**: release checks green + fresh platform-confirmed quota
  + spend within the shared cap. The CLI platform needs the actual pinned
  kit and `--confirm-quota <n>` after the operator checked the platform.
- **Real receipt**: the platform's `attempt_id` + acceptance status.
  Official score/cost/status arrive only through `reconcile()`.

```bash
bun run phase2 init --state .phase2/state.json --cap 100
bun run phase2 tick --state .phase2/state.json \
  --kit-dir .../kit --source-dir .../evok-agent --trace ./placeholder-trace.jsonl \
  --workspace ~/Projects/arena/playground/harness-phase2 --task hb016 --base-tree evok-agent
bun run phase2 submit --state .phase2/state.json \
  --kit-dir .../kit --source-dir .../evok-agent --trace ./placeholder-trace.jsonl \
  --model deepseek-v4.1-flash --real --estimated-cost 10 --confirm-quota 1
```

The workspace wrapper (`scripts/evok phase2`, `scripts/release-candidate`)
makes ONE `submit --real` call: the adapter already validates the bundle
internally, and the dataset id is deterministic per revision.

## External live blockers (2026-11-01)

- `harness-phase2-public-kit` returns `dataset_not_found` on Wenyon for the
  current account, so `harbor-kit` stays `waiting`; no real
  `check_source.py` / `selftest_harbor.py` evidence exists yet.
- Real daily quota cannot be queried through the CLI; real submit requires
  operator-confirmed `--confirm-quota <n>` (no reset-timezone guessing).

## Locks

- SubmissionBroker / contest-auto-submit / frozen AtCoder behavior and the
  live S1 path are untouched.
- Live submit is explicit `--real` plus platform-confirmed quota and budget
  headroom; env alone never opens it.
- No credentials, private checkers, withheld scores or raw release rules in
  the researcher view, the persisted state or argv.
