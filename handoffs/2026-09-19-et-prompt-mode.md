# ET-PROMPT-MODE handoff — three-mode prompt switch

| field | value |
|-------|--------|
| **ticket** | #150 · 控制面 |
| **slice** | Explore / Intake / Mission overlay assembly + visible `mode=` |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；未开 ET-SKILL-NS；Admission/Budget 谓词未改 |

## Demo「三模切换」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/cli/prompt-mode.test.ts -t "no active Mission"
bun test src/cli/prompt-mode.test.ts -t "unstarted draft"
bun test src/cli/prompt-mode.test.ts -t "reviewed/active"
bun test src/cli/prompt-mode.test.ts -t "Explore keeps Pi default"
bun test src/cli/prompt-mode.test.ts -t "Intake overlay"
bun test src/cli/prompt-mode.test.ts -t "Mission overlay"
bun test src/cli/evok-cli.test.ts -t "mode="
```

期望：

1. 空项目 → `mode=explore`；叠加层只有一行 `--project` 脚注，不含 Mission 话术。
2. 只有未启动 draft → `mode=intake`；叠加层含 mission-intake L1 + 草稿字段约束 + draft≠授权。
3. 有 reviewed/active `mission.json` → `mode=mission`；叠加层含 objective / constraints / budget / stop / do not submit / baseline + L0 evoK skills。
4. TUI 启动 stdout 与 `NativeTuiLaunch.modeBanner` 可见 `mode=explore|intake|mission`；状态栏 key 为 `evok-mode`。

tty 上手：

```bash
evok                              # 空项目 → 状态栏 mode=explore
evok /intake "draft a Mission"    # 写 draft
evok                              # 再进 TUI → mode=intake
evok /start --mission <id>        # 授权启动后
evok                              # mode=mission
```

同一 TUI 会话里，下一次用户发言会按磁盘状态重算模式（`before_agent_start`），Pi 默认提示不替换，只追加叠加层。

## 打开的缝 / 未开的缝

- **打开**：`src/cli/prompt-mode.ts` 分辨率 + 叠加层组装 + `createEvokPromptModeExtension`（`setStatus` + `before_agent_start` append）；TUI launch 打印 `mode=`。
- **未开（有意）**：ET-SKILL-NS 同根标记同步；八类 skill 正文；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP 谓词；Admission / hang / T48。
