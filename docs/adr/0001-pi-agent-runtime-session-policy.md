# ADR-0001: Pi AgentRuntime 的 Run 边界与 SDK 隐式行为策略

- **Status**: Proposed
- **Scope**: `PiAgentRuntime` 与 Pi SDK `AgentSession` 的适配边界
- **Related**: #1、#6、#8、#23

## 1. Scope / Trigger

Pi SDK 的 `AgentSession` 不是 evoK 的长期状态容器。重复调用同一个 session 会累积 user、assistant 和 tool-result 消息；SDK 默认还可能自动 compaction（额外的摘要 LLM 调用）和自动 retry。两者都会让一次 Run 的成本、上下文和停止原因变得不透明，并可能把过期叙事带入后续决策。

本规范适用于每次 `AgentRuntime.execute()` 代表的一个 **Run**，以及由它调用的 self-verification、candidate proposal、falsification 等阶段。

## 2. Decision

### 2.1 Session 是 Run 资源，不是 Mission 记忆

- 每个 `PiAgentRuntime.execute()` 创建一个全新的 Pi SDK `AgentSession`。
- 每个 Run 使用独立的临时 workspace 和 `SessionManager.inMemory()`。
- Run 结束、失败或取消时必须 dispose session；不得跨 Task、Branch、阶段或重试复用 session。
- 长期状态只来自 harness 的 Task Contract、Candidate/Snapshot、Evidence、Finding 和 event ledger；模型 transcript 不是权威状态。
- 同一 Run 内的 tool call 和必要的 correction attempt 可以继续使用同一 session；不能按每个 tool call 清空上下文。

### 2.2 禁止 Pi SDK 隐式 compaction

默认 factory 必须显式注入内存 `SettingsManager`，关闭自动 compaction：

```ts
SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
```

Runtime policy 高于调用方传入的可选 session settings，调用方不得通过 `sessionOptions` 重新打开上述能力。上下文超限应让当前 Run 显式失败，由 harness 根据 Task Contract 决定是否创建新的 Run；不得静默生成摘要并继续执行。

### 2.3 Retry 只有一个 owner

- Pi SDK assistant-turn retry 和 summarization retry 均由 runtime policy 关闭。
- transient provider failure 结束当前 Run；是否重试由 harness 的 Task Contract、预算、fencing 和 retry policy 决定。
- harness 的每次重试必须是新的 Run、session、workspace 和 attempt identity，不得在原 session 上继续。
- abort、sandbox violation、policy violation 和不确定的副作用状态不得由 Pi SDK 自动重试。

### 2.4 隐式生命周期必须可观测或 fail closed

Runtime 需要识别并规范化以下 Pi SDK 事件，保留经过 redaction 的事件数据：

- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `summarization_retry_scheduled`
- `summarization_retry_attempt_start`
- `summarization_retry_finished`

在 compaction/retry 明确关闭的策略下，收到上述任一事件表示 SDK policy drift 或配置绕过：事件先进入本次 Run 的可观测记录，然后 Run 以 policy violation 失败；不得把它当作普通成功完成。事件中的 message/tool payload 不能成为长期状态的权威来源。

## 3. Signatures

### 3.1 Runtime port

```ts
PiAgentRuntime.execute(
  input: PiAgentRuntimeRequest,
  signal?: AbortSignal,
): Promise<AgentRuntimeResult>
```

一个 `execute()` 调用对应一个 Run。成功结果必须包含：

- 唯一 `sessionId` 和临时 `workspace`
- lifecycle/tool/message 事件及可审计的 `ledger`
- 聚合 token/cost usage
- terminal `stopReason`
- 可选的模型文本结果

### 3.2 SDK policy boundary

`defaultFactory` 创建 Pi session 时必须提供由 runtime 控制的 `SettingsManager`；至少约束：

```ts
compaction.enabled === false
retry.enabled === false
```

`resourceLoader`、tools、cwd 和 `sessionManager` 的安全约束仍由现有 sandbox/runtime contract 管理；本 ADR 不扩大其配置面。

### 3.3 Normalized event contract

`RuntimeEvent.type` 除现有事件外，必须支持第 2.4 节列出的七类 SDK lifecycle event。原始事件只能放在 redacted `raw` 中；禁止把未脱敏的 secret 或凭证写入 event/ledger。

