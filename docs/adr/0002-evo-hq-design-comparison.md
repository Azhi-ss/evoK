# ADR-0002: Design 对照 — evo-hq fanout / gate / benchmark JSON

- **Status**: Accepted
- **Scope**: 设计对照（docs-only），不改变任何运行时契约
- **Related**: #15（本票）、#20（旧版 T14，已关闭且无产出文档，本 ADR 取代之）、#1

## 1. Scope / Trigger

evo-hq/evo 是一个「autoresearch loop」：把代码库变成优化引擎，discover 基准 → instrument → tree search + 并行 subagent 实验。它在 Pi 上以 `@evo-hq/pi-evo` 插件形态存在，自带 `/discover`、`/optimize`、`/subagent`、`/infra-setup` skills 和 mid-run inject extension。

本 ADR 对照 evo-hq 的 fanout、subagent 捆绑、gate 与 benchmark JSON 契约，逐项给出 evoK 的对应物和 采纳 | 改编 | 拒绝 结论。**本 ADR 只做设计对照**：不引入对 evo-hq 的运行时依赖，不修改 AgentRuntime 端口，不开新实现票（可采纳项全部落到已有 ticket）。

公开文档链接（本 ADR 的事实来源，均于本票执行日核对）：

- https://github.com/evo-hq/evo （README、`plugins/evo/skills/{discover,subagent}/…`）
- https://pi.dev/packages/@evo-hq/pi-evo （插件注册面、peerDependencies）
- https://evo-hq.com/docs/ （gate 语义、frontier 策略文档）
- npm 镜像快照：`@evo-hq/pi-evo@0.8.0` skills/README

## 2. evo-hq 契约面（事实记录）

### 2.1 Fanout 与 subagent 捆绑

- **Tree search over greedy hill climb**：任意 committed node 可 fork 多个方向；每轮 orchestrator（指 evo-hq 自己的主循环 agent，非 evoK 的 Mission Director/Team Coordinator 角色）写结构化 brief（objective、parent node、boundaries、pointer traces），spawn N 个半自主 subagent，各自在独立 git worktree 内读共享状态、形成假设、编辑、跑 benchmark，并在 branch 内按 budget 多次迭代。
- **Round 宽度 = `subagents=N`**（live concurrency），加上 `budget`（per-branch depth）与 `stall`（无提升轮数后停止）。
- **Candidate-work delegation invariant**：orchestrator 自己不建、不改、不跑 candidate 实验；subagent 用 `evo new --parent <id>` 申请自己的实验。**Resource-cap invariant**：`subagents=N` 是并发上限，受绑定资源（GPU/slot）约束，禁止超额 spawn。
- **Pi 上的捆绑原因**：Pi 默认无 fanout。`@evo-hq/pi-evo` 把 `pi-subagents` 作为 bundled provider 装进插件（peerDeps 依赖 `pi-agent-core` 等），注册一个 `subagent` tool 使 `/optimize` 能在单轮内并行 fan out —— 即把并行机制从 host 挪进插件。evo 官方对 Pi 的定位是 "extension-provided" fanout。
- **Cross-cutting scans**：轮间由 RLM 风格（arXiv:2512.24601）的 scan subagent 并行读 trace batch，归纳 gate-failure 交集、跨 trace 的共因失败，写回共享状态供下一轮 subagent 阅读。
- **Frontier strategies**：argmax / top_k / epsilon_greedy / softmax / pareto_per_task（GEPA 灵感，arXiv:2507.19457），在 dashboard 的 Frontier tab 配置。

### 2.2 Gate

- Gate 是 pass/fail 检查，**每个实验都跑**；gate 失败即 discard，即使 score 刷新 best。任何 exit 0 = pass / exit ≠ 0 = fail 的命令都可作 gate（测试套件、不变量脚本、held-out slice 的 score floor）。判定只看 exit code，不看 stdout。
- Gate 是 node-scoped 且沿实验树继承：root 注册的 gate 作用于所有后代；可给特定 branch 挂窄 gate。
- 从零构造 benchmark 时 **discover 自动附加 held-out score-floor gate**（baseline 分作阈值）；benchmark 已存在时 gate 是 opt-in。
- 每个 `evo run` 前后有 **verifier subagent**（约 30s 静态分析，JSON verdict `{passed, verdict, findings}`），检查 test-set leakage、subsetted eval、新 artifact 缺 gate、空泛假设等；verdict `fail` 是 stop-the-line 前置条件。

### 2.3 Benchmark JSON 契约

