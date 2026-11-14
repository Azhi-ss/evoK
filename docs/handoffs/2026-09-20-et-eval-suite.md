# ET-EVAL-SUITE handoff — `suite-metric` Competition Adapter

| field | value |
|-------|--------|
| **ticket** | #172 · 晋级门（本地 suite 评测适配器；`score = pass_rate ∈ [0,1]`） |
| **slice** | `src/competition/suite-metric.ts`；copyable `templates/evaluation.suite-metric.json`；fixture runner `fixture-manifest` |
| **locks** | `#40` off；真交冻；DeployArena standby；Elite≠晋级；Admission/Budget/hang/T48 **谓词未改**；分数不是晋级键 |

## 合同

复制：

```bash
PROJECT="$(pwd)/my-research-project"
mkdir -p "$PROJECT/.evok" "$PROJECT/suite"
cp templates/evaluation.suite-metric.json "$PROJECT/.evok/evaluation.json"
cp templates/suite-metric.cases.json "$PROJECT/suite/cases.json"
```

`id` 必须是 `suite-metric`。`score.metric` 是 `pass_rate`，`min=0` `max=1`。
清单在**项目侧**（trusted `suiteFiles`），不从 Candidate 快照读用例。
模型自报 `score` / `answer.txt` 第一行数字 **不是** 分数源。

`/start` 仍默认 `file-metric`。本适配器是并列 Evaluator：对 Candidate 快照可调用。
`examples/demo-suite` 归 ET-OPS-DOMAIN。

## 三态 demo（不需要 LLM / 真交）

```bash
bun test src/competition/suite-metric.test.ts
```

| 态 | 快照 | 期望 |
|----|------|------|
| **缺产物** | 有 5 案清单、无 `answers/*.txt` | `status=fail`，`score=0`，**不是**静默 `1.0` |
| **部分过** | 只写入 `answers/a.txt` + `answers/b.txt` | `score=0.4` ∈ (0,1) |
| **全过** | 五个答案都匹配 | `score=1.0`，`status=pass` |
| **inconclusive** | 缺清单 / 空套件 | `status=inconclusive`，**无** score（≠ 0 分 pass，≠ 自嗨满分） |
| **自报无效** | 同时种下 `score=1` / `"I scored 1.0"` + 只有 2/5 过 | 仍是 `0.4` |

可编程调用：

```ts
import { evaluateSuiteMetric, normalizeSuiteMetricContract } from "./src/competition/suite-metric";

const contract = normalizeSuiteMetricContract(JSON.parse(await Bun.file("templates/evaluation.suite-metric.json").text()));
const suiteFiles = { "suite/cases.json": await Bun.file("templates/suite-metric.cases.json").text() };

await evaluateSuiteMetric({}, contract, { suiteFiles });                    // fail  0
await evaluateSuiteMetric({ "answers/a.txt": "ok-a", "answers/b.txt": "ok-b" }, contract, { suiteFiles }); // 0.4
await evaluateSuiteMetric({
  "answers/a.txt": "ok-a", "answers/b.txt": "ok-b", "answers/c.txt": "ok-c",
  "answers/d.txt": "ok-d", "answers/e.txt": "ok-e",
}, contract, { suiteFiles });                                               // 1.0
```

换真本地小题套件：传入 `options.runner`（ET-OPS-DOMAIN）。未接线的 runner 名 → inconclusive/fail，不发明 1.0。

## 打开的缝 / 未开的缝

- **打开**：`suite-metric` 适配器与 LLM arm / file-metric **并列**；`evaluation.json` 合同可复制；三态 + 自报覆盖单测；每次评测产出机器可读 `suite-report.json`（`artifact_refs` + `artifacts`）；超时 / 崩溃 / 缺清单 fail-closed。
- **未开（有意）**：`examples/demo-suite`；`/research continue` 抬分圈；把 suite 分焊成 Elite/晋级键；CLI `/start` 自动改走 suite-metric。
- **未改**：Admission / Budget / hang / T48 谓词；`#40`；真交 / DeployArena / Bohrium。
