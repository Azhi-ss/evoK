# Pi 0.83.0 资源加载逻辑与 evok 对照

核对对象：本项目安装的 `@earendil-works/pi-coding-agent@0.83.0`，不是全局 Pi 的最新版。本文记录源码事实与设计建议，不代表 evok 已实现资源加载或 CLI。

## 结论

- **不需要自建信任确认流程。** 裸 SDK 默认允许项目资源加载；交互式 Pi CLI 的项目信任处理是另一层启动策略。用户已明确选择 evok 直接加载配置来源，不询问首次信任。[S1][S2][S3]
- 提示词选择、skill 解析、元数据注入、显式 skill 展开都已有 SDK 实现。evok 需要适配自己的资源路径和执行目录，不能只把 `noSkills` 翻成 `false`。[S4][S5][S6][S7]
- `agentDir: ~/.evok` 只改用户配置根，不会把项目 `.pi` 改为 `.evok`，也不会自动排除全局 `~/.agents/skills`。[S8][S9]

## 1. SDK 启动链路

```text
createAgentSession(options)
  ├─ 确定 cwd、agentDir、ModelRuntime、SettingsManager、SessionManager
  ├─ 没传 resourceLoader：创建 DefaultResourceLoader → reload()
  ├─ 传了 resourceLoader：直接使用，调用者负责先 reload()
  └─ AgentSession
       └─ 按实际启用的工具重建 system prompt
            基础提示词 + append + context files + skills 索引 + cwd
```

`cwd` 既是默认发现项目资源的起点，也是工具工作目录的默认来源。使用显式 loader 后，资源来源由 loader 决定，session 的工具 cwd 可以另设为 Run 工作区。[S2][S6]

## 2. 信任：SDK 与 CLI 不是同一个默认流程

| 路径 | 0.83.0 的实际行为 |
|---|---|
| `SettingsManager.create()` / `inMemory()` | `projectTrusted` 默认 `true` |
| 裸 `createAgentSession()` | 默认 loader 调用普通 `reload()`，没有项目确认 UI |
| `loader.reload({ resolveProjectTrust })` | 只有显式传入此回调，才先进入未信任阶段，再调用外部决策 |
| Pi CLI | 额外调用 trust resolver；未知项目在交互模式可询问，非交互默认 `ask` 则不加载受信任控制的项目资源 |

CLI 的 `--approve`、已有信任记录、全局 `defaultProjectTrust` 等会改变 CLI 决策。SDK 的初始 `projectTrusted: true` 与全局设置 `defaultProjectTrust: ask` 不是同一个开关。普通 reload 保持当前 trust 状态，不会替调用者重新询问。[S1][S2][S3]

**evok 已确认的选择：**不接 CLI 信任 UI，不维护首次信任注册表，直接加载约定的提示词/skills。资源加载和工具权限是两件事；本决定不自动批准第三方 extension 执行或安装 packages。[S2][S3][S10]

## 3. 系统提示词的选择与拼接

### 选择基础提示词

按优先级选一份：

1. 显式传入的 `systemPrompt`（CLI 对应 `--system-prompt`）；
2. `<cwd>/.pi/SYSTEM.md`；
3. `<agentDir>/SYSTEM.md`；
4. 都没有时使用 SDK 内置 coding assistant prompt。

项目文件由 loader 的 `projectTrusted` 状态控制。`systemPromptOverride` 可以替换选择后的结果。文件内容作为完整基础提示词替换，而不是与内置基础提示词叠加；但 context 与 skills 索引仍会继续加入。[S4][S7]

### 追加提示词

`APPEND_SYSTEM.md` 同样是**项目优先、用户兜底，只选一份**。显式 `appendSystemPrompt` 数组替代自动发现，可以承载多段；`appendSystemPromptOverride` 可修改最终数组。这不是“用户 APPEND + 项目 APPEND 总是叠加”。[S4]

### 最终 system prompt

```text
自定义 SYSTEM 或内置基础提示词
+ 选中的 APPEND 内容
+ context files 的完整正文
+ skills 的 name / description / location 索引
+ session cwd
```

在 0.83.0 中，只有启用 `read` 工具才加入自动 skills 索引。skill 完整正文不会默认塞进 system prompt。[S6][S7]

## 4. AGENTS.md 上下文

