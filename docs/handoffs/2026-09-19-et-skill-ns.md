# ET-SKILL-NS handoff — same-root Pi skills + tag filter + /skill L1

| field | value |
|-------|--------|
| **ticket** | #152 · 控制面 |
| **slice** | 同根 Pi skills 扫描 + evoK 标记过滤 + bundled 同步 + `/skill` L1 |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；未填 EXP/EVID/POL 正文；Admission/Budget 谓词未改 |

## Demo「标记过滤 / L0→L1」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/mission/skill-namespace.test.ts
bun test src/cli/tui-mirror.test.ts -t "/skill"
bun test src/cli/prompt-mode.test.ts -t "accepted + evoK-tagged"
```

期望：

1. 发现扫 `<project>/.pi/skills`（及 `.agents/skills`、用户 Pi `skills/`），**不**把 `.evok/skills` 当平行根。
2. `resources/skills/mission-intake` 同步/链接到 `<project>/.pi/skills/evok/intake/mission-intake/`，带 `owner`/`namespace: evok` + `category` + `state`。
3. `/skills` 只列 evoK-tagged；未打标的普通 Pi skill 出现在发现全集，但不进 `/skills`、不进 Mission/Intake 默认 L0。
4. 默认只有 accepted + tagged 的 L0（name+description）。`/skill <name>` 才灌 L1，且 name 必须在 tagged catalog；正文写明 **不是** start/continue/交卷授权。

tty 上手：

```bash
evok /skills --project <dir>
evok /skill mission-intake --project <dir>
```

## 打开的缝 / 未开的缝

- **打开**：`isEvokTagged` / frontmatter `owner`+`namespace`；`discoverEvokResources` 同根扫描；`syncBundledSkillsIntoPiRoot`；`/skills` 标记过滤；`/skill` tagged catalog L1。
- **未开（有意）**：experiment / evidence / policy skill 正文；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP 谓词；Admission / hang / T48。
