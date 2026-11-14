---
status: accepted
---

# 0008 — Physical `src/evidence/` pack (ET-A1 / #121)

Physical cut of the evidence package. Logical ownership stays the six-pack
map in [ADR-0007](0007-six-pack-ownership.md). No gate, T48, hang, or Broker
predicate change.

## Decision

Gate-authority modules live under `src/evidence/`:

- ledger: `hypothesis-ledger` (write/projection in the same module), `ledger-kinds`
- hang: `kill-test-hang`
- methodology: `methodology`, `methodology-contracts`, `methodology-acceptance`, ME-1 seam tests
- gates: `verification-gates`, `validation-ladder`
- Broker simulation: `submission-broker`

Amendment (ET-M1-EXP / #142): experiment-validity and method Admission /
writeback also live here (`experiment-validity`, `method-admission`).
They do not change Kill-test / T48 / hang / Broker predicates.

Amendment (ET-M1-BUD / #144): the Budget Gate reserve → settle
contract also lives here (`budget-gate`). Over-budget or unreserved
refuses continue / writeback. Budget pass is not Admission pass.
It does not replace MissionRecord operational accounting and does
not change Kill-test / T48 / hang / Broker predicates.

Amendment (ET-SUBMIT-AUTO / #179): contest-arm auto-submit lives here
(`contest-auto-submit`). All promotion / evidence gates must be green
or the attempt is ledged and refused. Predicates are reused, not
loosened. Compatibility `autoSubmit` still cannot bypass Human
Acceptance on a direct `SubmissionBroker.submit` call.

Amendment (ET-PROMO-HARD / #180): the hang gate on contest-auto-submit
and the before-promotion hook require a ledger `KillTestPlan`. Claiming
kill-test pass without a plan fails closed. Isolated `runKillTestHang`
predicate checks may omit a plan. Admission / Budget / T48 / hang
tri-state predicates are not loosened.

Amendment (ET-DEPLOY-ORCH / #182): DeployArena COI reuses
`attemptContestAutoSubmit`. Competition assembles `submission.json`
and the playground seam; this pack still owns the gate colors and
ledger. Predicates are not loosened.

Amendment (M1-T1 / #210): the Mission Research Memory projection model
(`research-memory`) lives here: deterministic, bounded reading cards
projected from authoritative Mission history, with content-addressed
snapshots validated on load. It is derived and advisory; Mission history
stays the only write log, and no gate / T48 / hang / Broker predicate
changes.

Amendment (M1-T2 / #211): the pinned Research Decision Packet
(`projectResearchDecisionPacket`, `evok.research-decision-packet/v1`)
lives here. It is a bounded, content-addressed presentation view of ONE
validated Research Memory snapshot, and `assertPacketCardRefs` refuses a
decision that claims a card outside it. The packet is advisory: the
mission controller still derives decision deltas, validates both proposal
stages, and keeps every budget / permission / gate predicate unchanged.

Amendment (M1-T3 / #212): stored Synthesis Proposals (`synthesis-proposal` module,
`evok.synthesis-proposal/v1`) and their reading cards
(`evok.research-memory-hypothesis-card/v1`,
`evok.research-memory-synthesis-finding-card/v1`,
`evok.research-memory-pitfall-card/v1`) live here. The controller validates identity,
schema, sensitive content, typed refs, visibility, applicability and
idempotency before storage; an accepted Proposal is `accepted_for_storage`
while staying epistemically unverified, and reads as a provisional
Hypothesis / Finding / Pitfall card in the next deterministic snapshot.
Proposal integrity is never scientific approval, refs alone cannot create a
Verified Claim, next-validation content is advisory-only, no background LLM
synthesis runs, and a rejection record keeps a reason code plus a content
address but never the refused payload.

Amendment (M1-T4 / #213): `run-outcome` classifies one authoritative Run
Outcome as `positive`, `negative` (a real measured refutation) or
`operational` (OOM, timeout, invalid measurement, protocol failure). Only a
measurement can create scientific Negative Evidence; an operational failure
keeps its Run Outcome and projects an advisory Operational Pitfall card
(`evok.research-memory-operational-pitfall-card/v1`) with its reproducing
conditions, and can never refute a Hypothesis. Finding cards carry the
outcome state so packets and persisted snapshots stay visibly distinct, and a
repeated Experiment objective carries advisory replication context — never a
rejection or a Memory-owned veto. Existing Experiment Validity, Promotion,
Admission, Budget, hang/T48 and Broker predicates are untouched.

Amendment (M1-T9 / #218): the evaluation arms live here too. A trusted
configuration value selects `off` / `sham` / `real` (`researchMemoryModeOf`,
durable on the Mission record so a resume cannot switch arms), and the
Schema-only Sham is a projection, not a second store: `shamResearchMemorySnapshot`
and `shamResearchDecisionPacket` keep the real card count, order, kinds, limits,
reserved categories and omission counts while replacing every card with an
`evok.research-memory-control-card/v1` slot — no research fact, ref,
applicability or directional advice, explicitly marked `control: "sham"`, and
validated to fail closed otherwise. The three-arm report and its offline replay
(`src/mission/memory-evaluation.ts`) are pure reads over authoritative durable
records: they pin each Run to the state visible before it began and change no
evaluator, Promotion, Admission, Budget, hang/T48 or Broker predicate.

Flat `src/*.ts` files remain compatibility re-exports. Consumers may keep
importing the old paths.

Later note (2026-11-14 layout simplification): those flat re-exports are deleted. Import this pack. See ADR-0013.

**Boundary:** evidence 独占门权威；search 持结构；mission 只读摘要 / 挂 hang.

Methodology fixtures stay at `src/fixtures/methodology/` with an ownership
pin. Contest-arm auto-submit is fail-closed and ledged. Elite / Team
Fan-Out are not Promotion keys. Pattern C is not thickened.

## Out of scope / freezes

- No change to gate three-state, T48, hang, or Broker predicates.
- Contest-arm auto-submit stays fail-closed (all gates green + ledger).
- No move of `search-selection-port` / Progressive, `runGoldenPath` / mission-*,
  `llm-comp-arm*` runtime, or Team orchestra.
- No `#40` / default `fixed_uct` / Progressive default change.
