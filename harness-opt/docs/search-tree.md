# 搜索树接到 opt-loop

默认关闭。`--search-tree-from-round N`（或 `OptLoopOptions.searchTreeFromRound`）把 N 写进签名的 `pre-round1.json`。没写这个字段时，prompt、父节点选择和磁盘上的树都跟以前一样。续跑沿用这份预注册里的 N；两边都给了但数字不同，拒绝启动。

N 及以后的轮次才用树。用到的都是原有函数：

- `Lineage` 的 `put`、`roleView`、`events`、`nodeSummaries`、`log`、`gateLog`
- `getSelector(DEFAULT_SELECTOR_ID)`，也就是 `GreedySelector.pick`
- `orchestrator.ts` 里的已试列表：选中父节点的 `children`，再取每个子节点的 `patchSummary`
- 有 `devMean` 时调用 `backprop(lin, node, devMean)`
- 落盘用现成的 `signedAttestationJson` / `attestationJsonMacOk`（和 `campaign.json` 同一套 HMAC）

文件是 loop 输出目录里的 `search-tree.json`，旁边是 `campaign.json`。正文带 `nonce`、`outRel`、`searchTreeFromRound`、节点、事件、gate 日志，以及由节点 `patchSummary` 算出的 `tried`。签名不对、或 `tried` 和节点对不上，续跑和 `--carry-from` 都拒绝。源目录只读。`--carry-from` 在新循环也打开了从第 N 轮生效时，核对源文件后把节点带进新的签名文件。

控制节点始终是 evaluated 的根，`GreedySelector.pick` 因此选得到父节点。reward 落在 `[0, 1]` 时写入 `devScores`。没有这样的 baseline reward 时，`configPath` 是 `control/config.json`，`devScores` 是 `[0]`。这个 0 不是测出来的 reward，只为了现有 selector 能选中它。

gap-finder 和 innovator 走原来塞「上一轮评语」的那条 prompt。历史块是角色事件和节点摘要。G0–G3 的 pass/fail（以及 code、reason）写在同一条 `log` 事件上，所以会出现在 prompt 里；`gate.jsonl` 仍另记一份。`roleView` 照旧不读 `gate.jsonl`，held-out 字段照旧被去掉。

## 截断

这条只作用于搜索树历史块，不再用 trace 的 `trimLongString` 头尾截断。历史块最多 **12000** 字。超出时从最老的一轮开始，把该轮压成一行：knob、reward、accept/reject、一句 reason。最近两轮保留全文。压完仍超过 12000 时，先丢掉更老的一行，最后才从块的开头截到 12000。规则原文接在块后面。这段文字在角色 prompt 里，因此计入 innovator 单次上限和只读 3000 万上限。

## 导入

`--search-tree-import <loopOut>` 可重复，只读。每一轮读入全部 innovator 候选（含 `no_conclusion` 这类无效候选，标成 invalid）、critic 的 `excluded`、ranker 的 `winnerId`、每个候选的 summary、G0–G3、accept/reject、评语（`reasonLabel` 为 `commentary`）和 reward。

accept 的权威来源按布局读，缺了不默认成 reject：

- closure 里有布尔 `accepted` 就用它（fresh-carry）
- 否则用 `loop-result.json` 里该轮的 `rounds[].accepted`，或顶层 `accepted.round`（round2 的 `accepted: true` 在这里，不在 closure）
- 都没有则写成 `absent in source`

knob、门、评语按该目录里实际有的文件读：`candidates/gap.json`、`review-input.json`、`state/nodes/gates.json`、closure 的 `gates` / `reviewReason`、reviewer 会话。源里真没有的字段写成 `absent in source`，不猜。

父子关系看配置字节，不把三次运行串成一条链。一轮的父节点是 `baseline/config.json` 对得上的那个已有节点。round2 的 baseline 是 round1 当时用的配置，所以 round2 的候选挂在 round1 的那个候选下面。round3 的 baseline 是 control，所以它的候选和 round1 的候选都挂在控制根上，彼此是兄弟。对不上任何别人的配置时，父节点也是控制根。每一轮自己的候选（含无效的）都是该轮父节点的子节点。本仓库不自带那三份运行目录，只有传入路径才导入。

## 现有模块里没有、因此没有新造的

- `Lineage` 自己不签名。完整性只在 `search-tree.json` 这一份 HMAC 上。`Lineage.log` 会重打时间戳，恢复事件时用原来的 `appendContained` 把签过名的行写回去。
- `Node` 没有 reviewer 结论、knob、比赛 reward 这三个字段。accept / reason / knob / patch / gates 记在 `log("round"|"review", …)` 里。reward 只有落在 `[0, 1]` 里才写入 `devScores`。`scoreTraces` 的 ×100 不写入节点。
- opt-loop 不跑 `Orchestrator.step`，因此不持有它的 parent lock，也不使用 0.01 / 0.9 那两条占位 keep 规则。
- 已试列表只是当前父节点的子节点。其余候选在历史块里。
- 没有上游 health / sane 探针。HTTP 200 且空 body 算失败这条没有落地。
- 没有 ShinkaEvolve 式的多轮洞见摘要，没有 `memory.jsonl` 的写入，没有 skill 写回。UCT、softmax-mix 和那些会抛 TODO 的 selector 都没有接到这条循环上。