## 4. Validation & Error Matrix

| 场景 | 预期行为 |
|---|---|
| 新 Run、正常 prompt 完成 | 返回 usage、stop reason、`session_end`；session 被 dispose |
| 同一 runtime 再次使用已占用 workspace/session | 在创建或执行前拒绝 |
| SDK context overflow | 当前 Run 失败；不触发自动摘要，不静默继续 |
| 收到 `compaction_*` | 记录 redacted 事件并以 policy violation 失败 |
| 收到 `auto_retry_*` 或 `summarization_retry_*` | 记录 redacted 事件并以 policy violation 失败 |
| transient provider error | 当前 Run 失败；不在 Pi session 内重试；由 harness 后续决定是否新建 Run |
| AbortSignal 取消 | 中止当前 session，抛出 `AbortError`；不自动重试；清理 listener/session |
| sandbox 或权限违规 | 失败/隔离，禁止自动重试 |
| 调用方传入开启 compaction/retry 的 settings | runtime policy 覆盖，不能改变最终行为 |

## 5. Good / Base / Bad Cases

### Good

- 一个 Run 内完成多次 tool call，保留该 Run 所需的短期上下文。
- 下一阶段或另一 Branch 使用新的 session、workspace 和 attempt identity。
- 模型需要重试时，由 harness 依据预算创建新的 Run，并在 ledger 中关联前一次失败 Evidence。

### Base

- 单次 prompt 无 tool call，SDK 返回正常 assistant completion；事件和 usage 与当前 `AgentRuntimeResult` 契约一致。

### Bad

- 一个持久 session 依次承载多个 Task/Branch，并把历史 transcript 当作当前状态。
- 依赖 SDK 默认 compaction，让摘要替代 authoritative Evidence。
- Pi SDK 和 harness 同时 retry，却没有统一次数、成本和副作用判断。
- 发生 sandbox violation 后继续复用原 session。

## 6. Tests Required

1. **Policy injection**：使用真实 `createAgentSession` 检查默认 factory 创建的 session 关闭 auto-compaction/auto-retry；传入相反 settings 不能覆盖 runtime policy。
2. **Lifecycle normalization**：fake session 发送七类 lifecycle event，断言事件类型、redacted raw 和 policy-violation 失败路径。
3. **No hidden retry**：使用 deterministic/faux provider 注入 transient failure，断言单个 Run 不重复请求、不产生自动 retry 事件；后续 harness retry（若存在）使用新的 session/workspace。
4. **No hidden compaction**：多轮/tool-heavy 的真实 SDK integration test 断言不会产生 compaction 或 summarization-retry 事件；context overflow 必须显式失败。
5. **Isolation regression**：两个阶段/Branch 的 prompt 和 session state 互不可见，且每个 session 最终 dispose。
6. **Existing contract regression**：保留现有 abort、usage/cost、stop reason、sandbox 和 tool allowlist 断言。

测试只断言 AgentRuntime 的外部行为和可观测契约，不依赖 Pi SDK 私有字段或内部实现细节。

## 7. Wrong vs Correct

### Wrong

```ts
const session = await createAgentSession(options);
for (const task of tasks) {
  await session.prompt(task.prompt);
}
```

这会把多个 Task 的 transcript/tool result 混进同一上下文，并把 SDK 默认 compaction/retry 隐藏在业务控制面之外。

### Correct

```ts
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

// 每个 execute()/Run 创建一次，结束后 dispose；失败重试创建新的 Run。
const { session } = await createAgentSession({
  ...options,
  settingsManager,
  sessionManager: SessionManager.inMemory(options.cwd),
});
```

## 8. Out of Scope / Follow-ups

- 不引入跨 Mission 的持久 Pi conversation 或通用 transcript memory。
- 不在本 ADR 中实现 harness 的 durable intent/result recovery；该问题由 #23 处理。
- 不重做完整 event payload 的大小上限和 observation projection；需要时单独建 ticket。
- 不改变 CompetitionAdapter、Evaluator、Promotion 或 Mission Objective 契约。
- 如果未来确实需要连续 AgentSession，必须另立 ADR，采用 bounded incremental authoritative envelope，并重新验证历史消息不能覆盖 ledger 状态。
