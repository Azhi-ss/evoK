# ET-PROMO-HARD handoff — 晋级硬化（可落地 Spec + 收紧，不放宽）

| field | value |
|-------|--------|
| **ticket** | #180 · 晋级门+控制面（before-promotion / kill-hang / ledger 能合则合） |
| **slice** | hang 挂钩 + contest-auto-submit 要求 ledger `KillTestPlan`；named AC；本 handoff |
| **locks** | `#40` 仍 opt-in / 默认 `fixed_uct`；Admission / Budget / hang / T48 **谓词未放宽**（Broker/挂点收紧：无 plan 不得声称 pass）；Elite ≠ 晋级 |

## 路径（短）

1. **Ledger（#50 H1/H2）** — `src/evidence/hypothesis-ledger.ts`：`Hypothesis` / `KillTestPlan` / `KillTestResult`；事件 `hypothesis.created` · `status_changed` · `expand_requested` · `kill_test.planned` · `finished`。`expand_requested` 只记账本，不调 UCT。
2. **Hang（#52 K1/K2）** — `runKillTestHang` / `createKillTestHangHook`：T48 后、Broker 前；三态；`inconclusive ≠ pass`；无 T48 映射 Artifact 或仅标量诊断 → 硬拒。
3. **Before-promotion AC（#68 E1 / #69 E3 / #70 E2）** — `assembleOuterE2eMinPath` 把 mapped refs + ledger plan 挂进 `ToyCompetitionHarness.verification.killTestHang`。
4. **Broker（#185 缝）** — `attemptContestAutoSubmit`：**无 ledger `KillTestPlan` 不得绿 hang**；全绿才交；每次 attempt 写 contest ledger。

## 落地 vs 延后

| Spec / # | 本票 | 说明 |
|---|---|---|
| **#50** ledger 三对象 + 事件 + expand 不调 UCT | **landed / locked** | 既有 H1/H2；named AC 锁字段名（`hypothesisId` / `planId` / `resultId` / `evidenceRefs`） |
| **#51** 旁槽 / MMD 不得当晋级键 | **filter landed** | hang / catalog 硬拒标量唯一判定 |
| **#52** Kill-test 挂点 | **landed + tightened** | 挂钩 / contest-auto-submit 要求 ledger plan |
| **#68** E1 runner | **landed / locked** | `runOuterMinPathSetup` |
| **#69** E3 mapped search-space refs | **landed / locked** | `buildOuterSearchSpaceFixtures` |
| **#70** E2 outer AC | **landed / locked** | `outer-e2e-min-path` + 接到 auto-submit |
| **#77–#79** | **locked if LLM.3 / LP.2 / ME1；else deferred** | issue 正文本环境 403 读不到。仓库已有 LLM.3 / LP.2 / ME1 named AC，未新造门语言 |
| **#51 全量** param-space / MMD 适配器 | **deferred** | 诊断适配器 / S* 不在本票 |
| **#50 增列** `parent_ids` / `spawned_by` / plan.`budget`·`status` / sqlite | **deferred** | 改既有 H1/H2 形状会动已锁 AC；不发明第二套账本 |
| DeployArena 厚编排（#182） / 商业 OS / 权重训练 | **out** | 非目标 |
| 放宽 Admission / Budget / hang / T48；焊 `#40` 为默认 | **wontfix** | 硬化只收紧 |

## 怎么用

```ts
const path = assembleOuterE2eMinPath({ outcome: "pass" });
await attemptContestAutoSubmit({
  champion,
  hang: {
    outcome: "pass",
    evidenceRefs: ["ev-kill"],
    catalog: path.setup.fixture.catalog,
    ledger: path.setup.ledger, // required
    planId: path.setup.planId, // required
  },
  admission,
  budget,
  submit,
});
```

- 孤立 `runKillTestHang` 仍可无 plan，只测 T48 / 标量过滤。
- `createKillTestHangHook` 与 contest-auto-submit **必须**带 ledger plan。

## 小土豆 wave smoke

1. 无 plan 声称 hang pass → hang `missing`，不得交。
2. E1+E3 mapped refs + ledger hang `pass` → 可 auto-submit；`fail` / `inconclusive` / 未映射 / 仅标量 → 不得交。
3. `inconclusive ≠ pass`；缺 holdout 仍拒 Admission；未预留仍拒 Budget。
4. `SELECTION_POLICY_40 === "off"`，默认仍 `fixed_uct`。

```bash
bun test src/evidence/et-promo-hard.test.ts
bun test src/evidence/contest-auto-submit.test.ts
bun test src/evidence/kill-test-hang.test.ts
bun test src/mission/outer-e2e-min-path.test.ts
```