- **环境变量**（`evo run` 注入）：`EVO_RESULT_PATH`（结果 JSON 路径，缺省退化为 stdout）、`EVO_TRACES_DIR`（per-task trace JSON 目录）、`EVO_EXPERIMENT_ID`、`EVO_CHECKPOINT_DIR`（可恢复 checkpoint / 声明式 artifact）。
- **Result JSON**：`{"score": 0.6, "tasks": {"t1": 0.8, "t2": 0.4}, "artifacts": {"label": "path"}}` —— 单一 `score` 数字 + 可选 `tasks` 分解 + 可选 `artifacts`（label→path，discard 后仍可 `evo new --from-artifact` 复用）。
- **exit code**：0 表示正常完成（低分也 0）；非 0 仅表示基础设施失败。`--metric max|min` 声明优化方向。
- **构造纪律**：Goodhart audit（列举可 gaming 策略与 held-out 检测手段）、60–70% train / 30–40% held-out 切片、每个从零构造的 benchmark 必须配至少一个 gate、benchmark determinism 一行声明。
- **自认缺口**（对 evoK 有对照价值）：evo 当前**不做**跨独立 run 的均值/置信区间比较，噪声 benchmark 可能 commit 一个「lucky」实验；multi-run / variance-aware 优化在 roadmap 未实现。

## 3. 映射表（evo-hq 概念 → evoK 对应物 → 结论）

| evo-hq 概念 | evoK 对应物（已有/拟议） | 结论 |
|---|---|---|
| Parallel subagent fanout（每 agent 独立 worktree） | Fan-Out / Branch / Team 执行 + DAG scheduler（#3、#5；harness 拥有 fanout，非 runtime 插件） | **采纳**（概念已有，机制不同：evoK 由 harness 的 ExecutionPlan 声明拓扑，不依赖 host subagent tool） |
| `subagents=N` 并发宽度 + resource-cap invariant | DAG scheduler 的资源有界并行与 JoinPolicy quorum（#5） | **采纳**（已存在；N 受 binding resource 约束的纪律与 evoK 一致） |
| 共享状态：failure traces / annotations / discarded hypotheses | Evidence、event ledger、WORLD_MODEL predict→reconcile（#8、#12） | **采纳**（已存在，且 evoK 更强：ledger 是权威状态，非共享文件夹） |
| 每 branch 内迭代 budget / `max_attempts` + failure-class | Run attempt identity、fencing、幂等与 Branch recovery（#4） | **采纳**（已存在） |
| Frontier strategies（argmax/top_k/ε-greedy/softmax/pareto） | Promotion policy / Local Champion（#8）+ macro/micro bandit（#14）；GEPA 类策略见 #26 | **改编**：只作为 Mission Director 的**可选**扩展策略（#26 已限定），不进默认 Promotion 路径；不做 dashboard 配置面 |
| Cross-cutting scan subagents（RLM 风格共因分析） | Cross-review loop（#22） | **采纳**（落到既有 #22） |
| Gate：命令 exit-code 契约、gate 失败即使刷分也 discard | Verification gates（#7：Falsifier/Critic/Challenger/Auditor/SuccessAuditor，authoritative: false）+ SubmissionBroker quota/Human Acceptance（#10、#35）；增益阈值见 noise protocol 的 `marginPolicy`（#11） | **改编**：语义采纳（否决权在 gate 不在 score），机制不同——evoK 用类型化角色契约与 promotion 门槛，不用任意 shell 命令当 gate |
| Held-out score-floor gate 自动附加（构造基准时） | Validation ladder：inner CV → outer holdout → 限量 Public probe（#34）+ Leakage audit / test-signal policy（#33） | **采纳**（落到既有 #33、#34） |
| Verifier subagent pre/post JSON verdict | verification-gates.ts 的 VerificationTrigger（before-expensive-execution / before-promotion 等）+ Falsifier/Auditor 角色（#7） | **采纳**（角色已有；JSON verdict 形态可作为 Auditor 输出规范参考） |
| Benchmark JSON：`{score, tasks, artifacts}` + 环境变量路径 | EvaluationContract + noise protocol（#11、#16）：normalized noise model、ladder、margin、SymmetricAB | **改编**：字段形状可参考，但 evoK 的 evaluation_contract 是 Adapter 声明的带噪声归一化契约，eval 信息流另有 #24；`tasks` 分解与 evoK 的 per-task Evidence 对应 |
| exit 0 = infra 正常（低分也 0） | Evaluator 只产出 observation/score/finding，不决定 promotion（CONTEXT.md Evaluator 词条） | **采纳**（已一致） |
| `--metric max/min` 优化方向 | Task Contract 的 `objective` + Adapter 声明的 `metric`（如 "score (higher is better)"）；`EvaluationContract` 无方向字段 | **采纳**（方向声明在 Task Contract/Adapter，不在 evaluation_contract） |
| Goodhart audit + train/held-out 切片 + determinism 声明 | #33（gaming/leakage）、#34（held-out）、#11（噪声协议要求每 Run 代表决策统计量） | **采纳**（evoK 在噪声方向已超前：evo 自认无 multi-run CI，#11 已实现归一化） |
| Checkpoint/artifact 声明与 `--from-artifact` 复用 | Snapshot / Artifact（#1 词汇与既有 Snapshot 概念） | **改编**：以 Snapshot 的不可变标识复用，不做裸路径 label 契约 |
| **bundling pi-subagents 以在 Pi 内获得 fanout** | — | **拒绝**（见 §4.1） |
| **把长期自主 loop 放进单会话 LLM orchestrator** | — | **拒绝**（见 §4.2；ADR-0001 已定 Run 边界） |
| **score 劫持 mission 优先级（内外层）** | — | **拒绝**（见 §4.3；Verification 永不 scoring/promoting，#7） |
| mid-run inject extension（EVO DIRECTIVE banner） | Human Acceptance + Mission Policy + stop reason（#10、#1） | **拒绝**（见 §4.4） |
| Dashboard / Frontier 配置面 | ledger + artifact 可观测 | **拒绝**（当前无需求；YAGNI，需要时另开票） |
| `@evo-hq/pi-evo` 运行时依赖 | — | **拒绝**（见 §5；不修改 AgentRuntime 端口） |

