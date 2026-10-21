# harness-opt

挂在 Pi 上的 harness 优化插件。模型权重不动，只搜外壳。Orchestrator 是确定性代码。这一轮把主会话能驱动的一轮跑通：`/harness-opt` 和同名 LLM tool、命名工作流 `harnessopt.round`、gap-finder / innovator / reviewer-gate 的结构化委派、带步骤的 trace、每阶段报告、轮末 E2E reviewer。

设计原文的权威副本在本机 `/workspace/company/research/`。仓库 `design/` 里是随 PR 走的副本。

## 目录

```
harness-opt/
  package.json                         依赖 pi-subagents 0.79.1。仓库根目录执行 `bun install` 时，这个目录是 workspace，依赖会一起装上
  fixed-model.json                     赛方 id、本地 id、测试 id
  extensions/harness-opt/index.ts      /harness-opt、tool、连字符命令、工作流注册
  workflows/round.js                   harnessopt.round 的脚本正文
  agents/                              三份角色，model 读本地 id
  src/session.ts                       start | step | status | gate | stop
  src/live-round.ts                    委派结果解析后写 gaps / patch / review
  src/pi/delegate.ts                   pi-subagents 的 request/response 事件
  src/modules/executor.ts              bohr 沙箱接口；本机跑 sample-trace
  src/reports.ts                       每轮每阶段一份 JSON，外加 e2e
  src/thresholds.ts                    显式阈值；缺了就失败关闭
  src/heldout-file.ts                  sealed/heldout-score.json
  fixtures/sample-trace.json           三步 trace：read、失败的 bash、write
  fixtures/tasks/dev-1.json            离线 dev 题
```

## 主会话怎么驱动一轮

默认运行目录是项目里的 `.harness-opt/`（已 gitignore）。

```text
/harness-opt start|step|status|gate|stop
```

同名 LLM tool 参数是 `command` 加上可选 `args`。每条命令都用 `ctx.ui.notify` 回显结果和失败项，并用 widget 画状态面板：当前轮、阶段、预算余量、最佳节点、证据门七项（模型、held-out、trace、变更说明、TTS、预算含配额、dry-run）。没跑过的项标 `not-run`。

`start` 必填（文件里已经有则不必再传）：

- `--min-delta`（必须是正数，来自实测 sigma）
- `--tts-baseline`
- `--held-out-floor`
- `--token-budget`
- `--max-local-runs`
- `--max-wall-s`
- `--max-submits`
- `--heldout-score`（写入 `sealed/heldout-score.json`，`source` 为 `hand-filled`。这是声明值，不是对某个候选的评测）

缺任何一项，命令失败并在回显里写出缺的名字。提交门不填 0.5、0.4、5e6 或 `tokensSpent: 0`。

其它入口：

- `harnessopt-select`：必填 `--root <谱系目录>`。可选 `--selector`。
- `harnessopt-record`：必填 `--root` 和 `--kind`。
- `harnessopt-submit-gate`：必填 `--root <运行目录>`。live submit 仍然不发。

`session_start` 用 `pi-subagents/workflow-resources` 注册 `harnessopt.round`。`subagent({ workflow: "harnessopt.round" })` 拿到的脚本依次跑 gap-finder、innovator、reviewer-gate。脚本正文不调用 `bin/eval.ts`。host command 只有 `bun bin/eval.ts --cand <id> --split dev`，登记在 `resolveRoundWorkflow`，脚本本身不执行它。这条命令的 dev 分只读 `traces/<cand>/*.json` 里执行器写下的 `reward` 和 `tokens`。候选 config 上的 `fixtureScore` 和 `tokens` 不读。没有 trace 就失败关闭。held-out 仍只在 `--gate` 下读 `sealed/heldout-score.json`。

Pi 里的 tool 把委派事件发到 `pi.events`，不挂样例桥，并传入默认超时 `300000` ms。没有 pi-subagents 在听时，到点发出只含 `requestId` / `ownerRunId` / `nodeId` 的 cancel，UI 写出 `timed out`。超时前 update 里已经出现的 token 记入 `state/usage.json`。CLI 没有这条总线，`demo` / `step` 挂上同协议的 sample bridge。桥的标签以实际收到的应答为准：start 时是 `bridge none`，样例应答之后才是 `bridge sample`，外部总线真的回了终端事件才是 `pi-subagents`。

