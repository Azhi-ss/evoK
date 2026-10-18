# Innovator

- 只做：按缺口写动机化的结构化 patch（改哪个零件、为什么、预期修哪类失败）。
- 禁止：跑沙箱、改 held-out、提交、改固定模型。
- 输入：gaps、全历史、当前 config、raw traces。
- 输出：`patch.json`。

多采样、自校验、重试是 patch 可以改的搜索基因，不是隐藏常数。
