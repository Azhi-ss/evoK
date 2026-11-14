# ET-ORCH-GAP handoff — ModelOrchestra / golden-path / strong-search opt-in

| field | value |
|-------|--------|
| **ticket** | #181 · 控制面主 + 搜索协作（无第二 CA） |
| **slice** | `runOrchGap` 胶水；`runModelOrchestra`；`strongSearch` opt-in；本 handoff |
| **locks** | 产品默认仍 `fixed_uct` / `#40` Progressive **off**；env 不静默翻默认；真交冻；DeployArena standby（#182 下一票，本票不做）；Admission / Budget / hang / T48 **谓词未改**；Elite ≠ 晋级 |

## stub vs impl / land vs defer

| Spec / # | 本票 | 说明 |
|---|---|---|
| **#27 ModelOrchestra** | **thin impl**（不是 stub） | 既有 `ModelOrchestra` 已解析 flash-first / catalog / cross-model。本票加可运行 one-shot `runModelOrchestra`。不调度 Task，不花 Budget，不晋级。 |
| **#98 golden-path glue** | **landed** | 既有 `runGoldenPath`（V1-G / #101）。本票经 `runOrchGap({ goldenPath })` 接到控制面胶水。默认 **不** 自动跑 hang。mock default；`{ live: true }` 才开 live。 |
| **#99 strong-search opt-in port** | **opt-in landed** | 既有 `SearchSelectionPort` / `StrongSearchAdapter`。本票把 `{ strongSearch: true }` / `strong_search` alias 接到 `resolveSearchSelection` + SEA `mountStrongSearchOptIn`。默认路径仍 `fixed_uct`。 |
| DeployArena 厚编排（#182） | **out** | 下一票。本票不实现。 |
| 焊 Progressive / StrongSearch 为默认 | **wontfix** | 默认仍 off |

## 怎么用

```ts
import { runOrchGap } from "./src/mission/orch-gap";

const gap = await runOrchGap({ catalog }); // default: unconfigured orchestra, no hang, fixed_uct

await runOrchGap({
  catalog,
  orchestra: { fast: "acme/flash-2", deep: "acme/pro-2" },
  goldenPath: { statement: "hold-out must not move" },
  searchSelection: { strongSearch: true, t: 8 },
});
```

- `gap.orchestraKind === "thin-impl"`
- `gap.goldenPathLanded === true` 即使本次没跑 hang
- 无名 `createSearchSelectionPort()` / `resolveSearchSelection()` 仍是 `fixed_uct`
- `.evok/search.json` 可写 `{ "strongSearch": true }`；env **不会**翻默认

## 小土豆 wave smoke

1. `runOrchGap({ catalog })` → orchestra unconfigured default；无 goldenPath；`fixed_uct` / `#40` off。
2. `{ strongSearch: true }` 或 `selectionId: "strong_search"` → StrongSearchAdapter；默认 factory 仍 `fixed_uct`。
3. `{ goldenPath: { statement } }` → mock `runGoldenPath`；`EVOK_NEWAPI_LIVE` 单独不开 live。
4. `EVOK_SEARCH_SELECTION=strong_search` **不会**翻默认。
5. 缺 holdout 仍拒 Admission；未预留仍拒 Budget；hang inconclusive 不是 pass。

```bash
bun test src/search/strong-search-opt-in.test.ts
bun test src/execution/model-orchestra.test.ts
bun test src/mission/orch-gap.test.ts
bun test src/search/progressive-opt-in.test.ts
bun test src/mission/v1-golden-path.test.ts
```

## 打开的缝 / 未开的缝

- **打开**：`runOrchGap`；`runModelOrchestra`；`strongSearch` / `strong_search` opt-in；`optInStrongSearchPort` / `mountStrongSearchOptIn`。
- **未开（有意）**：DeployArena 厚编排（#182）；把 Progressive / StrongSearch 焊成产品默认；真交 always-on；商业竞赛 OS；权重训练。
- **未改**：默认 `fixed_uct`；`#40` Progressive 默认 off；Admission / Budget / hang / T48 谓词。