## 模型和阈值

`fixed-model.json` 是唯一映射：

| 名字 | id |
|---|---|
| 赛方 | `deepseek-v4.1-flash` |
| 本地 Pi | `ai-modeling/deepseek-v4-1-flash-261017` |
| 本轮测试 | `deepseek-v4-1-flash-261017` |

证据门和三份 `agents/*.md` 的 `model:` 都读这里。三者任一精确匹配才通过。`qwen-*` 和带 sft/grpo/lora 的 id 失败。

token 记在 `state/usage.json` 的 `tokensSpent`。委派 usage、超时前已经观测到的 usage，以及 trace 上的 tokens 都会加上。文件不存在时预算门失败，并点名 `tokensSpent`。

held-out 只有 `sealed/heldout-score.json`。读不到、JSON 坏、分数不是有限数，都抛 `held-out read failed`，不吞成 null。分数只进 `state/gate.jsonl`。`--heldout-score` 写成 `source: "hand-filled"`、`entries` 为空。提交门和里程碑按 `configPath` 读 `entries`，不回退到那个全局声明值。条目不是 `evaluated` 时抛错，detail 含 `手填`，这道门失败，也不算绿。父子因此不会读到同一个数。`recordEvaluatedHeldOut` 才写入某一条候选的实测；样例执行器不调用它。

TTS 只认 `state/tts-comparison.json` 里 `source: "matched-budget"` 且 `status` 为 `passed` 或 `failed`。没有这份文件时状态是 `not-run`，提交门失败。held-out 和 `ttsBaseline` 的比较不能把这盏灯点绿。

## 执行器和题库

`HarnessExecutor.run` 返回带 `steps` 的 trace。`BohrSandboxExecutor` 在没有本地 bohr / pi-bio-harness 镜像时抛 `ExecutorUnavailable`。本机闭环用 `SampleTraceExecutor`，重放 `fixtures/sample-trace.json`：read 成功、bash `exit 1: assertion failed...`、write 成功。报告写 `executor sample-trace`。基线路径含 `/base/` 时 reward 0.4，其后候选 0.8。

`LocalJsonTaskSource` 读目录里的 JSON。`PlaygroundTaskSource.list/download` 在没有 playground CLI 时失败关闭，错误里写明 CLI 未安装。`start --task-source` 写进 `state/session.json`，`step` 按这个字段取题，不会在 step 里改回本地目录。`run --dev <目录>` 走本地题库和执行器，不再把题库丢掉然后空跑。

`playground submit --dry-run` 会带上 `evidence_pack/pack.json`。没有 CLI、没有该 flag、没给提交物路径，都标 `not-run` 并失败关闭。live submit 不发。

## 每阶段报告和 E2E

每一轮写 `reports/round-N/<stage>.json`：`round`、`stage`、`output`、`explanation`。阶段是 select、gap、propose、run、review、backprop、gate。

`reviewRoundE2E` 在 step 末尾检查这七份报告的 `stage`、非空 `explanation` 和非空 `output`，并按阶段核对内容（gap 要能被 `parseGapReport` 接受且至少一条，propose 要有 summary 和 configPath，review 要有布尔 `accept` 和非空 `reason`）。产物同样用 `parseGapReport` / `parsePatchFile` 校验，`{}` 不能过。候选被留下时，`evidence_pack/pack.json` 必须有 model、变更说明和 trace 索引；没被留下且目录不存在则记一笔「未晋升」。结果写 `reports/round-N/e2e.json`。缺阶段或内容不符则 E2E 失败。gate 报告里的 `ok` 不是 true 时，e2e 的 gate 项也是 false，整份 e2e 因此不通过。dry-run、手填 held-out、TTS not-run 都会让这项为 false。TTS 文件缺失、读不出来、或链接被 containment 拒绝时，tts 项记红，`reports/round-N/gate.json` 和 `e2e.json` 仍会写出。

## 角色守卫

