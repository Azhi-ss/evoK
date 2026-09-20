# Spec · contest-arm auto-submit (ET-SUBMIT-AUTO / #179)

Contest-arm **automatic External Submission** is allowed only when every
promotion / evidence gate is **green**. Every attempt writes an auditable
ledger. Any red / yellow / missing gate **fails closed** and must not
submit.

This is not a commercial contest OS and not DeployArena thick
orchestration. `#40` Progressive stays **opt-in**; the product default
remains `fixed_uct`.

## Seam

`attemptContestAutoSubmit` / `evaluateContestAutoSubmitGates` in
`src/evidence/contest-auto-submit.ts`.

1. Re-evaluate the existing gate APIs (do not accept a caller-supplied
   `ok: true`).
2. Color each gate `green` / `yellow` / `red` / `missing`.
3. If any gate is not green → write ledger → **do not** call submit.
4. If all green → call the injected submit seam (mockable). Real network
   submit stays behind `{ live: true }` plus an existing Broker
   destination.

`createBrokerContestSubmitSeam` is the existing submit adapter. Dry-run
uses `SubmissionBroker.createDryRun`. Live uses `createRequest` + a
gate-green authorization (`acceptedBy: "contest-auto-submit"`) +
`submit`. The compatibility `autoSubmit` flag is unchanged and still
cannot bypass Human Acceptance on a direct `broker.submit` call.

## Required gates

| Gate | Existing API | Green | Not green |
|---|---|---|---|
| **promotion** | champion eligibility (evaluator + Success Auditor + local promote) | all three true | missing champion, or not promoted |
| **hang** | `runKillTestHang` | `ok` **and** a ledger `KillTestPlan` | missing input or missing plan; `fail` = red; `inconclusive` = yellow. Claiming pass without a plan is not green. |
| **T48** | `auditMethodology` + `oofEnsembleGate` | both `ok` (sleep when no contract is injected — existing predicate) | disagree / missing used-split / required OOF absent |
| **Admission** | `evaluateMethodAdmission` | `admitted` | missing input; missing holdout / official / adversarial = red; hang / inconclusive = yellow |
| **Budget** | `evaluateBudgetGate` / `budgetDecisionIsPass` | pass | missing input; unreserved / over-budget = red |

Elite / score / Team Fan-Out are **not** keys. They cannot turn a red
Admission or Budget gate green.

## Ledger

`InMemoryContestAutoSubmitLedger` (or any `ContestAutoSubmitLedger`):

- every attempt → `CONTEST_AUTO_SUBMIT_ATTEMPTED`
- refuse → `CONTEST_AUTO_SUBMIT_REFUSED`
- submit called → `CONTEST_AUTO_SUBMIT_SUBMITTED`

Live Broker submits also write the existing SubmissionBroker events.

## Locks

- Admission / Budget / hang / T48 **predicates are not loosened**.
  Hardening (fail-closed on missing) is intentional.
- `#40` / Progressive default stays **off** / `fixed_uct`.
- Deploy Arena stays orthogonal standby.
- No commercial contest OS, weight training, or Elite-as-promotion key.
