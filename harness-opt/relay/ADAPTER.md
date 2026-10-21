# Relay 适配说明

宿主侧 relay 是 tokens、激活、EWI-relay-v1 和角色读证据的唯一来源。本文件记录 hooks 和账本的约定，以及这台环境没有核实的部分。

## 绑定和上游

数据面只绑定 `10.204.0.1` 上的可配置端口，不绑定 `0.0.0.0`，也不做转发容器或 iptables。容器 `BASE_URL` 形如 `http://10.204.0.1:<port>/r/<runId>/v1`。循环启动的 `control` 进程调用 `bind()`，在该地址上接受 `POST /r/<runId>/v1/chat/completions`，经 `handle()` 转到上游。done 里的 usage 只取上游响应。上游固定为 `https://newapi.ai-modeling.top/v1/chat/completions`，只有测试参数可以换掉，请求里的 Host 或 URL 不采用。测试可以显式把监听地址改成 `127.0.0.1`；`assert_bind_host` 仍然拒绝它。

**未核实：** 这台 VM 上绑定 `10.204.0.1` 会 `EADDRNOTAVAIL`，容器是否够得到这个地址没有实测。真实 docker 出网同样未核实。

密钥从 `RELAY_UPSTREAM_KEY_FILE` 读取（模式 `0600`，不能是符号链接）。它的路径或内容和 `HARNESS_ATTEST_KEY_FILE` 相同则拒绝启动。进来的 `Authorization` 丢掉，换成上游密钥，日志里不写这两样。

## 密钥扫描的限度

请求体只按原始字节匹配上游密钥和 HMAC 密钥。命中则 `403`，`reason` 为 `secret_in_body`，不转发，也不保存 body、tool 或 sha。base64、JSON 转义、拆开存放都不会被发现。单测锁定了这一点：密钥的 base64 会照常转发。

## 账本和分类

`load()` 只解析和校验。未计分的决定都在 `classify()`。布局违规的名字固定是 `布局违规`。infra 和 run 同时出现时两边都列出，`unscored_kind` 取 `run`。

- infra：`usage_missing`、`relay_restart`、`attest_mismatch`、`no_requests`、`connect_failed`、`prerun_layout`、`docker_daemon_event`、`upstream_server_error`。
- run：`token_cap`、`checker_undecided`、`client_disconnect`、`result_runid_mismatch`、`布局违规`、`upstream_client_error`。

`usage_missing` 只来自 2xx 且没有 usage 的 done。4xx 是 `upstream_client_error`，5xx 或网络错误是 `upstream_server_error`（infra，但不是重跑条件）。`docker_daemon_event` 只包括 `dockerd_restart`、`dockerd_unavailable`、`host_oom_other`。容器自己的 die、oom、kill、exit 不是 infra。`connect_failed` 需要零条请求再加上宿主侧拨号证据，容器文本里的 “connection refused” 不算。

上游错误的 done 记下 `status`（HTTP 码或 null）和 `errClass`（`4xx`、`5xx` 或 `network`）。

**未核实：** usage 里的缓存字段名按 `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens` 读取。字段缺失且 usage 存在时直接报错，不当成 0。

## 读证据

先核对宿主文件 sha，再只在该角色自己的 runId 下匹配。行首若每一行都是 `N|`，先剥掉这个前缀；混有不带前缀的行则不剥。

**未核实：** Pi 真实前缀是否就是 `N|`。这里按这个格式钉死。

不足 200 字节的文件必须整文件匹配。片段还要至少 3 行且至少 200 字节、全文里只出现一次、行对齐，并且 `toolName` 为 `read`、参数路径指向该宿主文件、请求 seq 早于结论。引用的行号必须整个落在片段内，并盖到至少一行非空行。第 1 轮 gap 的目标是 `pre_round1` 里 `round0Record` 的宿主私有副本，按签名里的 sha 判定。未签名文件、改过一字节的副本或 sha 不符都是防伪失败，循环停止，不再开下一轮。

## 布局、循环和检查器拷贝

容器启动前写 `preRunLayout`（`ok`、`checks`、checks 的 sha，再加 HMAC）。`ok` 为假则记 infra `prerun_layout`，容器不启动。检查通过之后，outputs 里出现符号链接或额外目录，记 run `布局违规`。`classify` 只记录代码，不重跑。