子代理的 read、write、edit、grep、find、ls、bash 在执行前过合约。`structured_output`、`contact_supervisor` 这些框架工具按名字放行，用来把角色结果交回父会话。reviewer-gate 的合约不含 `contact_supervisor`，守卫对这个角色拒绝该工具。不在框架白名单里的工具默认拒绝。文件工具的参数名从已安装的 pi-coding-agent 工具 schema 枚举：grep 的 `ignoreCase`、`literal`、`context` 在 schema 里，放行；schema 里没有的参数拒绝。`Path`、`FilePath` 这类路径别名会先把值送进 `resolveLink`。实测：值指向运行根外时报 `path escapes the run root`；值落到 `tests/`、`solution`、`private` 时报 `forbidden path`。这两类在别名预检里就拒绝，并记 `kind: contract`。`sealed/` 不在这条预检里。别名指向 `sealed/heldout-score.json` 且路径仍在运行根内时，预检放行，随后因为 `Path` / `FilePath` 不是工具 schema 的参数，报 `argument Path is not allowed`（同样记 `kind: contract`），到不了 held-out 检查。真正的 `path` 参数指向 `sealed/` 时，角色读检查报 `cannot read held-out`，记 `kind: contract`。

守卫在 Pi 打开文件之前解析符号链接。Pi 自带的 read/write 不接受 `O_NOFOLLOW`，守卫也拿不到它们随后打开的那个 fd，所以检查和真正打开之间仍有一段窗口，链接可能在这中间被换掉。这是已知限制。

宿主自己的落盘走同一套解析：`writeRoleFile`，以及 `state/`、`reports/`、`candidates/`、`traces/`、阈值、held-out 和 `run_state.json`。held-out 评分文件和 `state/tts-comparison.json` 的读取也走这一套：逐段解析，最终用 `O_NOFOLLOW` 打开。解析后的位置必须仍是请求的那条相对路径，并且留在运行根里。跑到运行根外，或被链接改到另一条路径（包括 `sealed/`、`tests/`、`solution`、`private`），就拒绝，并在 `state/lineage.jsonl` 记一条 `kind: contract`，文件内容不读入。链接目标按每一段再解析：link1 指向 link2、link2 再指向 `/etc`、`sealed/`、`tests/`、`solution`、`private`、合约外或运行根外，读和写都拒绝。符号链接这一跳落地后必须仍在运行根内，才继续看后面的段。read、write、edit、grep、find、ls、bash 上的 `path`、`file_path`、`paths`、`Path`、`FilePath`、`location`、`locations` 以及其它路径别名都过同一条解析，查的是解析后的值。中间目录在检查和创建之间被换成链接的窗口还在。

`review.json` 里的 `reason` 是编排器用的判定理由。reviewer 模型自己写的原文另存在 `modelReason`。

innovator 不能写 `candidates/base/`。基线由 orchestrator 写入。守卫仍允许 innovator 把 `candidates/<id>/config.json` 直接写盘，这条写不经过 `applyPatch`。子代把这份文件选作父节点时，`readParentConfig` 先按同一套递归白名单清洗：表外键、元数据键和危险键从 `parts` 与 `search` 里剔除。part 里面混入的 `search.*` 和其他跨命名空间键也按表外剔除，不改顶层 search。空数组走同一套校验：白名单叶子记「是空数组」且不写入，不是叶子的记「不在白名单」。`rejected` 按键去重，每条带来源 `parent-clean` 或 `this-round`。清洗后的配置才传给子代。子候选读取父节点的 `configPath`，用同一条补丁链路把补丁叠上去：`parsePatchFile` 保留顶层 `search`、`search.samples` 和 `changes`，`applyPatch` 再归一化、路由、校验。改动只写进 `patch.part`。带这个 part 前缀的键只剥一层，`skills.skills.selector.weight` 不会再剥成 `selector.weight`。剥完的全路径必须落在配置白名单上（按 part 的叶子，加上顶层 `search.samples` / `selfChecks` / `retries`）。对象值里的每个嵌套键都继续这条路径再查一次，任何深度的 `notes`、`candidateId` 或其他表外键都记入 `rejected`，不会跟着叶子写进去。`toolchain.checker` 在白名单里，会写入；`toolchain.tools.check.id` 和 `skills.trigger` 没有 harness 消费点，不在白名单里。`foo.bar`、顶层 `notes`、`candidateId` 不在白名单里，记入 `rejected`。不再因为段名是 `id` 就拒绝。`memory.enabled`、`memory.scope`、`memory.recall`、`memory.maxItems` 由打过补丁的 harness 只读注入；`memory.policy` 仍不在白名单。`policy` 不是 part，仓库里没有读取 `policy` 的代码，它不在优化搜索范围内，也不是空接口。指向别的 part 的键记入 `rejected`，不跨 part 写入。`search.samples` 这类参数改顶层 search。文件路径和 `__proto__` 同样记入 `patch.json` 的 `rejected`（带原因）并跳过，propose 继续走到 gate。父配置里没被补丁改到的 part 和 TTS 基因留在子配置里。trace 写到 `traces/<candidateId>/<taskId>.json`，子节点和父节点各有自己的文件。

