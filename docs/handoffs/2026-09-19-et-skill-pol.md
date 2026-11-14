# ET-SKILL-POL handoff — thin policy skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #158 · 晋级门（policy/门禁话术）+ 控制面目录落地 |
| **slice** | bundled `policy` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；Admission/Budget/hang/T48 谓词未改 |

## Demo「policy L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-policy.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill policy"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/policy/SKILL.md` 带 `owner`/`namespace: evok` + `category: policy` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/policy/policy/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `policy`（只有 name+description）。
4. `/skill policy` 灌 L1，正文写明 **不是** privilege expansion（skill≠扩权），**不是** start / continue / 交卷授权，且 **不放宽门**。
5. 话术含红灯仍问人：AtCoder 真交冻、`#40` off、Elite≠Promotion、预算超支问人。
6. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill policy --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `policy` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：search / method-improvement / recovery / pitfalls skill 正文；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP / Admission 谓词；hang / T48。
