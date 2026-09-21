# ET-CHORD-SPLIT-PLATFORM handoff — Chord plugin `evok-platform`

| field | value |
|-------|--------|
| **ticket** | #190 · 平台 sole（Pi/Chord wave #2） |
| **slice** | 独立 Chord 插件 `evok-platform`（Mission / 编排 / TUI·CLI 座位）；本地试点加载；最小烟测 + 短 Spec |
| **locks** | 不绑 Cordis/DSH；不做 `evok-research` / `evok-eval`；不做完整 DOC-CHORD；**不声称** changelog 官方 Chord 热插拔；不 merge |

## 什么落地了

| 面 | 本票 | 说明 |
|---|---|---|
| 声明 | `plugins/evok-platform/package.json` | 常规 `chord.facets.session` + `tui`；peer `@earendil-works/chord@^0.86` |
| 座位 | session + tui facets | session 提供 `evok.platform`；tui 消费它并登记烟测命令 |
| 加载 | `src/cli/evok-platform-plugin.ts` | 进程内 `createStaticFacetLoader` + `createFacetHost`。实验路径 |
| Spec | `docs/evok-platform-chord.md` | 诚实：changelog 未宣传热插拔 |

## 打开的缝 / 未开的缝

- **打开**：`evok-platform` 可独立声明、可在本地试点路径单独加载；座位指向 `src/mission`（控制面 / 薄编排胶水）和 `src/cli`（入口镜像）。
- **未开（有意）**：`evok-research` / `evok-eval`；生产多环境分布式 Chord；Cordis/DSH；把 Mission 权威搬进插件；Pi experimental `-e` 作为产品承诺。
- **未改**：Admission / Budget / hang / T48 / Broker 谓词；`#40` Progressive 默认；真交；DeployArena。

## 诚实失败叙事

官方 `0.86.0` / `0.86.1` changelog **未宣传** Chord 热插拔。本票是本地
实验试点。热插失败应回退为单扩展入口，而不是当生产能力。完整装法 /
限制见 ET-DOC-CHORD / #193。

## 怎么验

```bash
bun test src/cli/evok-platform-plugin.test.ts
bun run typecheck
```

期望：`declareEvokPlatformPlugin().changelogOfficialHotPlug === false`；
session 可单独加载；session+tui 一起加载并登记 `evok-platform` 烟测命令
（自定义服务 `listCommands`，不是 Pi InteractiveMode slash，也不是
changelog 官方热插拔）。

## 下一票

ET-CHORD-SPLIT-RESEARCH / #191 或 ET-CHORD-SPLIT-EVAL / #192（其他域插件）。
本 PR **不要**混进那两个包。DOC-CHORD / #193 后置。
