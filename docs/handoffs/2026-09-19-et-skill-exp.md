# ET-SKILL-EXP handoff — thin experiment skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #154 · 控制面（Mission skills 目录） |
| **slice** | bundled `experiment` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；未填 EVID/POL 正文；Admission/Budget 谓词未改 |

## Demo「experiment L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-experiment.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill experiment"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/experiment/SKILL.md` 带 `owner`/`namespace: evok` + `category: experiment` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/experiment/experiment/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `experiment`（只有 name+description）。
4. `/skill experiment` 灌 L1，正文写明 **不是** start / continue / 交卷授权。
5. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill experiment --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `experiment` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：evidence / policy skill 正文；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP 谓词；Admission / hang / T48。
