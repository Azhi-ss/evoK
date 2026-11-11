---
status: m1-delivered
version: 0.2
---

> 落位说明（#242 M-a）：Research Memory 的物理位置现为 `src/memory/`
> ([ADR-0016](adr/0016-memory-physical-pack.md))；存储引擎（SQLite 主存）与
> `memory_read` 服务通道由 [memory-subsystem-prd.md](memory-subsystem-prd.md)
> 决定，本文的 M1 设计不再代表当前存储方案。

# evoK Long-term Research Memory PRD

> 目标：让 evoK 在长时间、多方向的比赛研究中，维护“现在研究到了什么阶段、哪些解释仍在竞争、旧结论何时失效、下一步怎样区分它们”，而不只是记住哪些 Experiment 曾经运行过。
>
> 参考：董锦汉《假设森林｜让下一次研究，有枝可循》及一轮外部 ChatGPT 架构评审。本文将“条件化假设谱系 + 只追加记录 + 审查合并 + 固定快照有界检索”映射到 evoK 现有 Mission / Evidence / MemorySlice 架构，而不是复制一个独立产品。

## 0. 文档状态与设计决策

本文是共同设计的 PRD，不是实现授权，也不改变现有 ADR、Promotion、Admission、Budget、hang/T48 或 External Submission 语义。

**M1 已交付**（单 Mission、跨 Run；parent spec #209，tickets #210–#218 全部关闭）。M2 跨 Mission Transfer Candidate 尚未开始，且按 §11 要求须先证明 M1 收益超过其额外决策成本。

| ID | 决策 | 当前建议 |
| --- | --- | --- |
| D1 | M1 边界 | **只做单 Mission、跨 Run**。跨 Mission 是 M2，不提前引入 |
| D2 | Memory 的核心职责 | **研究状态延续**：Hypothesis 谱系、竞争解释、条件化 Finding、Pitfall、Unknowns 和下一验证建议 |
| D3 | 长期记忆是否保存 transcript | 否。继续遵守 ADR-0001；fresh session 与持久研究资产并存 |
| D4 | Memory 如何影响 Director | 采用 Memory-blind Proposal → Memory-informed Revision；不引入新的 Utility 公式或 Search authority |
| D5 | Memory Synthesis 的权威 | 只能是可审计的解释性 Proposal；Deterministic Projection 与 Verified Claim 分开 |
| D6 | 存储与检索 | 项目本地 typed events + immutable snapshots + deterministic scoped retrieval；不引入 Neo4j/向量库 |
| D7 | 反方向坍缩 | 不设置固定探索配额；必须保留 Blind Proposal、Rejected-direction Audit 和 Diversity Monitoring |
| D8 | 跨 Mission 迁移 | M2 仅作为 Transfer Candidate 来源；相同 Contract digest 不是科学适用性的充分条件 |

## 1. 背景与现状

### 1.1 比赛中的问题

一个 Competition Mission 可能同时尝试特征工程、模型结构、训练策略、数据清洗、集成和后处理。当前每个 Run 都是 fresh session，保证了隔离与审计，但也带来：

1. 新 Run 容易重复另一个 Branch 已经否决的方向。
2. Candidate 被淘汰后，失败原因和适用条件没有稳定进入后续选点。
3. 实验列表不能表达方向之间的细化、竞争、替代、反驳和迁移关系。
4. 系统只保留“发生了什么”，缺少“当前研究到了什么阶段、下一步应区分什么”。
5. 把所有历史塞进 prompt 会造成上下文膨胀、旧叙事污染、数据泄漏和不可复现。

evoK 缺的不是持久聊天，而是**可审查、可演化、有适用边界的长期研究状态**。

### 1.2 现有能力