## 4. 明确拒绝项

### 4.1 以 Pi Extension 为核心 / bundling pi-subagents 获得 fanout

evo-hq 在 Pi 上的 fanout 依赖插件捆绑 `pi-subagents`（peerDeps `pi-agent-core` 等）注册 `subagent` tool —— 并行机制的生命周期、并发上限、失败语义都由 host/插件运行时持有。evoK 的硬约束（#1）是 standalone harness、Pi runtime 可替换、不 fork Pi。fanout 必须由 harness 自己的 ExecutionPlan / DAG scheduler（#3、#5）拥有：拓扑、quorum、超时、失败关闭都在 evoK 代码内可审计。把 fanout 外包给插件等于把 Mission Policy 的执行语义交给第三方运行时版本漂移。**结论：不安装、不依赖 `@evo-hq/pi-evo`；evoK 的 fanout 已是第一方构件。**

### 4.2 长期自主性放进单会话 LLM orchestrator

evo 的 `/optimize` 是一个长期运行的主 agent session，subagent 通过 host 的 Task 工具回卷；停止、恢复、状态都寄居在会话 transcript 里。evoK 已明确拒绝该形态（ADR-0001）：session 是 Run 资源而非 Mission 记忆；每个 `AgentRuntime.execute()` 一个新 session，Run 结束即 dispose；长期状态只在 harness 的 Task Contract、Snapshot、Evidence、Finding、ledger。Mission 的存续不依赖任何单一 LLM 会话。**结论：维持 ADR-0001；不引入跨 Run/跨 Task 的持久会话编排。**

### 4.3 内层/外层 score 劫持 mission 优先级

evo 的搜索目标是单一 benchmark score，gaming 防护只靠 gate（held-out floor 等）。evoK 拒绝两层劫持：

- **内层**（任务执行层）：Evaluator 只测量、不晋升（CONTEXT.md）；Verification 角色契约 `authoritative: false`，「Team verification may block or quarantine, but it never scores or promotes」（#7）。单次分数即使刷新 best，也要过噪声协议（#11：ladder、margin、SymmetricAB）才进入比较。
- **外层**（Mission 层）：Research Objective 由 human 拥有，不得被 agent 隐式改写；Promotion ≠ Human Acceptance ≠ External Submission（#10）；提交由 SubmissionBroker 的 quota 与 Human Acceptance 门控（#10，quota 一等化见 #35），增益阈值由 noise protocol 的 `marginPolicy` 提供（#11）。evo 的「keep what improves the score, throw away what doesn't」若原样搬进 evoK，等于让 benchmark score 取代 Mission Objective。

### 4.4 mid-run inject / EVO DIRECTIVE banner

evo 通过插件 hook 通道向运行中的 orchestrator session 注入用户权威消息（UserPromptSubmit、SubagentStop 等任意通道）。这与 ADR-0001 的会话边界冲突（运行中 session 的权威输入只能来自该 Run 的调用方），且 hook-banner 注入面本身就是 prompt-injection 的放大器。evoK 的等价能力走 harness 层：Mission seam、stop reason、Human Acceptance（#10），事件经 ledger 审计而非 banner 广播。

## 5. 结论

1. **无运行时依赖**：本对照不引入对 evo-hq / `@evo-hq/pi-evo` 的任何 import、peerDependency、CLI 调用或 JSON 互操作需求。
2. **AgentRuntime 端口不动**：`PiAgentRuntime.execute()` 的契约维持 ADR-0001 原样；不绑定 `@evo-hq/pi-evo`，不新增 session 复用或 host-subagent 通道。
3. **可采纳项全部落到既有 ticket，不开重复实现票**：fanout/拓扑 #3/#5、verification gates #7、loop/ledger #8/#12、SubmissionBroker/Human Acceptance #10、噪声协议 #11/#16、Cross-review #22、GEPA 可选策略 #26、Leakage audit #33、Validation ladder #34、submission quota #35。
4. 本 ADR 的「改编」行只描述 evoK 已选方向的对照依据；若要改变任何契约（evaluation_contract 形状、gate 机制、promotion policy），须另开实现票并走 #1 增补流程。

## 6. Out of Scope / Follow-ups

- 不改变 `evaluation_contract`、JoinPolicy、verification gate 或 promotion policy 的任何代码契约。
- 不评估 evo-hq dashboard 或 remote backend（Modal/E2B/Daytona）设计。
- 情报包 `/workspace/company/research/2026-09-04-evok-x-ideas.md` 在本工作区不可达，未作为事实来源核对；本 ADR 的事实全部来自上述公开链接。若该包内容与本文冲突，以 ticket 增补流程修订。
