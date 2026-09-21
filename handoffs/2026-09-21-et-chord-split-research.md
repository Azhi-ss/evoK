# ET-CHORD-SPLIT-RESEARCH handoff — Chord plugin `evok-research`

| field | value |
|-------|--------|
| **ticket** | #191 · 研究引擎 sole（Pi/Chord wave） |
| **slice** | 独立 Chord 插件 `evok-research`（选点 / Harness / SelectionPolicy 座位）；本地试点加载；最小烟测 + 短 Spec |
| **locks** | 产品默认仍 `fixed_uct`；`#40` Progressive **仅显式 opt-in**；不绑 Cordis/DSH；不做 `evok-eval`；不改 `evok-platform`；不做完整 DOC-CHORD；**不声称** changelog 官方 Chord 热插拔；不改 Admission / Budget / hang / T48 / Broker 谓词；不 merge |

## 什么落地了

| 面 | 本票 | 说明 |
|---|---|---|
| 声明 | `plugins/evok-research/package.json` | 常规 `chord.facets.session` + `tui`；peer `@earendil-works/chord@^0.86` |
| 座位 | session + tui facets | session 提供 `evok.research`；tui 消费它并登记烟测命令 |
| 加载 | `src/cli/evok-research-plugin.ts` | 进程内 `createStaticFacetLoader` + `createFacetHost`。实验路径 |
| Spec | `docs/evok-research-chord.md` | 诚实：changelog 未宣传热插拔；默认 `fixed_uct` |

## 打开的缝 / 未开的缝

- **打开**：`evok-research` 可独立声明、可在本地试点路径单独加载；座位指向 `src/search`（选点 / Harness / SelectionPolicy）。默认仍 `fixed_uct`；`#40` Progressive 默认 off。
- **未开（有意）**：`evok-eval`；生产多环境分布式 Chord；Cordis/DSH；权重训练；把选点数学搬进插件；静默翻默认；Pi experimental `-e` 作为产品承诺。
- **未改**：Admission / Budget / hang / T48 / Broker 谓词；`#40` Progressive 默认；`evok-platform`；真交。

## 诚实失败叙事

官方 `0.86.0` / `0.86.1` changelog **未宣传** Chord 热插拔。本票是本地
实验试点。热插失败应回退为单扩展入口，而不是当生产能力。完整装法 /
限制见 ET-DOC-CHORD / #193。

Elite ≠ 晋级。若本座位暴露 Progressive 表面，仍是显式 opt-in，不是
晋级 / Promotion / Admission / Broker / kill-test key。

## 怎么验

```bash
bun test src/cli/evok-research-plugin.test.ts
bun run typecheck
```

期望：`declareEvokResearchPlugin().changelogOfficialHotPlug === false`；
`defaultSelectionId === "fixed_uct"`；`progressiveDefault === "off"`；
session 可单独加载；session+tui 一起加载并登记 `evok-research` 烟测命令
（自定义服务 `listCommands`，不是 Pi InteractiveMode slash，也不是
changelog 官方热插拔）。加载后 `createDefaultSearchSelectionPort().id`
仍是 `fixed_uct`，`SELECTION_POLICY_40` 仍是 `"off"`。

## 下一票

ET-CHORD-SPLIT-EVAL / #192 或 ET-DOC-CHORD / #193。
本 PR **不要**混进 `evok-eval` 或改写 `evok-platform`。
