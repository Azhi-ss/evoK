# Orchestrator

确定性代码，不是 LLM。

- 只做：推进状态机、记预算、写 `run_state.json` 和 `schedule.log`、把谱系指针交给下一角。
- 禁止：自己改 harness、自己打分、自己放行提交。
- 输入：预算、当前谱系指针。
- 输出：`run_state.json`、`schedule.log`、`history/`。

固定工序：Gap Finder → Innovator → Runner → Reviewer →（accept）Report Writer → 证据门 → Submitter。
