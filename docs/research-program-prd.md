---
status: spec
version: 1.0
date: 2026-11-11
supersedes: docs/research-program-vertical-slice.md (kept as a source, not the contract)
related: "#235 (memory), #238 (human insight, delivered), #221/#222 (closed)"
implements: none yet — spec; tickets are separate
---

# Research Program PRD — run-to-completion autonomous research

## 0. What this document is

The product contract for turning evoK from a **bounded experiment executor** into
a **run-to-completion research system**. It records the business direction, the
architecture constraints that several rounds of adversarial review converged on,
and the places where this design disagrees with the earlier vertical-slice note.

It is not an implementation plan. Tickets are opened separately and must not
contradict §3.

## 1. The problem, in product terms

Today a Mission runs a bounded batch of Experiments and then waits for a human to
`/research continue`. A NOSE-style request — "基于 NOSE 做气味-分子生成，完成文献
gap、基线复现、方法实现和效果验证" — therefore produces **one experiment batch and
a number**, not a finished study.

The operator's complaint is often phrased as "I have to keep pressing resume".
That is the symptom. The underlying defect is:

> After a batch of experiments, the operator still cannot tell whether the result
> can be believed.

Automating more steps without fixing that produces a system that automatically
generates more confusing results.

## 2. Operator role

**Absentee owner by default, occasional advisor by choice.**

```text
operator states a research goal once
   ↓
the system runs without asking for anything
   ↑
operator may drop an insight at any time (#238, already delivered)
   ↓
the system reads it at the next decision point — may adopt, refute, or ignore it
   ↓
the system keeps its own rhythm; an insight never interrupts a Run
   ↓
operator collects a report
```

Two consequences:

- **The system must never wait on the operator to make progress.** No manual
  resume in the normal path, including after a crash.
- **Because the operator does not watch the process, the report must prove itself.**
  What was *not* done must be as visible as what succeeded.

## 3. Locked architecture decisions

| # | Decision |
|---|---|
| R1 | **One control plane.** Extend `runMissionController` into a long-running research loop. No second controller with its own lifecycle, budget, permissions or dispatch authority. |
| R2 | **Mission is the long-lived research goal and the only authorization boundary.** ResearchProgram is a versioned, ledger-derived execution plan inside it, not an independently authorized object. |
| R3 | **Convergence Auditor is an evidence gate, not a research agent.** It verifies a pre-declared completion contract. It cannot propose experiments, change the objective, change the budget, or dispatch. |
| R4 | **Sequential execution.** DAG computes dependencies and readiness; one node is dispatched at a time. No parallel fan-out in this design. |
| R5 | **Abandoning a direction is a first-class output.** "This direction is not worth continuing, reason X, evidence Y" must be as expressible and as well-supported as "continue". |
| R6 | **Operator insight never changes the run state** and never becomes Evidence. See #238. |
| R7 | **Resolved ≠ terminated.** §5. |
| R8 | **Budget is a fuse, not a steering wheel.** §7. |
| R9 | **Protocols are frozen and versioned.** §6.3. |
| R10 | **Literature work is capability-based, not tool-bound.** §6.2. |
| R11 | **Memory evaluation stays at decision-point granularity.** §8.1. |
| R12 | **Human intervention is split into hard stops and soft records.** §8.2. |

## 4. What a complete study contains

Not a linear pipeline — a shape the plan must be able to reach, in whatever order
the evidence demands:

```text
literature and gap matrix
baseline selection and environment
baseline reproduction (or an explicit, evidenced cannot-reproduce record)
method implementation
controlled comparison
error analysis → revision → further comparison
independent validation
convergence audit
reproducible package: code + environment + data + raw results + report
```

Non-linearity is the point: a failed baseline leads to environment repair, error
analysis can invalidate the method, failed validation can reopen the conclusion.
The plan is regenerated after every node from the latest evidence rather than
executed once as a fixed script.

## 5. Terminal states

Two families, never merged:

