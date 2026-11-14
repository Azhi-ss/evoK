# ET-OPS-DOMAIN handoff — `examples/demo-suite` true-domain scaffold

| field | value |
|-------|--------|
| **ticket** | #173 · 控制面（可复制真域脚手架；baseline 实测 ≈0.4 `pass_rate`） |
| **slice** | `examples/demo-suite`；`local-js-exports` runner；start 路径按 `evaluation.json` 分发 file-metric / suite-metric |
| **locks** | `#40` off；真交冻；DeployArena standby；Admission/Budget/hang/T48/Broker **谓词未改**；不实现 LIFT（#174）/ how-to-use |

## Demo commands

从仓库根目录（**必须绝对路径**）：

```bash
DEMO="$(pwd)/examples/demo-suite"
bun run evok --start --baseline-only --project "$DEMO" --mission demo-suite
```

等价：

```bash
bun run evok /start --baseline-only --project "$(pwd)/examples/demo-suite" --mission demo-suite
```

期望：

1. `.evok/evaluation.json` 是 `id: suite-metric`，`score.metric: pass_rate`，runner `local-js-exports`，清单 `suite/cases.json`。
2. 对寄出的 `src/solve.js` 跑 trusted suite：**实测** `n_pass=2` / `n_total=5` → `pass_rate=0.4`。不是 `answer.txt` 第一行手写 0.4，也不是 file-metric 种子。
3. 无 Pi model/auth（或其它 start 前置）时：**列出 remaining hard gates**，`nothing dispatched`，exit `3`。不写 `baseline-complete`，不发明 green。
4. Admission / Budget Gate / hang / T48 / External Submission·Broker 出现在 **Still in force（not downgraded; not a pass）**。
5. 不授权真交；`#40` Progressive stays off。抬分 ≥0.8 留给 #174。

无模型复现实测 0.4：

```bash
bun test src/project-evaluator.test.ts
bun test src/competition/local-js-exports-runner.test.ts
bun test src/mission/start-hard-gates.test.ts -t "demo suite"
bun test src/cli/evok-cli.test.ts -t "demo-suite"
```

## 打开的缝 / 未开的缝

- **打开**：`examples/demo-suite` 可复制脚手架；abs-path README；`local-js-exports` 对 Candidate 模块跑 trusted cases；`--start` 读到 `id=suite-metric` 时走 `createSuiteMetricEvaluator`（trusted `suiteFiles` 来自项目侧）。
- **未开（有意）**：`/research continue` 抬分圈（#174）；`docs/how-to-use.md`；把 suite 分焊成 Elite/晋级键；真交；DeployArena；`#40`。
- **未改**：Admission / Budget / hang / T48 / Broker 谓词。