- 先取 `<agentDir>` 中的上下文文件。
- 再从 cwd 沿祖先目录查找，按较远祖先到 cwd 顺序拼接。
- 同一目录候选顺序为 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`，只加载第一份可读文件。
- 普通上下文祖先遍历到文件系统根，不像项目 `.agents/skills` 在 Git 根停止。
- `noContextFiles` 可关闭；`agentsFilesOverride` 可控制结果。
- 本地锁定的 0.83.0 实现没有 `AGENTS.override.md` 候选，不应把新版文档行为混入本版本。[S11]

这是完整正文上下文，和按需读取的 skills 不是同一机制。

## 5. Skills 发现、去重和读取

### 默认来源

- 用户：`<agentDir>/skills/`、`~/.agents/skills/`；
- 项目：`<cwd>/.pi/skills/`；
- 项目共享目录：从 cwd 到最近 Git 根的每一级 `.agents/skills/`，没有 Git 根时遍历到文件系统根；
- settings 配置的 paths、已配置 packages、显式 `--skill` / `additionalSkillPaths`。[S5][S8]

### 格式与扫描

- 递归寻找 `SKILL.md`；某目录自身有 `SKILL.md` 时即视为 skill 根，不继续进入其参考资料目录发现 skills。
- 自动 `.pi/skills` 支持顶层 `.md`；自动 `.agents/skills` 只发现 `SKILL.md`，忽略顶层和分组中的普通 `.md`（0.83.0）。
- 跳过隐藏子目录、`node_modules`，应用 `.gitignore` / `.ignore` / `.fdignore`。
- `description` 缺失或解析失败则跳过并报告诊断；名称格式等多数问题只警告。
- 名称缺省时解析器用父目录名；文档格式仍建议显式写 `name`。
- `allowed-tools` 并不在这个版本的 skill 解析结果中形成工具授权；不能靠 frontmatter 扩权。[S5][S8]

### 同名优先级

普通资源发现经过排序后，skill 去重采用“第一份胜出，并诊断冲突”：

```text
项目 settings 显式路径
> 项目自动发现
> 用户 settings 显式路径
> 用户自动发现
> package 资源
```

同为项目自动发现时，本版本先加入 `.pi/skills`，再加入从 cwd 向上的 `.agents/skills`。同一个真实文件经符号链接重复出现会去重。`additionalSkillPaths` 是追加来源；不能把它概括成“CLI 的同名 skill 总能覆盖所有默认来源”。`noSkills: true` 禁用默认发现，但显式 paths 仍可加载。[S4][S5][S8]

### 两条使用路径

1. **自动使用：** system prompt 仅含 skill 名称、描述、文件位置；模型匹配任务后调用 `read` 读取正文，再按步骤操作。
2. **显式使用：** `/skill:name 参数` 由 `AgentSession` 同步读取对应文件、去掉 frontmatter、包装为 skill 内容并注明相对引用的基准目录，随后送入模型。这是提示词展开，不是 skill 本身变成新的工具或独立 Agent。

`disable-model-invocation: true` 隐藏自动索引，但仍可显式调用。相对引用从 skill 自己的目录解析。模型自动选择是否读取仍是模型行为，不是宿主保证执行每一个匹配 skill。[S5][S6]

## 6. 对 evok 的最小适配建议（尚未实现）

已确认的来源是 `~/.evok`、项目 `.evok` 和项目 `.agents/skills`，而非继承整个日常 Pi 环境。建议只做路径适配，复用 SDK 解析与会话行为：

- 对 `SYSTEM.md`、`APPEND_SYSTEM.md` 显式选择项目 `.evok` 或用户 `~/.evok` 文件，保持 Pi 的“项目优先、只选一份”语义；默认 evok 基础提示词内容仍待设计。
- 给 SDK 提供明确的 skill 文件来源，保留冲突诊断、元数据索引和 `/skill:` 展开。不写第二套 YAML/Markdown parser，不新增 skill Agent 服务。
- 阻止默认 `.pi` / 全局 `.agents` 资源混入。只改 `agentDir` 不够：SDK 项目目录常量来自它自身 package.json 的 `.pi`，且 package manager 独立加入 `~/.agents/skills`。
- 若使用 `noSkills: true + additionalSkillPaths` 装配明确来源，注意显式传整个 `.agents/skills` 目录会允许顶层普通 `.md`，与自动 `.agents` 规则有差别；要保持一致，可只枚举 `SKILL.md` 再交给 SDK 解析。
- 区分研究项目路径与 Run 临时 cwd：发现时使用研究项目，执行时使用隔离工作区。用户已选择原位置只读访问已发现的 skill 目录（含引用资源），不复制 Mission 资源快照；不能仅把工作区外路径写进索引，然后被现有 `SandboxBoundary` 拒绝。skill 读取不得扩大写入/执行权限，运行期间外部修改可能被后续读取看到（ADR-0006）。
- 工具 allowlist、安全扩展、compaction/retry 策略继续由 `PiAgentRuntime` 保持。传入 custom loader 会替代当前 default loader，因此不能遗失现有安全扩展。
- 完整 `DefaultResourceLoader.reload()` 还会解析 packages、加载 extensions；“直接读提示词和 skills”不等于需要把 package 自动安装和第三方 extension 执行也一并打开。[S2][S4][S8][S9][S10][S12]

建议的装配关系：

```text
evok 启动
  → 确定研究项目和 evok 资源来源（无信任询问）
  → SDK ResourceLoader：SYSTEM / APPEND / context / skills
  → PiAgentRuntime：实际 model、工具策略、Run cwd
  → createAgentSession({ resourceLoader, ... })
  → SDK 提示词拼接与工具循环
