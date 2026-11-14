# ET-SKILL-RSI handoff — thin method-improvement skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #162 · 控制面（thin accepted `method-improvement` skill；任务内 RSI 入口；validation-gated；≠自动晋级） |
| **slice** | bundled `method-improvement` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；Elite≠Admission；DeployArena standby；Admission/Budget/hang/T48 谓词未改；≠ auto-promote |

## Demo「method-improvement L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-method-improvement.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill method-improvement"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/method-improvement/SKILL.md` 带 `owner`/`namespace: evok` + `category: method-improvement` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/method-improvement/method-improvement/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `method-improvement`（只有 name+description）。
4. `/skill method-improvement` 灌 L1，正文写明 **不是** start / continue / 交卷授权，且 **不放宽门**。
5. L1 含四行模板：何时用 / 禁止做什么 / ≠授权 / 与 Admission·Budget 关系。
6. 正文写清 validation-gated：version id → verify command / adversarial tags → enable record → rollbackable；≠ auto-promote；Elite ≠ Admission。
7. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。Elite 不能代替 holdout。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill method-improvement --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `method-improvement` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：recovery / pitfalls skill 正文；Continual Harness CRUD；权重共训；DeployArena；`#40` / Progressive 默认；真交。
- **未改**：Budget / EXP / Admission 谓词；hang / T48。