| 现有能力 | 位置 | 已解决 | 缺口 |
| --- | --- | --- | --- |
| Mission / event / snapshot recovery | `src/mission/`、`docs/adr/0004...` | Mission 持久化、恢复、重放 | 主要服务当前 Mission，不是研究状态投影 |
| Evidence / Finding / Negative Evidence / Pitfall | `src/mission/research-loop.ts` | 类型、scope、证据引用、基本搜索 | 缺少当前研究状态、生命周期和默认决策注入 |
| Hypothesis / KillTest ledger | `src/evidence/hypothesis-ledger.ts` | Hypothesis 状态和 append-only events | 当前 store 是 in-memory，缺少持久研究连续性 |
| ClaimCard / objections | `src/predict-reconcile.ts` | 预测、状态和反对意见 | 缺少 applicability、竞争解释和下一判别实验的完整投影 |
| MemorySlice / MemoryProvider | `src/execution/memory-slice.ts`、`context-broker.ts` | 引用优先、敏感字段拒绝、Run/agent 绑定、digest 审计 | provider 是可选 seam，没有默认 durable provider |
| MemoryWriteProposal / AgentResult | `src/execution/memory-slice.ts` | agent 可提议，不可自行生效 | 缺少完整性校验、版本化和 snapshot projection |
| fresh child session + child-bound slice | `src/execution/subagents-adapter.ts` | 不继承父 session，父子记忆不可错绑 | 需要由真实 provider 为 child 生成新 slice |
| Director trusted projection | `src/mission/mission-director.ts` | 每次基于当前 measured evidence 决策 | 当前输入不含 Research Memory projection，也无法审计 Memory 改变了什么 |

**结论：** 不另造事实数据库、transcript memory、第七个功能包或第二个 Mission 状态模型。真正需要新增的是：

- **Memory Synthesis**：从权威记录形成可审计、条件化的研究状态提案；
- **Memory Lifecycle**：让研究状态随新证据和条件变化而演化、降级和重验；
- **Memory Decision Integration**：将研究状态安全地交给 Director，并审计其实际影响。

## 2. 产品定义

### 2.1 Research Record 与 Research Memory

- **Research Record**：Experiment、Evidence、Artifact、Candidate、Run Outcome 等原始权威记录，回答“发生了什么”。
- **Research Memory**：引用 Research Record 的版本化研究投影，回答“当前研究处于什么状态，哪些问题仍未解决，下一步有什么验证建议”。
- **Search Retrieval**：按当前问题找到相关记录或投影；它本身不维护研究状态。

如果删除 Memory 后，系统只是少了一批可以重新搜到的旧实验，而没有丢失任何研究状态、竞争关系或下一验证结构，就说明这层 Memory 没有产生独立价值。

长期记忆分三层：

| 层 | 生命周期 | 用途 |
| --- | --- | --- |
| Run Working Context | 一个 Run | 当前 Pi session 的 model/tool context；结束即 dispose |
| Mission Research Memory | 一个 Mission，跨 Task / Branch / Run | M1 核心；维护研究状态和方向连续性 |
| Competition Research Memory | 同项目、同 Competition，跨 Mission | M2；只作为待兼容性检查和当前 Mission 重验的 Transfer Candidate 来源 |

**Hypothesis Forest** 是 Research Memory 中 Hypothesis、竞争、细化、反驳和迁移关系的一种阅读视图，不是新的 mainline。

### 2.2 三个必须分开的属性

1. **Applicability**：在什么 Task、Objective、Evaluation、Dataset、Method、Runtime 和 Contract 条件下，这条结论能作为直接先验。
2. **Visibility**：哪个 Mission、Role 和 agent 可以读取；适用不等于获准读取。
3. **Evidence / Epistemic Status**：proposed/supported/contested/refuted 等科学状态，与记录是否完整、是否被存储、是否仍适用分别处理。

相同 Competition + Contract digest 只允许进入共享候选，不证明科学适用。不同 digest 默认不共享，未来只能显式进入 Transfer Candidate；人工迁移不等于自动继承。

### 2.3 三个权威层次

| 层次 | 产生方式 | 权威边界 |
| --- | --- | --- |
| Deterministic Projection | Controller 根据权威事件确定性重放 | 结构、身份、血缘和已记录状态可重放；不创造新科学解释 |
| Synthesis Proposal | Agent / Director 提交条件化解释 | 未验证解释；只能以 proposed 身份保存 |
| Verified Claim | 走现有 Evidence / Claim / Experiment Validity 规则 | 现有规则认可的结论；Memory 不另开状态通道 |

Controller 接受 Proposal 进入存储，只表示结构和引用完整性通过，不表示科学认可。

