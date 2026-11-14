# ET-SUBMIT-AUTO handoff — 门控全绿才自动交（fail-closed + ledger）

| field | value |
|-------|--------|
| **ticket** | #179 · 晋级门（竞赛臂门控全绿 → 自动 submit；ledger；fail-closed） |
| **slice** | `src/evidence/contest-auto-submit.ts`；Broker submit seam；`docs/contest-auto-submit.md` |
| **locks** | `#40` 仍 opt-in / 默认 `fixed_uct`；Admission / Budget / hang / T48 **谓词未放宽**；Elite ≠ 晋级；DeployArena 仍 standby；无商业竞赛 OS |

## 怎么用

```ts
import {
  attemptContestAutoSubmit,
  createBrokerContestSubmitSeam,
} from "./src/evidence/contest-auto-submit";

const result = await attemptContestAutoSubmit({
  champion,
  hang,       // runKillTestHang 输入
  admission,  // evaluateMethodAdmission 输入
  budget,     // evaluateBudgetGate 输入
  live: false,
  submit: createBrokerContestSubmitSeam(broker, request),
  ledger,
});
```

- 全绿：调用 submit seam（`live !== true` 走 Broker dry-run）。
- 任一红 / 黄 / 缺：`submitted === false`，写 `CONTEST_AUTO_SUBMIT_REFUSED`。
- 真网提交仍要 `{ live: true }` + 已有 destination；缺 seam 也 fail-closed。

## 小土豆 wave smoke

1. 全绿路径会调 submit；黄/红/缺门不得交。
2. 每次 attempt 都写 ledger（成功与拒绝）。
3. 缺 holdout 仍拒 Admission；未预留仍拒 Budget；hang inconclusive 是 yellow，不是 pass。
4. T48 无 contract 仍 sleep（绿）——既有谓词，不是放宽。
5. `SELECTION_POLICY_40 === "off"`，默认仍 `fixed_uct`。
6. `autoSubmit: true` 仍不能绕过直接 `broker.submit` 的 Human Acceptance。

```bash
bun test src/evidence/contest-auto-submit.test.ts
bun test src/evidence/submission-broker.test.ts
bun test src/evidence/method-admission.test.ts
bun test src/evidence/budget-gate.test.ts
bun test src/evidence/kill-test-hang.test.ts
```

## 打开的缝 / 未开的缝

- **打开**：竞赛臂 Broker 自动交编排；门控复评；attempt ledger；mockable submit seam。
- **未开（有意）**：商业竞赛 OS；DeployArena 厚编排（#182）；权重训练；把 `#40` 焊成默认；放宽 Admission / Budget / hang / T48 谓词；Elite 当晋级钥匙。
- **未改**：默认 `fixed_uct`；门控谓词语义；`autoSubmit` 兼容旗语义。
