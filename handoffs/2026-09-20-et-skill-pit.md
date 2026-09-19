# ET-SKILL-PIT handoff — thin pitfalls skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #166 · 晋级门（thin accepted `pitfalls` skill；可复用失败签名；≠拒答库 / ≠自动拒答黑名单） |
| **slice** | bundled `pitfalls` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；DeployArena standby；Admission/Budget/hang/T48/Broker 谓词未改；无硬编码拒答黑名单 |

## Demo「pitfalls L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-pitfalls.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill pitfalls"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/pitfalls/SKILL.md` 带 `owner`/`namespace: evok` + `category: pitfalls` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/pitfalls/pitfalls/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `pitfalls`（只有 name+description）。
4. `/skill pitfalls` 灌 L1，正文写明 **不是** start / continue / 交卷授权，且 **不放宽门**。
5. L1 含四行模板：何时用 / 禁止做什么 / ≠授权 / 与 Admission·Budget 关系。
6. 正文是可复用失败签名（docs only）：Goodhart on train、missing holdout、treating inconclusive as pass、Elite-as-Promotion。**不是**拒答库 / 自动拒答黑名单；签名 **不是** gate hook。
7. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；Elite 不是 Admission；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill pitfalls --project <dir>
```

## Fixture margin

若再加一份 accepted L0 使 continue 信封略涨，只允许微调
`tests/integration/mission-continue.test.ts` 的 fixture total。
那是 **fixture margin**，**不是** Budget 谓词变更。本票未改
`BudgetLedger` / reserve→settle 合同。

## 打开的缝 / 未开的缝

- **打开**：bundled `pitfalls` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：硬编码拒答黑名单；把签名焊进 hang/T48/Admission/Budget/Broker 谓词；新 hang 谓词；`#40` / Progressive 默认；真交；DeployArena；OPS-START / DOC-USE。
- **未改**：Budget / EXP / Admission 谓词；hang / T48。
