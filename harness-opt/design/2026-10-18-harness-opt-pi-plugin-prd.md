# PRD：Pi 插件式 Harness 优化器（自动打 Harness 优化赛）

- 日期：2026-10-18（Asia/Tokyo）
- 状态：Draft v0.3（船长确认：多 agent 要拆；2026-10-18 19:36 JST 已对照 live 题面补 Open Questions）
- 依据：2026-10-18-autoresearch-arch-decomposition.md
- 读者：船长（曾宇）
- 写法：先说人话结论；事实 / 推断分开标

## 0. 一句话产品（结论先行）
做一个挂在 Pi 上的 harness 优化插件：模型不动，只搜「外壳」怎么配；本地反复 propose→跑题→打分→归因→留好的；证据够了才自动交 Playground 的 Harness 优化赛。它不是又一个大而全的科研系统，也不是训模型。

## 1. 问题与机会
问题：Bohrium Playground 有「Harness 优化赛」赛道——同一模型、不训练、不换模型，比谁把 Agent 外壳（loop / 上下文 / 记忆 / 工具链 / Skills）调得更强（live：BioMaster 场景 Harness 优化赛，status=open）。人手调外壳又慢又容易瞎试，需要能过夜自转的闭环。本机已有 evoK，但大量 experimental、边界糊，不适合整坨当产品。文献里 2026 已有「把 harness 当代码搜」的线（Meta-Harness / AutoSaddler / VeRO / HarnessOpt-Bench），以及「进化未必赢 test-time scaling」的警告（Rethinking Harness Evolution）。
机会：赛题分数是现成、客观的评测，比经典 autoresearch 还好闭环。把搜索空间收成「外壳零件」，做成 Pi 插件，正好贴赛规。

## 2. 赛规与硬约束（写死）
- 不训练权重：禁止 SFT/RL/GRPO 等改模型参数。
- 不换模型：优化器与被测 agent 用赛方指定固定模型（或赛方免费额度模型）；不得偷换更强底座刷分。
- 只改外壳：Agent loop、上下文策略、记忆、工具链、Skills（及与之绑定的配置/小段调度代码）。
- 不偷看 test：优化器只能见本地 dev；held-out 与线上 hidden 禁止进 proposer 上下文。
- 不无门控狂交：未过证据门，不得 playground submit。
- 预算闸：token/次数/墙钟必须可配置、可熔断。
IdeaScientist 的 GRPO 训角色禁止迁入本产品；多角色编排必须拆成独立 agent（见 §5.3），只借编排与中间产物协议，不借训参。

## 3. 目标与非目标
目标：1) Pi 运行时内以插件形态提供「外壳自优化」，并按多 agent 职责拆分；2) 对可复现本地赛题自动迭代 harness 配置，留可审计谱系；3) 达标后经证据门控调用 Playground CLI 提交；4) 证明收益不只是「多采样几次」（必须做 matched-budget 的 TTS 对照）。
非目标：不做端到端写论文；不做无边界自改优化器；不把 evoK 整仓产品化、不依赖未正式的 Chord hot-plug 当唯一发布路径；第一版只先打 Harness 优化赛。

## 4. 用户故事
船长：装好 Pi + 本插件 + playground CLI，登录赛方账号；指定固定模型 + 本地题集路径 + 预算；跑一夜（改外壳→沙箱跑题→看分和失败原因→留好丢差）；早上看到谱系图、最优配置、相对 TTS 基线对照表、是否门控提交；只改一份类似 program.md 的意图文件（预算、禁止改什么、优先优化哪类失败），不手写每轮补丁。

