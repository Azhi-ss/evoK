## 0. 结论
1) 只装一个包：`pi install npm:pi-subagents`。最新 0.79.1 已自带子代理→主会话提问的 contact_supervisor（need_decision/interview_request/progress_update）和主会话回复的 subagent_supervisor，不再需要 pi-intercom。这修正了'pi-subagents + pi-intercom 才能双向'的旧说法。
2) 不用自己写 intercom 插件；我们自建插件只装'脑子'：选择器、评测门控、证据包、谱系记录。
3) 最关键：pi-subagents 允许别的扩展注册'命名工作流资源'，里面写死'先跑哪个子代理、再跑哪条评测命令'——这正是 Orchestrator 的固定决策程序，LLM 只按名字调用。
4) 前提坑：Pi 1.x 要 Node ≥ 22.19；box 是 20.19.2 且没装 pi。

## 1. 选哪个包
pi-subagents 0.79.1（nicobailon，★3949）= 选它，最主流。备选 @tintinweb/pi-subagents 0.22.0（要 Pi ≥1.1.0）。pi-intercom 雏形不装。`@nicobailon/*` 这个 scoped 名字 npm 404 不存在，别用。

## 2. 安装
node --version（需 ≥22.19）。装 Pi：`curl -fsSL https://pi.dev/install.sh | sh` 或 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`。装编排包：`pi install npm:pi-subagents`（项目级加 -l 写 .pi/settings.json）。自检 `/subagents-doctor`。pi-subagents peer 要 @earendil-works/pi-ai >=0.86.1，evoK 锁 Pi 0.86.1 → 兼容。

## 3. 用法要点
主会话工具：subagent（唯一委派入口；可 subagent({agent,task}) / subagent({workflow:true}) 同回复写一个 js workflow 块 / subagent({workflow:'./workflows/round.js',args,cwd}) / subagent({workflow:'名字',args})）；action: validate|status|resume|stop|steer|list；subagent_supervisor({action:reply|pending})；bg_wait。旧的 /chain /parallel /run-chain 已删，链式一律写成工作流脚本。
工作流脚本里：runs.run、runs.all（有序数组）、runs.lanes、runs.steer、runs.status、emit、args（≤16KiB、冻结）。沙箱里没文件系统没 shell；runs.host（跑主机命令）只有'命名资源'授权时可用，裸脚本不能用。ok:true 只说子代理正常结束不代表干对——靠 outputSchema 状态字段或主机 gate 判定。
门控 gate（直接当评测门）：gate:'npm test' 单命令；或 typed gate gate:{command, output:'json', schema:{...}}——子代理产物落盘后在其 cwd 跑命令，stdout 必须是一个 JSON（≤12000 字）→ result.structuredOutput；不合 schema 直接判失败。gate 和 outputSchema 不能同时用。
子代理定义：一个 md 文件=一个子代理（YAML frontmatter + 系统提示）。字段 name/description/tools/excludeTools/model/thinking/systemPromptMode:replace|append/inheritProjectContext/inheritSkills/output/defaultContext:fresh|fork/acceptanceRole/subagentOnlyExtensions/timeoutMs。内置 agent：scout/researcher/evidence-auditor/worker/reviewer/oracle/delegate。注意：自定义 agent 与内置同名会整体覆盖，所以我们角色名加前缀（如 reviewer-gate）。我们角色一律 fresh（防串台，对齐 PRD 单写者）；长 brief 用文件路径传别塞 args。

## 4. 双向沟通
原生提供（不需 intercom）：子代理侧 contact_supervisor({reason,message,interview?})（need_decision/interview_request 阻塞等回复；progress_update 不阻塞）；主会话侧 subagent_supervisor({action:'pending'}) / ({action:'reply',replyTo,message})。【对我们】全自动打榜时主会话不是人，所以要么 Orchestrator 规则自动答，要么子代理不问把疑问写进输出。雏形：Gap Finder/Innovator 允许 contact_supervisor，Reviewer 不给。

## 5. Pi 插件最小骨架
官方约定：扩展 = TS 模块 export default function (pi: ExtensionAPI) {...}，Pi 用 jiti 直接加载 TS 无需编译。入口 pi.registerTool() / pi.registerCommand() / pi.on(event) / pi.appendEntry() / pi.events。不要在工厂函数里起进程/socket/定时器，放到 session_start，session_shutdown 清理。包 = 目录或 npm 包；package.json 带 keywords:['pi-package'] 和 pi:{extensions:[...],skills:[...]}。@earendil-works/pi-ai、pi-coding-agent、typebox 由宿主提供 → 写 peerDependencies:'*' 不放 dependencies。本地未发布挂载 `pi install ./local-package`（不复制按路径加载）。
evoK 里真正的 ExtensionAPI 写法在 src/cli/tui-mirror.ts（createEvokTuiMirrorExtension → pi.registerCommand）和 src/cli/prompt-mode.ts（pi.on('session_start') / pi.on('before_agent_start')）——拿这两个当工厂函数写法参考。evoK 的 plugins/evok-platform、evok-research 是 Chord facet（experimental、非正式 hot-plug），不是 pi install 那种插件模板，别照抄。我们的插件按 pi.extensions 官方约定写，不走 Chord。

## 6. 雏形目录骨架（按这个建）
```
harness-opt/                          # 我们的仓库，同时是一个 Pi 包
├── package.json                      # keywords: pi-package；pi.extensions + pi.subagents.agents
├── extensions/harness-opt/index.ts   # 注册工具 + 命名工作流资源
├── agents/{gap-finder.md, innovator.md, runner.md(可选), reviewer.md}
├── bin/{select.ts(选择器读 lineage 输出父节点 JSON), eval.ts(跑 dev + 打分 stdout JSON 给 typed gate), record.ts(写谱系/run_state)}
├── state/{lineage.jsonl, run_state.json}
├── candidates/<id>/                  # 每个候选 harness 配置 + traces
└── .pi/settings.json
```
package.json：{"name":"pi-harness-opt","version":"0.0.1","private":true,"type":"module","keywords":["pi-package"],"pi":{"extensions":["./extensions/harness-opt/index.ts"],"subagents":{"agents":["./agents"]}},"peerDependencies":{"@earendil-works/pi-coding-agent":"*","@earendil-works/pi-ai":"*","typebox":"*"}}
四个角色 md：gap-finder（tools: read,grep,find,ls,contact_supervisor；defaultContext: fresh；只读 traces 归纳失败模式，不提补丁不改文件，按 outputSchema 返回 gaps）；innovator（加 write；只写 candidates/<id>/，每个补丁写清改哪个零件/为什么/预期修哪类失败，禁碰 held-out、禁跑评测、禁提交）；reviewer-gate（acceptanceRole: read-only；只读评测 JSON 和基线判 accept/reject，不写补丁救场）；runner 雏形可不建（Runner 用 bin/eval.ts 当主机命令）。
固定工序：先裸脚本 workflows/round.js 跑通（gap-finder → innovator 带 typed gate `bun bin/eval.ts --cand .. --split dev` → reviewer-gate）；再固化成命名工作流资源（index.ts 里 session_start 注册 harnessopt.round，resolve() 必须同步无 I/O 只做校验+拼字符串，授权 hostCommands）。主会话一轮压成三步：harnessopt_select → subagent({workflow:'harnessopt.round',args}) → harnessopt_record。选什么/怎么评/过不过门都在我们代码里。
三条硬线：(1) held-out 只有 `bin/eval.ts --split heldout` 能读且只在 harnessopt_submit_gate 调，agent 工具白名单没 bash；(2) `playground submit` 只在 harnessopt_submit_gate 内部，任何 agent 不给；(3) 每轮 usageBudget.tokens.hard 上限。

## 7. 坑（实现时必踩）
前台子代理不加载父会话环境扩展，要用我们插件的工具必须 async:true 或在 agent 里写 subagentOnlyExtensions。重名覆盖→角色名加前缀。项目信任→项目级包/agent 只在项目被信任后加载，自动跑需预先信任或用个人级安装。
未核实清单（实跑逐条验，代码里留 TODO 指向本段）：裸脚本 gate.command 用 args 拼接是否被接受；`import 'pi-subagents/workflow-resources'` 分开安装时能否解析（可能需把 pi-subagents 列为本包依赖）；结构化委派 API 能否从 registerCommand handler 发起；原生 contact_supervisor 阻塞超时默认值；`pi install -l ./` 挂本地包时 pi.subagents.agents 是否被读到。
