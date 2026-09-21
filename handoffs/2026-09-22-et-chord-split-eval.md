# ET-CHORD-SPLIT-EVAL handoff — Chord plugin `evok-eval`

| field | value |
|-------|--------|
| **ticket** | #192 · 评测发布 sole（Pi/Chord wave） |
| **slice** | 独立 Chord 插件 `evok-eval`（eval / promotion / Broker 座位）；本地试点加载；最小烟测 + 短 Spec |
| **locks** | Admission / Budget / hang / T48 / Broker **fail-closed / 不放宽**；auto-submit 仍 fail-closed；Elite ≠ Promotion；不绑 Cordis/DSH；不改 `evok-platform` / `evok-research`；不做完整 DOC-CHORD；**不声称** changelog 官方 Chord 热插拔；不 merge |

## 什么落地了

| 面 | 本票 | 说明 |
|---|---|---|
| 声明 | `plugins/evok-eval/package.json` | 常规 `chord.facets.session` + `tui`；peer `@earendil-works/chord@^0.86` |
| 座位 | session + tui facets | session 提供 `evok.eval`；tui 消费它并登记烟测命令 |
| 加载 | `src/cli/evok-eval-plugin.ts` | 进程内 `createStaticFacetLoader` + `createFacetHost`。实验路径 |
| Spec | `docs/evok-eval-chord.md` | 诚实：changelog 未宣传热插拔；门闩 fail-closed |

## 打开的缝 / 未开的缝

- **打开**：`evok-eval` 可独立声明、可在本地试点路径单独加载；座位指向 `src/competition`（suite-metric 评分）和 `src/evidence`（Promotion / Admission / Broker）。`failClosed` / `*NoWiden` / `autoSubmitFailClosed` 锁在座位声明上。
- **未开（有意）**：生产多环境分布式 Chord；Cordis/DSH；把评分 / 门闩谓词搬进插件；静默放宽任何 gate；真交决策 UI；Pi experimental `-e` 作为产品承诺。
- **未改**：Admission / Budget / hang / T48 / Broker 谓词实现；auto-submit 政策；`#40` Progressive 默认；`evok-platform`；`evok-research`。

## 诚实失败叙事

官方 `0.86.0` / `0.86.1` changelog **未宣传** Chord 热插拔。本票是本地
实验试点。热插失败应回退为单扩展入口，而不是当生产能力。完整装法 /
限制见 ET-DOC-CHORD / #193。

Elite ≠ 晋级。本座位声明 Promotion / Broker，但 Elite 不是 Promotion /
Admission / Broker / kill-test key。auto-submit 仍是全绿才交、否则
fail-closed。

## 怎么验

```bash
bun test src/cli/evok-eval-plugin.test.ts
bun run typecheck
```

期望：`declareEvokEvalPlugin().changelogOfficialHotPlug === false`；
`failClosed === true`；`autoSubmitFailClosed === true`；
`eliteIsPromotion === false`；session 可单独加载；session+tui 一起加载
并登记 `evok-eval` 烟测命令（自定义服务 `listCommands`，不是 Pi
InteractiveMode slash，也不是 changelog 官方热插拔）。加载后
`evaluateContestAutoSubmitGates({})` 仍拒绝，缺 holdout 的 Admission
（即使 `elite: true`）仍拒绝，`ELITE_IS_NOT_JINJI` 仍为 true。

## IN / OUT

| IN | OUT |
|---|---|
| 独立 `evok-eval` 声明 + 本地进程内加载 | Cordis / DSH |
| session + session+tui 烟测 | 改写 `evok-platform` / `evok-research` |
| 座位级 fail-closed / no-widen 锁 | 放宽任何 gate / Broker / Admission / Budget / hang / T48 谓词 |
| 诚实 Spec + handoff | 声称 changelog 官方热插拔 |
| how-to 一行指针 | 真交政策 / 自动提交决策 UI 变更 |

## 下一票

ET-DOC-CHORD / #193（平台/交付 later）。
本 PR **不要**混进 `evok-platform` / `evok-research` 重写。