```text
proposal_integrity_status: accepted_for_storage | rejected
epistemic_status:          proposed | supported | contested | refuted | ...
```

这两个状态不得合并，也不得使用容易误导的 `controller_approved_synthesis`。

## 3. 目标与非目标

### 3.1 M1 目标

- G1：同一 Mission 的新 Run 能获得与当前 Task 有关的 Hypothesis、竞争解释、Finding、Negative Evidence refs、Pitfall 和 Unknowns。
- G2：Memory 的独立价值体现为研究状态、适用边界和下一验证建议，而不是 Experiment/Evidence 的第二份存储。
- G3：每条投影都能回到 source Mission/Task/Run、Evidence/Artifact refs 和固定 snapshot。
- G4：Director 的 Memory-blind 与 Memory-informed 提案均被保存，能够审计 Memory 改变了什么。
- G5：Researcher 和 subagent 使用同一快照的 Run/agent-bound 有界视图；Evaluator 默认不看 Memory。
- G6：研究状态可以 active/provisional/contested/stale/superseded/withdrawn，旧事实保留但旧结论不永久生效。
- G7：可以通过离线 replay 和在线 on/off 对照验证收益，同时观察方向坍缩和错误记忆影响。

### 3.2 M1 非目标

- 不做跨 Mission / Competition Research Memory。
- 不做跨 Run 持久 Pi conversation，不恢复 transcript。
- 不引入显式 `U0 + λM − μD + γV`、新的 Search math 或固定探索配额。
- 不做后台、自主、自动提交的 LLM Memory Synthesis。
- 不让 Memory 直接修改 Skill/Method、Search authority、Promotion、Admission、Budget 上限或 Submission。
- 不删除或合并现有 Negative Evidence、Run Outcome 等领域对象。
- 不新增 Forest Manager、standing agent roster、Neo4j、向量库或 HTML Forest UI。

## 4. 核心场景

### S1：历史记录转化为研究状态

R1 支持“Kernel 是瓶颈”，R2 的 restart 无效但不能反驳它，R3 的 acquisition 变差却处于不同条件。Memory 不只返回三条分数，而是保留两个竞争 Hypothesis、各自证据边界和“固定其他条件，只改变 acquisition”的下一判别实验建议。

### S2：失败方向不被无意重复，也不被永久封死

相同条件下的无效结果进入相关 Hypothesis 的 Negative Evidence 视图；换 split、metric 或数据版本后，该结论按 applicability 降级，而不是泛化为“任何情况下都无效”。

### S3：基础设施失败不变成科学反证

OOM/Timeout 保留原始 Run Outcome，可以形成带硬件和配置条件的 Operational Pitfall，但不得自动产生针对 Hypothesis 的科学 Negative Evidence。

### S4：Memory 改变选择但不能消灭竞争解释

Blind Proposal 选择验证 H2；Memory Packet 显示 H1 支持较多但也有未解决反证。Revised Proposal 可改选 H1，但必须保留 H2、原 Blind Proposal、影响它的卡片和理由。H2 未执行的结果是 `unobserved`，不是失败或 regret。

### S5：重复实验具有复现价值

历史实验存在不等于禁止重复。更换随机种子、关键消融或验证竞争 Hypothesis 可能是高价值 replication；只有已有证据充分且预期信息价值低时，Director 才应降低重复实验优先级。

### S6：subagent 获得自己的切片

父 agent 委托子任务时，从同一快照生成 child-bound MemorySlice。父/sibling/旧 Run slice 被直接转交时 fail closed；child 仍是 fresh session。

## 5. 产品原则

1. **Records are authoritative; Memory is a projection.**
2. **Proposals are interpretations; they are not verified findings.**
3. **Memory informs decisions; it does not authorize actions.**
4. **Snapshots are reproducible; historical conclusions are not permanently applicable.**
5. **Cards may compose; authoritative domain types do not merge.** Negative Evidence 可以在 Hypothesis Card 中展示，但仍是独立 Evidence 类型。
6. **Scope before similarity.** 先 visibility/applicability 硬过滤，再相关性和多样性排序。
7. **Preserve the counterfactual proposal.** Memory 介入前的 Blind Proposal 不可覆盖。
8. **No autonomous background synthesis.** Agent/Director 可在研究过程中提交结构化 Proposal，系统不偷偷生成第二事实源。

