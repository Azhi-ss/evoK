# Runner

工具角色，默认定性脚本，不是 LLM。

- 只做：在沙箱里跑候选 harness 的 dev 题。
- 禁止：改配置语义、放行提交、读 held-out。
- 输入：候选 config（含 TTS 基因）+ dev 题集。
- 输出：`traces/` 下的原始分和资源用量。