pi-subagents 0.79.1 的默认 intercom bridge 模式是 `always`。桥打开时，`applyIntercomBridgeToAgent` 会把 `contact_supervisor` 追加进子代理的工具列表，并把 `DEFAULT_INTERCOM_BRIDGE_TEMPLATE` 接到系统提示后面，其中有一句 `Use contact_supervisor first.`。reviewer-gate 自己的文件不包含这句，frontmatter 也不再点这个工具的名字；角色合约禁止它联系主管。产品委派 reviewer-gate 时带 `intercomBridge: { mode: "off" }`，桥不激活，这句话不会注入，工具也不会被桥加回去。子代理扩展在 `before_agent_start` 里如果仍看到这段桥文本，会从 reviewer-gate 的系统提示里切掉。守卫同时拒绝 reviewer-gate 调用该工具。gap-finder 和 innovator 的合约仍包含它，桥和守卫对这两个角色保持放行。

## 证据门

`Orchestrator.submitGate` 把下列项相与。任一项不过就 fail-closed：

1. 模型 id 落在映射表里
2. held-out 不低于基线 + Δ。Δ 必须是正的有限数。不传、传 0、非有限值，这道门失败，detail 含 `sigma`
3. trace 包
4. 变更说明
5. TTS 来自真实 matched-budget 对比且状态为 passed。没有对比则 not-run，失败
6. token 预算与当日配额（面板上合成预算一行）
7. `playground submit --dry-run` 成功

里程碑分三态：没读到是 `unread`，读到且下跌是 `fell`，读到且没跌是 `held`。dev 上涨且状态为 `fell` 才拒绝为回归。没读到、或读到的是手填声明，也拒绝晋升，理由是 `milestone-unread`，不是下跌。谱系事件用 `milestone` 记下这一态；`regressed` 只在读到且下跌时为真。里程碑分别用子节点和父节点的 `configPath` 去读 `entries`。

留下规则 `childMean ≥ parentMean − 0.01` 和预筛 `smallMean ≥ 0.9 × parent.devMean` 是占位常数，不是 LCB，也不是配对差。`dev_small` 与 `dev_full` 在夹具里是同一分数的重复；跑过 full 之后 `devMean` 只用 full，不把两段拼起来。

## 选择器

主链路用 `GreedySelector`。`getSelector` 还能换：

- `softmax-mix`：AFlow 公式
- `uct`：UCB1 加 progressive widening，只是公式

未实现，调用即抛 TODO，失败关闭：

- `score-child-prop`（中心须是 archive 中位数，斜率约 `1/sigma`；表达式仍在 `scoreChildPropWeight`）
- `paired-lcb`（`PairedLcbKeep`）
- `successive-halving`（`SuccessiveHalvingStage`）
- `map-elites`（`MapElitesArchive`）
- `novelty`（`NoveltyFilter`）
- `ParetoArchive`

## 多轮优化环

`optimize` 把 gap-finder、innovator、reviewer-gate 接到一次 Dev-II 执行上。默认协议：只做 i014，3 轮，每轮 1 个候选，dev 种子 0/1/2。三轮里最后一个被接受的候选，再和 control 按 `C0,X0,C1,X1,C2,X2` 交替重跑 i014，然后 held-out 跑 002、i030、hb003 各 3 个种子。每道题的 docker 网络都是 `devii-004-int`。`gateway-only` 是 host 侧的语义标记，`heldOut.gatewayOnly` 列出全部 held-out 题号 `002`、`i030`、`hb003`，不写进容器 argv。三轮都没有接受的候选时，不跑终比，也不跑 held-out。模型名是 `deepseek-v4-1-flash-261017`，地址只从环境变量 `BASE_URL` 读。

