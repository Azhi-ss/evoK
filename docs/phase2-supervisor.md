# Phase 2 Pi supervision (#219)

The extension wraps `PiCampaignHost.rounds` in `createSupervisorRoundHost` when
the host supplies `supervision.directory`. `registerRoundWake` still owns the
single Director queue, idle checks, metered provider selection and restoration.
There is no additional agent or model provider. Quiet polling does not open a
meter or request a model turn.

The supervisor reads `status.json`, `state.json`, `campaign.json`, `limits.json`
and the existing `campaign.status()` budget projection. It never writes those
files, reconciles charges, dispatches work, or submits a candidate. Campaign's
deterministic `deadline-stop` and `budget-stop` remain intact.

| Watcher | Trigger and identity |
| --- | --- |
| result | A finite official score, including zero; key is attempt id + score. Reports the matching revision's screening mean and official-minus-screening deviation. |
| deadline | At/after 21:00 +08 with an unused local slot, or expired internal deadline; one notification per +08 date. Uses the existing strongest-eligible-revision ranking. Actual attempt submission history is converted to +08 (the latest `submitting`
entry wins, so a retried attempt still consumes its day); a known exhausted
account quota suppresses `submitDue`. |
| budget | Crossing below the floor (default CNY 40), or held-unverified increasing more than settled between observations. A continuing floor breach does not re-alert on the Director's own spend. Recovery arms the next crossing. |
| stall | The same evaluating digest/task/phase/start time exceeds 90 minutes, or a digest has at least two consecutive zero screening scores. Thresholds can be supplied by the host. |

Notification identities include the campaign directory and are persisted as
`evok-round` custom messages in the active Pi session branch. A delivered
supervisor notification is not bought again even if Pi exits before the answer.
The budget comparison baseline, floor episode and undelivered growth alerts are
persisted as `evok-supervisor-budget` entries, so a restart does not lose an
observed growth edge. Filesystem notifications are debounced; a 30-second
unreferenced timer also detects clock-only deadline/stall transitions and budget
changes. Shutdown removes both subscriptions and the timer.

The wake includes the rule, evidence and three decisions: `advise` in the next
research handoff; `submit` only when a deadline event has `submitDue`; or
`reconfigure` only after recording the operator's explicit decision. Release
still goes through `scripts/release-candidate`, `PHASE2_RELEASE_COST_BOUND_CNY`,
fresh account quota and existing validation checks. A local unused slot is not
proof of account quota. Missing measurements/costs are reported as unknown.

## Independent competition workspace

The Python campaign and `scripts/pi-campaign-host.ts` live in the separate
`playground/harness-phase2` checkout, not this engine repository. The companion
[workspace patch](phase2-supervisor-workspace.patch) contains the host wiring,
meter adapter, read-only daily spend projection and their regression tests.
Apply it to that checkout when updating an older installation:

```sh
git apply --check /path/to/evoK/docs/phase2-supervisor-workspace.patch
git apply /path/to/evoK/docs/phase2-supervisor-workspace.patch
```

The host supplies `supervision: { directory: join(root, ".phase2/campaign") }`.
Supervisor wakes use the existing Director meter without claiming/acknowledging
a fabricated campaign job. `openDirector` receives the current provider/model.
The workspace meter currently supports only `ai-modeling/kimi-k3-1-pro-261024`;
another selection produces a waiting notice instead of silently changing
provider or opening an unmetered call. `dailySpend` groups booked ledger amounts
(including holds) by +08 date; undated access/cloud amounts stay explicit in
`undatedSpendCNY`. No accounting amounts or reservation states are changed.

The workspace must load this engine revision via its existing checkout pin or
`EVOK_REPO`. Installing the change does not itself run a live submission.

## Offline verification

```sh
bun test src/cli/pi-supervisor.test.ts src/cli/pi-round-wake.test.ts \
  src/cli/pi-campaign-director.test.ts tests/integration/pi-supervisor.test.ts
bun run typecheck
```

The integration fixture uses the real Pi `SessionManager`, reopens its JSONL
session from disk, and checks both official score delivery and clock-only daily
submission proposals. It does not call a model or the Playground platform.
