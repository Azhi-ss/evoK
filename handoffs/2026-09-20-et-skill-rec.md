# ET-SKILL-REC handoff — thin recovery skill L0→L1

| field | value |
|-------|--------|
| **ticket** | #164 · 控制面（thin accepted `recovery` skill；continue/repair/hang 程序指针；≠第二控制面） |
| **slice** | bundled `recovery` accepted 薄正文；同根 Pi skills + evoK 标记 |
| **locks** | `#40` off；真交冻；DeployArena standby；Admission/Budget/hang/T48 谓词未改；无新 hang 谓词；≠第二编排面 |

## Demo「recovery L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-recovery.test.ts
bun test src/cli/evok-cli.test.ts -t "/skill recovery"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay carries"
```

期望：

1. `resources/skills/recovery/SKILL.md` 带 `owner`/`namespace: evok` + `category: recovery` + `state: accepted`。
2. 启动同步/链接到 `<project>/.pi/skills/evok/recovery/recovery/`。
3. `/skills` 与 Mission overlay 的 accepted L0 可见 `recovery`（只有 name+description）。
4. `/skill recovery` 灌 L1，正文写明 **不是** start / continue / 交卷授权，且 **不放宽门**。
5. L1 含四行模板：何时用 / 禁止做什么 / ≠授权 / 与 Admission·Budget 关系。
6. 正文只指向既有路径：`continueResearch` / `/research continue`；`MISSION_REPAIRED` + `/research repair` reserved；`resumeAuthorizedMission` / `/mission-resume`；`runKillTestHang`。**不是**第二控制面；**不**新造 hang 谓词。
7. 缺 protected holdout 仍拒 Admission；未预留 Budget 仍拒 writeback；hang inconclusive 不是 pass；未映射 T48 artifact 仍挡。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill recovery --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：bundled `recovery` SKILL.md；同根同步后 L0 可发现；`/skill` L1。
- **未开（有意）**：pitfalls skill 正文；新 hang 谓词；第二编排面；`/research repair` 实现；自动 resume 绕过 Mission 门；DeployArena；`#40` / Progressive 默认；真交；PIT / OPS-START。
- **未改**：Budget / EXP / Admission 谓词；hang / T48。
