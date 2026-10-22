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

生产循环是：gap、六名 innovator、critic、ranker、赢家的一次种子 0 真实运行、reviewer。critic 排除后只剩 1 个候选时不调用 ranker，该候选记 `rank=walkover` 并进入真实运行。一个都不剩时记 `no_winner`，下一轮重新生成候选。剩下至少 2 个时才调用 ranker。赢家是绑定的 `winnerId`（在候选列表里且未被 critic 排除）。键数排序只记录在 `codeRank`，不否决。空的、无效的或已排除的 `winnerId` 是 `no_winner:ranker_invalid`。没有赢家的轮次在 closure、轮次记录和 stopReport 里写下原因。最多 10 轮。只读 token 上限把 innovator、critic、ranker 的 relay usage（i+o+cacheRead，和 `ledger.tokens` 同一套解析）加总，到 3000 万就不再开新调用。缺文件、没有 done、或 2xx 的 usage 为空都是 `usage_missing`，不是 0。innovator 出现这种情况时该轮记故障并停环；critic、ranker、reviewer 记故障轮。`options.readOnlyTokens` 只在 dry-run 里替换这个加总，execute 模式不读它。execute 模式的控制通道拒绝 `record`、`plant-role`、`plant-read`。每名 innovator 另有签名里的 200000 上限。中继按单次调用拒绝将满这个数的转发。宿主再把该 innovator 各次尝试的用量加总，账本一旦越过就杀掉还在跑的进程，重试前再查一次，候选记 `cap_hit`。生产角色调用由宿主对每个 runId 先 `open_run` 再 `close_run`。控制面是 `harness_relay.py control`：它监听配置的 host:port（生产是 `10.204.0.1`），把角色 POST 交给 `handle()` 转发上游，用量只来自上游响应。一次性命令是 `open-run`、`close-run`、`verify-log`。角色输入、`*-input.json` 和 `sessions/*.spawn.json` 只带 roleFacing 配置和 `baseUrl`，不含 `relayLog` 和日志根。角色 cwd 不含这条路径。`close_run` 只在磁盘字节与中继进程内存里的滚动链一致时才追加 close。链的 HMAC 密钥在中继启动时用 `secrets.token_bytes(32)` 生成，只留在进程内存，不写盘，也不读 `HARNESS_ATTEST_KEY_FILE`。签文在同目录 `relay.jsonl.sig`（模式 `0600`），记下内存正文的 sha256 和链 MAC。已有签文时再次关闭不重签。链 MAC 只在中继进程还活着时能核对，因为密钥只在内存里。进程退出后的 `verify-log` 只核对签文里的 `relayLogSha` 和磁盘 sha256。磁盘与内存不一致是 `attest_mismatch`。`close_run` 这时在原文件末尾追加一条带 `fault` 的 close，文件留在原地，同一进程或重启后都能再开新 run。缺文件是 `usage_missing`。循环按中继控制通道的报告记故障轮并停环。只读 token 合计同样来自这份报告。一次 innovator 调用的用量将达到 200000，或 innovator+critic+ranker 将达到 3000 万时，中继拒绝把该次响应交回角色并返回错误。上游已经返回的这次用量计入 3000 万合计。已经到顶、还没转发给上游的拒绝不计入。2xx 缺 cached 字段是 `usage_missing`，不抛异常。缺文件、没有 done、或 2xx 的 usage 为空仍是 `usage_missing`。密钥从 `HARNESS_ATTEST_KEY_FILE` 和 `RELAY_UPSTREAM_KEY_FILE` 读取，不放进角色 argv 或角色环境。`pre-round1` 只从 `HARNESS_ATTEST_KEY_FILE` 读密钥。critic+ranker 每轮另有 3M 子上限，到顶是 `no_winner:cap_hit`，不并进 30M 停机。宿主在进程还在跑时就把这两项加总，越过就杀掉，并且在下一次重试之前再查。`close_run` 抛错是 `relay_close_failed`，记故障轮，不记 0 token 再重试。`pre_round1` 含 `gateRuleSha`。它是一份两行清单的 sha256，不是单文件哈希。清单每行是 `docs/reviewer-gate-rules.md <该文件 sha256>` 和 `src/modules/reviewer-gates.ts <该文件 sha256>`，行末换行，路径相对 `harness-opt/`。reviewer 的判决是宿主的 G0–G3：G0 失败是 `anti_forgery`，G2 的拒绝码是 `inactive_key`，G3 要求真实运行已计分、墙钟低于该题官方 `[agent].timeout_sec`、timedOut 为假，且 reward 不低于最近一次已签名基线。模型只写 `reason`，不写 accept 或 verdict。补丁后的 harness 把三个计数分开：`agent-loop.maxSteps` 截断的是 `agent_end` 步数（`stats.turns`、`run_end.steps`）；分支源码里的 `goal.maxContinuationTurns` 截断的是 continuation turn（pi-goal 的 automatic model response），这个数写进 `continuationLimits.automaticTurns`，也就是 `run_end.goalContinuationTurns`；relay 调用是 trace 里的 `assistant_message` 和 `auto_retry_start`，不由这两个上限截断。有效旋钮名单只含已签名基线 harness（sha `4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c`）读到的 `effective["..."]` 键，不含 `goal.maxContinuationTurns`。`closure.json` 记下每道门。`--stop-before-run` 把 G1 和静态 G2 记成 preflight，`final` 为 false。环启动时，有效旋钮名单上的键若在所挂 harness 里没有 `effective["..."]` 入口，就拒绝启动。critic、ranker、reviewer 的最终 assistant 消息必须含结论 JSON。relay 在 done 行记下响应正文里的 assistant 文本和 `assistantSha`。`bind_role_call` 解析该 run 最后一条 done 的 assistant；critic 和 ranker 只在它和角色报告的结论一致时接受。reviewer 的结论只有 `reason`，不改变宿主判决。会话文本不算。运行签名带上 `relay_binding` 读出的 `relayLogSha`、`relaySha`、`bootId`。缺日志，或 `relaySha` / `bootId` 为空，签名直接拒绝。`verify_run_record` 重算 `<runId>/relay.jsonl` 的 sha256，和签名里的 `relayLogSha` 不一致就失败，并要求 `expectedRunId` 等于 checker 目录的父目录名。把 A 的记录拿到 B 的 checker 目录上会失败。签运行记录的子进程从 `HARNESS_ATTEST_KEY_FILE`（模式 `0600` 的普通文件）读 HMAC 密钥，argv 里不放密钥。`harness_relay.py` 的生产 CLI 是 `patch-active`、`control`、`open-run`、`close-run`、`verify-log`。`complete` 不在生产命令里。种请求的 `plant-request`、`plant-read`、`plant-role` 在 `plant.py`，只给测试和 dry-run。文件末尾不是换行时，红 close 前先补一个换行。上一次启动留下的未关闭日志，或末尾无法解析的行，标成 closed-red，不挡住新 run，也不删文件。中继启动时按已有日志重算 innovator、critic、ranker 的用量，红 run 记下的 usage 同样计入。`control` 必须带 `--mode dry-run|execute`，缺了就退出，不会默认打开 plant。因此 `harness_relay.py` 的 sha256 改为 `db5ebd725365000681c8aa88945327e88abd94a13bdc21343771795b174dfe91`（38686 字节）。Python 单测在 `harness-opt/relay` 目录里跑 `python3 -m unittest`。

