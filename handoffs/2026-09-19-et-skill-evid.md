# ET-SKILL-EVID handoff — thin evidence skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #156 · 晋级门（evidence 语义）+ 控制面目录落地 |
| **slice** | bundled `evidence` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；未填 POL 正文；Admission/Budget/hang/T48 谓词未改 |

## Demo「evidence L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-evidence.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill evidence"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/evidence/SKILL.md` 带 `owner`/`namespace: evok` + `category: evidence` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/evidence/evidence/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `evidence`（只有 name+description）。
4. `/skill evidence` 灌 L1，正文写明 **不是** start / continue / 交卷授权，且 **不放宽门**。
5. 话术含 effective≠optimal、inconclusive≠pass、holdout、lineage。
6. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill evidence --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `evidence` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：policy skill 正文；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP / Admission 谓词；hang / T48。
