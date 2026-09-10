# T6 live acceptance runbook (#114, AC8)

The offline example (`examples/lifecycle/`) and the separate-process tests use a
deterministic **faux** model and are **controlled evidence**, not live
acceptance. The full live lifecycle runs **only** after an operator supplies an
explicit test budget and usable provider configuration. Missing authorization
or configuration **blocks** the acceptance; it is never reported as a pass.

## Required inputs

1. Usable Pi provider configuration for the pinned SDK — real model resolves
   and preflights (`~/.pi/agent/models.json` + valid auth). No credentials are
   copied into the project or Mission storage.
2. An explicit, capped test budget in model-USD, set as `EVOK_LIVE_TEST_BUDGET_USD`.
3. A tiny local research project with `.evok/evaluation.json` (the independent
   local file-metric evaluator) and a `MISSION.md` reference. The candidate
   objective is deliberately trivial (materialize `answer.txt`) so the spend is
   tiny and the independent measurement is reproducible.

No real **External Submission** is permitted at any point; the Mission
permissions stay `read-project` + `isolated-workspace-write` (+ optional
workspace-local shell) with `network: "none"`.

## Run

```bash
export EVOK_LIVE_TEST=1
export EVOK_LIVE_TEST_BUDGET_USD=0.5     # explicit, capped
export EVOK_LIVE_RECORD="$PWD/live-record.json"

# 1. intake (one turn), then review the saved draft
bun run evok --intake --project ./live-project "raise the answer metric toward 0.9 on this project"

# 2. explicit start (baseline + autonomous continuation); Ctrl+C stops the
#    in-flight dispatch/decision and records a truthful interrupted state
bun run evok /start --mission <id> --project ./live-project --max-experiments 3

# 3. reopen the project — no work resumes from listing
bun run evok --missions --project ./live-project
bun run evok --status --mission <id> --project ./live-project

# 4. explicit resume: adopt confirmed runs, reconcile unconfirmed work, continue
bun run evok /resume --mission <id> --project ./live-project
```

The same stop can instead be sent as SIGINT to the process group from another
terminal; `Ctrl+C` keeps its normal meaning (cancel the in-flight request), it
is **not** bound to a new Mission-pause shortcut (ADR-0004).

## What to record (live evidence, distinct from fixtures)

The acceptance record (`EVOK_LIVE_RECORD`) must contain:

- `model`: resolved provider/model id and tier that actually served each Run.
- `sourceAndToolUse`: the reference/skill files read and the tools actually
  invoked (from the Run ledgers), confirming real retrieval and file work.
- `artifacts`: durable paths under
  `./live-project/.evok/missions/<id>/runs/*/snapshot|result.json`.
- `independentObservations`: the evaluator id/version and measured
  scores/facts for baseline and follow-up — read from `result.json`, never
  from model text or a pre-filled score file.
- `usage` and `costUsd`: token lines per candidate Run and per decision call;
  total observed cost, asserted `<= EVOK_LIVE_TEST_BUDGET_USD`.
- `stopAndRecovery`: the interruption boundary (before/after confirmation),
  the reopen listing, the resume reconciliation (`adopted` / `re-measured` /
  `abandoned`), and proof the confirmed work was not re-executed or re-billed.
- `externalSubmission: false`, `distinguishing: "live"`.

## Gate

A recorded, authorized live run for #114 is checked in at
`docs/live-record-t6.json` (model `ai-modeling/doubao-seed-evolving`, total
$0.0559 of a $0.50 cap, externalSubmission=false). Verify it with:

```bash
EVOK_LIVE_TEST=1 EVOK_LIVE_TEST_BUDGET_USD=0.5 \
  EVOK_LIVE_RECORD=./docs/live-record-t6.json \
  bun test --path-ignore-patterns="" tests/integration/live-recovery-acceptance.live.test.ts
```

Without `EVOK_LIVE_TEST=1` and a positive budget the gate **fails closed** when
explicitly run (and is excluded from `bun test` by default). A successful live
run, its record, and any discrepancy versus the controlled fixtures are then
reported on issue #114 before this acceptance is considered complete.
