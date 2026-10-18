# harness-opt

挂在 Pi 上的 harness 优化插件雏形。模型权重不动，只搜外壳（agent loop / 上下文 / 记忆 / 工具链 / Skills）。这一轮是可单测的空流程，不跑训练、不交线上赛。

设计依据在 `design/`。目前入库的是 `2026-10-18-harness-opt-pi-plugin-prd.md`。选择器与 pi-subagents 的两份说明、以及 `orchestrator.py`，文件名已经写在代码 TODO 里，正文随后补进同一目录。

## 目录

```
harness-opt/
  agents/                 角色提示词与写权限声明
  design/                 设计文档原文
  src/orchestrator.ts     确定性状态机（不是 LLM）
  src/modules/probe.ts    题库探针：dev / held-out 切开
  src/modules/proposer.ts 候选生成：Gap Finder + Innovator 的上下文边界
  src/modules/runner.ts   沙箱执行的 dev 跑题（含 TTS 基因）
  src/modules/scoring.ts  评分 + 归因
  src/modules/selector.ts 选择器接口
  src/modules/evidence-gate.ts  证据门
  src/adapters/evok-sandbox.ts  复用 evoK SandboxBoundary
  src/adapters/evok-submission.ts  复用 evoK contest auto-submit 门
  src/pi/subagents-port.ts  pi-subagents 宿主接口（桩）
  src/cli.ts              本地空跑入口
```

## 六模块和角色

| PRD §5 模块 | 代码 |
|---|---|
| 题库探针 | `src/modules/probe.ts` |
| 候选生成器 | `src/modules/proposer.ts`，角色 `agents/gap-finder.md`、`agents/innovator.md` |
| 沙箱执行 | `src/modules/runner.ts` + `src/adapters/evok-sandbox.ts`，角色 `agents/runner.md` |
| 评分 + 归因 | `src/modules/scoring.ts` |
| 选择器 | `src/modules/selector.ts`，Reviewer 调用它 |
| 证据门控提交 | `src/modules/evidence-gate.ts` + `src/adapters/evok-submission.ts`，角色 `agents/report-writer.md`、`agents/submitter.md` |

Orchestrator（`src/orchestrator.ts`）是确定性代码。一轮工序：

`gap-finder → innovator → runner → reviewer → report-writer →（门全绿才）submitter`

Reject 写入谱系失败节点，不再交给 Report Writer。Reviewer 可以否决。held-out 只在证据门读取，不进 Gap Finder / Innovator。

## 选择器

默认准则是 `staged-threshold`（分数差和 token 回归两道门槛），不是纯贪心。`greedy` 可以显式选，但不是默认。

`paired-ci-halving`、`aflow-sample`、`dgm-sample`、`uct` 只登记接口。调用高级采样会抛出 TODO，指向 `design/2026-10-18-evolution-selector-solutions.md` 第 ④ 节。门槛留在 `PromotionCriterion.decide` 的输入里，方便以后换成「配对评测 + 置信区间下界 + successive halving」。

`samples` / `selfChecks` / `retries` 写在候选配置上，patch 可以改。`SelectorSearchConfig.sampleCount` 是父代抽样次数，同样是配置而不是写死的常数。

## 复用了 evoK 的什么

- 沙箱：`src/execution/security-boundary.ts` 的 `SandboxBoundary`。拒绝越界路径，默认不开 bash、不开网络。不启动 `PiAgentRuntime`。
- 提交门：`src/evidence/contest-auto-submit.ts` 的 `evaluateContestAutoSubmitGates`。缺 promotion / hang / admission / budget 就失败关闭。本插件自己的证据门（模型白名单、held-out、trace、TTS、日配额）另外算，两边都绿才可能往下走。

不依赖 `plugins/evok-platform` 和 `plugins/evok-research`。不把 Chord hot-plug 当加载路径。

## 桩和 TODO

pi-subagents **没有安装，也没有被 import**。`UnverifiedPiSubagentsDelegator` 会抛错。未核实的四点写在 `src/pi/subagents-port.ts`：

1. 插件引用 pi-subagents 的 import 路径
2. workflow 脚本的评测命令（`clarify → scout → worker → review` 只是猜测的宿主工序，不是产品状态机）
3. 结构化委派的请求形状
4. 把 `agents/*.md` 挂进子代理角色目录

不要装 pi-intercom。`contact_supervisor` 是 pi-subagents 自带的。当前机器的 Node 是 22.14，低于 Pi 要求的 22.19，所以编排层用接口加桩，纯逻辑测试不需要 Pi。

真 playground submit 没有接。证据门绿了也只干跑，`liveSubmit` 默认 false。

## 本地空跑

```bash
bun harness-opt/src/cli.ts empty --out /tmp/harness-opt-empty
```

空跑会走完 Gap Finder → Innovator → Runner → Reviewer → Report Writer。候选能过 staged dev 门，然后被证据门拦住（没有 held-out、没有 TTS 对照），不会调用 Submitter。

`run --dev <题库目录>` 会按 `split` 切开 dev / held-out，然后仍用同一套夹具执行器打分。它不调用模型，也不读 held-out 题面进 proposer。

```bash
bun test harness-opt
bunx --package typescript@5.9.3 tsc --project tsconfig.json --pretty false
```
