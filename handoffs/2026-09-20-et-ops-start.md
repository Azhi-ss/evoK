# ET-OPS-START handoff — evaluation template + abs-path + demo scaffold

| field | value |
|-------|--------|
| **ticket** | #168 · 控制面（start 路径可跑：`evaluation.json` 模板 + abs-path 操作提示 + 最小 demo） |
| **slice** | copyable file-metric template；`inspectStartHardGates`；`examples/demo-start`；`--start --baseline-only` 诚实列剩余硬门 |
| **locks** | `#40` off；真交冻；DeployArena standby；Elite≠晋级；Admission/Budget/hang/T48/Broker 谓词未改；start ≠ skill-authorization |

## Demo commands

从仓库根目录（**必须绝对路径**）：

```bash
DEMO="$(pwd)/examples/demo-start"
bun run evok --start --baseline-only --project "$DEMO" --mission demo-start
```

等价：

```bash
bun run evok /start --baseline-only --project "$(pwd)/examples/demo-start" --mission demo-start
```

期望：

1. `templates/evaluation.json` 字段匹配 Mission file-metric 合同（`id` / `version` / 相对 `artifact` / 可选 `metric` `min` `max`）。
2. Demo 已带同一合同：`examples/demo-start/.evok/evaluation.json`，以及可审查 draft `demo-start`。
3. 无 Pi model/auth（或其它 start 前置）时：**列出 remaining hard gates**，`nothing dispatched`，exit `3`。不写 `baseline-complete`，不发明 green。
4. Admission / Budget Gate / hang / T48 / External Submission·Broker 出现在 **Still in force（not downgraded; not a pass）**。
5. 不授权真交；`#40` Progressive stays off。

复制模板到自己的项目：

```bash
PROJECT="$(pwd)/my-research-project"
mkdir -p "$PROJECT/.evok"
cp templates/evaluation.json "$PROJECT/.evok/evaluation.json"
```

单元复现（不需要 InteractiveMode / 真 LLM）：

```bash
bun test src/mission/start-hard-gates.test.ts
bun test src/cli/evok-cli.test.ts -t "start hard-gate inventory"
```

## 打开的缝 / 未开的缝

- **打开**：可复制 `templates/evaluation.json`；abs-path 写进 CLI usage + demo README；`examples/demo-start` 脚手架；`--start` 真实路径（无 injected runner）先 `inspectStartHardGates`，阻塞则列全部门、不 dispatch。
- **未开（有意）**：ET-DOC-USE / `docs/how-to-use.md`；真交；DeployArena；`#40` / Progressive 默认；改 Admission/Budget/hang/T48 谓词；把 start 当成 skill 授权。
- **未改**：Budget / EXP / Admission 谓词；hang / T48；Broker。
