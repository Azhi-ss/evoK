# Long-running Mission + derived ResearchProgram（垂直切片）

## 结论

不新增拥有独立生命周期、预算、权限或派发权的 `ResearchProgramController`。
把现有 `runMissionController` 升级为长期研究执行循环，接入已有 Campaign、
`generateTasks` 和 DAG Scheduler。Mission 是唯一研究目标与授权边界；
ResearchProgram 只是 Mission 执行过程中形成、可版本化的动态计划。

## ChatGPT 关键反对意见与裁决

> “我反对按照 B 的描述，新增一个拥有独立生命周期和调度权的外层 ResearchProgramController。”

接受。否则预算、权限、scope 和终止权会在两个 Controller 之间冲突。

> “推荐：长期 Mission + 派生 ResearchProgram。”

接受。保留 ResearchProgram 概念和模块，但它只是 ledger 派生视图/计划，不拥有授权。

> “Convergence Auditor … Evidence Gate，而不是新的 Research Agent。”

接受。Auditor 不生成实验、不扩预算、不修改目标、不派发节点，只检查证据和完成条件。

> “DAG 不等于必须并行。”

接受。第一版顺序执行，先证明完整研究生命周期，暂不做 fan-out。

## 源码映射（复用而非重写）

| 现有模块 | 在新闭环中的职责 | 是否有独立派发权 |
|---|---|---|
| `runMissionController` | 唯一运行时控制、预算/权限检查、节点派发 | **是** |
| `research-loop.ts` Campaign / `generateTasks` | 根据证据生成/修订研究计划 | 否 |
| `dag-scheduler.ts` | 计算依赖和 Ready 节点 | 否 |
| Director Blind→Revision | 对具体研究行动进行两阶段决策 | 仅 Revised Proposal 可进入 Controller |
| `file-blueprint.ts` GOAL/SCOREBOARD | 研究目标与结果投影 | 否 |
| Convergence Auditor | 检查完成契约与未解决 objection | 否 |
| Mission ledger | 目标、计划版本、节点、Attempt、证据、终止状态的唯一事实源 | 授权边界 |

## 两类完成，不能混淆

1. **Workflow Completeness**：文献、环境、基线、方法、对照、分析、验证、报告是否完成。
2. **Scientific Resolution**：证据最终是 supported / falsified / inconclusive。

完成所有节点不等于科学成功；预算耗尽也不等于研究完成。

## 节点类型与最小输出契约

| 类型 | 必要输出 |
|---|---|
| Literature | 可追溯文献矩阵、公开基线、research gap |
| Environment | 版本固定、GPU/依赖验证、可复现配置 |
| Baseline | 公开实现、冻结协议下的复现指标或受阻证据 |
| Implement | 可运行方法代码、commit、配置 |
| Measure | 独立评估结果、原始产物、协议版本 |
| Analyze | 证据驱动的误差分类与下一假设 |
| Repair | 工程修复记录；不得静默改变科学协议 |
| Validate | 独立数据/模型复核，或明确不可用原因 |
| Report | 代码、环境、配置、结果、证据引用完整的可复现报告 |

## 计划变更与 scope

每次 DAG 变化写 `ResearchPlanRevision`：

- parent_plan_version / new plan_version
- added/removed nodes 与 dependency changes
- rationale 与 related evidence
- `mission_scope_check`: in-scope / scope-expansion
- budget impact

In-scope 的消融、复核、工程修复可自动执行；改变研究目标、扩预算、扩权限必须人类重新授权。

## 终止状态

- `completed_supported`
- `completed_falsified`
- `completed_inconclusive`
- `budget_exhausted`
- `blocked`
- `human_review_required`
- `cancelled`

必须预留独立验证和最终报告资源，不能把全部预算用于方法爬坡。

## Ledger 最小新增事件

- `ResearchPlanCreated` / `ResearchPlanRevised`
- `ResearchNodeCreated` / `Started` / `Completed` / `Failed` / `Blocked`
- `NodeAttemptStarted` / `Checkpointed` / `Finished` / `Interrupted`
- `ConvergenceAssessmentRecorded`
- `MissionTerminalStateRecorded`

Attempt 有唯一 ID 和幂等键。恢复时先检查进程、checkpoint 和已有 artifact，不能盲目重复训练。

## Phase 1：顺序垂直切片

目标：一个长期 Mission 自动推进多个不同类型节点，无需人工 `/resume`，最终进入明确终止状态。

顺序路径：

```text
Literature → Environment → Baseline → Implement → Measure → Analyze → Report
```

每个节点结束后重新生成/修订 DAG；失败可触发 investigate/repair，但不得改变目标或覆盖旧协议。

验收：

1. 不调用人工 `/resume`，连续完成至少 literature、baseline、measure、analyze 四类节点。
2. 所有计划、节点、Attempt、评估和终止状态可从 ledger 重建。
3. 注入一次 controller 崩溃，恢复后不重复已确认节点或重复扣费。
4. scope-expansion 节点被阻止，预算不足进入 `budget_exhausted` 而非科学完成。
5. Auditor 只读证据，无派发、改目标、改预算能力。

## 后续阶段（不在第一版）

- 并行 fan-out 与资源共享。
- 跨 Mission insight / 多研究计划协作。
- 自动 scope expansion。
- 更复杂的长期记忆与主动文献订阅。
