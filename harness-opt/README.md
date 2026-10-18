# harness-opt

挂在 Pi 上的 harness 优化插件。模型权重不动，只搜外壳。Orchestrator 是确定性代码。这一轮把主会话能驱动的一轮跑通：`/harness-opt` 和同名 LLM tool、命名工作流 `harnessopt.round`、gap-finder / innovator / reviewer-gate 的结构化委派、带步骤的 trace、每阶段报告、轮末 E2E reviewer。

设计原文的权威副本在本机 `/workspace/company/research/`。仓库 `design/` 里是随 PR 走的副本。

## 目录

```
harness-opt/
  package.json                         依赖 pi-subagents 0.79.1
  fixed-model.json                     赛方 id、本地 id、测试 id
  extensions/harness-opt/index.ts      /harness-opt、tool、连字符命令、工作流注册
  workflows/round.js                   harnessopt.round 的脚本正文
  agents/                              三份角色，model 读本地 id
  src/session.ts                       start | step | status | gate | stop
  src/live-round.ts                    委派结果解析后写 gaps / patch / review
  src/pi/delegate.ts                   pi-subagents 的 request/response 事件
  src/modules/executor.ts              bohr 沙箱接口；本机跑 sample-trace
  src/reports.ts                       每轮每阶段一份 JSON，外加 e2e
  src/thresholds.ts                    显式阈值；缺了就失败关闭
  src/heldout-file.ts                  sealed/heldout-score.json
  fixtures/sample-trace.json           三步 trace：read、失败的 bash、write
  fixtures/tasks/dev-1.json            离线 dev 题
```

## 主会话怎么驱动一轮

默认运行目录是项目里的 `.harness-opt/`（已 gitignore）。

```text
/harness-opt start|step|status|gate|stop
```

同名 LLM tool 参数是 `command` 加上可选 `args`。每条命令都用 `ctx.ui.notify` 回显结果和失败项，并用 widget 画状态面板：当前轮、阶段、预算余量、最佳节点、证据门七项（模型、held-out、trace、变更说明、TTS、预算含配额、dry-run）。没跑过的项标 `not-run`。

`start` 必填（文件里已经有则不必再传）：

- `--min-delta`（必须是正数，来自实测 sigma）
- `--tts-baseline`
- `--held-out-floor`
- `--token-budget`
- `--max-local-runs`
- `--max-wall-s`
- `--max-submits`
- `--heldout-score`（写入 `sealed/heldout-score.json`，`source` 为 `hand-filled`。这是声明值，不是对某个候选的评测）

缺任何一项，命令失败并在回显里写出缺的名字。提交门不填 0.5、0.4、5e6 或 `tokensSpent: 0`。

其它入口：

- `harnessopt-select`：必填 `--root <谱系目录>`。可选 `--selector`。
- `harnessopt-record`：必填 `--root` 和 `--kind`。
- `harnessopt-submit-gate`：必填 `--root <运行目录>`。live submit 仍然不发。

`session_start` 用 `pi-subagents/workflow-resources` 注册 `harnessopt.round`。`subagent({ workflow: "harnessopt.round" })` 拿到的脚本依次跑 gap-finder、innovator、reviewer-gate。host command 只有 `bun bin/eval.ts --cand <id> --split dev`。

Pi 里的 tool 把委派事件发到 `pi.events`，不挂样例桥，并传入默认超时 `300000` ms。没有 pi-subagents 在听时，到点发出只含 `requestId` / `ownerRunId` / `nodeId` 的 cancel，UI 写出 `timed out`。超时前 update 里已经出现的 token 记入 `state/usage.json`。CLI 没有这条总线，`demo` / `step` 挂上同协议的 sample bridge。桥的标签以实际收到的应答为准：start 时是 `bridge none`，样例应答之后才是 `bridge sample`，外部总线真的回了终端事件才是 `pi-subagents`。

## 模型和阈值

`fixed-model.json` 是唯一映射：

| 名字 | id |
|---|---|
| 赛方 | `deepseek-v4.1-flash` |
| 本地 Pi | `ai-modeling/deepseek-v4-1-flash-261017` |
| 本轮测试 | `deepseek-v4-1-flash-261017` |

证据门和三份 `agents/*.md` 的 `model:` 都读这里。三者任一精确匹配才通过。`qwen-*` 和带 sft/grpo/lora 的 id 失败。

token 记在 `state/usage.json` 的 `tokensSpent`。委派 usage、超时前已经观测到的 usage，以及 trace 上的 tokens 都会加上。文件不存在时预算门失败，并点名 `tokensSpent`。

held-out 只有 `sealed/heldout-score.json`。读不到、JSON 坏、分数不是有限数，都抛 `held-out read failed`，不吞成 null。分数只进 `state/gate.jsonl`。`--heldout-score` 写成 `source: "hand-filled"`、`entries` 为空。提交门和里程碑按 `configPath` 读 `entries`，不回退到那个全局声明值。条目不是 `evaluated` 时抛错，detail 含 `手填`，这道门失败，也不算绿。父子因此不会读到同一个数。`recordEvaluatedHeldOut` 才写入某一条候选的实测；样例执行器不调用它。

TTS 只认 `state/tts-comparison.json` 里 `source: "matched-budget"` 且 `status` 为 `passed` 或 `failed`。没有这份文件时状态是 `not-run`，提交门失败。held-out 和 `ttsBaseline` 的比较不能把这盏灯点绿。

## 执行器和题库