## 5. 系统架构
### 5.1 与 Pi 的边界
- Pi：模型路由、认证（~/.pi/agent/models.json / auth.json）、基础 runtime、skills 加载。
- 本插件（产品）：外壳配置的搜索闭环、本地评测协议、归因、谱系、证据门控、对接 playground 提交。
- Playground：真赛题、真打分、排行榜。
- evoK（可选依赖）：仅借「沙箱执行 + 提交/证据」相关代码思路或薄封装；不是产品壳。
实现路径分阶段：MVP=独立 npm/bun 包 + CLI，进程内调 Pi SDK / 子进程调 playground（不绑 Chord）；V1=按 Pi 0.86 插件惯例打包（可参考 evoK chord.facets 形状），文档标明 Chord hot-plug 若未正式则以静态加载插件为准；不把 evok-platform/evok-research experimental pilot 当生产依赖。
### 5.2 六模块（闭环）
题库探针 → 候选生成器(Proposer) → 沙箱执行 → 评分+归因 → 选择器 → 证据门控提交；旁挂 谱系/全历史 FS/EvoDAG。
1) 题库探针：playground task list/download（或本地镜像题）拉题；切 dev（优化器用）与 held-out（只在里程碑评估，优化器不可见）。
2) 候选生成器 Proposer：输入=当前最佳配置 + 原始 traces + 归因摘要 + 变更历史（全历史 FS，对齐 Meta-Harness）；输出=动机化结构化 patch（对齐 AutoSaddler，改哪个零件、为什么、预期修哪类失败）；禁止无动机随机改。
3) 沙箱执行器：隔离跑「当前 harness + 固定模型」；超时/熔断；落盘 trace/产物/日志；优先复用 evoK execution/沙箱薄封装，跑不通则干净容器自研最小沙箱。
4) 评分+归因：标量=题集 Pass/赛方分数代理；归因类别（最少）：超时、空转循环、工具误用、上下文溢出/丢证据、技能未触发、格式不合格；Proposer 必须能读 raw trace。
5) 选择器：默认贪心留/回滚 + dev 泛化门；维护线性谱系；V1 升级 Pareto（准度 vs 成本）或浅 EvoDAG；任何 dev 涨 held-out 掉→拒绝晋升。
6) 证据门控提交：对齐 evoK「证据所有、失败关闭」；缺证据不交；调 playground submit（flags 以赛方题面为准，未定时只实现接口与干跑）。
### 5.3 多 Agent 拆分（船长拍板：要拆）
外环不是一个全能 agent 串着干，而是 Orchestrator + 若干专职 agent，中间产物 schema 固定、禁止串台。
Agent 清单（只干什么 / 禁止 / 输入 / 输出落盘）：
- Orchestrator：调度、管预算、推进状态机、决定下一轮谁上场 | 禁止自己改 harness、自己打分放行 | 输入 预算+当前谱系指针 | 输出 run_state.json、调度日志。
- Gap Finder：读 traces 归纳失败模式/共享缺口 | 禁止提具体补丁、提交 | 输入 当前/历史 traces | 输出 gaps.md + gaps.json。
- Innovator：按缺口提动机化结构化 patch | 禁止跑沙箱、改 held-out、提交 | 输入 gaps + 全历史 FS + 当前 config | 输出 patch.json（零件、动机、预期修哪类失败）。
- Runner（可非 LLM）：沙箱执行候选 harness | 禁止改配置语义、放行提交 | 输入 候选 config + dev 题集 | 输出 traces、原始分、资源用量。
- Reviewer：dev 门、回归、held-out 守门、对照 TTS 是否达标 | 禁止自己写补丁救场 | 输入 本轮结果+基线 | 输出 review.json（accept/reject+理由）。
- Report Writer：变更说明 + 提交证据包 | 禁止改分数、绕过门控 | 输入 已 accept 谱系节点 | 输出 evidence_pack/（固定 schema）。
- Submitter（可非 LLM）：仅在证据门全绿时调 playground submit | 禁止缺证据提交 | 输入 evidence_pack | 输出 提交回执/失败原因。
GRPO/任何训参角色：不做。
协作规则：1) 单写者（每个落盘产物只有一个 agent 可写，其它只读）；2) Reviewer 一票否决（Innovator reject 后不得直接再交同一 patch 刷分，须经 Gap Finder 更新缺口）；3) Orchestrator 不命题（只传 gaps 与预算，不替 Innovator 做主）；4) Runner/Submitter 默认工具型（优先确定性脚本，需 LLM 解释时另开只读旁路，不赋写配置权）；5) 同一固定模型（所有 LLM agent 共用赛规白名单模型，禁止审稿用更强模）。
一轮状态机：Orchestrator → Gap Finder(出 gaps) → Innovator(出 patch) → Runner(跑 dev) → Reviewer(accept?)；reject→回 Orchestrator 记谱系失败节点；accept→Report Writer(证据包)→(门全绿?)Submitter : 停在本地最优。
与单循环关系：逻辑上必须多 agent（职责隔离、可审计、可单测每一角）；部署上可同进程多角色调用，但提示词、工具集、写权限必须分开，禁止合成超级 agent 提示。