| Family | States | Meaning |
|---|---|---|
| **Research Resolved** | `supported`, `falsified`, `inconclusive` | the authorized question received an evidence-backed answer, including a negative or an honestly uncertain one |
| **Research Terminated** | `budget_exhausted`, `blocked`, `human_review_required`, `cancelled` | execution stopped; the question was not necessarily answered |

A study that falsifies its own hypothesis through valid controls is a **complete
and valuable** study. A study that ran out of budget is **not** complete, however
many experiments it ran, and its report must list the completion conditions that
remain unmet.

## 6. Research nodes

### 6.1 Typed nodes with real output contracts

A node type is not a label. Each type has a distinct output schema and a distinct
completion criterion:

| Type | Required output | Complete when |
|---|---|---|
| Literature | traceable source records, extracted methods/data/results, public baseline list, stated gap, open questions | sources traceable and the gap is argued from them |
| Environment | pinned dependencies, hardware/software verification, runnable key scripts | the environment runs and its configuration is reproducible |
| Baseline | public implementation, metrics under a frozen protocol | reproduced, or blocked with evidence |
| Implement | runnable method code, commit, configuration | it runs and its version is fixed |
| Measure | independent evaluation, raw artifacts, protocol version | the experiment is valid and traceable |
| Analyze | evidence-backed error taxonomy and the next hypothesis | the classification is supported by evidence |
| Repair | engineering repair record | the fault is resolved **without** silently changing the scientific protocol |
| Validate | independent-data or independent-model review | done, or recorded as unavailable with a reason |
| Report | code, environment, configuration, results, evidence links | the package is reproducible |

### 6.2 Literature is a capability, not a tool binding

The operator may have already assembled the literature. The system may also need
to find it. **No specific search provider or literature tool is mandated.**

Requirements are on the **output**, not the mechanism:

- Accept operator-supplied material as a legitimate starting input.
- Let the researcher obtain whatever else it needs using the capabilities it
  already has (web search, reading, shell), within Mission permissions.
- Judge the Literature node by §6.1's output contract, never by "did it call the
  approved search tool" or "did it fetch N papers".
- Record provenance for every source so the gap matrix is auditable.

This keeps the design independent of any vendor and avoids building retrieval
infrastructure before there is evidence it is the binding constraint.

### 6.3 Repair must not become quiet protocol drift

A system that can repair its own experiments can also tune its way to a pretty
number. Therefore:

- **Engineering repair** (environment, code bugs) is allowed in scope.
- **Method improvement** changes the method and is recorded as such.
- **Protocol change** (test split, metric, evaluation harness) creates a **new
  protocol version**; previous results are never overwritten or re-scored under
  the new version.
- Every experiment retains configuration, model snapshot, seeds and protocol
  version, so iterations stay comparable.

## 7. Budget as a fuse

The operator does not want to allocate budgets per phase. Accepted — no
fine-grained allocation is required.

But removing the ceiling entirely is rejected. With an absentee operator, an
unbounded loop that fails to converge has no automatic stop at all, and the
metering work delivered in #221 would lose its purpose. `validEvidencePerBudget`
is also one of three directional metrics in #222.

So:

- One generous default Run/cost ceiling per Mission. The operator need not set it.
- A **mandatory reserve** for independent validation and the final report, with a
  global default in Mission Policy, so the system cannot spend everything on
  hill-climbing and end up unable to substantiate its own result.
- Crossing the ceiling yields `budget_exhausted`, explicitly not completion.
- Manual stop / pause is always available.
- Cost accounting stays; it is what makes the fuse and the audit possible.

## 8. Three interactions with existing subsystems

### 8.1 Long-lived Missions vs memory evaluation (#222)

Off/Sham/Real comparability relies on freezing an identical decision point. A
long-lived Mission whose plan evolves no longer offers a meaningful
"replay the whole Mission under three arms" comparison.

Decision: **evaluate at decision-point granularity only** for long-lived Missions.
Each Blind Proposal + Revision pair remains freezable, so L1 counterfactuals still
work. `whole-mission-comparison` is documented as applying to bounded Missions
only. Nothing in #222 is reopened.

