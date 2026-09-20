# Spec · promotion hardening (ET-PROMO-HARD / #180)

Landable before-promotion / kill-hang / ledger Specs stacked on the
existing hang and contest-auto-submit seams. **Tighten only.** Admission /
Budget / hang / T48 predicates are not loosened. `#40` stays opt-in /
default `fixed_uct`.

## Stack

```
T48 methodology / OOF (sleep when no contract)
  → Kill-test hang (before-promotion overlay; SuccessAuditor family)
  → Broker / contest-arm auto-submit
```

| Path | Module | Notes |
|---|---|---|
| **Ledger** | `HypothesisLedger` (`#50` H1/H2) | `Hypothesis` / `KillTestPlan` / `KillTestResult`; events `hypothesis.created` · `status_changed` · `expand_requested` · `kill_test.planned` · `finished`. `expand_requested` does not call UCT. |
| **Hang** | `runKillTestHang` / `createKillTestHangHook` (`#52` K1/K2) | After T48, before Broker. `pass` / `fail` / `inconclusive`; `inconclusive ≠ pass`. Unmapped Artifact or sole MMD/near-dup/side-slot scalar is a hard reject. |
| **Before-promotion AC** | E1 `#68` + E3 `#69` + E2 `#70` | `assembleOuterE2eMinPath` wires mapped refs + ledger plan into the hang hook. |
| **Broker** | `attemptContestAutoSubmit` (`#185` seam) | Hang is green only with a ledger `KillTestPlan`. No plan cannot claim pass. |

## Locks

- Isolated `runKillTestHang` predicate checks may omit a plan (T48 / scalar filters).
- Before-promotion hook and contest-auto-submit **require** a ledger plan.
- Elite / MMD / near-dup / side-slot / Team Fan-Out are not Promotion keys.
- Durable sqlite, full param-space/MMD adapter, DeployArena thick orch, extra `#50` columns (`parent_ids`, `spawned_by`, plan `budget`/`status`), and `#77–#79` (issue bodies unreachable here) stay out of this slice.
