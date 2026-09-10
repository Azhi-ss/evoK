# evoK recovery lifecycle example (T6 · #114)

A small, **fully offline, reproducible** example of the v1 research lifecycle,
including interruption and explicit recovery. It uses the real evoK operations
with a deterministic **faux** model, so there are **no paid model calls and no
network**:

```
skill/reference reading
  → natural-language intake (reviewable draft, nothing dispatched)
  → explicit "/start"
  → real baseline execution in an isolated workspace
  → independent measurement
  → evidence-dependent follow-up proposed by the read-only Mission Director
  → durable persistence
  → operator stop after the baseline is confirmed
  → reopen: progress, stop reason, remaining budget (no auto-resume)
  → explicit "/resume": reconstruct from durable records, reuse the confirmed
    baseline (no duplicate execution/accounting/evaluation), continue
```

## Run

```bash
# full lifecycle in a fresh temp project
bun run example:lifecycle

# in a fixed project directory
bun run examples/lifecycle/recovery-example.ts ./my-example-project

# reopen an existing project: list unfinished Missions and stop
bun run examples/lifecycle/recovery-example.ts ./my-example-project --reopen
```

## What demonstrates what

| Acceptance point (#114) | Where it shows |
| --- | --- |
| Reliable interruption that does not hijack Ctrl+C | The start controller is stopped through an `AbortSignal` after the baseline is durably confirmed; confirmed results persist and the uncertain decision is cancelled. The CLI keeps `Ctrl+C` as request cancellation only. |
| Reopen lists progress/stop/remaining budget | `--reopen` prints status, baseline/experiment counts, negative evidence, consumed/remaining budget, and the stop reason. Listing never resumes. |
| Only an explicit request resumes | `/resume <id>` / `--resume`; questions and negations are rejected (`isExplicitResumeRequest`). Intake is not repeated and budget is not restored. |
| Reuse confirmed outcomes | The resume output `adopted:` lists the confirmed baseline; it is not executed, metered, or evaluated again. |
| Reconcile unconfirmed work from evidence | Unconfirmed pre-interrupt intents are abandoned as Negative Evidence; a durable snapshot without a result is independently re-measured; a retry gets a fresh Run id (`exp:2` → `exp:3`) and remaining budget. The separate-process tests in `tests/integration/mission-resume.test.ts` exercise both boundaries. |
| Preserve objective/evaluation/permissions/accounting | Recovery reconstructs solely from `mission.json`, per-run `result.json`, and immutable snapshots; damaged budget arithmetic or a digest mismatch blocks recovery visibly. |
| Independent evaluator | `evaluator` in the script parses the frozen snapshot's `answer.txt` itself. The model never supplies a score and there is no score-file input. |

## Live acceptance is separate

This offline example is controlled evidence, **not** the live acceptance. The
full live scenario (real provider, real tools, recorded model/cost/artifacts)
runs only with an explicit test budget and usable provider configuration;
missing authorization blocks rather than passes. See
`docs/live-acceptance-t6.md`.