### 8.2 Human intervention: hard stops vs soft records

A diligent research system hits judgment calls constantly. If each one stops for
approval, the operator is back to babysitting and will start approving blindly.

| Class | Examples | Behaviour |
|---|---|---|
| **Hard stop** | changing the Mission objective, exceeding total budget, external submission, new credentials or real resources | stop and wait |
| **Soft record** | plan revisions, in-scope node additions, method changes, protocol versions | proceed, append to the ledger marked `needs_review`, summarize in the report |

Default is to proceed and leave an auditable trail. Only genuine boundary
crossings interrupt.

### 8.3 Crash recovery

Recovery is from the Ledger, automatically, without human resume. Node attempts
carry unique ids and idempotency keys; on restart the controller inspects prior
attempts, live processes, checkpoints and existing artifacts before deciding
whether to resume, recover or re-execute. It must never blindly repeat an
expensive training run or double-charge for one.

## 9. Report shape

The first screen answers "can I believe this", not "what did you do":

```text
verdict:            supported | falsified | inconclusive | not completed
claim:              what the evidence supports, at the scope actually tested
confidence breakdown:
  ✓ baseline reproduced (difference attributed)
  ✓ controlled comparisons, independent data
  ⚠ unstable across seeds
  ✗ external review not performed — no suitable independent benchmark
abandonment advice: which directions are not worth continuing, with evidence
unmet conditions:   what was not done
reproducible package: code, environment, data, raw results, evidence links
```

Omissions are first-class. A report that only shows successes is harmful to an
operator who is not watching the process.

## 10. Disagreements with the earlier vertical-slice note

`docs/research-program-vertical-slice.md` is a useful source but is not the
contract. Where they differ, this PRD governs.

| Topic | The note | This PRD |
|---|---|---|
| Node kinds | assumes `measure` / `investigate` / `repair` already exist | **They are not on `main`.** They exist only in an unmerged stashed change set. Node types here are defined as new work; no dependency on that stash |
| Completion | workflow completeness + scientific resolution, listed together | kept, but R5 adds **abandonment** as a first-class outcome, which the note does not cover |
| Literature | a Literature node with outputs | same outputs, but R10 explicitly refuses to bind a search tool |
| Budget | "reserve resources for validation" | R7/R8 make it a default policy with a hard reserve, no per-phase allocation |
| Human approval | scope expansion needs re-authorization | R12 splits hard stops from soft records so normal judgment calls do not interrupt |
| DAG scheduler | "wire in the existing scheduler" | **First activation, not wiring.** `dag-scheduler.ts` still has no production caller after #221; it must be validated as new code |
| Milestones | treats milestones as available | `CampaignMilestoneState` exists in `research-loop.ts` but is **not consumed by the mainline**; the gap is the execution loop, not the concept |

## 11. Explicitly out of scope

- Parallel fan-out, resource sharing between concurrent nodes.
- Cross-Mission research programs or cross-Mission memory.
- Automatic scope expansion.
- Standing literature subscriptions, vector retrieval, embeddings.
- A supervisor UI. The operator's needs here are a submission entry point and a
  readable report; a TUI dashboard is a separate `cli` concern and must not
  become a second control plane (ADR-0007).

## 12. Sequencing

This PRD does not jump the queue. `#235` (memory subsystem: `src/memory/`, SQLite
store, `memory_read`) is in flight and moves the Director input assembly this
design depends on. Research Program tickets are opened against the tree after
#235 lands, and the first of them is the source mapping in §13.

## 13. First deliverable: a verified source map

Before any behaviour change, one ticket produces a verified map of the actual
call graph among `runMissionController`, `research-loop.ts` (Campaign,
`generateTasks`, milestones), `dag-scheduler.ts`, the Director two-phase seam, and
the Ledger — naming for each whether it needs **wiring**, **first activation**, or
**modification**. The map is checked against the code, not written from memory.
Everything else in this PRD is scheduled from that map.
