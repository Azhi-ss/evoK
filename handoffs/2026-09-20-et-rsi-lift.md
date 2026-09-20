# ET-RSI-LIFT handoff — one authorized continue → measured lift or honest kill

| field | value |
|-------|--------|
| **ticket** | #174 · 搜索+控制面（baseline 后授权一圈 `/research continue`） |
| **slice** | `src/search/suite-lift-circle.ts`；`src/mission/research-continue-lift.ts`；`continueResearch` 接线；`docs/how-to-use.md` §6 |
| **locks** | `#40` off；默认 `fixed_uct`；真交冻；DeployArena standby；Admission / Budget / hang / T48 **谓词未改**；不 dispatch Pi Run |

## 数字（demo-suite / suite-metric）

| 态 | 来源 | `pass_rate` |
|---|---|---|
| **baseline** | 寄出 `src/solve.js` + 可信 `suite/cases.json` | **0.4**（2/5，实测，不是手写种子） |
| **一圈 continue** | 默认 local helper-completion + 独立 suite-metric | **1.0**（5/5）· verdict `lifted` |
| **诚实 kill** | identity 提案或 hang 挡晋级 | 保持 0.4 或分数虽升但 `blocksPromotion=true`；档案在 `evidence/research-continue/<mission>/<exp>.json` |

无模型复现：

```bash
bun test src/project-evaluator.test.ts
bun test src/search/suite-lift-circle.test.ts
bun test src/mission/research-continue-lift.test.ts
bun test src/cli/evok-cli.test.ts -t "demo-suite"
```

CLI 烟测（绝对路径；需已有 recorded baseline，`--start` 在缺 Pi auth 时仍只列 hard gates）：

```bash
DEMO="$(pwd)/examples/demo-suite"
cp -R "$DEMO" /tmp/evok-demo-suite
DEMO="$(cd /tmp/evok-demo-suite && pwd)"
bun run evok --start --baseline-only --project "$DEMO" --mission demo-suite
bun run evok /research continue --project "$DEMO" --mission demo-suite
```

## 小土豆 wave smoke

1. `examples/demo-suite` 的 `evaluation.json` 仍是 `id: suite-metric`，`score.metric: pass_rate`。
2. 寄出 `src/solve.js` **未被改写**（仍是故意 2/5）。抬分提案与 hang 决定写在 `evidence/`。
3. `/research continue` 仍要用户 token + 已授权 Mission + 已记录 baseline。聊天 / 模型批准不能 continue。
4. 默认父选择仍是 `fixed_uct`。`#40` Progressive **off**。未开真交 / DeployArena。
5. 晋级 hang 生效：`runKillTestHang` + H2 `HypothesisLedger`（`kill_test.planned` / `finished`）。缺 T48 映射或 hang fail → `verdict killed`，不静默晋级。诚实 kill 会把 hypothesis 标为 `killed`。
6. `docs/how-to-use.md` 有 **§6 Suite-metric + one-circle lift**。
7. file-metric / events-only continue 仍是 skeleton experiment（不发明第二控制面）。

## 打开的缝 / 未开的缝

- **打开**：suite-metric 一圈 continue；search 拥有 opt-in harness；独立实测抬分或诚实 kill+`evidence/`；how-to 一节。
- **未开（有意）**：Pi Run dispatch；`/research repair` / `stop`；真交；DeployArena；`#40` / Progressive 默认；Admission / Budget / hang / T48 谓词改语义；权重训练。
- **未改**：默认 `fixed_uct`；Admission / Budget / hang / T48 / Broker 谓词。