`hooks.reconcile_first_run` 的题来自独立的 `--expected-task`（预注册），没有默认题，也不从 `--task` 填。空的 `expected_task` 直接拒绝。只有配置的任务、control 配置 sha、seed 9、`control` 臂、`reconcile` 为真、并且还没有接受过，才记 `purpose=reconcile` 并从统计里排除。零条 relay 请求、agent 非 0 退出、或没有 `task-*` 目录时，`accepted` 为假，运行 unscored 且不签名。`once --reconcile` 和环里种子 9 的已计分 control 真实运行都走这个判断。

`devii_docker_v2.py once` 跑一题、一个 seed、一条臂（`control` 或 `candidate`）。task 可以是 `hb003`，解析成 `tasks3/hb003`。它复用 `agent_cmd` → `hooks.container_argv`，不再包一层 sudo。容器内无真实密钥，只有固定占位符 `API_KEY=relay-placeholder-not-a-key`（r14）。其它 `API_KEY` 在 docker 之前拒绝。中继转发时丢掉客户端 `Authorization`，换成 `RELAY_UPSTREAM_KEY_FILE`。`once` 的 `_standalone_relay` 和环的 `harness_relay.py control` 用同一个 `use_network_upstream`：默认 `UPSTREAM_URL`，密钥是 `RELAY_UPSTREAM_KEY_FILE`。请求头固定 `User-Agent: Mozilla/5.0`，与 `Authorization`、`Content-Type` 一起发出，不能改。生产路径如果上游是 `_default_upstream` 或其它假上游，拒绝启动或 `open_run`，并在日志根的 `reject.jsonl` 记下 `fake_upstream`。假上游只接受构造参数 `allow_fake_upstream=True`。真实上游冒烟默认跳过。在 `harness-opt/relay` 下设置 `RELAY_LIVE_SMOKE=1` 和 `RELAY_UPSTREAM_KEY_FILE` 后跑 `python3 -m unittest test_relay.LiveUpstreamSmoke.test_one_chat_reaches_the_real_upstream`。它不 bind `10.204.0.1`，经 `handle` 发一条非流式 chat，要求 `choices` 非空，且 `usage` 的 prompt 与 completion 都是整数、两者之和大于 0。启动 agent 前，若固定名的容器还在，用 `container_argv` 同一条 `sudo -E docker` 先 `kill` 再 `rm -f`，把 name 和 id 写入 `devii_one.log`，运行照常计分。`BASE_URL` 是 `http://10.204.0.1:<port>/r/<runId>/v1`。故障行的 `tokens` 取 `close_run` 报告里的内存值，没有这条链时为 null。宿主分配 runId。单独运行时这个进程自己 `Relay` 监听、`open_run`（kind `executor`）、docker、checker、`close_run`。这次 `close_run` 若是 `attest_mismatch` 或 `usage_missing`，运行记为故障：unscored、不签名、也不当作预注册对账。环里的真实运行把同一个命令加上 `--relay-external`：环已经打开这次 run，子进程不 bind、不 open、不 close。tokens 只来自 `relay_usage_tokens`。缺日志或空 runId 是 `usage_missing`。挂载的 harness 必须是 sha256 `4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c`，否则 docker 之前拒绝，并把这个 sha 写进 `result.json` 的 `mountedHarnessSha`。checker 之后、签名之前，`once` 再用 `hooks.container_argv` 起一个容器，把 `workspace` 只读挂上，`cp -a` 最后的 `workspace/runs/task-*` 到 `<run>/task-copy/`，并 `chown` 给调用者的 uid/gid。原件不改。`result.json` 记下 `taskCopySha`。随后调用 `copy_checker_before_sign` 再 `sign_run_record`（`checkerOutputSha`、`reward`、`relayLogSha`、`relaySha`、`bootId`）。评估器 null 分是 unscored，reward 留空，原因从 `.scorer-result.json` 保留。有 `--attest-dir` 时，在 `result.json` 写完之后写 `devii-opt-attest/v1`。这个目录不能和 run 目录嵌套。`optimize --control-attest` 读的就是这份 `attestation.json`。relay 日志和 `run-record.json` 留在 `HARNESS_RELAY_LOG_ROOT/<runId>/`。已经落地、当时没写证明的 control 运行用 `devii_docker_v2.py attest --run-dir <run> --harness <file> --config <file> --attest-dir <dir>` 补写，调用同一个 `write_run_attestation`，不启动 docker。trace 的 `run_start.candidateConfigHash` 必须等于 control 文件的 sha256，转换器不改 trace。`attest` 不改 run 目录。`task-copy/trace.jsonl` 是普通文件时，trace、session、output 都读 `task-copy/`，下一轮 gap-finder 用的也是这条 trace。没有这份拷贝时，顶层有普通文件 `trace.jsonl` 就用它，否则用 `workspace/runs/task-*` 里按名字排序后最后一个含 `trace.jsonl` 的目录；`.pi-sessions` 和 `outputs` 先用顶层已经有文件的树，否则用这个 task 目录里的树。读不到目录时以 `attest cannot read ...` 失败关闭，不把 PermissionError 抛出去。这样 `traceSha`、session 和 output 哈希会写上，`candidateConfigHash` 核对才会发生。

