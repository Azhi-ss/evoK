# 搜索树接到 opt-loop

默认关闭。`--search-tree-from-round N`（或 `OptLoopOptions.searchTreeFromRound`）把 N 写进签名的 `pre-round1.json`。没写这个字段时，prompt、父节点选择和磁盘上的树都跟以前一样。续跑沿用这份预注册里的 N；两边都给了但数字不同，拒绝启动。

N 及以后的轮次才用树。用到的都是原有函数：

- `Lineage` 的 `put`、`roleView`、`events`、`nodeSummaries`、`log`、`gateLog`
- `getSelector(DEFAULT_SELECTOR_ID)`，也就是 `GreedySelector.pick`
- `orchestrator.ts` 里的已试列表：选中父节点的 `children`，再取每个子节点的 `patchSummary`
- 有 `devMean` 时调用 `backprop(lin, node, devMean)`
- 落盘用现成的 `signedAttestationJson` / `attestationJsonMacOk`（和 `campaign.json` 同一套 HMAC）

文件是 loop 输出目录里的 `search-tree.json`，旁边是 `campaign.json`。正文带 `nonce`、`outRel`、`searchTreeFromRound`、节点、事件、gate 日志，以及由节点 `patchSummary` 算出的 `tried`。签名不对、或 `tried` 和节点对不上，续跑和 `--carry-from` 都拒绝。源目录只读。`--carry-from` 在新循环也打开了从第 N 轮生效时，核对源文件后把节点带进新的签名文件。

控制节点始终是 evaluated 的根。reward 落在 `[0, 1]` 时写入 `devScores`，父节点走 `GreedySelector.pick`。没有这样的 baseline reward 时，`configPath` 是 `control/config.json`，`devScores` 是 `[0]`。这个 0 不是测出来的 reward。这时 `selectParent` 按 id 固定返回控制节点，不看 dev 分数的高低，所以导入进来的高分候选不能抢走根的位置。

gap-finder 和 innovator 走原来塞「上一轮评语」的那条 prompt。历史块是每一轮每个候选的摘要行，加上最近一轮的详情。G0–G3 的 pass/fail（以及 code、reason）写在同一条 `log` 事件上，所以会出现在 prompt 里；`gate.jsonl` 仍另记一份。`roleView` 照旧不读 `gate.jsonl`，held-out 字段照旧被去掉。

## 截断

这条只作用于搜索树历史块，不再用 trace 的 `trimLongString` 头尾截断，也不再把块从末尾切成 12000 字。历史块的 JSON 正文最多 **24000** 字。这是预注册的修正，全文在 `research/2026-10-23-search-tree-history-amendment.md`。上限不新增 `pre-round1.json` 的签名字段。没打开搜索树时，预注册文件跟以前一样。

两层，但摘要行先压短。旋钮只列有变化的键，写成 `key: old→new`。critic、ranker 和每一道门的原因各最多 120 字。一行目标不超过 400 字。reward 和 accept/reject 只写在真正跑过的那个候选上，其余候选写 `not evaluated`。放得下时，最近一轮另保留全文详情。

超出 24000 时，先按整条丢掉最近一轮的详情，从最后一条开始。不从字符串中间截，不拆开 JSON。仍然超出就把最早的轮次收成一行：最优候选、它的 reward、以及 `other N rejected`。从最老的一轮开始，收到放得下为止。这段函数不报错，有历史时也不会把 0 条送进 prompt。规则原文接在 JSON 后面。这段文字在角色 prompt 里，因此计入 innovator 单次上限和只读 3000 万上限。

## 导入

`--search-tree-import <loopOut>` 可重复，只读。每一轮读入全部 innovator 候选（含 `no_conclusion` 这类无效候选，标成 invalid）、critic 的 `excluded`、ranker 的 `winnerId`、每个候选的 summary、G0–G3（含原因）、accept/reject、评语（`reasonLabel` 为 `commentary`）和 reward。

critic 的 `excluded` 以该轮 `ranker-input.json` 为准。空数组是「没有排除」，不是缺失。这份文件没有字符串数组时，才回落到 `sessions/critic.jsonl`。

门的原因合并 closure 的 `gates` 和 `roles/reviewer-gate/state/nodes/gates.json`。同一 id 先留下已有的 pass，再补上缺失的 code 和 reason。源记录里的 reason 文本原样抄过来。

候选补丁按该候选的真实目录名读。`roles/innovator-N/patch.json` 有 summary 时用它。否则读 `roles/innovator-N/candidates/<目录名>/patch.json`（跳过 `base`；只有一个目录时用它，多个目录时按补丁 id 或目录名对上 `cN`）。`candidates/nudge-early/patch.json` 就是这种真实目录名。round 级的 `candidates/<目录名>/patch.json` 只在补丁或目录名对得上该槽位时使用。摘要行里的旋钮不抄整段 summary，而是拿该候选 config 对 `baseline/config.json` 做叶键比较，只留下变化的键。

reward 和 accept 只挂在这一轮真正评过的候选上，也就是 ranker 选出、配置写进 `candidate/config.json` 的那个。同轮其余候选在摘要行里写 `not evaluated`，不再复制这一轮的 reward 和 accept。

accept 的权威来源按布局读，缺了不默认成 reject：

- closure 里有布尔 `accepted` 就用它（fresh-carry）
- 否则用 `loop-result.json` 里该轮的 `rounds[].accepted`，或顶层 `accepted.round`（round2 的 `accepted: true` 在这里，不在 closure）
- 都没有则写成 `absent in source`

knob、门、评语按该目录里实际有的文件读：`candidates/gap.json`、`review-input.json`、`state/nodes/gates.json`、closure 的 `gates` / `reviewReason`、reviewer 会话。源里真没有的字段写成 `absent in source`，不猜。

父子关系看配置字节，不把三次运行串成一条链。一轮的父节点是 `baseline/config.json` 对得上的那个已有节点。这三份真实目录的 baseline 字节都和各自的 control 相同，而 control 登记在控制根上，所以 18 个候选都是控制根的子节点，彼此是兄弟。对不上任何别人的配置时，父节点也是控制根。每一轮自己的候选（含无效的）都是该轮父节点的子节点。accept 会把 baseline 覆盖成胜出候选；和本轮自己的候选撞上时忽略这次匹配，退回控制根。本仓库不自带那三份运行目录，只有传入路径才导入。

## 现有模块里没有、因此没有新造的

- `Lineage` 自己不签名。完整性只在 `search-tree.json` 这一份 HMAC 上。`Lineage.log` 会重打时间戳，恢复事件时用原来的 `appendContained` 把签过名的行写回去。
- `Node` 没有 reviewer 结论、knob、比赛 reward 这三个字段。accept / reason / knob / patch / gates 记在 `log("round"|"review", …)` 里。reward 只有落在 `[0, 1]` 里才写入 `devScores`。`scoreTraces` 的 ×100 不写入节点。
- opt-loop 不跑 `Orchestrator.step`，因此不持有它的 parent lock，也不使用 0.01 / 0.9 那两条占位 keep 规则。
- 已试列表只是当前父节点的子节点。其余候选在历史块里。
- 没有上游 health / sane 探针。HTTP 200 且空 body 算失败这条没有落地。
- 没有 ShinkaEvolve 式的多轮洞见摘要，没有 `memory.jsonl` 的写入，没有 skill 写回。UCT、softmax-mix 和那些会抛 TODO 的 selector 都没有接到这条循环上。