```

不 fork SDK，不修改依赖包的 package.json，不把它的完整 CLI 启动流程搬进 evoK。模型/认证已选择共享现有 Pi 配置（ADR-0005）；角色技能可见性和发现索引的重载时机仍是单独设计问题。

## 7. 本地验证

临时目录探针：`/tmp/evok-pi-loading-probe-uqbqe6sg/probe.mjs`，结果 `results.json`。使用安装的 0.83.0 SDK，隔离 HOME 和假项目，**零网络、零模型调用**，没有加载用户真实配置或第三方 extensions。

运行：

```sh
PI_OFFLINE=1 PI_TELEMETRY=0 bun /tmp/evok-pi-loading-probe-uqbqe6sg/probe.mjs
```

全部断言通过，覆盖：默认 SDK 无信任记录加载、SYSTEM/APPEND 项目优先、context 顺序、项目 settings/自动来源去重、嵌套 SKILL 发现、缺 description 跳过、正文未进入启动提示词、显式专用 skill 隐藏、无 read 不注入索引、noSkills+显式路径、修改 agentDir 后项目仍取 `.pi` 与全局 `.agents` 仍被发现。

这验证 SDK 的资源行为，不是 evok CLI/skills 功能已上线的证明。当前 evoK `src/pi-agent-runtime.ts:580–589` 仍关闭默认 skills/context/templates 加载。[S12]

## 源码索引

以下路径均相对本仓库的 `node_modules/@earendil-works/pi-coding-agent/`，行号对应 **0.83.0** 的已安装源码；升级 SDK 后应重新核对。

- **[S1]** `dist/core/settings-manager.js:136–175,249–299`：默认 projectTrusted、create/inMemory、reload。
- **[S2]** `dist/core/sdk.js:66–80,132–137,244–266`：SDK 装配、loader 和工具参数。
- **[S3]** `dist/core/resource-loader.js:255–280`；`dist/core/project-trust.js:17–58`；`dist/main.js:521–579`：可选 trust hook 与 CLI 层决策。
- **[S4]** `dist/core/resource-loader.js:329–340,380–396,499–519,808–830`：显式 skill paths、提示词选择与 overrides。
- **[S5]** `dist/core/skills.js:121–244,257–387`：扫描、frontmatter、索引、同名与真实路径去重。
- **[S6]** `dist/core/agent-session.js:710–740,950–974`：最终提示词装配与 `/skill:` 展开。
- **[S7]** `dist/core/system-prompt.js:7–110`：基础 prompt、append、context、skills、cwd 的拼接。
- **[S8]** `dist/core/package-manager.js:49–65,193–289,694–727,1904–1985,2035–2057`：来源、扫描范围、优先级。
- **[S9]** `dist/config.js:390–420`；`dist/core/settings-manager.js:43–50`：`.pi` 常量和 agentDir 的不同职责。
- **[S10]** `dist/core/resource-loader.js:275–280,424–445`；`dist/core/package-manager.js:977–1027`；`dist/core/agent-session.js:1940–2015`：package/extension 加载与独立工具过滤。
- **[S11]** `dist/core/resource-loader.js:31–109,370–379`：AGENTS/CLAUDE 候选、祖先顺序、context 开关。
- **[S12]** evoK 自身 `src/pi-agent-runtime.ts:556–598,765–783`；`src/security-boundary.ts:207–224`：当前默认 loader、安全扩展和路径限制。

参考文档（同一安装版本，已完整阅读）：`docs/sdk.md`、`docs/skills.md`、`docs/settings.md`、`docs/packages.md`、`docs/prompt-templates.md`。实际规则以以上源码和探针为准。