生成 control-r5 的证明目录：

```bash
HARNESS_ATTEST_KEY_FILE="$HARNESS_ATTEST_KEY_FILE" RELAY_UPSTREAM_KEY_FILE="$RELAY_UPSTREAM_KEY_FILE" \
HARNESS_RELAY_LOG_ROOT=/home/box/.harness-relay \
python3 harness-opt/relay/devii_docker_v2.py once \
  --task hb003 --seed 9 --arm control --reconcile --expected-task hb003 \
  --config /workspace/harness-opt-runs/config/control.json \
  --run-dir /workspace/harness-opt-runs/reconcile/hb003/seed9/control-r5 \
  --harness /workspace/harness-opt-runs/config/harness.pr202.mjs \
  --attest-dir /workspace/harness-opt-runs/reconcile/hb003/seed9/control-r5-attest \
  --out /workspace/harness-opt-runs/reconcile/hb003/seed9
```

第 1 轮：

```bash
BASE_URL="$BASE_URL" \
RELAY_UPSTREAM_KEY_FILE="$RELAY_UPSTREAM_KEY_FILE" \
HARNESS_ATTEST_KEY_FILE="$HARNESS_ATTEST_KEY_FILE" \
HARNESS_RELAY_LOG_ROOT=/home/box/.harness-relay \
bun harness-opt/src/cli.ts optimize --execute --rounds 1 \
  --out /tmp/harness-opt-loop \
  --pi-bin "$PI_BIN" \
  --attest-root /tmp/harness-opt-attest \
  --attest-key-file "$HARNESS_ATTEST_KEY_FILE" \
  --harness /workspace/harness-opt-runs/config/harness.pr202.mjs \
  --control-config /workspace/harness-opt-runs/config/control.json \
  --control-attest /workspace/harness-opt-runs/reconcile/hb003/seed9/control-r5-attest \
  --task hb003 --task-path tasks3/hb003 --network devii-004-int --token-w 9024166 \
  --round0-trace 'heldout/hb003/seed0/.../trace.jsonl' \
  --round0-sha 3e4f857cfbaae07c3901c379bcdcdd681c15f2438881ad943a6ab6cc957b1a76
```