## 6. 信息模型

### 6.1 复用现有领域对象

规范记录来自现有对象或其版本化投影：

- Hypothesis / ClaimCard / KillTestPlan
- Experiment / Candidate / Snapshot ref
- Evidence / Finding / Negative Evidence / Pitfall
- Run Outcome / Experiment Validity
- 已 Admission 的 Method/Skill 仅作为带版本引用；Memory 不执行 Admission

现有 `MemorySlice.facts` 可保留兼容性，但自由文本 facts 不得成为长期科学结论的权威载体。

M1 只需要三种**阅读卡片**，不是三种新权威实体：

| 阅读卡片 | 聚合内容 |
| --- | --- |
| Hypothesis Card | 条件化 claim、支持/反证 refs、竞争解释、unknowns、下一判别实验建议 |
| Finding Card | 已有证据支持的条件化结论、适用范围、限制和生命周期 |
| Pitfall Card | 基础设施、配置、协议和重复失败模式及规避建议；科学/工程原因分开 |

### 6.2 最小公共信封

| 字段组 | 内容 |
| --- | --- |
| Identity | memory/card id、schemaVersion、kind、revision、digest |
| Namespace | M1 固定为 mission + missionId；snapshotId |
| Content | 原领域对象 typed refs + 有界 summary；不是原始事实副本 |
| Applicability | 按 claim 需要选择 task_scope、objective、evaluation_protocol、dataset_version、method/configuration、runtime、contract_digest |
| Visibility | M1 为 mission-only + Role policy；无 global |
| Provenance | source mission/task/run、source agent/role、evidence/artifact refs、createdAt |
| Integrity vs epistemic state | proposal_integrity_status 与 epistemic_status 分开 |
| Lifecycle | active/provisional/contested/stale/superseded/withdrawn、invalidation_conditions、revalidation_required |
| Lineage | derivedFrom、supersedes、必要关系 refs |

Applicability 是 claim-specific 的：OOM Pitfall 可能需要 GPU 和 batch size，不需要 Objective；泛化 Finding 可能需要 dataset/evaluation/method，不需要 GPU。M1 不建立统一、臃肿的八维 Context Fingerprint。

### 6.3 最小关系集合

- `DERIVED_FROM`
- `SUPPORTS` / `CONTRADICTS`
- `COMPETES_WITH`
- `SUPERSEDES`
- `TRANSFERS_TO`：M2 才使用，语义为 Transfer Candidate，不表示迁移成功

不使用无边界的 `RELATED_TO`。树形层级只是阅读投影，底层允许竞争和迁移关系。

### 6.4 融合与状态推进

1. 同 Run、同 operation 重放幂等。
2. 等价 Hypothesis 优先 revision 或显式去重，不能无限生成同义节点。
3. 同条件冲突保留双方和 Evidence，不执行 last-write-wins。
4. 条件不同则并存；局部反例不得覆盖其他条件。
5. Agent 不得自行把 proposed 改为 supported/refuted；状态变化仍走现有证据规则。
6. `next_discriminating_experiment` 永远是建议，不是事实或自动可执行 Action。

### 6.5 生命周期与失效

历史事实不删除，历史结论可降级。数据、目标、评估协议、方法或运行条件发生关键变化时，新的 Snapshot 必须把受影响投影标为 stale 或 revalidation_required，而不是继续当作 active 直接先验。

- Agent 可提出 contested/stale 建议；Controller 只按明确事件和规则生成新投影。
- `withdrawn` 只阻止未来读取该投影，不删除原 Evidence，不篡改历史 Snapshot。
- Append-only 回答“历史上记录了什么”，不回答“今天仍该怎样使用”。

## 7. 写入与 Snapshot 流程

### 7.1 双通道写入

```text
Channel A: automatic record index
Experiment / Evidence / Run Outcome
  → trusted controller 自动索引 ID、revision、provenance
  → 不为每条记录自动生成 Memory Card

Channel B: research-state proposal
Agent / Director MemoryWriteProposal
  → identity/schema/sensitive/ref/applicability 校验
  → dedupe + conflict + evidence-state checks
  → accepted_for_storage 的未验证解释
  → 不自动升级为 Verified Claim

权威事件 + accepted proposals + existing claim rules
  → deterministic projection
  → next immutable Memory Snapshot
```

