# 选择器方案要点（PR 随行摘录）

权威全文在本机 `/workspace/company/research/2026-10-18-evolution-selector-solutions.md`（约 41KB）。下面只保存贴进会话的落地结论，供 PR diff。团队核验以本机原文为准。

核心结论：光换选择器救不了进化；关键是把'多采样/自校验/重试（TTS）'做成可搜的 harness 配置项（TTS 基因化），因为提交物本身就是一个 harness 镜像。证据：DGM Greedy 39.7% vs weighted sampling 50.0%；Rethinking Harness Evolution (arXiv:2607.12227) 4.4 节 held-out 63.2→63.2。没有干净的公开证据证明'选择器+抗噪'能赢 matched-budget 多采样，需本地 E0/E1/E2 实验。
P0（必做）：三分数据切分 + 一次性 held-out；测噪声 sigma；配对评测 + successive halving + LCB（置信区间下界）保留；matched-budget TTS 基线门；TTS 基因化。
P1：加权父采样 + 每任务 Pareto；novelty 拒绝；patch 卫生。
P2：MAP-Elites；2-3 个 island；AB-MCTS。
不要碰：完整 UCT、CMA-ME、纯 novelty search、PBT、FunSearch 规模 islands、把线上榜分当反馈。
落地接口（接到 orchestrator.py 骨架）：Evaluator（配对评测+LCB）、Racer（successive halving）、Archive 变体（线性/Pareto/MAP-Elites）、WeightedSelector、MixedSelector、NoveltyFilter、BaselineGate（matched-budget TTS）。MVP 先用 GreedySelector + BaselineGate，其余留接口加 TODO。
