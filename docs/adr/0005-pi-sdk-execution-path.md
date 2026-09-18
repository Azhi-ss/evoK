---
status: accepted
---

# 0005 — Reuse Pi Coding Agent SDK for v1 execution

The v1 production execution path remains the existing `PiAgentRuntime` backed by `@earendil-works/pi-coding-agent` and `AgentSession`; evoK will not build a second model/tool execution loop or add a forwarding-only Agent layer. The real cold-start probe verified that the existing SDK can perform model-backed tool execution when explicitly configured, so replacing it would duplicate working model, authentication, event, and tool-loop machinery without a demonstrated need.

The Research Loop belongs to evoK: Mission Director and search policies choose subsequent Experiments under the human-owned objective, budget, and evidence gates. The SDK supplies the multi-turn execution within a Run; one Run may contain many model/tool turns, but separate Runs use separate sessions as described in ADR-0001. A unified execution path does not mean a singleton conversation shared across Missions, Roles, or Branches.

System-prompt and skill loading reuse SDK mechanisms rather than a new parser; their approved directories and direct-loading policy are recorded in ADR-0006. Role visibility remains a separate design question; approved in-place read-only skill access from Runs is recorded in ADR-0006. This ADR authorizes no code changes or removal of the existing mock/Newapi paths by itself; integrating or retiring those paths must preserve their applicable contracts and tests.

## Amendment (ET-TUI1 / #134, ET-ADR-PRD / #136)

The no-second-Agent-Loop pin extends to the interactive path. Headless
`PiAgentRuntime` and Pi native TUI (`InteractiveMode`, #134) share Pi;
evoK does not add a forwarding-only Agent layer or keep a custom
readline REPL. Run-time resource isolation (this ADR + ADR-0006) still
does not automatically inherit personal Pi prompts, skills, or
conversation history. The TUI reuses Pi's interactive / extension
surface without making that surface Mission authority. Product baseline
is recorded in [ADR-0014](0014-prd-rsi-baseline.md).

## Shared model and authentication configuration

V1 reuses Pi's existing model definitions and credential stores through SDK `ModelRuntime` (the SDK-resolved Pi configuration directory, normally `~/.pi/agent/models.json` and `~/.pi/agent/auth.json`). evoK does not copy credentials into `~/.evok`, implement another provider login system, or expose credentials to candidate workspaces; Pi/SDK retains responsibility for authentication handling. evoK may choose models and fast/deep bindings from that catalog. Sharing model/auth sources does not inherit Pi's prompts, skills, extensions, or conversation history: research resources remain independently configured under ADR-0006.
