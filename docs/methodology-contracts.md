# Methodology contracts — feature pipeline / OOF ensemble / split discipline (T44, #37)

Three Kaggle-methodology objects promoted from "the inner search does whatever"
to first-class harness/adapter contracts. Table competitions are won or lost on
**feature engineering, ensembling, and the split**; editing a whole file blindly
and splitting randomly produces fake CV (research gaps G4/G5/G6, spec #1).
Implementation: `src/evidence/methodology-contracts.ts` (flat
`src/methodology-contracts.ts` re-exports); wired into the mission seam in
`src/toy-harness.ts`.

The three objects:

1. **`feature_pipeline`** — a component-level feature pipeline with named steps;
   independently searchable / ablated without touching the ensemble or the split.
2. **`oof_ensemble`** — a stacking / blending ensemble; promotion requires OOF
   (out-of-fold) predictions or a contract-declared leakage-safe equivalent.
3. **`split_contract`** — time / group / kfold split discipline with **purge**
   and **embargo** declarations. Violating a declared split is a **rule
   failure**, not merely a worse score.

## Contract face

A `ToyCompetitionAdapter` (or a candidate/task declaration) optionally exposes
the contracts via `methodology_contracts` / `methodologyContracts` /
`methodology` (object or accessor; a mission may also pass
`methodologyContracts` in its options). Absent → the methodology gates are
inactive and legacy missions run unchanged. `resolveMethodologyContracts()`
validates and freezes the bundle; a malformed declaration fails closed.

| object | required fields | notes |
|---|---|---|
| `feature_pipeline` | `id`, `steps[]` (each `id` + `kind`, optional `params`) | ≥1 step or resolution throws |
| `oof_ensemble` | `id`, `members[]` (≥2), `method`, `oof` | `method` is `stack`(ing) / `blend`(ing); `oof.protocol` must be `oof` or carry `declared_equivalent: true` |
| `split_contract` | `id`, `kind`, `folds` | `kind` is `kfold` \| `time` \| `group`; `purge`/`embargo` default to `0` (a `gap` alias maps to `purge`); a `group` split requires `group_column` |

## Rule failures, not worse scores

- **Split discipline.** `auditMethodology(contracts, files)` statically scans
  candidate files for a random/shuffling splitter (`KFold(shuffle=True)`,
  `StratifiedKFold`, `ShuffleSplit`, `train_test_split`, `splitter="random"`,
  …). Only a declared **time** or **group** split is audited — a `kfold`
  contract permits ordinary random CV. A confirmed violation raises
  `MethodologyViolation` (a `TrustViolation`); the harness **quarantines the
  branch before it is ever evaluated**, exactly like a data-honesty leakage
  finding. A worse score is negotiable; a broken split is not.
- **OOF ensemble promotion.** An ensemble candidate promotes only with OOF
  predictions (or a declared leakage-safe equivalent). The candidate signals
  `component=ensemble` and OOF presence via evaluation facts
  (`oof_predictions` / `oof_present` / `oof`). With an `oof_ensemble` declared,
  the promotion gate calls `validateEnsemblePromotion(...)`; an ensemble with no
  OOF is rejected (`BRANCH_REJECTED` with an explicit leakage reason). Non-ensemble
  candidates and missions with no declared ensemble pass through.

## Component fan-out — touch only FE or only ensemble; never the split

`applyComponentFanOut(contracts, { component, change })` applies a bounded
component-level change:

- a `feature_pipeline` change (`add_step` / `remove_step`) rebuilds only the
  feature pipeline; the ensemble and split are carried through unchanged;
- an `oof_ensemble` change (`add_member` / `remove_member`) rebuilds only the
  ensemble; the feature pipeline and split are carried through unchanged.

The result is **re-normalized**, so a malformed outcome (e.g. an ensemble left
with fewer than two members) fails closed instead of silently propagating.

**Inner search must never silently rewrite `split_contract`.** The split is
structurally out of reach of fan-out: a change that names `split_contract`
throws, and every fan-out carries the declared split through byte-identical.
A candidate that re-declares a random splitter against a time/group contract is
caught by the split audit above. This keeps the inner candidate-search engine
from quietly trading a valid (purge/embargo-protected) CV for an optimistic,
leaking one — the same story-11 separation that keeps search from reading the
holdout.

## Manifest evidence seam (T48)

`src/evidence/methodology.ts` handles the plugin wire contract and manifest digest/OOF
checks. It is not a replacement for this module's source audit or evaluator-fact
OOF gate. Its camel-case contract (`splitRef`, `required`, etc.) differs from
T44's component contracts; do not feed one resolver's output into the other.

The `src/toy-harness.ts` barrel retains the T44 names (`MethodologyContracts`,
`resolveMethodologyContracts`, `auditMethodology`). Manifest APIs are available
under `methodologyManifest` and their contract types have `Manifest*` aliases.
Direct imports from either module remain supported. A unified schema/converter
is deferred rather than silently dropping T44 purge/embargo or component data.

When both paths are wired, candidate source and adapter rule validation run
before evaluation; the local OOF/holdout gates run before `KillTester` writes its
result. `KillTester` still follows `SuccessAuditor`, and passing it never replaces
claim-card, cross-model, baseline, promotion-policy, or human-acceptance checks.
The combined path is covered by `tests/integration/merged-promotion.test.ts`.

## Ledger / seam

- A split violation rides the existing trust-violation path: the branch is
  quarantined (`BRANCH_QUARANTINED`) before snapshot evaluation, so a broken
  split never produces a score.
- An OOF-less ensemble promotion refusal rides the existing Evaluation-kind
  `BRANCH_REJECTED` with an explicit `oof|leakage` reason.
- No new promotion or submission authority is introduced; these gates only
  refuse, matching the data-honesty (`docs/data-honesty.md`) and validation-ladder
  (`docs/validation-ladder.md`) contracts.

ponytail: the split audit is a deliberately naive static token scan (comments
included, fails closed) and the OOF signal is read from evaluation facts; an
obfuscated splitter or a candidate that lies about OOF escapes. Upgrade path:
AST/dataflow analysis plus adapter-provided split/OOF probes when a real adapter
replaces the toy fixtures.