`relay/devii_docker_v2.py` 的 agent 启动走 `hooks.container_argv`。每次容器都是串行的 `docker run`，argv 含 `--cap-drop NET_RAW`，agent 的 `BASE_URL` 指向 relay。checker 不拿 `BASE_URL` 和 `HARNESS_RUN_ID`。挂载是这次 run 目录、CFG，以及 `/workspace/contest-data/devii` 下原来的 data_lake 和 checker tests。挂载源或目标落在 `/home/box` 下则拒绝。启动前检查 `devii-004-int` 是否存在、relay 是否在 `10.204.0.1` 上监听，任一失败则不启动容器。生产路径用宿主锁保证一次只跑一个容器。`result.json` 记下 `relay_id`（宿主 run id），checker 输出经 `copy_checker_before_sign` 拷到该 id 的 relay 目录。relay 日志默认在 `/home/box/.harness-relay`，这个目录不挂进容器。计分时缺少 relay 日志根目录会失败，不会跳过 checker 拷贝和签名。执行器的 token 只加总该 run 的 relay 账本（`ledger.tokens`）。`result.json` 里的 `tokens` 和 `task-*/trace.jsonl` 都不算数。计分时账本缺失或 run id 为空记 `usage_missing`，不是 0 token；2xx 缺 usage 同样记 `usage_missing`。

生产循环是：gap、六名 innovator、critic、ranker、赢家的一次种子 0 真实运行、reviewer。最多 10 轮。只读 token 上限把 innovator、critic、ranker 的 relay usage（i+o+cacheRead，和 `ledger.tokens` 同一套解析）加总，到 3000 万就不再开新调用。缺文件、没有 done、或 2xx 的 usage 为空都是 `usage_missing`，不是 0。innovator 出现这种情况时该轮记故障并停环；critic、ranker、reviewer 记故障轮。`options.readOnlyTokens` 只在 dry-run 里替换这个加总，execute 模式不读它。execute 模式的控制通道拒绝 `record`、`plant-role`、`plant-read`。每名 innovator 另有签名里的 200000 上限，按该次调用的 relay usage 判定，超出的候选从排序里排除。生产角色调用由宿主对每个 runId 先 `open_run` 再 `close_run`。控制面是 `harness_relay.py control`：它监听配置的 host:port（生产是 `10.204.0.1`），把角色 POST 交给 `handle()` 转发上游，用量只来自上游响应。一次性命令是 `open-run`、`close-run`、`verify-log`。角色输入、`*-input.json` 和 `sessions/*.spawn.json` 只带 roleFacing 配置和 `baseUrl`，不含 `relayLog` 和日志根。角色 cwd 不含这条路径。`close_run` 只在磁盘字节与中继进程内存里的滚动链一致时才追加 close。链的 HMAC 密钥在中继启动时用 `secrets.token_bytes(32)` 生成，只留在进程内存，不写盘，也不读 `HARNESS_ATTEST_KEY_FILE`。签文在同目录 `relay.jsonl.sig`（模式 `0600`），记下内存正文的 sha256 和链 MAC。已有签文时再次关闭不重签。链 MAC 只在中继进程还活着时能核对，因为密钥只在内存里。进程退出后的 `verify-log` 只核对签文里的 `relayLogSha` 和磁盘 sha256。磁盘与内存不一致是 `attest_mismatch`。`close_run` 这时在原文件末尾追加一条带 `fault` 的 close，文件留在原地，同一进程或重启后都能再开新 run。缺文件是 `usage_missing`。循环按中继控制通道的报告记故障轮并停环。只读 token 合计同样来自这份报告。一次 innovator 调用的用量将达到 200000，或 innovator+critic+ranker 将达到 3000 万时，中继拒绝把该次响应交回角色并返回错误。上游已经返回的这次用量计入 3000 万合计。已经到顶、还没转发给上游的拒绝不计入。2xx 缺 cached 字段是 `usage_missing`，不抛异常。缺文件、没有 done、或 2xx 的 usage 为空仍是 `usage_missing`。密钥从 `HARNESS_ATTEST_KEY_FILE` 和 `RELAY_UPSTREAM_KEY_FILE` 读取，不放进角色 argv 或角色环境。`pre-round1` 只从 `HARNESS_ATTEST_KEY_FILE` 读密钥。critic+ranker 每轮另有 3M 子上限，到顶是 `no_winner:cap_hit`，不并进 30M 停机。critic、ranker、reviewer 的最终 assistant 消息必须含结论 JSON。relay 在 done 行记下响应正文里的 assistant 文本和 `assistantSha`。`bind_role_call` 解析该 run 最后一条 done 的 assistant，只在它和角色报告的结论一致时接受。会话文本不算。运行签名带上 `relay_binding` 读出的 `relayLogSha`、`relaySha`、`bootId`。缺日志，或 `relaySha` / `bootId` 为空，签名直接拒绝。`verify_run_record` 重算 `<runId>/relay.jsonl` 的 sha256，和签名里的 `relayLogSha` 不一致就失败，并要求 `expectedRunId` 等于 checker 目录的父目录名。把 A 的记录拿到 B 的 checker 目录上会失败。签运行记录的子进程从 `HARNESS_ATTEST_KEY_FILE`（模式 `0600` 的普通文件）读 HMAC 密钥，argv 里不放密钥。`harness_relay.py` 的生产 CLI 是 `patch-active`、`control`、`open-run`、`close-run`、`verify-log`。`complete` 不在生产命令里。种请求的 `plant-request`、`plant-read`、`plant-role` 在 `plant.py`，只给测试和 dry-run。文件末尾不是换行时，红 close 前先补一个换行。上一次启动留下的未关闭日志，或末尾无法解析的行，标成 closed-red，不挡住新 run，也不删文件。中继启动时按已有日志重算 innovator、critic、ranker 的用量，红 run 记下的 usage 同样计入。`control` 必须带 `--mode dry-run|execute`，缺了就退出，不会默认打开 plant。因此 `harness_relay.py` 的 sha256 改为 `0f57630e3fb7ce642575744a4ac782f8b43388dd33237b2d1bf0f1a597ef7c44`（36822 字节）。Python 单测在 `harness-opt/relay` 目录里跑 `python3 -m unittest`。

