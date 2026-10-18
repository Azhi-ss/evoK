# harness-opt

挂在 Pi 上的 harness 优化插件雏形。模型权重不动，只搜外壳（agent loop / 上下文 / 记忆 / 工具链 / Skills）。这一轮是可单测的空流程：确定性 Orchestrator、四个可换选择器、评测门和谱系落盘。不跑训练，不交线上赛。

设计原文的权威副本在本机 `/workspace/company/research/`。仓库 `design/` 里是随 PR 走的副本：

- `design/2026-10-18-harness-opt-pi-plugin-prd.md`
- `design/2026-10-18-pi-subagents-setup.md`
- `design/orchestrator.py`（选择器、评测门、谱系、状态机的移植起点）
- `design/2026-10-18-evolution-selector-solutions.md`（落地结论摘录，完整约 41KB 的原文仍在本机）

## 目录

```
harness-opt/
  package.json                         pi-package：extensions + subagents.agents
  extensions/harness-opt/index.ts      注册 harnessopt_select / _record / _submit_gate
  workflows/round.js                   命名工作流骨架，未核实前直接抛 TODO
  agents/                              gap-finder、innovator、reviewer-gate
  bin/select.ts                        读谱系，打印父节点 JSON
  bin/eval.ts                          dev 打分；held-out 只有 --gate 能读
  bin/record.ts                        追加 lineage.jsonl / 写 run_state.json
  state/                               运行时谱系（仓库里只有占位）
  candidates/                          每个候选一份配置
  .pi/settings.json                    packages 为空，避免误加载
  src/orchestrator.ts                  确定性状态机（不是 LLM）
  src/lineage.ts                       每节点一个 JSON + lineage.jsonl；门分数在 gate.jsonl
  src/budget.ts                        本地次数、token、墙钟、日提交配额
  src/modules/selector.ts              Greedy / SoftmaxMix / ScoreChildProp / UCT
  src/modules/probe.ts                 题库探针：dev / held-out 切开
  src/modules/proposer.ts              候选生成与 held-out 泄漏检查
  src/modules/runner.ts                dev 跑题与 TTS 基因
  src/modules/scoring.ts               赛制 0–100 展示分 + 归因
  src/modules/evidence-gate.ts         证据门（和 BaselineGate 相与）
  src/adapters/evok-sandbox.ts         复用 evoK SandboxBoundary
  src/adapters/evok-submission.ts      复用 evoK contest auto-submit 门
  src/pi/subagents-port.ts             pi-subagents 未核实接口（桩）
```

## 六模块和角色

| PRD §5 模块 | 代码 |
|---|---|
| 题库探针 | `src/modules/probe.ts` |
| 候选生成器 | `src/modules/proposer.ts`，角色 `agents/gap-finder.md`、`agents/innovator.md` |
| 沙箱执行 | `src/modules/runner.ts`、`bin/eval.ts`、`src/adapters/evok-sandbox.ts` |
| 评分 + 归因 | `src/modules/scoring.ts`（展示分 ×100）；循环内部用 [0, 1] |
| 选择器 | `src/modules/selector.ts`，默认 `GreedySelector` |
| 证据门控提交 | `Orchestrator.submitGate`（BaselineGate）+ `src/modules/evidence-gate.ts` + `src/adapters/evok-submission.ts` |

Orchestrator（`src/orchestrator.ts`）是确定性代码，工序跟 `design/orchestrator.py` 一致，并补上 PRD 的晋升守门和证据门：

`select → gap → propose → dev_small（够格才 dev_full）→ review（含 held-out 回归）→ backprop →（accept 才）report writer`

Reject 把子节点标成 `rejected`，仍然回传价值。Reviewer 可以否决。重复的补丁摘要直接丢掉。评测器在里程碑读 held-out：候选 dev 上涨且 held-out 相对父节点下跌，就拒绝晋升。没读到 held-out 也拒绝晋升。这个读数不进 Gap Finder / Innovator，也不写进节点 JSON。谱系事件里只留 `regressed` 这个结论，不留分数。

选不到父节点、补丁摘要重复、runner 抛错、新节点 id 已存在，这几条都不消耗本地次数。连续发生 `maxConsecutiveStalls` 次（默认 3）且中间没有完成一次 review，`run()` 就停。runner 抛错时，已经标成 `running` 的子节点改成 `failed`。价值回传遇到自己指向自己的父节点会停，不会顺着环空转。

## 证据门

`Orchestrator.submitGate` 调用 `evaluateEvidenceGate`，再与另外三道相与。任一项不过就 fail-closed，不调用 live playground submit：

1. 固定模型 ID 与 `fixed-model.json` 里的 `deepseek-v4.1-flash` 精确一致（`qwen-*` 这类前缀过不了）
2. held-out 不低于基线 + Δ。Δ 必须是由实测 sigma 推出的正数。不传、传 0、或传非有限值，这道门失败关闭，没有默认 0
3. 存在完整 trace 包
4. 存在变更说明
5. TTS matched-budget 对照已跑且 held-out 不低于 TTS 基线（未跑则禁止自动交）
6. token 预算与当日提交次数未超
7. `playground submit --dry-run` 成功；CLI 不支持时显式标 `not-run` 并失败关闭

`harnessopt_submit_gate` 的 handler 会跑这条全链路。门全绿时 Submitter stub 写回执，`submitted` 仍是 false。

held-out 分数只写 `state/gate.jsonl`。`lineage.jsonl` 的 gate 事件只有节点 id 和是否通过。角色拿到的谱系视图会删掉任何 held-out / hidden 字段；Gap Finder 和 Innovator 的输入、输出都会过 `assertNoHeldOutLeak`。`run_state.json` 不保存这个分数。Gap Finder、Innovator、Reviewer、Runner 都不能读 `gate.jsonl`。

