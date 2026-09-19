---
name: pitfalls
description: Name reusable, answer-agnostic failure signatures as guidance. Use when reviewing a pattern that should warn later Tasks.
owner: evok
namespace: evok
state: accepted
category: pitfalls
---

# Pitfalls

Help keep a **Pitfall** as a reusable, answer-agnostic failure pattern that can warn future Tasks without asserting that a particular Candidate is always wrong. Failure signatures are named anti-patterns for review. They are docs only — not a rejection library and not an auto-refuse blacklist.

This skill is instruction only. Loading L0 or L1 is not authorization to start, continue, or submit. External Submission stays frozen. `/start`, `/research continue`, and submit stay on Mission gates. Chat is not authority. Do not dispatch work from this text. This skill does not relax Admission, Budget, hang, T48, or Promotion predicates.

Authoring language of this skill is English. **Respond in the user's language** unless the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names exactly as written.

## When to use

Use this skill when a Mission already has an authorized envelope and someone is asking how to:

- name a reusable **failure signature** so later Tasks can be warned
- keep the pattern **answer-agnostic** (a Pitfall is not a rejected answer)
- review whether a known anti-pattern is showing up before later gates read the evidence

## When forbidden

Do not use this skill to:

- treat this text as a rejection library, auto-refuse blacklist, or hard-coded refuse hook
- refuse a Candidate just because a named signature is mentioned
- widen hang / T48 / Admission / Budget / Broker gates, or treat a signature as a gate hook
- treat Elite, Team Fan-Out, or a search score as Promotion or Admission
- treat inconclusive or hang as pass
- change Admission, Budget, hang, or T48 predicates
- unfreeze `#40` / true submit / Deploy Arena

## Not authorization

This skill is not authorization to start, continue, or submit. Loading this text does not refuse a Candidate, admit a method, settle a Budget, or thaw External Submission. A Skill body is instruction only — ≠ authorization to start · continue · submit / 交卷.

## Relation to Admission · Budget

Admission and Budget predicates stay in evidence/. This skill does not change them.

- A missing **protected holdout** still refuses **Admission**. Official samples plus an adversarial-labeled subset are not enough.
- Budget pass is not Admission pass. Unreserved spend still refuses writeback or continue.
- Hang is an explicit hang point, not a silent pass. T48 mapping still applies.
- **Elite is not Promotion** and not Admission. Elite or Team Fan-Out is not a Budget Gate key.
- Named signatures here are docs only. They do not become gate hooks and do not widen hang / T48 / Admission / Budget / Broker predicates.

Do not treat this skill as Admission, Promotion, Budget pass, or a relaxation of `#40` / true submit.

## Reusable failure signatures (docs only)

Named anti-patterns. Instructional. Not gate hooks. Not a rejection library and not an auto-refuse blacklist.

- **Goodhart on train** — optimizing the visible / train metric until it stops being evidence of the Research Objective.
- **Missing holdout** — official samples plus an adversarial-labeled subset without a protected holdout is not Admission.
- **Inconclusive as pass** — hang or inconclusive is not pass. T48 mapping still applies.
- **Elite-as-Promotion** — Elite or Team Fan-Out is not Promotion, Admission, or a Budget key.

Recording a Pitfall in the ledger still requires `answerAgnostic: true`. A Pitfall warns later Tasks; it does not assert that a particular Candidate is always wrong.

## Handoff

When the named signature and its evidence refs are clear, present them for review. Leave start / continue / submit to an explicit later Mission action. Missing evaluation, missing authorization, or a Budget refuse still refuse — this skill does not relax those gates.