要求：

- Controller 能验证引用存在、身份和权限，但不能据此证明引用真的支持某个解释。
- Synthesis Proposal 必须包含 supporting refs、contradicting refs、unknowns 和 applicability；没有反证时也要明确写 unknown，而非假装不存在。
- 科学证据与 Operational Evidence 分开；OOM/Timeout 不能自动进入科学反证状态机。
- 敏感内容在提交前拒绝，拒绝记录不得包含敏感正文。
- M1 不运行后台自主 LLM Synthesis；只允许实际研究过程中的结构化 Proposal。

### 7.2 M2 跨 Mission 预告（不在 M1 实现）

```text
Competition Memory
  → Candidate Transfer Source
  → Context Compatibility Check
  → Transfer Proposal
  → Current Mission Revalidation
  → Current Mission Local Evidence
```

跨 Mission 记录首先是候选知识来源，不自动成为当前 Mission 的 Finding。相同 Contract digest 不是充分条件；不同 digest 不进入默认共享。

## 8. 检索与 Director 决策协议

### 8.1 Research Decision Packet

```text
Task Contract + Role + Mission State + Memory Policy
                         │
                         ▼
        pin ledger/memory/retrieval-policy revisions
                         │
                         ▼
          visibility → applicability hard filters
                         │
                         ▼
       deterministic ranking + diversity + hard token cap
                         │
                         ▼
              Research Decision Packet + refs
```

Packet 不是“最相似卡片列表”，至少按需要覆盖：

- Relevant Findings
- Contradicting Evidence refs
- Competing Hypotheses
- Known / Operational Pitfalls
- Open Questions / Unknowns
- Proposed Next Validation

竞争 Hypothesis 和反面证据必须有独立展示位置，不能因历史支持数量较少而被挤出。省略数量必须可见。历史重复只提供 replication-value 判断材料，不自动 reject。

每次读取固定：ledger revision、memory revision、retrieval policy version、query context、visibility/applicability policy 和 token budget。详情由 trusted broker 在同快照、同权限下按 ID 回取。

### 8.2 Two-stage Director Decision Protocol（M1 核心）

不引入新 Utility 公式、不增加新控制角色。

#### Stage 0 — Pin

固定当前权威状态、Memory Snapshot、检索策略和可见性边界。

#### Stage 1 — Memory-blind Proposal

Director 使用现有 Mission State、当前可见 measured evidence、原工具和原规则提出 bounded next action。

- **Memory-blind 不等于 History-blind**：Stage 1 仍读取当前 Director 原本可见的 measured evidence；它只是看不到持久 Research Memory 的研究状态投影。
- Blind Proposal 必须在任何 Memory Card 展示前冻结并持久化。
- 原 Search / Experiment 流程不变。

#### Stage 2 — Memory-informed Revision

Director 读取 Research Decision Packet，可以维持、重排、替换或撤回 Blind Proposal，并说明原因。

- 新候选仍需通过现有 Search / Action 流程生成和验证。
- Memory 不得直接产生绕过权限的可执行 Action。
- Controller 按原有权限、预算、Search authority、Admission 和 Action Validity 规则验证 Revised Proposal。

至少保存：

```text
decision_id
blind_proposal + blind_proposal_revision
memory_snapshot_id + memory_card_refs
revised_proposal
decision_delta: unchanged | reordered | replaced | withdrawn | expanded_via_existing_search
revision_reason
rejected_alternatives
controller_validation
model/tool/cost usage for both stages
```

两个阶段的模型版本、原始上下文和工具权限必须固定；不得事后重生成“Blind Proposal”。若实现为两个 priced decision Runs，两者都必须按现有预算规则计量，不能将第二次思考免费记到 Memory 上。

### 8.3 Exploration Accountability

M1 不设置固定 Memory-blind Exploration 配额，但必须有：

1. Blind Proposal Preservation；
2. Rejected-direction Audit；
3. Hypothesis Diversity / Branch Coverage Monitoring。

