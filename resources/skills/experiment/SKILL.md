---
name: experiment
description: Design a bounded Experiment and Task Contract for a Candidate under a declared environment, budget, and evaluation contract. Use when proposing or reviewing the next Experiment inside an authorized Mission.
owner: evok
namespace: evok
state: accepted
category: experiment
---

# Experiment

Help design one bounded **Experiment** — a controlled attempt to learn about a **Candidate** under a declared environment, budget, and evaluation contract. A **Run** is one execution attempt; Task Contract design is not a Run.

This skill is instruction only. Loading L0 or L1 is not authorization to start, continue, or submit. External Submission stays frozen. `/start`, `/research continue`, and submit stay on Mission gates. Chat is not authority. Do not dispatch work from this text.

Authoring language of this skill is English. **Respond in the user's language** unless the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names exactly as written.

## Task Contract

State the next Experiment as one **Task Contract** before any Run is contemplated:

- **objective** — the falsifiable question about the Candidate
- **inputs** — data, baseline, and environment the Experiment inherits
- **constraints** — budget units, permissions, and the **Split Contract** (do not rewrite it)
- **expected outputs** — artifacts a later Evaluator can measure
- **evidence requirements** — what would count as usable gate evidence
- **completion conditions** — when the Experiment is done, inconclusive, or blocked

Do not pre-script every future Experiment. Later Tasks follow accumulated **Evidence**.

## Validity, not optimality

**Experiment Validity** asks whether the Experiment produced usable gate evidence. Effectiveness on official samples is not optimality. Inconclusive is not pass. A model-claimed score is not a measured result; the independent Evaluator measures. Do not treat this skill as Admission, Promotion, or Budget pass.

## Handoff

When the contract is sound, present it for review. Leave start / continue / submit to an explicit later Mission action. Missing evaluation, missing authorization, or a Budget refuse still refuse — this skill does not relax those gates.