## 6. 搜索空间（外壳零件）
Agent loop（ReAct/plan-exec、反思次数、循环熔断、最大步数）；上下文（压缩/摘要触发、分块、注入顺序、系统提示切片）；记忆（开关、写什么、召回近因/相关/重要）；工具链（工具集、描述、错误回灌、输出截断）；Skills（题型 skill 文本与触发条件）。MVP 先枚举+小配置；V1 允许受限代码级变异（仍禁止改模型与评测器）。

## 7. 闭环算法：文献组合
最小外环=Karpathy autoresearch（改→固定预算跑→比指标→留/回滚，指标换赛题分）；工程壳=VeRO（版本化、预算闸、结构化观察、validation commit）；归因与补丁=AutoSaddler（诊断→结构化 patch→验证→耐久更新）；优化器上下文=Meta-Harness（文件系统全历史 代码+分+trace）；编排=IdeaScientist 三角色中间产物协议（不迁 GRPO）；方法论护栏=Rethinking（强制 matched-budget TTS 对照）。明确不作主路径：AI Scientist 写论文、DGM/Gödel 无边界自改、纯 OPRO 只改提示。
默认一轮伪代码：while budget_left: failures=attribute(best.traces); patch=propose(best.config,failures,history_fs)(必须带动机); cand=apply(best.config,patch); result=sandbox_run(cand,dev_set,fixed_model); if pass_dev_gate(result,best) and not regress(heldout_smoke): commit(cand);update_history_fs() else rollback(patch); submit_if_evidence_gate(best).

## 8. 评测协议
1) 数据分裂 dev（可迭代）/held-out（里程碑才跑，不得进 proposer）；2) 主指标 题级 Pass 或赛方分数代理，辅 步数/超时率/工具误用率/token；3) 归因覆盖率 每条失败 trace 至少一个归因标签；4) 对照实验（P0 护栏）同模型同总调用预算，纯 TTS（更多独立尝试/多数票）vs 本插件优化后单配置，打不过 TTS 不得宣称 harness 进化有效；5) 可重复 固定种子/镜像/配置落盘/trace 落盘。

## 9. 提交与证据门控（草案，赛题面落地后可改阈值）
提交前必须同时满足：固定模型 ID 与赛规一致（写死校验）；held-out 不低于约定门槛（或相对基线 +Δ）；存在完整 trace 包与变更说明；通过 TTS matched-budget 对照（或明确标记未跑对照、禁止自动交）；预算与提交次数未超限；干跑 playground submit --dry-run（若支持）成功。任一不满足→fail-closed，只写本地报告，不交。