gap-finder 启动前，环把 round-0 trace 和已验证的 control trace 以 `0444` 拷进该角色 cwd 的 `traces/`，文件名不含 `private`。sha 对不上就停。任务提示和 `relayCited` 只用这些拷贝。相对读路径按该角色 cwd 解析，realpath 必须留在 cwd 内并等于这份拷贝；`..` 和指向 cwd 外的符号链接不算。绝对路径仍按原路径比较。`cite-check --log <relay.jsonl> --cwd <角色 cwd> --file <拷贝> --sha <sha>` 离线重放。`stageGapTrace` 用 `O_EXCL|O_NOFOLLOW` 写这些拷贝。角色非 0 退出里，HTTP 5xx、非上限 429 和网络错误最多 3 次，间隔 5 秒、20 秒。用尽后 gap-finder、critic、ranker、reviewer-gate 记 `role_failed` 并写下 closure；innovator 的任何失败（含退出 0 但没有结论）都让该候选无效，这一轮继续。未知异常记 `internal_error` 并写下 closure。每次尝试的用量计入 innovator 20 万和 critic+ranker 300 万。日志路径未知时 stderr 里的 429 不重试。`LOOP_LIVE_SMOKE=1` 且 `PI_BIN`、`LOOP_LIVE_ROUND0`、`LOOP_LIVE_ROUND0_SHA` 都设置时，`bun test harness-opt/src/modules/opt-loop.test.ts -t "live role smoke"` 用真实 Pi 跑 gap-finder、innovator、critic、ranker（或 walkover）和 reviewer-gate，然后停，不调用 `once`，不启动 docker。ranker 给出仍在候选里的 `winnerId` 时，reviewer-gate 必须有真实 relay 调用并且结论已记下，否则 `--stop-before-run` 和这次冒烟都失败。引用检查失败则测试失败。每个跑过的角色都要退出码 0，并且自己的 relay 账本里至少有一条 done，usage 折成的 tokens 大于 0。没设这些变量就跳过。盒子上的 Pi 是 `/home/box/.local/bin/pi`（CLI 1.3.0），PATH 里要有 Node 22（`~/.nvm/versions/node/v22.23.3/bin`）。`--execute` 用 `--print`、`--system-prompt harness-opt/agents/<role>.md` 和这一轮的任务提示拉起角色。证据角色的 `--tools` 只有 `read`，innovator 是一条 `--tools read,write`。没有 `--pi-bin` 时仍以 `execute mode needs roles` 失败。`pre_round1` 只由环自己签。每个角色的 `models.json` `maxTokens` 默认是 ranker、critic、reviewer-gate `32768`，gap-finder 和 innovator `16384`，若模型目录上限更低则用那个数。`--role-max-tokens role=n` 按角色覆盖。上限记在 spawn 和 argv 记录里。Pi 的退出码写在 spawn 记录的 `exitCode`。空输出且撞上长度上限的非 0 退出记 `role_output_truncated`。`--execute --stop-before-run` 跑完角色链，写下 closure，在 once/docker 之前停下。角色冒烟调用的就是这条命令。

