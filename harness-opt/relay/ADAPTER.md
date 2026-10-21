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

不足 200 字节的文件必须整文件匹配。片段还要至少 3 行且至少 200 字节、全文里只出现一次、行对齐，并且 `toolName` 为 `read`、参数路径指向该宿主文件、请求 seq 早于结论。引用的行号必须整个落在片段内，并盖到至少一行非空行。

## 布局、配对和 ITT

容器启动前写 `preRunLayout`（`ok`、`checks`、checks 的 sha，再加 HMAC）。`ok` 为假则记 infra `prerun_layout`，容器不启动。检查通过之后，outputs 里出现符号链接或额外目录，记 run `布局违规`。

`pair_rerun_decision` 不接收 reward、EWI 或 checker 正文。只有 `final` 或 `dev`、计数器为 0、代码是 `{relay_restart, docker_daemon_event, usage_missing}` 的非空子集、且每条都有宿主证据时才重跑，并作废整对。同一 block 里多对都满足时只重跑最早的一对，其余是 `{action: no, reason: block_cap}`。计数器不为 0 则 `{action: stop, reason: cap}`。决定写入只追加、带 HMAC、并 fsync 的 `pair_decision` 记录。编排器在读任何 reward 之前先做这个决定。

`itt_summary(schedule, results, run_notes, key)` 先检查日程 HMAC。签名失败抛 `ValueError("schedule signature failed")`。日程 sha 和 run-notes 里的 `scheduleSha` 不一致则抛 `ValueError("schedule sha does not match run-notes")`。两种情况都不返回部分数字。签名和 sha 都通过时，分母是未作废的槽位数。

## EWI 和轮询

计分 EWI 调用仓库里的 `scripts/ewi_idle.py`，字节与批准稿相同，sha256 `8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69`。`ts_of` 在列表推导里调用，非有限 `ts` 抛 `ValueError('missing ts')`。`EWI-relay-v1` 是另一套指标，不改这个文件。

输出监视的单测走 2 秒内容 sha 的 `poll_once`。**未核实：** inotify。token 上限的单测直接调用 `poll_once`，不睡眠 15 秒。
