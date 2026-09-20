# ET-DEPLOY-ORCH handoff — DeployArena 厚编排（任务图 / worker / 汇聚 / COI→自动交）

| field | value |
|-------|--------|
| **ticket** | #182 · 控制面主 + 晋级门协作（无第二 CA） |
| **slice** | `runDeployArenaGraph` + 本地汇聚 + COI `submission.json`；`runDeployArenaOrch` 挂 `competitionId=deploy-arena` 并接到 `#179` auto-submit |
| **locks** | 非商业 OS；无账户/账单/多租户/Web 市场；`#40` 仍 opt-in / 默认 `fixed_uct`；Admission / Budget / hang / T48 **谓词未放宽**；Elite ≠ 晋级；不实现 #183 SPEC-SWEEP；不 merge |

## 怎么用

```ts
import { runDeployArenaOrch } from "./src/mission/deploy-arena-orch";

const result = await runDeployArenaOrch({
  competitionId: "deploy-arena",
  knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
  gates,                 // 既有 contest-auto-submit 门控输入
  live: false,
});
```

- 未声明 / 非 `deploy-arena`：fail-closed，不开本臂。
- 烟测图：两台机器 / 两块 GPU worker 跑 `aime26` + `gpqa-diamond`，本地均值汇聚，双科 **>95** 才过能力门。
- COI 只组装 `{ image, command, env }`，交卷走 `attemptContestAutoSubmit`；门未绿不调 playground。
- `{ live: true }` 且缺 playground/bohr 凭证 → `credentials-missing`，不 exec。
- `EVOK_DEPLOY_ARENA_LIVE` **不会**翻 live。

Bohrium CLI（用户环境，密钥不进仓）：见 [docs/deploy-arena.md](../docs/deploy-arena.md)。

- `playground` 0.1.39 · `bohr` 2.7.0 · 运行面 WSL2
- `playground task download --challenge-id llm-challenge-arena-v1 --out DIR`
- `playground submit --challenge-id ID --outputs DIR --trace TRACE`

## 小土豆 wave smoke

1. `DEPLOY_ARENA_SMOKE_GRAPH` 两 worker 能力题可跑；本地汇聚有 mean/min/max。
2. `runDeployArenaOrch({ competitionId: "deploy-arena", … })` 组装 submission 并走 `#179`；缺门不得交。
3. live 无凭证 fail-closed；env 单独不开 live。
4. `SELECTION_POLICY_40 === "off"`，默认仍 `fixed_uct`。
5. 缺 holdout 仍拒 Admission；未预留仍拒 Budget。

```bash
bun test src/competition/deploy-arena.test.ts
bun test src/mission/deploy-arena-orch.test.ts
bun test tests/integration/deploy-arena-orch.test.ts
bun test src/evidence/contest-auto-submit.test.ts
```

## 打开的缝 / 未开的缝

- **打开**：DeployArena 任务/服务图；多机多 GPU worker 标签；本地评测汇聚；COI `submission.json`；playground argv；接到 contest-arm auto-submit。
- **未开（有意）**：账户 / 账单 / 多租户 / Web 插件市场 / 商业竞赛 OS；AtCoder 真交解冻；把 `#40` 焊成默认；放宽 Admission / Budget / hang / T48；#183 SPEC-SWEEP；加厚 execution C。
- **未改**：默认 `fixed_uct`；门控谓词语义；`autoSubmit` 兼容旗语义。