当连续多个 Run 出现 Memory 持续改写 Blind Proposal、同一 Hypothesis 长期占据资源、竞争解释反复被排除且没有新判别证据时，触发一次方向集中审查。审查只要求重新评估，不强制选择某个探索方向，阈值不硬编码为固定比例。

### 8.4 角色视图

| 消费者 | 读取方式 | 限制 |
| --- | --- | --- |
| Mission Director | 上述 Two-stage Protocol | Memory 可影响建议，不获得额外审批权 |
| Researcher | 默认 MemoryProvider → ContextBroker → Run-bound MemorySlice | 遵守 RoleTaskContext、rule visibility、allowedPaths 和敏感字段限制 |
| Critic / Falsifier / Reviewer | 同快照下获取相关 claim、objection、counterexample 和 refs | 不读其他 agent transcript，不接受作者自报为事实 |
| Subagent | 从同快照生成 child-bound slice | 禁止复用 parent/sibling identity 或 slice |
| Evaluator | 默认不读取 Research Memory | 避免研究叙事污染独立测量 |

每个 Run 记录收到的 snapshot id、slice digest、卡片 ids 和详情 refs，保证可复现。

## 9. 存储、恢复与安全

### 9.1 存储与恢复

- 项目本地生成目录建议为 `<project>/.evok/memory/`，默认不入 Git；不得写入凭证。
- Mission 原始记录仍在 `.evok/missions/<mission-id>/`；Memory 保存投影和 refs，不复制整套 artifact。
- v1 使用 typed append-only events、immutable snapshots 和 active pointer；图数据库不是前提。
- reader 固定完整 snapshot，active pointer 原子切换；crash 不得暴露半提交状态。
- sequence gap、digest mismatch、未知 schema 必须 fail closed，不能返回“空记忆”。
- Memory projection 损坏时可从权威记录和 accepted proposals 重建；重建必须保持 refs/digests 一致。

### 9.2 比赛隔离

- 默认 namespace 是 project + mission；M2 才增加 project + competition，不做用户全局记忆。
- scope/applicability 不能替代 visibility。
- hidden data、holdout、private leaderboard、凭证、raw rule bodies、global/Mission budget 和 transcript 继续禁止进入 agent memory。
- 除字段名检查外，还需检查 summary/value 中的 secret 和敏感数据；只禁止名为 `holdout` 的 key 不足以防止正文泄漏。
- source 中最严格的可见性约束由派生记忆继承，projection/publication 不得自动放宽。
- 用户可关闭 Mission 的长期读取或 retract 投影，不影响原始 Evidence。

## 10. 功能需求与优先级

### P0 — 单 Mission、跨 Run 闭环

- F1：自动索引当前 Mission 权威 Experiment/Evidence/Run Outcome 的 ID、revision 和 provenance。
- F2：支持 Hypothesis/Finding/Pitfall 三种阅读卡片及 Deterministic Projection、Synthesis Proposal、Verified Claim 三层边界。
- F3：提供默认 durable MemoryProvider，为每个候选 Run 生成 scoped MemorySlice。
- F4：实现 Two-stage Director Protocol、结构化 decision_delta 和双阶段成本审计。
- F5：实现 MemoryWriteProposal 完整性校验、版本化、失效/降级和 deterministic snapshot replay。
- F6：保留 Negative Evidence、Run Outcome 等权威类型；实现 Scientific/Operational 阅读区分。
- F7：保留 subagent child-binding、Evaluator 不读 Memory 和敏感内容 fail-closed。
- F8：实现 Blind Proposal Preservation、Rejected-direction Audit、Diversity Monitoring 和触发式方向集中审查。
- F9：提供只读检查：active snapshot、记录数、来源、生命周期和拒绝原因；不提供 memory 控制面。

### P1 — 同 Competition 跨 Mission（设计完成后再排期）

- F10：Transfer Candidate、Context Compatibility、当前 Mission 重验和本地 Evidence 化。
- F11：Contract 变化时禁止默认共享；人工迁移不自动继承。
- F12：跨 Mission publication、固定 Competition snapshot 和只读导出。

### P2 — 验证后再扩展

