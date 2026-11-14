# ET-TUI-MIRROR handoff — TUI mirror = CLI gates

| field | value |
|-------|--------|
| **ticket** | #148 · 控制面 |
| **slice** | Pi native TUI registers evoK mirror slashes; dispatch reuses `runEvok` |
| **locks** | `#40` off；真交冻；Elite≠晋级；DeployArena standby；未开 ET-PROMPT-MODE / ET-SKILL-NS |

## Demo「TUI mirror = CLI gates」

最短可复现（不需要真开 InteractiveMode）：

```bash
bun test src/cli/tui-mirror.test.ts -t "missing evaluation"
bun test src/cli/tui-mirror.test.ts -t "unauthorized"
bun test src/cli/tui-mirror.test.ts -t "over-budget"
bun test src/cli/tui-mirror.test.ts -t "Pi owns"
```

期望：

1. TUI `/start` 缺 `evaluation.json` → 与 `evok /start` **同文案、同 exit**（configError）。
2. TUI `/research continue` 无 `MISSION_AUTHORIZED` → 与 CLI **同拒**（not authorized）。
3. TUI `/start` 注入 `BudgetExhaustedError` → 与 CLI **同拒**。
4. 冲突表：Pi 占用 `/resume`；Mission resume 是 `/mission-resume` / `/evok-resume`。

tty 上手：`evok` 进 TUI 后可调用 `/skills` `/skill <name>` `/research status` `/missions` `/intake …` `/start` `/mission-resume`。输入 `/resume` 仍是 Pi 会话恢复。

## 打开的缝 / 未开的缝

- **打开**：`src/cli/tui-mirror.ts` 目录 + 冲突表 + `executeTuiMirrorCommand` → `runEvok`；`/skill <name>` L1 disclose（现有 catalog）；Pi `extensionFactories` 注册镜像斜杠。
- **未开（有意）**：ET-PROMPT-MODE 三模叠加；ET-SKILL-NS 同根标记同步；DeployArena；`#40` / Progressive；真交。
- **未改**：Budget / EXP 谓词；Admission / hang / T48。
