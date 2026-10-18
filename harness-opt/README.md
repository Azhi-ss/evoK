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
  src/lineage.ts                       每节点一个 JSON + lineage.jsonl
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

Orchestrator（`src/orchestrator.ts`）是确定性代码，工序跟 `design/orchestrator.py` 一致：

`select → gap → propose → dev_small（够格才 dev_full）→ review → backprop`

Reject 把子节点标成 `rejected`，仍然回传价值。Reviewer 可以否决。重复的补丁摘要直接丢掉。held-out 只在 `submitGate` 里经回调读取，不进 Gap Finder / Innovator。

主会话三步对应扩展命令：`harnessopt_select` → `subagent({workflow:'harnessopt.round'})` → `harnessopt_record`。`subagent` 调用本身还没接（见下面的 TODO）。`harnessopt_submit_gate` 是唯一允许读 held-out、也是唯一允许碰 playground submit 的入口；这一轮 live submit 不接线。

三条硬线：

1. held-out 只有 `bin/eval.ts --split heldout --gate` 能读，而且只有提交门会带 `--gate`。角色工具列表里没有 bash。
2. playground submit 只留在 `harnessopt_submit_gate` 里面，当前实现不发起请求。
3. 命名工作流的 `usageBudget.tokens.hard` 是 200000。

## 选择器

MVP 父节点选择器是 `GreedySelector`，提交门是 `BaselineGate`（`submitGate`：held-out ≥ 基线 + 余量，且 ≥ matched-budget TTS，且当天还有配额）。

另外三个选择器按 `orchestrator.py` 移植，可以用 `getSelector` 换上：

- `softmax-mix`：AFlow，top-k 上 `λ·uniform + (1-λ)·softmax(α·100·s)`，默认 k=4、α=0.2、λ=0.3
- `score-child-prop`：DGM，`sigmoid(10·(s-0.5)) / (1+子节点数)`
- `uct`：UCB1 加 progressive widening。这只是公式，不是完整 UCT 产品

保留规则是 keep-better 加 0.01 噪声余量。小子集均值 ≥ 0.9 × 父均值才跑完整 dev。`PairedLcbKeep`、`SuccessiveHalvingStage`、`ParetoArchive`、`MapElitesArchive`、`NoveltyFilter` 调用时抛 TODO，指向选择器摘录里的 P0/P1/P2。

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

空跑种一个 dev 均值 0.4 的根节点，贪心扩展出一个 0.8 的子节点，小子集过线后跑完整 dev，Reviewer 收下。随后 `submitGate` 用 0.1 的 held-out 对 0.5 的 TTS 基线，`submit` 为 false。不调用模型，不读 held-out 题面进 proposer。

`run --dev <题库目录>` 会按 `split` 切开 dev / held-out，held-out 只留在密封库里，执行器仍是夹具分数。

```bash
bun test harness-opt
bunx --package typescript@5.9.3 tsc --project tsconfig.json --pretty false
```