`HarnessExecutor.run` 返回带 `steps` 的 trace。`BohrSandboxExecutor` 在没有本地 bohr / pi-bio-harness 镜像时抛 `ExecutorUnavailable`。本机闭环用 `SampleTraceExecutor`，重放 `fixtures/sample-trace.json`：read 成功、bash `exit 1: assertion failed...`、write 成功。报告写 `executor sample-trace`。基线路径含 `/base/` 时 reward 0.4，其后候选 0.8。

`LocalJsonTaskSource` 读目录里的 JSON。`PlaygroundTaskSource.list/download` 在没有 playground CLI 时失败关闭，错误里写明 CLI 未安装。`start --task-source` 写进 `state/session.json`，`step` 按这个字段取题，不会在 step 里改回本地目录。`run --dev <目录>` 走本地题库和执行器，不再把题库丢掉然后空跑。

`playground submit --dry-run` 会带上 `evidence_pack/pack.json`。没有 CLI、没有该 flag、没给提交物路径，都标 `not-run` 并失败关闭。live submit 不发。

## 每阶段报告和 E2E

每一轮写 `reports/round-N/<stage>.json`：`round`、`stage`、`output`、`explanation`。阶段是 select、gap、propose、run、review、backprop、gate。

`reviewRoundE2E` 在 step 末尾检查这七份报告的 `stage`、非空 `explanation` 和非空 `output`，并按阶段核对内容（gap 要能被 `parseGapReport` 接受且至少一条，propose 要有 summary 和 configPath，review 要有布尔 `accept` 和非空 `reason`）。产物同样用 `parseGapReport` / `parsePatchFile` 校验，`{}` 不能过。候选被留下时，`evidence_pack/pack.json` 必须有 model、变更说明和 trace 索引；没被留下且目录不存在则记一笔「未晋升」。结果写 `reports/round-N/e2e.json`。缺阶段或内容不符则 E2E 失败。提交门因 dry-run、手填 held-out 或 TTS not-run 而红，本身不让 E2E 失败。

## 证据门

`Orchestrator.submitGate` 把下列项相与。任一项不过就 fail-closed：

1. 模型 id 落在映射表里
2. held-out 不低于基线 + Δ。Δ 必须是正的有限数。不传、传 0、非有限值，这道门失败，detail 含 `sigma`
3. trace 包
4. 变更说明
5. TTS 来自真实 matched-budget 对比且状态为 passed。没有对比则 not-run，失败
6. token 预算与当日配额（面板上合成预算一行）
7. `playground submit --dry-run` 成功

dev 上涨且 held-out 相对父节点下跌，拒绝晋升。里程碑分别用子节点和父节点的 `configPath` 去读 `entries`。没读到、或读到的是手填声明，都拒绝晋升。谱系事件只留 `regressed`。

留下规则 `childMean ≥ parentMean − 0.01` 和预筛 `smallMean ≥ 0.9 × parent.devMean` 是占位常数，不是 LCB，也不是配对差。`dev_small` 与 `dev_full` 在夹具里是同一分数的重复；跑过 full 之后 `devMean` 只用 full，不把两段拼起来。

## 选择器

主链路用 `GreedySelector`。`getSelector` 还能换：

- `softmax-mix`：AFlow 公式
- `uct`：UCB1 加 progressive widening，只是公式

未实现，调用即抛 TODO，失败关闭：

- `score-child-prop`（中心须是 archive 中位数，斜率约 `1/sigma`；表达式仍在 `scoreChildPropWeight`）
- `paired-lcb`（`PairedLcbKeep`）
- `successive-halving`（`SuccessiveHalvingStage`）
- `map-elites`（`MapElitesArchive`）
- `novelty`（`NoveltyFilter`）
- `ParetoArchive`

## 本地闭环

```bash
bun harness-opt/src/cli.ts demo --out /tmp/harness-opt-demo
bun harness-opt/src/cli.ts empty --out /tmp/harness-opt-empty
```

`demo` 用上面的显式阈值和 `fixtures/tasks`，sample bridge 加 sample trace，跑完一轮。`--heldout-score` 是手填，里程碑读不到各候选的 evaluated 分数，子节点不晋升，best 留在 base，`evidence_pack/` 不写。提交门因此在 held-out、TTS（not-run）和 playground dry-run 上失败，`submit: false`。`empty` 仍是夹具角色；它把顶层 `{ score, tokens }` 写进同一个 `sealed/heldout-score.json` 再读回来。夹具要开绿灯时必须显式传入 `tts: "passed"`，表示一份 matched-budget 对比已经跑过。

`harnessopt-record --json` 保留整段 JSON，解析失败走 `ctx.ui.notify`，不把异常抛出命令循环。

```bash
bun test harness-opt
npx -p typescript@5.9.3 tsc -p tsconfig.json
npx -p typescript@5.9.3 tsc -p harness-opt/tsconfig.json
```

`bunx --package typescript@5.9.3` 在 bun 1.4 上解析不了这个包，所以类型检查改走 `npx -p`。evoK 根 `tsconfig.json` 不包含 `harness-opt/`。根 `package.json` 的 `harness-opt` 脚本只转发到插件 CLI。

本机没有 bohr 沙箱，也没有 playground CLI。样例执行器重放 `fixtures/sample-trace.json`，不是 bohr 沙箱。playground dry-run 在没有 CLI 时是 not-run。sample bridge 只在 CLI demo 里回答委派。Pi 会话里由 pi-subagents 接事件；接不上就超时、发 cancel、把已见 token 记账，不把样例回复伪装成模型输出。
