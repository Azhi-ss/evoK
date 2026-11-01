---
status: accepted
---

# 0015 — Phase 2 Playground arm (#208)

Scope of the Harness Phase 2 competition adapter and its research
integration. Clarifies how this arm relates to the freezes in
[ADR-0010](0010-mission-cli-physical-pack.md) and
[ADR-0012](0012-competition-physical-pack.md) without amending their
behavior.

## Decision

- The Phase 2 Playground challenge (`harness-45c4688b`) gets a
  competition-specific adapter (`src/competition/phase2-playground.ts`)
  and a research workflow seam (`src/mission/phase2-research.ts`), plus a
  thin CLI (`src/cli/phase2-cli.ts`). This is a new, separately
  identified arm, not the contest arm and not DeployArena.
- **Frozen surfaces are unchanged**: the generic SubmissionBroker,
  contest-arm auto-submit (`attemptContestAutoSubmit`), frozen AtCoder
  behavior, and the live S1 path are neither called nor modified. The
  ADR-0010 freeze ("no real contest submit path") and the ADR-0012
  freeze ("True External Submission stays frozen") continue to cover
  those paths. Issue #208 explicitly requests this arm's real
  submission capability, so its real submit is enabled **only** as
  `--real` with release checks green, fresh platform-confirmed daily
  quota, an explicit estimated cost within the shared cap, and an
  exact dry-run-validated bundle. Dry run, real readiness and a real
  receipt are distinct results; env alone never opens live.
- **No evidence-gate migration.** Release checks here are competition
  preparation facts (pinned Harbor kit, offline source validation,
  public smoke, real public-task validation), which CONTEXT.md assigns
  to the Competition Adapter. They are not Promotion, Admission, hang,
  T48 or Broker predicates, and none of those are reused or weakened.
- **The shared spend ledger is operational accounting**, in the same
  sense as MissionRecord accounting: a persisted cap, per-kind spend,
  and a submission cost reservation settled to the official cost. It
  is not the evidence Budget Gate (reserve → settle authorization) and
  does not authorize continue/writeback. S1-metered workspace charges
  are booked in the S1 ledger only (`externalBooking`), never twice.
- **Director vs adapter authority.** The Mission Director nominates and
  decides next actions; the competition module owns the
  competition-defined eligibility/ranking rules
  (`isPhase2Eligible`, `strongestPhase2Revision`) and all submission
  mechanics. Official score/cost/status is ingested only from the
  acknowledged own attempt, as summary facts, for its own revision.
- Researcher-facing views are whitelists: no credentials, private
  checkers, withheld scores, release rules, attempt internals or the
  global budget.

## Out of scope / freezes

- No change to SubmissionBroker, contest-auto-submit, AtCoder, live S1,
  Admission / Budget Gate / hang / T48 predicates.
- No second control plane: the CLI is a thin shell over the same
  classes a running Mission calls.
- No real submit without the actual pinned kit, verified candidate,
  platform-confirmed quota and budget headroom.