执行器命令由调用方给，不写 box 上的路径或镜像。`--executor-cmd` 是 JSON 数组，占位符有 `{task}` `{taskPath}` `{seed}` `{arm}` `{config}` `{runDir}` `{runId}` `{nonce}` `{relayLog}` `{attestDir}` `{harness}` `{model}` `{network}` `{tokenCap}` `{driver}`。没有 `{marker}`、`{patchHash}` 或 `{attestKey}`：环不会把补丁标记或证明密钥交给执行器，命令里写了这些占位符会直接拒绝。`{driver}` 来自 `--driver` 或 `HARNESS_OPT_DRIVER`。`{runId}` 是 16 字节随机数的 32 位十六进制，不是运行目录的 sha256。`{nonce}` 是一次性随机数，用过的 nonce 或已经写下 `result.json` 的运行目录会被拒绝。`{relayLog}` 指向这次 `{runId}` 的 relay 账本。`{attestDir}` 位于 `--attest-root` 下，并且不和 `{runDir}` 嵌套。`{network}` 展开成 `devii-004-int`。relay 的绑定地址、上游和容器可达性写在 `relay/ADAPTER.md`，类型检查扫过的 TS 源码里不出现这些地址。

驱动在容器退出之后，把 `{attestDir}/attestation.json` 写到任何挂载之外。环只读这个它自己分配的路径，不读执行器 stdout，也不读 `result.json` 里的路径。schema 是 `devii-opt-attest/v1`，字段与包装器的 `ATTEST_FIELDS` 一一对应，没有第二套名字：

| 包装器键 | JSON 字段 |
| --- | --- |
| schema | `schema` |
| harness | `mountedHarnessSha` |
| config | `mountedConfigSha` |
| trace | `traceSha` |
| sessions | `piSessionShas` |
| outputs | `outputShas` |
| reward | `reward` |
| rewardFile | `rewardFileSha` |
| result | `resultSha` |
| meta | `run` |
| mac | `hmacSha256` |

`hmacSha256` 是 HMAC-SHA256，覆盖除它自己以外的对象。待签字节等于 Python `json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`。密钥是 `HARNESS_ATTEST_KEY_FILE` 指向的文件的原始字节，模式 `0600`，至少 32 字节。这个环境变量可以由包装进程继承，但不得出现在 argv 里，也不得传进容器。`piSessionShas` 和 `outputShas` 只含普通文件的相对路径，不含 symlink。环会重算 trace、sessions、outputs、`verifier/reward.txt` 和 `result.json` 的 sha256，并核对 `mountedConfigSha` 等于宿主交给执行器的那份 config 文件。缺文件、哈希不符或 MAC 不符都失败关闭。`result.json` 的 `session_file` 不是证据。

`run` 里还有宿主分配的 `runId`、一次性 `nonce` 和 `runPath`。`runPath` 必须等于环交给这次执行的目录，也必须等于已签名的 `runDir`。对不上就失败关闭，哪怕 MAC 和文件哈希都对，这次运行不进入计分。`runId` 由环生成并经 `{runId}` 交给包装器；环核对时要求证明里的 `runId` 和 `nonce` 等于它分配的值。证明校验失败时，奖励记为未计分，原因是 `attest_mismatch`，不再读 `reward.txt`。`result.json` 里的 `runId` 如果出现且和宿主分配的不一致，原因是 `result_runid_mismatch`。tokens 超过 `6×W` 的原因是 `token_cap`。容器启动前的布局检查失败则不启动执行器，原因是 `prerun_layout`。

`patchActive` 为真需要三件事同时成立：已验证证明里的 `mountedConfigSha` 等于宿主候选 config 的 sha256，已证明的 trace 里 `run_start.candidateConfigHash` 等于这个 sha，并且已证明的某个 `.pi-sessions` 文件的 system message（`content` 或 `sections`）含有 harness 追加的 `candidateConfigHash: <同一哈希>`。候选 sha 还必须和 control 不同，`effective` 里的旋钮值要等于候选 config。做不到就不能接受，终比和 held-out 不跑。

