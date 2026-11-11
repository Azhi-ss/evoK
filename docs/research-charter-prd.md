---
status: spec
version: 1.0
date: 2026-11-11
related: "#235 (memory), #248 (research program), #238 (human insight, delivered)"
implements: none yet — spec; tickets separate
---

# Research Charter PRD — deciding what is worth researching before running it

## 0. What this is

The contract for **pre-Mission research scoping**: before evoK starts a long-running
research Mission, an agent investigates the landscape and proposes what the study
should be measured against. The human approves the proposal; the human does not
hand-pick papers.

Sibling specs, not sub-parts:

| Spec | Question it answers |
|---|---|
| **this one** | What is the study trying to beat, and is it worth doing at all? |
| #248 Research Program | How does an authorized study run to completion? |
| #235 Research Memory | How is what happened projected and re-served later? |

Charter is **forward-looking and human-authorized**; Memory is **backward-looking and
derived**. They must not be merged: Memory is a projection with no write authority,
whereas a Charter is an original human-authorized input. Their only seam is that a
Run records which Charter and protocol version it executed under.

## 1. The defect this fixes

Two opposite failures are both common:

1. **The human specifies the baseline.** Then the agent is not doing research
   scoping at all, and the human's literature knowledge becomes the ceiling.
2. **The agent picks an easy baseline and declares success.** Then the result is
   unfalsifiable in practice, and no downstream rigour can repair it.

The NOSE case adds a third: the generator was evaluated largely by NOSE's own
predictor, so it learned to please its own reward and collapsed in diversity. A
charter that fixes evaluation **before** any result exists is the cheapest place to
prevent that.

## 2. Division of authority

| Decision | Owner |
|---|---|
| Research direction | human |
| Research ambition | human |
| Resources, data access, external permissions | human |
| Research gap | agent, from literature, with sources |
| Baseline selection | agent |
| Benchmark and evaluation protocol | agent proposes, **human approves** |
| Stage goals during the study | agent, evolving with evidence |
| Final scientific conclusion | evidence, never the agent's declaration |

The human approves a **proposal**, not a reading list. "Is this set of competitors
representative and is the protocol fair" is a review question; "which paper should
we compare against" is not.

## 3. The charter's six required parts

1. **Objective** — the scientific question and its boundaries.
2. **Ambition** — expected contribution level; see §6 for its limits.
3. **Research gap** — what is solved, what is not, with sources.
4. **Baseline portfolio** — §4.
5. **Evaluation protocol** — §5.
6. **Constraints** — compute, data, permissions, external access.

It is an initial research contract, not a pre-scripted experiment table.

## 4. Baseline portfolio

Four categories, with counts as guidance rather than quotas; an agent that cannot
fill a category says why instead of padding it.

| Category | Purpose |
|---|---|
| Simple baseline (1–2) | rules out "the complexity bought nothing" |
| Strongest comparable baseline (1–2) | the real competitor |
| Method-specific baseline (0–1) | the closest methodological relative |
| Internal ablations (2–3) | isolates the proposed method's own contribution |

Every entry records: paper and year, task definition, conditioning, dataset and
split, metrics, code/data availability, reproduction status, comparability limits,
and why it was selected.

### Rules that prevent baseline shopping

1. **Task comparability beats recency.** The newest paper is not automatically the
   right competitor; an unconditional generator is not comparable to a
   conditional-generation task.
2. **Prefer the strongest reproducible method**, and check code, data, identical
   input conditions, and protocol compatibility before claiming comparability.
3. **Never silently downgrade.** If the strongest method cannot be reproduced, keep
   it as `reported_only` with the limitation documented, and name a separate
   `reproduced_baseline`.
4. **No single-metric judgement.** Target matching, validity, novelty, diversity and
   distributional quality are separate dimensions.
5. **Never rely on the method's own reward model** as the sole evidence of
   improvement. Independent evaluation is required by the charter, not added after
   the results look good.
