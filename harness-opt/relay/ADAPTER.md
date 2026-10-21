# Relay 适配说明

宿主侧 relay 是 tokens、激活、EWI-relay-v1 和角色读证据的唯一来源。本文件记录 hooks 和账本的约定，以及这台环境没有核实的部分。

## 绑定和上游

数据面只绑定 `10.204.0.1` 上的可配置端口，不绑定 `0.0.0.0`，也不做转发容器或 iptables。容器 `BASE_URL` 形如 `http://10.204.0.1:<port>/r/<runId>/v1`。上游固定为 `https://newapi.ai-modeling.top/v1/chat/completions`，只有测试参数可以换掉，请求里的 Host 或 URL 不采用。

**未核实：** 这台 VM 上绑定 `10.204.0.1` 会 `EADDRNOTAVAIL`，容器是否够得到这个地址没有实测。单测走进程内 handler，并在 bind 之前拒绝其它 host。真实 docker 出网同样未核实。

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

`relay/devii_docker_v2.py` 的 agent 启动走 `hooks.container_argv`。每次容器都是串行的 `docker run`，argv 含 `--cap-drop NET_RAW`，agent 的 `BASE_URL` 指向 relay。checker 不拿 `BASE_URL` 和 `HARNESS_RUN_ID`。挂载是这次 run 目录、CFG，以及 `/workspace/contest-data/devii` 下原来的 data_lake 和 checker tests。挂载源或目标落在 `/home/box` 下则拒绝。启动前检查 `devii-004-int` 是否存在、relay 是否在 `10.204.0.1` 上监听，任一失败则不启动容器。生产路径用宿主锁保证一次只跑一个容器。`result.json` 记下 `relay_id`（宿主 run id），checker 输出经 `copy_checker_before_sign` 拷到该 id 的 relay 目录。relay 日志默认在 `/home/box/.harness-relay`，这个目录不挂进容器。计分时缺少 relay 日志根目录会失败，不会跳过 checker 拷贝和签名。执行器的 token 只加总该 run 的 relay 账本（`ledger.tokens`）。`result.json` 里的 `tokens` 和 `task-*/trace.jsonl` 都不算数。账本缺失时记 0；2xx 缺 usage 时记 `usage_missing`。

生产循环是：gap、六名 innovator、critic、ranker、赢家的一次种子 0 真实运行、reviewer。最多 10 轮。只读 token 上限把 innovator、critic、ranker 的 relay usage（i+o+cacheRead）加总，到 3000 万就不再开新调用。critic+ranker 每轮另有 3M 子上限，到顶是 `no_winner:cap_hit`，不并进 30M 停机。critic、ranker、reviewer 只接受 `bind_role_call` 对上的结论。运行签名带上 `relay_binding` 读出的 `relayLogSha`、`relaySha`、`bootId`，`verify_run_record` 还要求 `expectedRunId` 等于 checker 目录的父目录名。把 A 的记录拿到 B 的 checker 目录上会失败。签运行记录的子进程从 `HARNESS_ATTEST_KEY_FILE`（模式 `0600` 的普通文件）读 HMAC 密钥，argv 里不放密钥。`harness_relay.py` 的生产 CLI 只剩 `patch-active`。种请求的 `plant-request`、`plant-read`、`plant-role` 在 `plant.py`，只给测试和 dry-run。因此 `harness_relay.py` 的 sha256 改为 `32623bb8b1293343af8f5a35e6ddf2a4971c765091bb6ca646cee1dbb22e3d36`。Python 单测在 `harness-opt/relay` 目录里跑 `python3 -m unittest`。

`devii_docker_v2.py` 把 checker 写到 `{run}/verifier`。宿主在签名前把该目录原样拷到 `/home/box/.harness-relay/<runId>/checker/`（模式 `0700`，测试可以换 relay 根）。这个目录不在任何容器挂载里。`checkerOutputSha` 和 `reward` 进入运行签名。`verify_run_record(runSig, checkerOut, reward)` 同时给 reviewer 输入和 run-notes 写入用。容器里的 `verifier/reward.txt`、`result.json` 的 reward、宿主 checker 输出或 run-notes 里展示的 reward 有一处对不上，就是 `attest_mismatch`，循环停止。run-notes 里的 reward 只作展示。

第 1 轮之前签 `pre_round1`。里面有 `round0Record`（`srcPath`、`srcSha256`、`hostCopyPath`）。有源文件时，宿主把它拷到私有路径再按实际字节签名。没有源文件时，声明的身份是 `srcPath=/workspace/company/runs/2026-10-21-real-executor-full/probe/i014/seed1/workspace/runs/task-g3un6z/trace.jsonl`、`srcSha256=6a213acd3b0b84c54609fbcfa492b5b2911926bafebc85b155d8e16d0f5a1e6c`，`hostCopyPath` 为空。`seedSha` 仍在签名里，不参与排序。另外还有 seed 0、innovator 上限 200000，以及四项停机上限 `maxRounds=10`、`readOnlyTokenCap=30000000`（innovator+critic+ranker 的 i+o+cacheRead，只认 relay usage）、`readOnlyWallCap=48h`、`realRunWallCap=103h`。critic+ranker 另有每轮 3M 子上限，到顶记 `no_winner:cap_hit`；它和 30M 累计分开判定，innovator 只计入 30M。先到先停。已经开始的真实运行会跑完并记下。`attest_mismatch`、reward 验签失败、`round0Record` 验签失败同样立即停环。停机报告把宿主证据上的故障轮和 reviewer 拒绝轮分开计数。

## EWI 和轮询

计分 EWI 是 `EWI-relay-v1`（`relay/ewi_relay.py`）。`t_first` 是宿主观察到预注册 `outputs/answer.txt` 第一次写入的时间。没有宿主观测则裁决为 `EWI不可判`，`ewi` 为 null。响应结束时间来自 relay 的 `done.ts_resp_end`，`t_end` 来自宿主时钟。600 秒标成 `新口径下未校准`。`scripts/ewi_idle.py`（sha256 `8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69`）只作为 `ewi_trace_ref`，不参与计分。`EWI_IDLE_SCRIPT` 覆盖会被拒绝。

输出监视的单测走 2 秒内容 sha 的 `poll_once`。**未核实：** inotify 能否看见容器写入。token 上限的单测直接调用 `poll_once`，不睡眠 15 秒。