`devii_docker_v2.py` 把 checker 写到 `{run}/verifier`。宿主在签名前把该目录原样拷到 `/home/box/.harness-relay/<runId>/checker/`（模式 `0700`，测试可以换 relay 根）。这个目录不在任何容器挂载里。`checkerOutputSha` 和 `reward` 进入运行签名。`verify_run_record(runSig, checkerOut, reward)` 同时给 reviewer 输入和 run-notes 写入用。容器里的 `verifier/reward.txt`、`result.json` 的 reward、宿主 checker 输出或 run-notes 里展示的 reward 有一处对不上，就是 `attest_mismatch`，循环停止。run-notes 里的 reward 只作展示。

第 1 轮之前签 `pre_round1`。里面有 `round0Record`（`srcPath`、`srcSha256`、`hostCopyPath`）。`round0Path` 和 `round0Sha` 是必填输入，没有默认值，缺了就拒绝。有源文件时，宿主把它拷到私有路径，字节 sha 必须等于传入的 sha，再签名。没有源文件时，`round0Record` 使用传入的路径和 sha，`hostCopyPath` 为空。当前盒子上操作者传入的路径是 `heldout/hb003/seed0/.../trace.jsonl`（中间段由操作者补全），sha256 是 `3e4f857cfbaae07c3901c379bcdcdd681c15f2438881ad943a6ab6cc957b1a76`。循环的目标题同样必填，没有默认题。`seedSha` 仍在签名里，不参与排序。另外还有 seed 0、innovator 上限 200000，以及四项停机上限 `maxRounds=10`、`readOnlyTokenCap=30000000`（innovator+critic+ranker 的 i+o+cacheRead，只认 relay usage）、`readOnlyWallCap=48h`、`realRunWallCap=103h`。critic+ranker 另有每轮 3M 子上限，到顶记 `no_winner:cap_hit`；它和 30M 累计分开判定，innovator 只计入 30M。先到先停。已经开始的真实运行会跑完并记下。`attest_mismatch`、reward 验签失败、`round0Record` 验签失败同样立即停环。停机报告把宿主证据上的故障轮和 reviewer 拒绝轮分开计数。

## EWI 和轮询

计分 EWI 是 `EWI-relay-v1`（`relay/ewi_relay.py`）。`t_first` 是宿主观察到预注册 `outputs/answer.txt` 第一次写入的时间。没有宿主观测则裁决为 `EWI不可判`，`ewi` 为 null。响应结束时间来自 relay 的 `done.ts_resp_end`，`t_end` 来自宿主时钟。600 秒标成 `新口径下未校准`。`scripts/ewi_idle.py`（sha256 `8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69`）只作为 `ewi_trace_ref`，不参与计分。`EWI_IDLE_SCRIPT` 覆盖会被拒绝。

输出监视的单测走 2 秒内容 sha 的 `poll_once`。**未核实：** inotify 能否看见容器写入。token 上限的单测直接调用 `poll_once`，不睡眠 15 秒。
