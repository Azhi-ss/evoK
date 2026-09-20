# evidence

evidence 独占门权威；search 持结构；mission 只读摘要 / 挂 hang。

Physical home of the Hypothesis ledger, Kill-test hang / T48, methodology
gates, verification-gates, validation-ladder, experiment-validity,
method Admission / writeback, Budget Gate (reserve → settle), Broker
**simulation**, and contest-arm auto-submit (all-green / fail-closed).
P6: physical pack is in place (barrel `index.ts`). Remaining flat
`src/*.ts` files are migration-period re-exports for one more release
([ADR-0013](../../docs/adr/0013-six-pack-physical-closeout.md)).

Contest-arm auto-submit (`contest-auto-submit`) is allowed only when every
promotion / evidence gate is green. The hang gate requires a ledger-bound
`KillTestPlan`. Each attempt writes a ledger; any red / yellow / missing
gate fails closed and must not submit. `submission-broker`
keeps the existing simulation (`PROMOTED_LOCAL` / dry-run / acceptChampion
analog). Real network submit stays behind `{ live: true }` plus an injected
destination. Elite / MMD / near-dup / Team Fan-Out are not Promotion keys.
Pattern C is not thickened here.

Methodology JSON fixtures stay at `src/fixtures/methodology/` (evidence-owned;
see that directory's ownership note) so competition-runtime import paths remain
stable.
