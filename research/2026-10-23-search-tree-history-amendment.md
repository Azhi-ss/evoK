# 预注册修正：搜索树历史块的截断

日期：2026-10-23。适用范围：harness-opt 在 `--search-tree-from-round` 打开之后，写进 gap-finder 和 innovator prompt 的搜索树历史块。不新增 `pre-round1.json` 的签名字段。搜索树仍然默认关闭。没打开时，预注册文件跟以前一样。

这份修正替换此前「摘要行本身超过 24000 字就报错」的规则。上限仍然是 24000 字。

## 摘要行

每一轮的每个候选先写成一行。

旋钮有两种写法，按记录本身的形状决定，不把一种改写成另一种：

- 结构化改动记录只列有变化的键，格式是 `key: old→new`。旧值来自该轮 `baseline/config.json`，新值来自该候选自己的 config；也可以是 `{before, after}`、`{changes}` 里的 `{old, new}` / `{before, after}`，或 `[old, new]`。没变化的键不写。某一侧没有值时写成 `absent`。
- 改动记录不是结构化的（只有一段散文摘要，没有可比较的旧值和新值）时，摘要行保留这段原文。不把它改写成 `key: old→new`。行长不够时再按下面的顺序缩短这段原文。

critic 的原因、ranker 的原因、以及每一道门的原因，各截到 120 字。一行的目标长度不超过 400 字。缩短顺序是：先缩短评语，再缩短门，再缩短旋钮，然后是 critic 和 ranker 的原因。门被缩短到一个字都不剩时，写成 `gates=truncated`。这和源里没有门的 `gates=absent in source` 不是同一件事。行长够、不需要动门这一栏时，源里没有门仍写 `gates=absent in source`。门只被裁掉一部分、还留着字时，留下裁短后的原文。

reward 和 accept/reject 只写在这一轮真正评过的那个候选上。其余候选写 `reward=not evaluated` 和 `verdict=not evaluated`。

## 放不下时怎么退化

历史块的 JSON 正文（`summaries`、`details` 和 `degradation`）最多 24000 字。这段函数不抛错。有历史时，prompt 里至少留下一条摘要，不会是 0 条。

顺序固定：

1. 放得下时，最近一轮保留全文详情，更早的轮次只有摘要行。每一轮的退化等级是 `none`。
2. 超出 24000 时，先按整条丢掉最近一轮的详情，从最后一条开始。不从字符串中间截，不拆开 JSON。只要丢掉过至少一条，这一轮的等级就是 `details_dropped`。详情全部丢掉也是这个等级。
3. 丢掉详情后仍然超出，就把最早的轮次收成一行。这一行是该轮最优候选（真正评过的那个，否则是 ranker 选中的那个）、它的 reward，再加上 `other N rejected`。从最老的一轮开始收，收到放得下为止。被收成一行的轮次等级是 `oldest_merged`。较新的、仍是每个候选一行的轮次保持原来的等级。
4. 每一轮都已收成一行却还超出时，丢掉最老的那一行，直到放得下。丢掉的轮次等级是 `line_dropped`。最新的一轮保留。若最后这一行本身仍超出，再按字符从末尾缩短这一行。按字符缩短不另设等级。

同一轮只记一个等级。较强的覆盖较弱的：`line_dropped` 高于 `oldest_merged`，`oldest_merged` 高于 `details_dropped`，`details_dropped` 高于 `none`。所以最近一轮先被丢掉详情、后来又被收成一行时，等级是 `oldest_merged`。

`degradation` 是 JSON 里的数组，从最老的一轮排到最新的一轮。每一项是 `{round, level}`。渲染时树上有的每一轮都在里面，包括摘要行已经被丢掉的轮次。`level` 只能是 `none`、`details_dropped`、`oldest_merged`、`line_dropped`。

这一份数组写进该轮 gap-finder 的历史块，同时也记一条 lineage 事件：`kind` 为 `history`，`round` 是使用这份历史的那一轮，`role` 为 `gap-finder`，`degradation` 是同一份数组。搜索树签名进 `search-tree.json` 时，这条事件在 `events` 里。后来的读者直接读这条事件，不用把 prompt 再推一遍。没有历史时 `degradation` 是空数组；搜索树这一轮开着，这条 `history` 事件仍然写。

规则原文接在 JSON 后面。这段文字在角色 prompt 里，计入 innovator 单次上限和只读 3000 万上限。

## 审计

方法评审 `reviews/2026-10-23-search-tree-history-amendment-method.md`（sha256 前缀 `70821399`）对上一版正文给出有条件通过。本修订补上退化等级、非结构化旋钮的散文回退，以及 `gates=truncated`。

- 上一版正文 sha256：`afe051878d254e42c4b290dfa5fac05112f509fe9cc99595a44eb78592288c48`
- 上一版实现提交：`cadaad3bd9edc9973662a69c0e22e7ee490c6df1`
