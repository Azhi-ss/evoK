---
name: method-improvement
description: Help keep Method Improvement inside one Mission. Use when reviewing a proposed method change that later gates will decide.
owner: evok
namespace: evok
state: accepted
category: method-improvement
---

# Method Improvement

Help keep **Method Improvement** as an in-Mission action: propose, verify, enable, and inherit a change to the working method (task-internal RSI). It is not a separate RSI project, not reflection-only improvement, and not a second mainline.

This skill is instruction only. Loading L0 or L1 is not authorization to start, continue, or submit. External Submission stays frozen. `/start`, `/research continue`, and submit stay on Mission gates. Chat is not authority. Do not dispatch work from this text. This skill does not relax Admission, Budget, hang, T48, or Promotion predicates.

Authoring language of this skill is English. **Respond in the user's language** unless the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names exactly as written.

## When to use

Use this skill when a Mission already has an authorized envelope and someone is asking how to:

- propose a new **version id** for the working method
- name the **verify command** and **adversarial** tags that later Admission will read
- record an **enable record** after gates pass, with a **rollbackable** prior version
- keep Method Improvement inside the same Mission rather than opening a second RSI project

## When forbidden

Do not use this skill to:

- treat a reflection, chat note, or score-up as Method Improvement
- auto-promote a Candidate (Promotion is a later evidence-gated decision)
- auto-admit a method or Skill into accepted Skill State
- treat Elite, Team Fan-Out, or a search score as Admission
- open Continual Harness CRUD or mid-episode harness rewrite
- treat weight / soft SFT co-training as product RSI
- change Admission, Budget, hang, or T48 predicates
- unfreeze `#40` / true submit / Deploy Arena

## Not authorization

This skill is not authorization to start, continue, or submit. Loading this text does not admit a method version, settle a Budget, or thaw External Submission. A Skill body is instruction only — ≠ authorization to start · continue · submit / 交卷.

## Relation to Admission · Budget

Admission and Budget predicates stay in evidence/. This skill does not change them.

- Validation-gated versioning is **version id → verify command / adversarial tags → enable record → rollbackable**. A missing **protected holdout** still refuses **Admission**.
- Budget pass is not Admission pass. Unreserved spend still refuses writeback or continue.
- Hang is an explicit hang point, not a silent pass. T48 mapping still applies.
- **Elite is not Admission.** Elite or Team Fan-Out is not an Admission, Promotion, or Budget Gate key.
- Method Improvement is **not automatic promotion** (≠ auto-promote). File-body Skill writeback stays not opened; accepted writeback still requires Admission + Budget.

Do not treat this skill as Admission, Promotion, Budget pass, or a relaxation of `#40` / true submit.

## Handoff

When the version id, verify command, adversarial tags, and rollback pointer are clear, present them for review. Leave start / continue / submit to an explicit later Mission action. Missing evaluation, missing authorization, or a Budget refuse still refuse — this skill does not relax those gates.