第一轮的 control trace 用 `--control-attest <目录>` 传入，目录里要有上述证明，而且 `run.arm` 是 `control`。环核对 `mountedConfigSha` 等于宿主 control 文件的 sha256，再核对 trace 里的 `run_start.candidateConfigHash` 等于这个 sha。预注册那份紧凑 control（`{"parts":{"agent-loop":{"maxSteps":25}}}\n`）的 sha256 是 `3e5d312d252f8f70a7f16f3a37a109f706fe85db59d4515a323828bdac5c192c`。环不把这个常数当成唯一合法值；换一份字节不同的 control 文件，证明对不上就拒绝。环不写 `baseline/` 桩。

`gapCitedTrace` 和 `reviewFedForward` 只认该角色自己的 relay 账本里的 `read` 工具结果，不认角色返回的文本，也不认会话文件里追加的 tool call。gap-finder 和 reviewer-gate 真正拉起 Pi 时 argv 含 `--tools read`，没有 write、edit、bash，argv 里也不放角色 runId。会话文件和宿主账本都在角色 cwd 和允许读取的路径之外，由宿主写入，并用证明密钥做 HMAC。对不上就不采信这份会话。引用是否成立由 `relay/ledger.py read-evidence` 判断：先核对宿主文件 sha，再在该角色 runId 下找一段读到的内容。桩角色不写 relay 读记录，因此 `--dry-run` 的 `gapCitedTrace` 为假，终比会被跳过。测试里若要接受候选，只能通过 relay 的 `plant-read` 种下读记录，生产桩不会这样做。

每一轮落下三个角色的 Pi session jsonl 和宿主算出的 sha、`patch.diff`、以及 `activation.json`。计分 EWI 是 `EWI-relay-v1`：`t_first` 来自宿主对 `outputs/answer.txt` 的观察，没有观察则是 `EWI不可判`（`ewi` 为 null，不是 false）。600 秒标成 `新口径下未校准`。`scripts/ewi_idle.py`（sha256 `8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69`）只作 `ewi_trace_ref`。`EWI_IDLE_SCRIPT` 会被拒绝。阈值仍是 `--ewi-threshold`，默认 600 秒。`ts_of` 用 `math.isfinite`：`assistant_message` 的 `ts` 不是有限数字（布尔、`NaN`、`Infinity`、`-Infinity`、字符串、null、缺字段）时抛 `ValueError('missing ts')`。空行或截断行是 `JSONDecodeError`。非对象行在 `.get` 上是 `AttributeError`。文件末尾换行不会多出一行。`outputs` 里指向文件的 symlink 跟随目标 mtime，指向目录的 symlink 不进入。`ewiRuns` 只收录 `ewi === true`，`withoutEwi` 只收录 `ewi === false`。停机上限写在第 1 轮之前的 `pre_round1` 里：最多 10 轮、只读 token 3000 万、只读墙钟 48 小时、真实运行墙钟 103 小时，先到先停。checker 输出在签名前从 `{run}/verifier` 拷到 relay 的 `<runId>/checker/`（0700）。`checkerOutputSha` 和 reward 进入运行签名，reviewer 与 run-notes 共用 `verify_run_record`，不符则停环。`pre_round1` 还签 `round0Record`；`seedSha` 留在签名里，不参与排序。critic+ranker 每轮另有 3M 子上限。容器串行启动，带 `--cap-drop NET_RAW`，并且不挂载 `/home/box`。单次 tokens 超过该题 `6×W` 记 `token_cap`。若存在 executor 的 relay 账本，`patchActive` 还要求每条请求的 system 配置哈希都包含所挂 config 的 sha；没有这份账本时不因此判假。

```bash
bun harness-opt/src/cli.ts optimize --out /tmp/harness-opt-loop --dry-run \
  --attest-root /tmp/harness-opt-attest --attest-key-file "$HARNESS_ATTEST_KEY_FILE" \
  --harness "$HARNESS_FILE" --control-attest /tmp/i014-control-attest
```

`--dry-run` 用桩角色和桩执行器，不发模型请求。`--execute` 才会按命令真的拉起驱动。`--attest-root` 必须在 `--out` 外面。

下面这条只跑一个候选种子，用来在真镜像和真模型上证明激活可以为真。它不是预注册的终比，也不会跑 `C0,X0,...` 或 held-out。镜像里的 harness 必须是这份补丁：它自己读候选 config，把 sha256 写进 `run_start`，并追加到 lead system prompt，Pi 再把这段写进 `.pi-sessions/*.jsonl`。包装器在容器退出后把这些文件留在 `{runDir}`，并把证明写到 `{attestDir}/attestation.json`，其中 `run.nonce` 必须等于 `{nonce}`。网络参数是 `--network devii-004-int`。