主会话三步对应扩展命令：`harnessopt_select` → `subagent({workflow:'harnessopt.round'})` → `harnessopt_record`。`subagent` 调用本身还没接（见下面的 TODO）。`harnessopt_submit_gate` 是唯一允许读 held-out、也是唯一允许碰 playground submit 的入口；这一轮 live submit 不接线。

三条硬线：

1. held-out 只有 `bin/eval.ts --split heldout --gate` 能读，而且只有提交门会带 `--gate`。角色工具列表里没有 bash。
2. playground submit 只留在 `harnessopt_submit_gate` 里面。支持时只跑 `--dry-run`；不支持则标未跑并失败关闭。live 请求不发。
3. 命名工作流的 `usageBudget.tokens.hard` 是 200000。

## 选择器

MVP 父节点选择器是 `GreedySelector`。提交门是 `submitGate`：held-out ≥ 基线 + 正的 Δ，且 ≥ matched-budget TTS，且当天还有配额。Δ 没有默认值。

可以用 `getSelector` 换上的选择器：

- `softmax-mix`：AFlow，top-k 上 `λ·uniform + (1-λ)·softmax(α·100·s)`，默认 k=4、α=0.2、λ=0.3
- `uct`：UCB1 加 progressive widening。这只是公式，不是完整 UCT 产品

`score-child-prop` 的 DGM 表达式 `sigmoid(10·(s-0.5)) / (1+子节点数)` 还在 `scoreChildPropWeight` 里，中心 0.5、斜率 10 没有按本档案标定。标定后的中心应取 archive 中位数，斜率约 `1/sigma`。`getSelector("score-child-prop")` 在标定前抛 TODO，失败关闭。

两处比较是占位，不是统计判据：

- 留下规则 `childMean ≥ parentMean − 0.01`：不配对，不是 LCB，0.01 是名义常数。
- 分段预筛 `smallMean ≥ 0.9 × parent.devMean`：小子集均值对全集均值，尺度不配，0.9 是拍的，只当便宜预筛。

`dev_small` 和 `dev_full` 在 `bin/eval.ts` 和空跑夹具里是同一夹具分的重复，不是不相交的题集。跑过 `dev_full` 之后，`devMean` 只用这份全量重复，不再把小集分数拼进去。

`PairedLcbKeep`、`SuccessiveHalvingStage`、`ParetoArchive`、`MapElitesArchive`、`NoveltyFilter` 调用时抛 TODO，指向选择器摘录里的 P0/P1/P2。

`samples` / `selfChecks` / `retries` 写在候选配置上，是可搜的 TTS 基因。

## 复用了 evoK 的什么

- 沙箱：`src/execution/security-boundary.ts` 的 `SandboxBoundary`。拒绝越界路径，默认不开 bash、不开网络。不启动 `PiAgentRuntime`。`bin/eval.ts` 和空跑的读配置都走它。
- 提交门：`src/evidence/contest-auto-submit.ts` 的 `evaluateContestAutoSubmitGates`。缺 promotion / hang / admission / budget 就失败关闭。插件自己的证据门（模型白名单、held-out、trace、TTS、日配额）另外算。BaselineGate 与这两边都绿，才可能进入提交；这一轮即使全绿也不发 live 请求。

不依赖 `plugins/evok-platform` 和 `plugins/evok-research`。不把 Chord hot-plug 当加载路径。不改 pi-subagents 源码，也不把它放进 dependencies。

## 桩和 TODO

pi-subagents **没有安装，也没有被 import**。`UnverifiedPiSubagentsDelegator` 会抛错。未核实项写在 `src/pi/subagents-port.ts`，对应设置文档第 7 节：

1. 裸脚本 `gate.command` 用 args 拼接是否被接受
2. 分开安装时 `import 'pi-subagents/workflow-resources'` 能否解析
3. `registerCommand` handler 里能否发起结构化委派
4. `contact_supervisor` 阻塞超时的默认值
5. `pi install -l ./` 会不会读到 `pi.subagents.agents`

`workflows/round.js` 在核实前执行会抛 TODO。当前机器的 Node 低于 Pi 要求的 22.19，所以编排层用 TypeScript 状态机单测，不装 Pi。

`.pi/settings.json` 的 `packages` 是空数组。等 Node ≥ 22.19 再用 `pi install -l` 填本地包。不要装 pi-intercom。`contact_supervisor` 是 pi-subagents 自带的。Gap Finder 和 Innovator 的角色文件允许它，Reviewer 不允许。

## 本地空跑

```bash
bun harness-opt/src/cli.ts empty --out /tmp/harness-opt-empty
```

空跑种一个 dev 均值 0.4 的根节点，贪心扩展出一个 0.8 的子节点。里程碑 held-out 从 0.5 到 0.55，没有回归，Reviewer 收下，并写出 trace 包和变更说明。随后提交门用 0.1 的 held-out 对 0.5 的 TTS 基线，加上本机没有 playground CLI 时的 dry-run（标 not-run），`submit` 为 false。0.1 写在 `state/gate.jsonl`。标准输出仍给操作者这份结果。不调用模型，不把 held-out 题面交给 proposer。

`run --dev <题库目录>` 会按 `split` 切开 dev / held-out，held-out 只留在密封库里，执行器仍是夹具分数。

插件自己类型检查、自己跑测试。evoK 根 `tsconfig.json` 不包含 `harness-opt/`。根 `package.json` 的 `harness-opt` 脚本只是转去插件 CLI。

```bash
bun test harness-opt
bunx --package typescript@5.9.3 tsc --project harness-opt/tsconfig.json --pretty false
```
