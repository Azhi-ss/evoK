---
status: spec
version: 0.2
date: 2026-11-11
issue: "#238"
supersedes: issue #238 original description (v0.1)
reviewed-by: external second opinion (ChatGPT), conversation /c/6af375b4-c9fc-83ee-8bc8-425c68c88312
implements: none yet — spec only; tickets opened separately once accepted
---

# Human Insight Draft — advisor context the Director must see but need not adopt

## 0. Status

Spec, not a ticket set. v0.2 incorporates an external adversarial review; the
changes it forced are listed in §10 so a reviewer can see what moved and why.

**Relationship to #235: independent.** Human Insight is not a submodule of
Research Memory. Both are inputs to the same Director decision assembly, but they
differ in source, authority and lifecycle. Neither spec changes the other's
locked decisions.

## 1. Problem

While a Mission runs autonomously, the operator has new ideas. Today there is no
sanctioned way for those ideas to reach the researchers:

- Turning every idea into a Task makes the human the search authority, costs a
  Run per idea, and teaches agents to comply instead of judge.
- Saying nothing wastes genuine domain intuition.
- Injecting ideas into the evidence layer would corrupt the Off/Sham/Real
  evaluation (#222): the arms would start measuring the operator's intuitions
  rather than the memory subsystem.

The wanted behaviour is **an advisor's insight, not a work order**. A researcher
may ignore it, refute it with reasons, propose a falsifying experiment, or defer
it — and keep working on the current Run.

## 2. Decisions (v0.2)

| # | Decision |
|---|---|
| D1 | Drafts are Mission-scoped and carry **zero epistemic authority**: never Evidence, never a Verified Claim, never promotable. Their **decision relevance is explicitly non-zero** — they may change what the Director proposes. |
| D2 | Drafts live in the **Mission Ledger** as events, projected into a separate **Mission Insight Inbox**. Independent of the Memory projection; **not** an independent fact source. |
| D3 | **Rejected.** No third reserved category in `ResearchDecisionPacket`. Insight enters as an independent **sidecar**. |
| D4 | Dispositions are `ignored` / `rejected` / `experiment_proposed` / `deferred`. `ignored` and `rejected` are never merged. |
| D5 | Every disposition reaches the operator with its reason and the decision that produced it. |
| D6 | **Mandatory visibility, never mandatory adoption.** Pending Insight is loaded into every Memory-informed Revision. It is not read during the Blind Proposal. |
| D7 | Across the Off/Sham/Real arms, the Insight input is **identical** — same ids, same versions. |

### 2.1 D1: the two kinds of authority, kept apart

"Zero authority" was ambiguous in v0.1. An input designed to influence decisions
cannot coherently be described as having no influence at all.

| Dimension | Human Insight Draft |
|---|---|
| Epistemic authority | **0** — proves nothing |
| Decision relevance | **non-zero** — may change the next Proposal |

The promotion path is strictly one-way through measurement:

```text
Insight → Director proposes Experiment → Experiment runs → result → Evidence
```

and never:

```text
Insight → Director agrees → Verified Claim        ✗ forbidden
```

### 2.2 D2: one fact source, two projections

v0.1 proposed "an independent Mission-level notes store". Read literally that
creates a second fact source with its own write logic, invisible to the Ledger
and unrebuildable from it — a direct violation of the authority model. Corrected:

```text
Mission Ledger  (only fact source, append-only)
   ├─ Research Memory projection   → ResearchDecisionPacket   (existing)
   └─ Mission Insight Inbox        → Insight Sidecar          (new)
```

Two event kinds are enough:

| Event | Payload |
|---|---|
| `HUMAN_INSIGHT_DRAFT_CREATED` | insight id, Mission id, text, optional falsification hint, author, created ordinal |
| `HUMAN_INSIGHT_DISPOSITION_RECORDED` | insight id, version, disposition, reason, decision ref, optional proposal ref |

The Inbox is a deterministic, rebuildable projection of those events, exactly as
Research Memory is a projection of Mission history. No separate write path, no
separate durability, no separate database.

## 3. Why not a third reserved packet category (D3 rejected)

The packet's reserved categories and Human Insight are different kinds of thing:

| Object | Source | Represents | Authority |
|---|---|---|---|
| Contradicting Evidence | experiment / observation | facts conflicting with a conclusion | Evidence |
| Competing Hypotheses | research reasoning | rival scientific explanations | Hypothesis |
| Human Insight | the operator | a new idea or direction | none |

Three concrete failures if they are merged:

1. **Semantic mixing.** The packet is a projection of *research* memory. Human
   Insight is not something memory summarised; it is a new external input.
2. **Harder attribution.** Evaluation would have to separate which packet bytes
   came from memory, which from the human, which from history.
3. **Reserved-category creep.** Literature hints, expert advice, lab observations
   would each want a slot next, and the packet degenerates into a context bucket.

Keep the packet as it is. Add a sidecar.

## 4. Director integration

```text
1. Blind Proposal            frozen without Memory AND without Insight
2. Load ResearchDecisionPacket
3. Load Insight Sidecar      pending Insight, pinned ids + versions
4. Memory-informed Revision  Director weighs both, records a disposition per Insight
5. Existing dispatch         only the Revised Proposal may dispatch
6. Disposition feedback      events appended; visible to the operator
```

Two properties this ordering protects:

- **The Blind Proposal stays a clean control.** Insight read before freezing
  would silently destroy the two-phase comparison the Director exists for.
- **No new dispatch path.** An Insight such as "test A with B now" can only ever
  become a normal Proposal through Revision. No scheduler, no interrupt, no new
  execution authority.

### 4.1 Mandatory visibility

v0.1 left it to the Director whether to read the drafts. That makes the feature
decorative: a Director busy with fresh results simply never loads them. This is
an input-delivery guarantee problem, not an intelligence problem.

So loading pending Insight is **part of the Revision step**, unconditionally.
What remains entirely the Director's is the judgement.

## 5. Dispositions

```text
pending
  ├─ ignored               seen, judged not worth pursuing; reason recommended
  ├─ rejected              refuted with reasons; reason REQUIRED
  ├─ experiment_proposed   worth testing; proposal_ref REQUIRED
  └─ deferred              not now; reason / revisit condition recorded
```

`ignored` and `rejected` must not be conflated. "The current data does not vary
temperature independently, so this cannot be identified right now" is not a
refutation of the hypothesis. Recording it as `rejected` would tell the operator
the idea was disproved when it was merely unpursuable.

**An agent's `rejected` is not scientific falsification.** It is a reasoned
opinion, labelled as such. Only a real Experiment can produce falsifying
Evidence.

Feedback shown to the operator should name the decision that produced it:

```text
Insight #014 — 怀疑温度对扩散机制的影响被低估
disposition: rejected
reason: 当前实验里温度与其他变量共变，无法单独识别其因果效应；此时追加实验信息增益有限。
link: Run #028 · Decision #031
```

Without this the feature reads as "the AI ignored me".

## 6. Evaluation constraint (#222)

Independent storage does **not** by itself keep the arms comparable. If Real sees
human Insight and Off/Sham do not, a measured improvement is unattributable:
memory, the operator's intuition, or an interaction.

For v1 the rule is simple:

| Arm | Memory | Insight |
|---|---|---|
| Off | none | **identical snapshot** |
| Sham | schema only | **identical snapshot** |
| Real | real | **identical snapshot** |

Same ids, same versions, same decision point. Alternatively, Insight is disabled
entirely in runs whose purpose is to evaluate Memory. A 3×2 factorial design is a
later option and is not needed now.

## 7. Engineering invariants

| Invariant | Why |
|---|---|
| **Snapshot consistency** — each Revision records the Insight ids and versions it actually read | drafts submitted mid-decision must not mutate an already-assembled input |
| **Idempotency** — one Insight cannot be dispositioned twice, or dispatched twice, within one decision cycle | retries must not duplicate experiments |
| **No interruption** — a new draft never aborts or pre-empts a running Run | it is context, not a control signal |
| **Deferred revival only by a later decision** — no background watcher | avoids a second scheduler |

The first two are required in v1. Deferred revival may be deferred itself.

## 8. Interfaces to pin before tickets

Three type shapes carry the whole design. Once these are agreed, implementation
tickets can be written without guessing.

1. **`HumanInsightDraft`** — id, Mission id, text, optional falsification hint,
   author, created ordinal, version.
2. **`InsightDisposition`** — insight id, version, one of four dispositions,
   reason, decision ref, optional proposal ref.
3. **`DirectorInsightSidecar`** — the pinned, ordered, truncated list handed to
   Revision, plus omission count and a `truncated` flag, mirroring the packet's
   explainability rules.

## 9. Out of scope

- Cross-Mission insight (M2).
- Any Evidence or promotion authority for drafts.
- Automatic experiment dispatch from a draft.
- Embeddings, vector retrieval, semantic search over drafts.
- A supervisor UI. The first version needs only a way to submit a draft and a way
  to read dispositions; a TUI surface is a separate `cli` concern and must not
  become a second control plane (ADR-0007).

## 10. What the external review changed

| Item | v0.1 | v0.2 |
|---|---|---|
| D1 | "zero authority" | split into epistemic authority 0 / decision relevance non-zero |
| D2 | independent notes store | Ledger events + derived Inbox projection; no second fact source |
| D3 | fallback option, third reserved category | rejected outright, with reasons |
| D4 | considered / rejected / experiment proposed | four dispositions; `ignored` ≠ `rejected` |
| D6 | absent — Director chose whether to read | mandatory load at Revision, never at Blind |
| Evaluation | "keep it out of the projection so arms stay comparable" | comparability comes from the protocol: identical Insight across arms |
| Position vs #235 | candidate sub-part of the memory spec | independent spec; shared seam is the Director input assembly only |
