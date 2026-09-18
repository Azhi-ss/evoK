---
status: accepted
---

# 0004 — evok is an autonomous research entrypoint, not a chat-dependent loop

The `evok` CLI is the entrypoint to a bounded autonomous Research Loop: once the user supplies a task, data, evaluation method, budget, and authorization, the system establishes a baseline and uses accumulated Evidence to choose and execute subsequent Experiments without requiring a human prompt at every iteration. It records results, handles failures within the authorized policy, and stops or pauses on budget exhaustion, declared stop conditions, or a need for further authorization; it cannot silently change the Research Objective, hard rules, or authorize a real External Submission.

An interactive interface may support setup, observation, and intervention, but is not the driver of each research iteration. A chat-first assistant that waits for “continue” and a fixed script that cannot use experimental feedback to choose its next action do not satisfy this v1 product boundary.

## Natural-language mission intake

The primary v1 entry accepts the user's natural-language research request and helps turn it into an explicit Mission draft; users do not have to author a `mission.json` before starting this conversation. The draft records the Research Objective, available data, evaluation method, constraints, budget, and intended outputs without treating the model's interpretation as user authorization.

Intake instructions live in a dedicated evoK skill, using Pi's skill discovery and on-demand body loading rather than hard-coding the interview into the CLI or embedding its full methodology in `SYSTEM.md`. Its description supports automatic selection for research intake; unlike the manual-only `grill-me` wrapper, it is not hidden with `disable-model-invocation: true`. Grilling, brainstorming, and planning are techniques within that skill, not separate mandatory commands, agents, or stages. The design borrows `grilling`'s fact/decision distinction, one decision question at a time with a recommendation, and confirmation before execution, plus `grill-with-docs`'s practice of recording settled decisions. evoK ships its own instructions rather than depending on another assistant's personal skill directories.

Maintain a single English version of the skill's name, description, and instructions. The agent responds and drafts the Mission in the user's language unless requested otherwise, preserving code identifiers, file paths, and tool names as written. Do not maintain duplicate localized skill files. The proposed body is recorded in [the mission intake skill draft](../mission-intake-skill.md), not installed in an active resource directory.

After the Mission draft and initial plan are presented, an explicit natural-language start request or the optional `/start` shortcut invokes the same Mission start validation. Required inputs, budget, and execution authority must be clear; ambiguous intent continues the conversation rather than starting experiments. Once authorized, research proceeds within those bounds without confirmation at each iteration.

The Mission is the continuing research effort, not a fixed script of all future experiments. Initial Tasks and their Execution Plans may be proposed during intake, while later research actions are chosen from accumulated Evidence under the authorized objective and policy.

The intake skill carries the research prompting, not a separate retrieval workflow. It directs the agent to inspect project material, retrieve external information when needed to resolve factual gaps, cite sources for key external claims, and mark unresolved facts as unknown. It does not prescribe a search sequence, mandatory deep-research phase, retrieval agent, or particular search provider. Retrieval uses actually configured tools under the existing network, data, and budget policy; skill instructions do not grant additional permissions or create a search capability by themselves.

## Foreground execution in v1

V1 runs the autonomous Research Loop in the foreground `evok` process. No built-in daemon, detached worker, or reconnect protocol is required; users who need to disconnect their terminal can use an existing terminal multiplexer such as `tmux`. Foreground execution does not require human input at each iteration, but does require the process to remain alive. Mission state, evidence, and results must still be persisted independently of the chat session; this decision does not promise uninterrupted execution after process termination.

## Project-local Mission storage

Persist each Mission under `<project>/.evok/missions/<mission-id>/`, separate from user-level configuration in `~/.evok/`. The directory holds Mission state, durable event records, results, and artifact indexes, reusing the existing research ledger and File Blueprint structures rather than introducing a parallel state model. Chat history may be retained for reference but is not the authority for recovery; credentials must not be copied into Mission storage.

Exclude `.evok/missions/` from Git by default, not the entire `.evok/` directory, so project configuration and skills can remain version-controlled. This is a storage-layout decision, not an implemented persistence layer or a grant for candidate Runs to modify controller-owned records.

## Recovery and model-led research decisions

After an interruption, reopening a project presents its unfinished Missions and remaining budgets; an explicit request resumes the selected Mission without repeating intake. Recovery uses durable records and confirmed artifacts, reuses completed results, and preserves consumed budget. Any retry uses a new Run/session rather than replaying the old conversation. Operations sent before a crash whose results were not confirmed must be reconciled from evidence before they can be adopted or safely retried; unresolved side effects cannot be treated as success or silently repeated.

The model reasons about the evidence and chooses useful next actions, including investigation, repair, retry, or a change of research direction within the authorized objective and policy. Do not encode a separate exhaustive recovery decision tree or fixed experimental workflow. The runtime retains durable execution accounting, budget/permission enforcement, duplicate-execution protection, and independent evaluation/promotion gates; model confidence does not replace those checks.

No new Mission interruption shortcut is selected here. In pinned Pi 0.83.0 interactive mode, `Ctrl+C` clears the editor and a rapid second press exits, while `Escape` is the default interrupt action. The earlier proposal to bind `Ctrl+C` directly to Mission pause is not adopted; UI key handling and Mission pause must not be conflated. Using the SDK alone does not automatically install Pi's interactive key handlers.

Remaining CLI commands, the concrete interruption UI, and the exact persisted file format remain separate design questions. SDK and resource decisions are recorded in ADR-0005/0006; this decision does not relax ADR-0001's separation of a Run's session from durable Mission state.

## Amendment (ET-TUI1 / #134, ET-ADR-PRD / #136)

The interactive surface is Pi native TUI via SDK `InteractiveMode`
(#134 / PR #135 @`f148960`), not a custom readline REPL. Foreground
`evok` still hosts the process; the TUI supports setup, observation, and
intervention and is not the driver of each research iteration. Product
baseline and six-pack mapping are recorded in
[ADR-0014](0014-prd-rsi-baseline.md).