```bash
LOOP_LIVE_SMOKE=1 PI_BIN="$PI_BIN" \
LOOP_LIVE_ROUND0=/path/to/round0-trace.jsonl \
LOOP_LIVE_ROUND0_SHA=<sha256> \
RELAY_UPSTREAM_KEY_FILE="$RELAY_UPSTREAM_KEY_FILE" \
bun test harness-opt/src/modules/opt-loop.test.ts -t "live role smoke"
```

`devii_docker_v2.py` 把 checker 写到 `{run}/verifier`。宿主在签名前把该目录原样拷到 `/home/box/.harness-relay/<runId>/checker/`（模式 `0700`，测试可以换 relay 根）。这个目录不在任何容器挂载里。`checkerOutputSha` 和 `reward` 进入运行签名。`verify_run_record(runSig, checkerOut, reward)` 同时给 reviewer 输入和 run-notes 写入用。容器里的 `verifier/reward.txt`、`result.json` 的 reward、宿主 checker 输出或 run-notes 里展示的 reward 有一处对不上，就是 `attest_mismatch`，循环停止。run-notes 里的 reward 只作展示。

第 1 轮之前签 `pre_round1`。里面有 `round0Record`（`srcPath`、`srcSha256`、`hostCopyPath`）。`round0Path` 和 `round0Sha` 是必填输入，没有默认值，缺了就拒绝。有源文件时，宿主把它拷到私有路径，字节 sha 必须等于传入的 sha，再签名。没有源文件时，`round0Record` 使用传入的路径和 sha，`hostCopyPath` 为空。当前盒子上操作者传入的路径是 `heldout/hb003/seed0/.../trace.jsonl`（中间段由操作者补全），sha256 是 `3e4f857cfbaae07c3901c379bcdcdd681c15f2438881ad943a6ab6cc957b1a76`。循环的目标题同样必填，没有默认题。`seedSha` 仍在签名里，不参与排序。另外还有 seed 0、innovator 上限 200000，以及四项停机上限 `maxRounds=10`、`readOnlyTokenCap=30000000`（innovator+critic+ranker 的 i+o+cacheRead，只认 relay usage）、`readOnlyWallCap=48h`、`realRunWallCap=103h`。critic+ranker 另有每轮 3M 子上限，到顶记 `no_winner:cap_hit`；它和 30M 累计分开判定，innovator 只计入 30M。先到先停。已经开始的真实运行会跑完并记下。`attest_mismatch`、reward 验签失败、`round0Record` 验签失败同样立即停环。停机报告把宿主证据上的故障轮和 reviewer 拒绝轮分开计数。

## EWI 和轮询

计分 EWI 是 `EWI-relay-v1`（`relay/ewi_relay.py`）。`t_first` 是宿主观察到预注册 `outputs/answer.txt` 第一次写入的时间。没有宿主观测则裁决为 `EWI不可判`，`ewi` 为 null。响应结束时间来自 relay 的 `done.ts_resp_end`，`t_end` 来自宿主时钟。600 秒标成 `新口径下未校准`。`scripts/ewi_idle.py`（sha256 `8a4ec70ff0e060fda168e613f5f6a2cd98eec83d33fab77a7ef25ca83ea6ad69`）只作为 `ewi_trace_ref`，不参与计分。`EWI_IDLE_SCRIPT` 覆盖会被拒绝。

输出监视的单测走 2 秒内容 sha 的 `poll_once`。**未核实：** inotify 能否看见容器写入。token 上限的单测直接调用 `poll_once`，不睡眠 15 秒。
