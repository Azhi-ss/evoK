# ET-DOC-CHORD handoff — Chord 多插件试点 how-to

| field | value |
|-------|--------|
| **ticket** | #193 · 平台 / wave tail（how-to / notes：三插件装法、热插预期、已知限制） |
| **slice** | 专用笔记 + README / how-to 指针；只写已落地本地试点路径；changelog **未宣传**热插拔 |
| **locks** | 不绑 Cordis/DSH；不写新插件代码；不改门闩 / 默认；不声称 changelog 官方热插拔；失败可回退单扩展入口；不 merge |

## 跟做路径

从仓库根目录：

```bash
bun install
ls plugins/evok-platform/package.json \
   plugins/evok-research/package.json \
   plugins/evok-eval/package.json
```

装法 / 加载 / 热插预期 / 限制：[`docs/chord-plugins.md`](../docs/chord-plugins.md)。
产品主路径仍是 [`docs/how-to-use.md`](../docs/how-to-use.md)
（Explore → intake → review → start → research）。README 顶栏有一行指针。

座位 Spec（声明字段与单插件 load 片段）：

- [`docs/evok-platform-chord.md`](../docs/evok-platform-chord.md) — Mission / 编排 / TUI·CLI
- [`docs/evok-research-chord.md`](../docs/evok-research-chord.md) — 选点 / Harness / SelectionPolicy；默认 `fixed_uct`
- [`docs/evok-eval-chord.md`](../docs/evok-eval-chord.md) — eval / promotion / Broker；fail-closed

## 诚实失败叙事

官方 `0.86.0` / `0.86.1` changelog **未宣传** Chord 热插拔。本票是本地
实验试点的装法与限制说明，**不是**官方 changelog 承诺。热插失败应回退
为单扩展入口（已落地的 `evok` CLI / Pi native TUI），而不是当生产能力。
`chord.facets` 对齐 pi 0.86 示例 **不**使 Pi experimental `-e` 成为
evoK 产品路径。不绑 Cordis / DSH。

## 怎么验（SPLIT 烟测，原样指向）

```bash
bun test src/cli/evok-platform-plugin.test.ts
bun test src/cli/evok-research-plugin.test.ts
bun test src/cli/evok-eval-plugin.test.ts
bun run typecheck
```

期望与 SPLIT handoff 一致：三插件可独立声明 / 本地进程内加载；
`changelogOfficialHotPlug === false`；research 默认仍 `fixed_uct` /
Progressive off；eval 门闩仍 fail-closed。烟测命令是自定义
`listCommands`，不是 Pi InteractiveMode slash，也不是 changelog
官方热插拔。

原写：

- [2026-09-21-et-chord-split-platform.md](2026-09-21-et-chord-split-platform.md)
- [2026-09-21-et-chord-split-research.md](2026-09-21-et-chord-split-research.md)
- [2026-09-22-et-chord-split-eval.md](2026-09-22-et-chord-split-eval.md)

## 打开的缝 / 未开的缝

- **打开**：`docs/chord-plugins.md`（装法 + 三插件 load + 热插预期 + 限制）；README / `docs/how-to-use.md` / `src/cli/README.md` 指针；三份座位 Spec 改指向该笔记；本 handoff。
- **未开（有意）**：Cordis / DSH；生产多环境分布式 Chord；新插件代码；把 Pi `-e` 写成产品命令；改 Admission / Budget / hang / T48 / Broker 谓词；翻 `#40` 默认。
- **未改**：任何代码门禁 / 谓词；三个插件实现；产品 CLI/TUI 主路径。