- F13：Forest 阅读视图、研究缺口排序、受控详情回取增强。
- F14：明确授权的跨 Competition transfer，仅限 answer-agnostic 且策略允许的内容。
- F15：在确定性基线之后评估 embedding/semantic retrieval；语义相似不能绕过硬过滤。

## 11. 评估设计与成功指标

### 11.1 正确性与安全门槛

- 100% 已提交投影具有 source refs、applicability、visibility 和 snapshot lineage。
- 100% Verified Claim 仍通过现有 Evidence 规则；`accepted_for_storage` 被当作 verified 的数量为 0。
- parent/child/sibling slice 错绑接受数为 0；敏感内容写入为 0。
- 同一输入可重放到相同 snapshot/digest；损坏存储不得静默变空。
- Memory 不改变任何现有 Promotion/Admission/Budget/hang/Broker gate 语义。

### 11.2 三组对照

| 组 | 输入 | 用途 |
| --- | --- | --- |
| A — Memory Off | 原 Director/Run context，无 Research Memory projection | 基线 |
| B — Schema-only Sham | 相同卡片结构、字段说明和中性占位，不提供研究事实、refs 或方向建议 | 估计格式和额外上下文影响 |
| C — Real Memory | 真实、经 visibility/applicability 过滤的 Research Decision Packet | 实际处理组 |

- C vs A：实际 Memory 系统的整体增益。
- C vs B：研究内容相对于结构/额外上下文的增量。
- B vs A：格式和额外上下文本身的影响。

Sham 不得包含虚构结论或其他 Mission 的误导性经验。不存在长度、语义信息量和决策相关性完全相同的完美 Sham，因此 B 只是辅助对照，不能作为唯一因果证明。

三组必须控制模型版本、system prompt、工具、Experiment/GPU/LLM/retry/evaluation 预算、停止条件和初始状态。**两阶段 Director 的调用次数和 token 预算也必须匹配**；Memory-on 不得通过额外免费思考或更多 Experiment 获胜。

### 11.3 两类实验

1. **Offline Replay**：固定 Mission State、候选动作、Budget 和 Memory Snapshot，只改变 Memory 是否参与，观察 Blind/Revised decision divergence、低价值重复和竞争解释保留。
2. **Online Research Evaluation**：比较最终独立评估、best-so-far vs budget、单位预算有效 Evidence、方向覆盖、新 Hypothesis 发现和已知问题重复失败。

Run N 的 Snapshot 只能包含 Run N 开始前已经存在的信息，禁止未来信息泄漏。

### 11.4 指标必须避免误读

- **Useful Replication Rate**：区分无价值重复、独立种子复现、关键消融和 Hypothesis 验证，不单纯追求重复率下降。
- **Hypothesis Diversity / Branch Coverage**：Memory 若降低重复率却使假设空间坍缩，不是成功。
- **Decision Divergence**：Memory 是否改变 Blind Proposal。
- **Rejected Direction Exposure**：哪些方向因 Memory 未执行，原因和卡片是什么。
- **Observed Decision Regret**：只有后续可比实验提供反事实证据后才能评估。

被放弃候选默认 `counterfactual_status = unobserved`；未知结果不得提前称为 regret。另需记录 Memory 是否只是重复了 Director 已有 measured evidence，避免双重计数。

## 12. M1 必测验收场景

