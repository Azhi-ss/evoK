# Validation ladder — inner CV → outer holdout → limited Public probe (T41, #34)

A three-level **data-split / leaderboard policy** contract that keeps any single
val or Public score from deciding a champion. Overfitting one validation set or
grinding the Public leaderboard is what causes a Private-LB shake-up (research
gap G2, spec #1). Implementation: `src/evidence/validation-ladder.ts` (flat
`src/validation-ladder.ts` re-exports); wired into the
mission seam in `src/toy-harness.ts`; ledger event classification in
`src/evidence/ledger-kinds.ts`.

## Scope — this is NOT the #11 evaluation noise protocol

This ticket and **#11** (`src/evaluation-noise.ts`) are complementary and
deliberately kept as separate contracts and tickets:

| | **#34 validation ladder (this)** | **#11 evaluation noise protocol** |
|---|---|---|
| governs | **which data split / leaderboard** a score came from and **who may read it** | **score noise** — repeats, escalation ladder, A/B agreement, margins |
| question | "Is this number from inner CV, the outer holdout, or a Public LB submission — and may a champion rest on it?" | "Is this one noisy score trustworthy enough to act on?" |
| enforcement | level declaration + reader visibility + probe cap + promotion basis | required repeats, best-of-N, symmetric A/B, tight-margin/micro-gain policy |

Noise ≠ data-split/LB policy: an outer-holdout score can still be a single noisy
draw (handled by #11), and a fully A/B-validated Public probe is still forbidden
as a promotion basis (handled here). A real evaluation usually needs both; the
contracts remain independently declared.

## The three levels

| level | purpose | default readers |
|---|---|---|
| `inner_cv` | repeated/inner search signal — drives parameter & model search only | `candidate_search`, `evaluator` |
| `outer_holdout` | the untouched held-out split — the default (and only unattended) promotion basis | `promotion_gate`, `mission_director`, `evaluator`, `auditor`, `operator` |
| `public_lb` | an optional, limited, expensive Public-leaderboard submission | `operator`, `submission_broker`, `mission_director`, `auditor` |

Spec story 11 is enforced as visibility: the leaderboard-optimizing search engine
(`candidate_search`) reads `inner_cv` but **never** `outer_holdout` or
`public_lb`; the `promotion_gate` reads `outer_holdout` but **never** the Public
score. Visibility is queryable via `canReadScore(level, role)`. The reader lists
are the fixed contract policy above; an adapter does not get to widen them
(fail-safe defaults are the whole point of story 11).

## Contract face

A `ToyCompetitionAdapter` optionally declares `validation_ladder` /
`validationLadder` (object or accessor; absent → the gate is inactive and legacy
missions run unchanged):

| field | aliases | default | meaning |
|---|---|---|---|
| `promotionBasis` | `promotion_basis` | `outer_holdout` | unattended promotion basis; any value other than `outer_holdout` is a configuration error |
| `publicProbeCap` | `public_probe_cap` | `0` | explicit count of Public LB probes allowed; must be a non-negative integer |

`resolveValidationLadder()` validates and freezes the contract; a non-holdout
promotion basis or a bad cap fails closed before the mission starts.

## Promotion and probe enforcement (mission seam)

An evaluator tags each evaluation with its validation level
(`validationLevel` / `validation_level` on the result: `inner_cv` |
`outer_holdout` | `public_lb`). With the ladder active:

1. **Default promotion uses the outer holdout, never the Public probe.** A
   `PROMOTED_LOCAL` verdict is refused (`BRANCH_REJECTED`) unless the evaluation
   it cites is `outer_holdout` evidence.
2. **Inner-CV-only improvement can never champion.** An `inner_cv` evaluation
   without outer evidence is rejected even when its raw score is higher.
3. **A Public LB probe can never champion.** A `public_lb` evaluation is rejected
   at the promotion gate regardless of score.
4. **Explicit probe cap.** Before a Public score is recorded as Evidence,
   `authorizePublicProbe(contract, spent)` checks the ledger-projected spend
   (`publicProbesUsedFromEvents`). Once the cap is exhausted the probe is
   **refused before any public score becomes Evidence** — a `PUBLIC_PROBE_REFUSED`
   Evidence event (`cap`, `spent`, `reason`) is appended and the branch rejects;
   further probes are refused the same way. The default cap is `0` (probe off
   unless explicitly budgeted).
   ponytail: v0 enforces the cap at the Evidence boundary — the refused probe
   leaves no public score in the ledger, so it can never feed grading or
   promotion. It does **not** physically block the expensive submission from
   executing, since the toy evaluator has no real external submission side
   effect; when a real adapter wires the Public LB through the SubmissionBroker,
   the same `authorizePublicProbe` check must run *before* the external call (the
   broker already requires an approval gate, so this is a guard placement, not a
   new authority).
5. **Fail closed on an undeclared level.** With the ladder active, an evaluation
   that names no validation level is rejected rather than promoted.

The contract and the projected `publicProbesUsed` count are exposed on
`MissionState` (`validationLadder`, `publicProbesUsed`).

## Ledger

- `PUBLIC_PROBE_REFUSED` — **Evidence** kind (an observation that a probe was
  denied by the cap), replay-safe and classified in `src/evidence/ledger-kinds.ts`.
- The evaluation's validation level rides the existing `EVALUATOR_SUCCEEDED`
  Evidence payload; promotion refusals ride the existing Evaluation-kind
  `BRANCH_REJECTED` with an explicit reason. No verdict silently uses a
  Public/inner score.

Graph Engineering note (#39): the holdout/probe scores are **Evidence**;
whether a candidate champions is the separate **Evaluation** verdict that cites
those Evidence ids. "Inner-CV-only can never champion" is precisely "an
Evaluation may not treat a wrong-level Evidence as its promotion basis".
