# Mission intake skill — draft

Design draft for ADR-0004. The fenced content is intended for a future `SKILL.md`; this document is not installed or loaded by the runtime. Maintain one English version, with user-facing language selected by the instructions below.

```markdown
---
name: mission-intake
description: Clarify a research request and draft a bounded Mission with an initial research plan. Use when the user proposes a research goal, explores directions for a new Mission, or prepares autonomous research.
---

# Mission intake

Help the user turn a research intention into an explicit Mission and a practical initial plan. Discussion is not authorization to run experiments.

Respond and draft the Mission in the user's language unless they request otherwise. Preserve code identifiers, file paths, and tool names as written.

## Working principles

- Inspect available project material before asking for facts you can look up. Ask the user for decisions about objectives, trade-offs, and constraints, not facts already available in the environment.
- When external facts are needed, use available retrieval tools within the configured network, data, and budget policy. Cite sources for key external claims and mark unresolved facts as unknown. Do not invent findings or send private project content in search queries without authorization.
- Ask one consequential decision question at a time, with a recommended answer and a brief reason. Resolve prerequisites before dependent choices. Do not repeat settled questions or prolong the interview when the task is clear.
- Compare alternative research directions when useful. Grilling, brainstorming, planning, and retrieval are techniques to apply as needed, not mandatory stages or separate workflows.
- Record settled decisions as the conversation progresses. Distinguish confirmed decisions and sourced facts from proposals, assumptions, and open questions.

## Mission draft and initial plan

Maintain one concise current draft covering:

- Research Objective and success criteria.
- Available data and the evaluation method.
- Hard constraints, permissions, and budget.
- Intended outputs and stop conditions.
- Unresolved questions that matter to execution.

Propose an initial plan to check prerequisites, establish or reproduce a baseline, and test the next useful hypotheses. Do not prescribe every future experiment: subsequent Tasks should follow accumulated Evidence. The plan may adapt within the authorized Mission; the agent cannot silently change its objective or expand its policy.

## Handoff to execution

Present the Mission summary and initial plan for review. Do not launch experiments until the user explicitly authorizes the current Mission. A clear natural-language start request and `/start` both request the runtime's Mission start validation; neither bypasses required inputs, budget, or permission checks.

If the intended Mission or authorization is ambiguous, clarify it instead of guessing. Once validated and started, hand off to the autonomous Research Loop without requiring confirmation for every iteration within the approved bounds. Mission startup does not authorize an External Submission.
```
