---
status: delivered
version: 1.1
date: 2026-11-11
related: "#235 (memory, delivered except M-e), #248 (research program), #249 (charter)"
implements: "#253 (Stage 1 #254, Stage 2 #255, Stage 3 #256, Stage 4 #257)"
reviewed-by: external adversarial second opinion; its objections and their dispositions in §9
---

# Code Structure PRD — named capabilities and a thin research controller

## 0. What this is

The contract for restructuring evoK so that its capabilities have names and its
research controller is thin. The problem is not folder layout; it is that
capabilities are **buried inside a pipeline**, so each new requirement has to be
re-discovered from the code instead of composed from named parts.

It also fixes a semantic confusion: `src/mission/` currently mixes **a research
object** (goal, authorization, plan versions, terminal state) with **a controller**
(deciding what happens next) and with **execution mechanics** (snapshots, artifacts,
metering). Those three have different change reasons and must not share a function.

## 1. Symptoms, measured

| Symptom | Evidence |
|---|---|
| God function | `src/mission/mission-start.ts` is **2886 lines**; `runMissionController` handles authorization, locking, budget, dispatch, snapshots, artifacts, metering, memory pinning, Director phases, recovery and terminal state |
| Two execution paths | `src/execution/pi-agent-runtime.ts` and `pi-child-dispatch.ts` each maintain their own snapshot, metering and credential rules; #221's defects (credentials in records, unconfirmed cancellation, ambiguous metering ownership, tool-turn off-by-one) largely followed from that split |
| No enforced boundaries | ADR-0007 assigns logical ownership, but nothing in the code stops `evidence` importing `execution` or a capability importing a research object |
| Compatibility shims persist | 55 flat `src/*.ts` re-exports kept "for one release" by ADR-0013 |

## 2. Locked decisions

| # | Decision |
|---|---|
| S1 | **Two layers with a forced direction.** Research objects (charter / program / hypothesis / experiment) sit above capabilities (harness / memory / delegation / runtime / evidence). Upper may import lower; **lower importing upper is a violation**. |
| S2 | **Mission splits into data and behaviour.** The Mission data contract (goal, authorization, plan versions, terminal state) is pure, validatable and replayable. The research controller is separate and thin. |
| S3 | **harness does not evaluate.** It executes in isolation and returns artifacts, raw usage and execution health. Evaluation is an independent consumer of immutable facts. |
| S4 | **Delegation shares the execution protocol** with the main Run path; it is not a second execution semantics. |
| S5 | **Restructure in four stages, boundaries before moves.** §4. Do not start by relocating execution code. |
| S6 | **Acceptance is behavioural equivalence**, including a Ledger trace comparison, not line counts. |
| S7 | **No line-count target.** A 300-line controller that still hides three shared states and two metering rules is still a god function. |

### 2.1 Explicitly not independent capabilities

Charter, program and insight are **contents of a Mission**, not reusable machines.
They stay in `mission/`. Earlier drafts listed them as top-level modules; that was
rejected because none can be understood or tested apart from a Mission.

## 3. Ownership boundaries that must exist before any move

These four distinctions are the substance of the design. Moving files without them
produces a fake boundary.

| # | Distinction | Owner of the decision | Owner of the mechanics |
|---|---|---|---|
| B1 | **Authorization snapshot vs execution environment snapshot** | Mission freezes *under what conditions* a Run may happen: plan version, authorization digest, budget reservation, memory digest, input digests | harness freezes *in what environment* it runs: runtime, model config, tools, sandbox image, filesystem |
| B2 | **Artifact collection vs artifact adoption** | Mission decides whether an artifact belongs to a Run and enters the Ledger | harness collects, validates, content-addresses and returns a receipt |
| B3 | **Raw usage vs attribution vs budget settlement** | Mission owns attribution (which Run/agent, incl. parent/child) and budget reserve/settle/refund | harness measures raw usage only |
| B4 | **Execution protocol vs execution backend** | the protocol (`ExecutionRequest` / `ExecutionReceipt`) is shared | Pi main-session and child-subagent backends may differ internally |

B1 has a concrete failure mode if ignored: authorization at T1, memory updated at
T2, harness snapshots at T3 — the Run then executes with memory the authorization
never saw, and the result is not reproducible.

B3 has one too: a parent reporting 10,000 tokens that already include the child's
3,000, summed again by the harness, yields 16,000 instead of 13,000.

## 4. Four stages

> **Delivery.** All four stages landed: Stage 1 #254 (`run-preparation.ts`),
> Stage 2 #255 (one `ExecutionRequest`/`ExecutionReceipt` protocol), Stage 3 #256
> (`src/harness/` with B1–B4 mechanical, `docs/agents/harness-map.md`), Stage 4
> #257 (`run-dispatch.ts`, `director-phases.ts`, `run-finalization.ts`,
> `recovery.ts`, and a controller that only composes them). The accepted
> measures are §6, not line counts: S6/S7 stand as written.

### Stage 1 — Mission-owned Run preparation

Extract `src/mission/run-preparation.ts`, returning an **immutable `PreparedRun`**:
authorization and permission checks, Mission lock, budget reservation, plan-version
freeze, the Mission-owned snapshot, the Research Memory digest pin, and the ledger
event proving preparation completed.

Nothing else moves. Execution paths, ledger semantics, digests, metering口径 and
ordering all stay identical.

**Why first:** it separates "this Run is authorized under these frozen conditions"
from "this Run executed", which is the boundary every later stage depends on.

### Stage 2 — One execution protocol

