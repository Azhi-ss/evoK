# ET-SKILL-SEA handoff — thin search skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #160 · 搜索（thin accepted `search` skill；opt-in 强搜；不解冻 #40） |
| **slice** | bundled `search` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；默认 `fixed_uct`；真交冻；Elite≠晋级；DeployArena standby；Admission/Budget/hang/T48 谓词未改 |

## Demo「search L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-search.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill search"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/search/SKILL.md` 带 `owner`/`namespace: evok` + `category: search` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/search/search/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `search`（只有 name+description）。
4. `/skill search` 灌 L1，正文写明 **不是** start / continue / 交卷授权，且 **不放宽门**。
5. L1 含四行模板：何时用 / 禁止做什么 / ≠授权 / 与 Admission·Budget 关系。
6. 正文写清默认 `fixed_uct`；强搜 / Progressive 仅显式 opt-in；`#40` stays off。可编程探索启发可作为文档/指引，不改默认选点数学。
7. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。默认选点仍是 `fixed_uct`。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill search --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `search` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：method-improvement / recovery / pitfalls skill 正文；DeployArena；`#40` / Progressive 默认；真交。
- **未改**：Budget / EXP / Admission 谓词；hang / T48；默认 `fixed_uct` 选点数学。