```bash
BASE_URL="$BASE_URL" HARNESS_ATTEST_KEY_FILE="$HARNESS_ATTEST_KEY_FILE" \
bun harness-opt/src/cli.ts optimize-one --out /tmp/harness-opt-once \
  --attest-root /tmp/harness-opt-attest --attest-key-file "$HARNESS_ATTEST_KEY_FILE" \
  --harness "$HARNESS_FILE" --config /tmp/harness-opt-candidate.json \
  --control-config /tmp/harness-opt-control.json --knob agent-loop.maxSteps \
  --seed 0 --task i014 --task-path "$TASK_DIR" \
  --executor-cmd '["python3","{driver}","--task","{taskPath}","--seed","{seed}","--arm","{arm}","--config","{config}","--run-dir","{runDir}","--run-id","{runId}","--nonce","{nonce}","--model","{model}","--network","{network}","--token-cap","{tokenCap}","--harness","{harness}","--attest-dir","{attestDir}"]' \
  --driver "$HARNESS_OPT_DRIVER"
```

`patchActive` 为真时退出码是 0，否则是 1。`$BASE_URL`、`$TASK_DIR`、`$HARNESS_FILE`、`$HARNESS_ATTEST_KEY_FILE`、`$HARNESS_OPT_DRIVER` 由运行那台机器提供。候选 config 必须和 control 不是同一份字节。仓库里的 `relay/devii_docker_v2.py` 是盒子启动器。agent 的 docker argv 只经 `hooks.container_argv` 生成，因此带 `--cap-drop NET_RAW`，容器 `BASE_URL` 指向 relay，并且拒绝挂载 `/home/box`。checker 走同一个构造器但 `expose_relay=False`，没有 `BASE_URL` 和 `HARNESS_RUN_ID`。挂载仍是这次 run 目录、CFG，以及 `/workspace/contest-data/devii` 下原来的 data_lake（tasks2）和 checker 的 tests。启动前若 `devii-004-int` 不存在或 relay 没在 `10.204.0.1` 上监听，运行失败。同一次运行拿宿主锁，第二进程拿不到锁。计分运行把 `relay_id` 写进 `result.json`，并在签名前把 checker 拷到该 id 的 relay 目录。缺少 relay 日志根目录会失败。

## 本地闭环

```bash
bun harness-opt/src/cli.ts demo --out /tmp/harness-opt-demo
bun harness-opt/src/cli.ts empty --out /tmp/harness-opt-empty
```

`demo` 用上面的显式阈值和 `fixtures/tasks`，sample bridge 加 sample trace，跑完一轮。`--heldout-score` 是手填，里程碑读不到各候选的 evaluated 分数，子节点不晋升，best 留在 base，`evidence_pack/` 不写。提交门因此在 held-out、TTS（not-run）和 playground dry-run 上失败，`submit: false`。`empty` 仍是夹具角色；它把顶层 `{ score, tokens }` 写进同一个 `sealed/heldout-score.json` 再读回来。夹具要开绿灯时必须显式传入 `tts: "passed"`，表示一份 matched-budget 对比已经跑过。

`harnessopt-record --json` 保留整段 JSON，解析失败走 `ctx.ui.notify`，不把异常抛出命令循环。

```bash
bun test harness-opt
npx -p typescript@5.9.3 tsc -p tsconfig.json
npx -p typescript@5.9.3 tsc -p harness-opt/tsconfig.json
```

`bunx --package typescript@5.9.3` 在 bun 1.4 上解析不了这个包，所以类型检查改走 `npx -p`。evoK 根 `tsconfig.json` 不包含 `harness-opt/`。根 `package.json` 的 `harness-opt` 脚本只转发到插件 CLI。

本机没有 bohr 沙箱，也没有 playground CLI。样例执行器重放 `fixtures/sample-trace.json`，不是 bohr 沙箱。playground dry-run 在没有 CLI 时是 not-run。sample bridge 只在 CLI demo 里回答委派。Pi 会话里由 pi-subagents 接事件；接不上就超时、发 cancel、把已见 token 记账，不把样例回复伪装成模型输出。
