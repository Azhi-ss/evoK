# 搜索树接到 opt-loop

默认关闭。`--search-tree-from-round N`（或 `OptLoopOptions.searchTreeFromRound`）把 N 写进签名的 `pre-round1.json`。没写这个字段时，prompt、父节点选择和磁盘上的树都跟以前一样。续跑沿用这份预注册里的 N；两边都给了但数字不同，拒绝启动。

N 及以后的轮次才用树。用到的都是原有函数：

- `Lineage` 的 `put`、`roleView`、`events`、`nodeSummaries`、`log`、`gateLog`
- `getSelector(DEFAULT_SELECTOR_ID)`，也就是 `GreedySelector.pick`
- `orchestrator.ts` 里的已试列表：选中父节点的 `children`，再取每个子节点的 `patchSummary`
- 有 `devMean` 时调用 `backprop(lin, node, devMean)`
- 落盘用现成的 `signedAttestationJson` / `attestationJsonMacOk`（和 `campaign.json` 同一套 HMAC）

文件是 loop 输出目录里的 `search-tree.json`，旁边是 `campaign.json`。正文带 `nonce`、`outRel`、`searchTreeFromRound`、节点、`roleView` 事件、gate 日志，以及由节点 `patchSummary` 算出的 `tried`。签名不对、或 `tried` 和节点对不上，续跑和 `--carry-from` 都拒绝。源目录只读。`--carry-from` 在新循环也打开了从第 N 轮生效时，核对源文件后把节点带进新的签名文件。

gap-finder 和 innovator 走原来塞「上一轮评语」的那条 prompt。多出来的一段是 `roleView()` 的 JSON（事件和节点摘要）。

截断就用 trace 那条，没有第三套摘要：先 `trimLongString`（超过 5100 字留头 2500 和尾 2500，中间写去掉了多少字），再 `capArtifact`（单段上限 20480，结尾 `\n... (truncated)`）。规则原文写在这段的最后一行，所以它本身不被截掉。

`--search-tree-import <loopOut>` 可重复，只读。它读该目录里已有的 `roundN/closure.json`、`run-notes.md`、`patch.diff` 和 reviewer 的 `candidates/gap.json`，写成现有的 `Node` 和一条 `review` 事件。本仓库里没有 `round1-r3`、`round2`、`round3-e92ce52f-r2` 这三份运行目录，所以不会自动去扫磁盘；把路径传进来才会导入。

## 现有模块里没有、因此没有新造的

- `Lineage` 自己不签名。完整性只在 `search-tree.json` 这一份 HMAC 上。`Lineage.log` 会重打时间戳，恢复事件时用原来的 `appendContained` 把签过名的行写回去。
- `roleView` 去掉 held-out，并且不读 `gate.jsonl`。门结果只进 `gateLog` 和签名文件的 `gates`，不进 gap / innovator 的 prompt。
- `Node` 没有 reviewer 结论、knob、比赛 reward 这三个字段。accept / reason / knob / patch 记在现有的 `log("review", …)` 里。reward 只有落在 `[0, 1]` 里才写入 `devScores`（selector 约定的区间）。`scoreTraces` 的 ×100 只是展示，不写入节点，也不另做缩放。区间外的 reward 不进 `devScores`。
- 没有 `[0, 1]` 的 baseline reward 时建不出 evaluated 的根，`GreedySelector.pick` 会抛 `no evaluated unlocked node`。这一轮不挂父节点。
- opt-loop 不跑 `Orchestrator.step`，因此不持有它的 parent lock，也不使用 0.01 / 0.9 那两条占位 keep 规则。
- 已试列表只是当前父节点的子节点，不是树上每一个候选。其余候选在 `roleView` 的历史里。
- 非赢家候选没有单独的 config 文件，`configPath` 只是路径字符串。
- 没有上游 health / sane 探针。HTTP 200 且空 body 算失败这条没有落地；探针在宿主脚本侧。
- 没有 ShinkaEvolve 式的多轮洞见摘要，没有 `memory.jsonl` 的写入，没有 skill 写回。UCT、softmax-mix 和那些会抛 TODO 的 selector 都没有接到这条循环上。
