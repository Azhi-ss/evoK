---
name: search
description: Decide whether to keep default parent selection or explicitly opt in to a removable Search Plugin. Use when choosing or reviewing search mount inside an authorized Mission.
owner: evok
namespace: evok
state: accepted
category: search
---

# Search

Help decide whether a Mission stays on the default parent-selection path or explicitly opts in to a removable **Search Plugin** (strong search / Progressive / MCTS). The default path is `fixed_uct` and does not depend on any plugin.

This skill is instruction only. Loading L0 or L1 is not authorization to start, continue, or submit. External Submission stays frozen. `/start`, `/research continue`, and submit stay on Mission gates. Chat is not authority. Do not dispatch work from this text. This skill does not relax Admission, Budget, hang, T48, or Promotion predicates.

Authoring language of this skill is English. **Respond in the user's language** unless the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names exactly as written.

## When to use

Use this skill when a Mission already has an authorized envelope and someone is asking whether to:

- stay on default `fixed_uct` parent selection
- explicitly opt in to Progressive / MCTS / StrongSearch via a removable Search Plugin
- record programmable exploration heuristics as guidance (docs only — they do not change default selection math)

## When forbidden

Do not use this skill to:

- weld Progressive / MCTS / StrongSearch as the product default
- treat `#40` as on by default — product default stays off; only an explicit Mission/config opt-in enables anneal + Elite
- silently override `fixed_uct` via environment variables or chat
- treat Elite, MMD, near-dup, or side-slot scores as 晋级 / Promotion, hang, or Broker keys
- treat ToyHarness as a second control plane
- change default selection math

## Not authorization

This skill is not authorization to start, continue, or submit. A Search Plugin is not Promotion authority and is not a second control plane. Loading this text does not mount a plugin, opt in Progressive, or flip `#40` on. Elite ≠ 晋级.

## Relation to Admission · Budget

Admission and Budget predicates stay in evidence/. This skill does not change them.

- A missing **protected holdout** still refuses **Admission**.
- Budget pass is not Admission pass. Unreserved spend still refuses writeback or continue.
- Hang is an explicit hang point, not a silent pass. T48 mapping still applies.

Do not treat this skill as Admission, Promotion, Budget pass, or a relaxation of `#40` / true submit.

## Default stays `fixed_uct`

Default parent selection remains `fixed_uct`. Progressive / MCTS / StrongSearch remain explicit Mission/config opt-in only. `#40` product default stays off. Env does not flip the default. Programmable exploration heuristics may be written as docs or guidance; they do not change default selection math. Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key.

## Handoff

When the selection path is clear, present the choice for review. Leave start / continue / submit to an explicit later Mission action. Missing evaluation, missing authorization, or a Budget refuse still refuse — this skill does not relax those gates.