## 10. 与 evoK 的关系
可复用（薄封装/抄协议）：沙箱/execution（src/execution/）、证据与提交门控思路（docs/contest-auto-submit.md、evidence、SubmissionBroker 精神）、local-file-evaluator 类离线评测器、「绝对路径 --project、凭证只走 Pi」运维纪律。明确丢弃/不依赖：把 Mission/编排/多 chord 座位揉成一团的产品叙事、未正式 Chord hot-plug 作唯一加载路径、宽泛 DAG 默认职责、任何可训练/可换模型刷分路径。一句话：evoK 是零件店，不是车身。

## 11. 里程碑
MVP：独立包+CLI（harness-opt run --dev … --budget …）；五角已拆开（Orchestrator/Gap Finder/Innovator/Runner/Reviewer，Report+Submitter 可先 stub）；各角独立提示词与写权限、中间产物 schema 固定可单测；固定模型、配置 JSON/目录可 diff；贪心留/回滚、全历史目录（config/score/trace）；五类归因标签至少可用；本地假题集能过夜≥N 轮并产出谱系报告；提交模块接口+dry-run、真提交默认关。V1：Pi 插件静态加载；对接 playground 拉题/提交；held-out 守门+TTS 对照报告自动生成；结构化 patch 分类；证据门控自动提交可开（默认仍需船长确认）。V2：Pareto/浅 EvoDAG 选留；受限代码级变异+更强诊断；多题型 skill 库与自动开关；配额感知调度。

## 12. 风险与护栏
分来回跳→动机化 patch+dev 门+谱系回滚+禁止无 trace 优化；过拟合 dev/奖励黑客→held-out+禁止 test 泄漏+提交前对照；进化不如多采样→强制 matched-budget TTS 基线；预算烧光→VeRO 预算闸+熔断+日额度感知；赛规/题面变更→适配层+Open Questions+自动提交默认关；误训/换模→CI/启动校验拒训练 API、校验 model id 白名单；evoK 缠死→插件零硬依赖 evoK 启动、复用代码 vendoring 或可选 adapter。

## 13. Open Questions（对照 live 题面）
已核实（2026-10-18 19:36 JST，来源 play.bohrium.com biomaster-harness-optimization-4f6eec24，status=open）：1) 评分=每题归一化 reward 等权平均×100，先按分降序、同分按 token 费用之和升序，失败题记 0；2) 提交次数=当前暂定每人每天最多一次；3) 模型=可选 DeepSeek/GLM/MiMo/MiniMax/Qwen API，权重不属本赛修改范围（选模型可以、训参不行），额度每人 ¥1,000 token；4) 提交物=可运行镜像（含最终 Harness+Skills），目录含 image.json/Dockerfile/README.md/memo.json/可选 build/，Pi 被点名为可用 Harness 之一；5) 赛包 harness_rc3.zip，开发集-I/II + 隐藏 A/B 评测集。未锁：赛季结束时间与是否用 B 集定名次；Pi 插件官方推荐形态（skill/extension/Chord facet）；本地缓存 practice 题版权；AutoSaddler 是否开源可用；『不换模型』需收窄为『不训权重、API 白名单内可选模型』（等船长点头再改 §2 措辞）。

## 14. 成功指标
本地有效性=held-out 相对默认 harness 的 ΔPass/ΔScore；非刷参=同预算下击败或持平纯 TTS；归因质量=≥X% 失败 trace 有归因+抽检一致率；工程可靠性=过夜崩溃率+误提交=0；赛场=排行榜名次/分数+合规自动提交成功率。阈值 MVP 跑通后由船长拍板。

## 15. 下一步
拉 Harness 赛正式题面填 Open Questions；开 MVP 骨架（独立于 evoK）先假题集跑通留/回滚；摸清 Pi 稳定插件 API 定 V1 加载方式；可选同步进飞书文档。

## 附录 关键文献
Meta-Harness arXiv:2603.28052；AutoSaddler 2608.23041；VeRO 2602.22480；HarnessOpt-Bench 2608.06301；Rethinking Harness Evolution 2607.12227；IdeaScientist 2610.04074；karpathy/autoresearch(github)。
