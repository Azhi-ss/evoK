---
name: recovery
description: Point at existing Mission continue, interrupt recovery, and hang paths. Use when reviewing how to resume or hang without inventing a second control plane.
owner: evok
namespace: evok
state: accepted
category: recovery
---

# Recovery

Help keep recovery on the existing Mission control plane: authorize, continue, repair, and stop. Point at the program paths that already exist. This skill is not a second control plane and does not invent a new hang predicate.

This skill is instruction only. Loading L0 or L1 is not authorization to start, continue, or submit. External Submission stays frozen. `/start`, `/research continue`, and submit stay on Mission gates. Chat is not authority. Do not dispatch work from this text. This skill does not relax Admission, Budget, hang, T48, or Promotion predicates.

Authoring language of this skill is English. **Respond in the user's language** unless the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names exactly as written.

## When to use

Use this skill when a Mission already has an authorized envelope and someone is asking how to:

- continue an authorized Mission after a recorded baseline (`/research continue` → `continueResearch` in `src/mission/research-entry.ts`)
- recover a readable research view from durable events (`recoverResearchStatus` over `control-events.jsonl`; disk merge with the MissionRecord is `readResearchStatus`)
- resume an interrupted Mission from disk (`resumeAuthorizedMission` in `src/mission/mission-start.ts` calls `reconcileInterruptedMission` in `src/mission/mission-resume.ts`; CLI/TUI `/mission-resume` or `evok --resume`)
- locate the existing hang gate (`runKillTestHang` in `src/evidence/kill-test-hang.ts`)

## When forbidden

Do not use this skill to:

- invent a second orchestration surface or a second Mission loop
- treat this text as `/research continue`, `/mission-resume`, or submit
- auto-resume without Mission gates, or treat chat / model memory as recovery authority
- treat Pi `/resume` as Mission resume (Pi owns `/resume`; Mission resume is `/mission-resume`)
- dispatch `/research repair` as if it were implemented — that verb is reserved; this slice exposes status and one authorized continue
- add a new hang predicate, change hang / T48 three-state, or treat hang inconclusive as pass
- change Admission, Budget, hang, or T48 predicates
- unfreeze `#40` / true submit / Deploy Arena

## Not authorization

This skill is not authorization to start, continue, or submit. Loading this text does not continue a Mission, reclaim a controller lock, settle a Budget, or thaw External Submission. A Skill body is instruction only — ≠ authorization to start · continue · submit / 交卷.

## Relation to Admission · Budget

Admission and Budget predicates stay in evidence/. This skill does not change them.

- Continue still requires an authorized Mission, a recorded baseline, a user `/research continue` token, and (when a BudgetDecision is supplied) a Budget pass. Unreserved spend still refuses continue.
- A missing **protected holdout** still refuses **Admission**. Budget pass is not Admission pass.
- Hang is an explicit hang point, not a silent pass. T48 mapping still applies. This skill does not add a new hang predicate (`runKillTestHang` stays the hang).
- Damaged records, digest mismatches, or broken budget arithmetic still block recovery visibly. Chat transcript is not authority.

Do not treat this skill as Admission, Promotion, Budget pass, or a relaxation of `#40` / true submit.

## Existing program paths only

Pointers — not a second control plane:

- **Continue:** `/research continue` → `continueResearch` in `src/mission/research-entry.ts`. Records `MISSION_CONTINUED` / `EXPERIMENT_ENTERED`. Model-authored approval cannot continue.
- **Repair / interrupt recovery:** `MISSION_REPAIRED` is already a control-event type projected by `recoverResearchStatus`. `/research repair` is reserved on the CLI (status + one authorized continue this slice). Interrupted-Mission recovery is `resumeAuthorizedMission` in `src/mission/mission-start.ts` after `reconcileInterruptedMission` in `src/mission/mission-resume.ts`, via `/mission-resume`. Branch accounting stays in `src/mission/branch-recovery.ts`.
- **Hang:** `runKillTestHang` in `src/evidence/kill-test-hang.ts`. Docs pin: `docs/adr/0008-evidence-physical-pack.md`. No new hang predicate.

## Handoff

When the existing continue / resume / hang path is clear, present the pointer for review. Leave start / continue / submit to an explicit later Mission action. Missing evaluation, missing authorization, or a Budget refuse still refuse — this skill does not relax those gates.