6. **The initial benchmark is frozen.** Newer work may be *added* as a supplementary
   comparator; it never silently replaces the frozen baseline or protocol.

## 5. Evaluation protocol

Proposed by the agent, approved by the human, frozen before experiments:

dataset and split; train/test isolation; metrics; candidate generation budget; seed
strategy; compute limits; statistical comparison; independent validation
requirements; reproducibility artifacts.

Changing the primary protocol later creates a **new protocol version** with a
recorded reason. Prior results are never re-scored under the new version or
overwritten.

## 6. Ambition is a rigour requirement, never a success criterion

Ambition is expressed as minimum / target / stretch bars, but:

- It determines **how strong the baselines and how strict the controls must be**.
- It **never appears in any termination or convergence condition**. "Reached ICML
  level" is not a checkable evidence property, and making it one would bias error
  analysis and convergence toward a desired outcome — the same reward-hacking shape
  this charter exists to prevent.
- It must not suppress **abandonment** (#248 R5). A system aiming high must still be
  able to say a direction is worthless.

## 7. `no-go` is a successful outcome

A scoping run whose correct answer is "do not do this" must be able to say so.
Otherwise the skill is structurally required to produce a launchable plan and will
dress up bad directions.

A charter may therefore conclude **`no_go_recommended`**, with evidence: the data is
insufficient, the question is already answered, resources are inadequate, or the
novelty does not survive the literature.

That is a completed scoping run, not a failed one. Nothing is authorized by it.

## 8. Where the contract lives

**Schema authority is inside the evoK repository.** The globally installed skill is
a *procedure*; it references a versioned schema rather than defining one. Editing a
global skill must never be able to break evoK's parsing at runtime.

```text
~/.agents/skills/evok-charter/SKILL.md     procedure, usable by Codex or any Pi
evoK resources/skills/charter/SKILL.md     evoK-facing: schema ref, ledger events,
                                           freezing and amendment rules
evoK src/mission/research-charter.ts       schema + validation + versioning (authority)
```

Schema id: **`evok.research-charter/v1`**. A breaking change requires a new version
and a migration note.

### Ledger events

Only three are needed initially, plus one for later amendments:

| Event | Records |
|---|---|
| `RESEARCH_CHARTER_PROPOSED` | charter version, artifact refs, schema id |
| `RESEARCH_CHARTER_APPROVED` | human authorization, approved version |
| `BENCHMARK_PROTOCOL_FROZEN` | frozen protocol version and digest |
| `BENCHMARK_EXTENSION_ADDED` | a later comparator added without altering the frozen set |

Full charter text, literature evidence and reproduction material stay in referenced
Mission artifacts. The ledger records versions, approvals and references — it is not
a document store.

## 9. Context discipline

- No new agent role for baseline selection; the existing agent runs the skill.
- The Director is **not** re-fed the whole charter or the literature. It receives a
  compact summary: objective, ambition, current stage goal, relevant baselines,
  current protocol version, open questions.
- Full documents stay in artifacts and are pulled only when a node needs them.
- No vector store, embeddings, or retrieval-attention subsystem.

## 10. Relationship to #248

Charter is the **input** to a Research Program. #248 governs how an authorized study
runs to completion; this spec governs whether the target was worth shooting at.
Neither replaces the other, and the research-program source map (§13 of #248) should
note where the charter version is read when a Run is dispatched.

## 11. Pilot before hardening

Before integrating deeply, run the global skill once on a real request — the NOSE
conditional molecular generation study — and judge the output on three points:

1. Did it find genuinely competitive baselines without being told which?
2. Did it state a real gap with sources, rather than an inferred one?
3. Could the human approve with a single review, without doing literature work?

If the pilot fails any of these, revise the skill before writing more evoK code.
A successful pilot is evidence about the *procedure*, not about the science.

## 12. Out of scope

Automatic experiment dispatch from a charter, cross-Mission charters, venue-acceptance
prediction, embeddings or vector retrieval, and any supervisor UI.