1. **跨 Run 新鲜执行**：后续 Run 使用 fresh session，获得有界研究状态和 refs，不含旧 transcript。
2. **真正的 Memory 增量**：Blind 阶段保留原 measured evidence；Memory Packet 提供的是竞争关系、条件化状态和下一验证结构，而非简单重放旧分数。
3. **相同 Contract 但 Finding 不适用**：历史 Kernel Finding 基于 dataset=v1/AUPRC/5-fold，当前为 v2/Latency/holdout；即使 Contract digest 相同，也只能作为 analogical hint，不得改变当前 Claim 状态。
4. **OOM 不等于反证**：大模型 Run OOM 后保留 Run Outcome，可形成带 GPU/batch 条件的 Operational Pitfall，但 Hypothesis 不得被 refuted。
5. **Memory 不得消灭 H2**：Blind 选择 H2、Revised 改选 H1 时，两个 Proposal、E-contradicting refs 和 H2 均保留；H2 结果为 unobserved。
6. **Proposal 不是科学背书**：仅因 supporting refs 存在，Synthesis 不得成为 Verified；integrity 与 epistemic 状态独立。
7. **Blind 不可事后伪造**：Memory 展示后不得重新生成或覆盖 Blind Proposal；decision_delta 和卡片 refs 必须持久化。
8. **无新 Search authority**：Memory 提议的新动作若绕过现有 Search/Controller 验证必须被拒绝。
9. **有价值重复不被误杀**：换 seed 或关键消融不得仅因“实验已存在”被自动拒绝。
10. **过期降级**：dataset/objective/evaluation 关键变化后，旧结论在新 Snapshot 中为 stale/revalidation_required，而非 active。
11. **成本诚实**：两个 Director 阶段均计量；on/off 评估匹配决策调用与预算。
12. **subagent 隔离**：child 获得新 identity 的 slice；父 slice 转交 fail closed。
13. **并发与恢复**：并发提交不丢失；crash 后只出现完整旧/新 Snapshot，digest 错误显式阻断。
14. **权限不变**：现有 evaluator、Promotion、Admission、Budget、hang/T48、Broker 测试保持原语义。

## 13. 分阶段交付

### M0 — 设计锁定

确认 D1–D8、术语和 P0 反例；然后再补领域词汇与必要 ADR，不在草案阶段直接修改实现。

### M1 — Persistent Research Memory Loop

```text
Pin revisions
  → Memory-blind Proposal
  → Research Decision Packet
  → Memory-informed Revision
  → Existing Controller Validation
  → Experiment / Evidence / Run Outcome
  → optional Synthesis Proposal
  → Deterministic Projection
  → next fresh Run
```

只支持 Single Mission / Cross Run。目标是证明研究状态记忆能改善后续决策，而非先建设跨 Mission 平台。

### M2 — 同 Competition Transfer Candidate

加入跨 Mission publication、compatibility、当前 Mission 重验和本地 Evidence 化，不做自动知识权威继承。

### M3 — 关系阅读与主动缺口

根据 M1/M2 对照结果增加 Forest 视图、竞争/迁移阅读和 Director 缺口排序，再决定是否需要语义检索。

## 14. Six-pack 归属建议

不新增 `memory` 第七包：

| Package | 责任 |
| --- | --- |
| evidence | typed records、append-only store、provenance、proposal integrity、snapshot 一致性；不拥有检索注入 |
| search | scoped retrieval、排序和 slicing；不拥有科学状态或 Promotion authority |
| execution | MemoryProvider、ContextBroker、MemorySlice、Role/child binding、受控详情回取 |
| mission | Two-stage Director Protocol、Memory Policy、Snapshot 生命周期；不另建控制平面 |
| competition | Contract/split/evaluator 的适用范围和 Competition 可见性约束（M2） |
| cli | 只读 inspect/export 与已有 Mission 配置入口；不成为 memory authority |

## 15. 参考与来源

- 董锦汉：《假设森林｜让下一次研究，有枝可循》，Feishu 私聊消息 `om_x100b6244a25724a0c1c443c668c5daf`。
- 原始消息链接：<https://applink.feishu.cn/client/chat/open?openChatId=oc_3d846d31a646e31c94a4d8d05ff75b08&position=13>
- 本地参考镜像：`tmp/dongjinhan-briefing/briefing.html`（临时研究材料，不作为仓库权威规范）。
- A-MEM 启发链接（原方案引用）：<https://arxiv.org/abs/2502.12110>。
- 外部设计切磋：ChatGPT 对话 <https://chatgpt.com/c/6aeebb20-4d2c-83ee-9c05-046e92cb1688>。其意见仅作为设计输入，不替代 evoK 领域契约或代码验证。
- evoK 权威词汇：`CONTEXT.md`。
- Run/session 边界：`docs/adr/0001-pi-agent-runtime-session-policy.md`。
- Mission 存储与恢复：`docs/adr/0004-evok-autonomous-research-entrypoint.md`。
- Pi 执行边界：`docs/adr/0005-pi-sdk-execution-path.md`。
- 当前 agent memory 契约：`docs/multi-agent-architecture.md`、`src/execution/memory-slice.ts`、`src/execution/context-broker.ts`。