Define `ExecutionRequest` and `ExecutionReceipt`; adapt **both** `pi-agent-runtime`
and `pi-child-dispatch` to them.

Verified on: credential rules, cancellation semantics (an unconfirmed cancel never
becomes success), parent/child attribution, tool-turn accounting, raw usage
traceability, artifact provenance.

Backends may differ internally. The protocol is what unifies them, not the
directory.

### Stage 3 — Physical harness extraction

Only now create `src/harness/{contracts,snapshot,execution,artifacts,metering,index}.ts`,
with B1–B4 honoured: environment snapshots only, artifact receipts only, raw usage
only, no research decisions.

### Stage 4 — Remaining Mission decomposition — delivered (#257)

`run-finalization.ts`, `director-phases.ts`, `recovery.ts`, and a thin research
controller that composes them.

As delivered, the controller body is the composition itself:

```text
prepareRun (run-preparation.ts, immutable PreparedRun)
  → Director decision (director-phases.ts: blind → pinned Memory/Insight → revision)
  → execute (run-dispatch.ts: one bounded candidate Run)
  → finalizeRun (run-finalization.ts: adopt the outcome into Mission state)
  → recover-or-terminate (recovery.ts: durable progress reuse, budget/iteration/interrupt bounds)
```

`execute` needed its own home: the dispatch closure held every execution mechanic
(runtime/workspace/sandbox, intent, snapshot adoption, metering, evaluation), so
leaving it inline would have kept the controller a pipeline. Research judgement
stays the Director's; finalization never measures, dispatch never decides, and
recovery only reads durable state. `mission-start.ts` keeps the entry points and
the composition.

## 5. Mechanical dependency enforcement

A CI check on import statements, added in Stage 1 (it is cheap and prevents the
structure from rotting immediately) and live in `bun run check` as
`scripts/import-boundaries.ts`:

| Module | May depend on |
|---|---|
| mission | harness, memory, evidence, execution, runtime contracts |
| harness | runtime, delegation, shared contracts |
| memory | ledger read interfaces, storage |
| evidence | raw artifacts, ledger fact reads |
| evaluation | immutable facts and artifacts only |

Hard rules: **harness never imports mission; harness never imports an evaluator;
memory has no write path into Mission history; an evaluator cannot influence
execution through harness.**

## 6. Acceptance

| Property | Test |
|---|---|
| Ledger trace equivalence | same simulated input before/after: identical event sequence, key payloads, digests, artifact provenance, usage attribution and final Mission state (timestamps normalized) |
| Content addressing | the 7 pinned memory digests stay identical |
| Authorization | missing permission still fails closed |
| Budget | reservation, attribution and settlement stay idempotent |
| Snapshot pinning | a Run uses the plan and memory references frozen at preparation |
| Cancellation | `unknown` never becomes `succeeded` |
| Recovery | fault injection after budget reservation, after execution start, after artifact write, before receipt persistence |
| Evaluation | Off/Sham/Real interfaces and comparability unchanged |
| Dependencies | CI blocks a reversed import |

Stage 1 must ship the trace-equivalence harness itself; later stages reuse it.

| Row | Where it is pinned |
|---|---|
| Ledger trace equivalence, content addressing, snapshot pinning, evaluation comparability | `tests/integration/ledger-trace.test.ts` (trace digest pins from the review base) + `src/memory/digests.test.ts` |
| Authorization, budget, cancellation | `tests/integration/mission-start.test.ts`, `mission-outcome-semantics.test.ts` |
| Recovery at the §6 commit points | `tests/integration/mission-recovery-faults.test.ts` (after budget reservation, after execution start, after artifact write, before receipt persistence) |
| Dependencies | `scripts/import-boundaries.ts` |

## 7. Relationship to other work

- **#248 Research Program** builds its long-running loop on the Stage 1
  `PreparedRun` boundary. It should not start before Stage 1 lands.
- **#249 Charter** (C2 #251 in flight) adds authorization content that the
  Mission-owned snapshot must freeze; Stage 1 should read the merged charter code.
- **#235 M-e** (shim deletion, aggregation pass) is the natural place to finish the
  leftover flat shims, after a soak period.

## 8. Out of scope

- Restructuring modules with **no production caller** (`dag-scheduler.ts`,
  `team-execution.ts`). Unused code does not earn a refactor.
- Rewriting harness-opt, which is a separate workspace.
- Any change to research semantics, evaluation metrics, or authorization rules.
- A supervisor UI.

## 9. What the external review changed

| Topic | Before review | After |
|---|---|---|
| First move | extract harness from `mission-start.ts` | **rejected**: snapshot, artifacts and metering carry Mission semantics; Stage 1 extracts Run preparation instead |
| Snapshots | one concept | **two**: authorization snapshot (Mission) vs environment snapshot (harness) |
| Metering | move to harness | **three layers**: raw measurement (harness), attribution (Mission), budget settlement (Mission) |
| Artifacts | harness owns them | harness **collects**; Mission **adopts** into the Ledger |
| Delegation | "reuse harness" | **unify the protocol first**; sharing a directory unifies nothing |
| One-step split | 8 files at once | rejected; four stages, each independently verifiable |
| Leave existing code | new code only | rejected; the known debt would keep taxing every later ticket |
| Acceptance | thin controller ≤300 lines | **line counts dropped as a metric**; behavioural trace equivalence instead |

The review's sharpest point, kept verbatim: a 300-line controller that still hides
three implicit shared states, two metering rules and two execution protocols is
still a god function, merely relocated.
