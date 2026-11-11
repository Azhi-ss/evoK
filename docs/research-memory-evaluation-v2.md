# Research Memory Evaluation: Spec v2

status: revised design (implementation not yet authorized)
scope: proving whether Mission Research Memory is worth its cost
scoring contract: `evok.l1-hindsight-scoring/v1` (see §3, "Hindsight scoring rule")
reviewed: `src/mission/memory-evaluation.ts`, `src/mission/mission-director.ts`,
          `docs/long-term-memory-prd.md` §11, `tests/integration/memory-evaluation.test.ts`

## 1. Why the current evaluation design cannot answer the question

The PRD says Memory's value should be shown with an Off / Sham / Real comparison.
The current implementation has a structural problem that makes this impossible
offline:

F1 — `evaluateResearchMemory` requires **exactly one arm per mode**
(`off`, `sham`, `real`) and throws otherwise. A single record cannot be replayed
into three arms.

F2 — `researchMemoryArmMetrics` reads `record.decisions`, `record.experiments`,
`record.budget.consumed`. All of these live in the MissionRecord, not in the
Research Memory projection. Replaying the same record under three different
`researchMemoryMode` values produces **three identical metric sets and a delta of
exactly zero**, regardless of what Memory contained.

F3 — `replayResearchMemory` produces `ReplayedRunMemory`: which cards a Run could
have seen and which ledger revision it was pinned to. That is a **leakage and
determinism check**, not evidence of research value.

F4 — The ten control checks (model version, prompts, tools, decision calls,
budgets, stopping conditions, initial state) validate comparability between
*independently produced* arms. They cannot manufacture comparability from one
record.

Conclusion: the current apparatus is a good fixture for **integrity** and a
non-functional fixture for **value**. Any value claim from it would be an
artifact, not a measurement.

There is a second, more serious bias:

F5 — If the `off` arm also loses current best / scoreboard state, it measures
amnesia, not absence of Memory. The result would be biased in Memory's favour by
construction.

## 2. What counts as evidence

Three distinct claims, kept separate:

| Claim | Evidence required |
| --- | --- |
| Integrity: no future information, deterministic projection, correct pinning | Offline replay — already supported |
| Local decision quality: Memory changes the next bounded action for the better | Decision-point counterfactual evaluation (L1) |
| Search-level value: Memory improves the trajectory, not just one step | Online multi-arm evaluation (L2) |

Offline replay answers only the first. It must not be reported as answering the
other two.

The PRD's success language should be narrowed accordingly: Memory is expected to
improve **cross-run consistency, avoidance of known failures, and preservation of
open questions**. Final-score improvement is not a design requirement and should
not be the headline metric. External ablations support this framing: persistent
state improved research efficiency across five frontier agents while hidden-test
outcomes did not consistently improve.

## 3. L1 — Decision-point counterfactual evaluation (do this first)

The existing two-stage Director protocol already produces frozen Blind Proposals.
Each one is a natural counterfactual decision point.

### Procedure

1. From completed Missions, select N revision decision points with a durable
   frozen Blind Proposal and a known subsequent outcome.
2. Rebuild the exact trusted base state for each point: objective, contract,
   policy, budget, tasks, observations, stateVersion. This state is identical
   across arms.
3. Generate three packets for the same point: Off (no Research Memory packet),
   Schema-only Sham, Real.
4. Run the revision stage once per arm with the same model, tools and decision
   budget. No Experiment is dispatched; only the proposed action is recorded.
5. Score the proposal against the **actually observed** outcome that followed the
   original decision.

### Hindsight scoring rule (`evok.l1-hindsight-scoring/v1`)

The L1 reference is **the action actually taken** — the revised proposal the
original Mission durably recorded and then executed. It is never the best action
among those the Mission later measured.

Rationale

- Cheap: the taken action is already recorded and measured by the Mission's own
  Evidence, so scoring costs no extra model call and no comparable re-measurement.
- Unbiased: the reference is fixed before any arm is re-decided, so no arm can
  influence which action it is scored against.
- Auditable: "did the arm propose what the Mission did?" is a structural
  `deriveDecisionDelta` comparison, not an LLM judge.

Bias limits (carried by every report)

- **Weak.** One observed action is not the best action, so a proposal that beat
  the taken action scores exactly like one that merely matched it.
- **No counterfactual for untaken actions.** L1 can never credit Memory for a
  better action the original Mission did not take.
- **The taken action may itself be a bad decision.** The rule measures agreement
  with the observed trajectory, not optimality.
- **Selection bias is why the alternative was rejected.** Scoring against the best
  action among those later measured would rank a set that depends on what the
  original Mission chose, so the reference would be picked with information the
  arms could not have had, and would move between samples. That variant needs
  comparable measurements and its own contract version.

**Changing this rule requires an explicit versioned evaluation-contract change**:
bump the contract id (`evok.l1-hindsight-scoring/v2`) and record the new
reference, its rationale and its bias limits here before any report is scored
against it. Reports are not edited in place to describe a different reference;
an unreviewed code change to the rule is a contract change that skipped this
section.

### Controls

- The base state is byte-identical across arms except for the Memory packet.
- Human Insight is identical across arms — same ids, versions and order — or
  disabled for the whole run, and the report records which choice was made and
  which pins were supplied (#241). A point whose arms read different Insight is
  refused before any decision call.
- No future information: the packet may only contain what existed at that
  decision point, enforced by the existing pinned-ledger check.
- `off` still carries the Mission's current best and scoreboard state (F5).
  This is a hard test assertion, not a guideline.
- One revision call per arm per point; identical correction-attempt budget.
- Scoring uses the real subsequent outcome, not an LLM judge.

### Metrics

- Decision delta distribution (unchanged / reordered / replaced / withdrawn).
- Whether the revised action matched the action actually taken, scored over the
  original Experiment's measured Evidence (see "Hindsight scoring rule" above).
- Rate of proposing an already-measured objective with no replication value.
- Preservation of competing Hypotheses in the proposal.

Sample target: ≥ 50 decision points across several Missions, so a direction can
be stated. Report direction, not effect size. Sham cannot match semantic
information, so only direction is meaningful; the existing caveat stays in the
report.

### What L1 cannot show

L1 measures whether Memory improves a single decision. It cannot measure where
Memory steers exploration over many steps, because off-policy trajectories have
no propensity. That requires L2.

## 4. L2 — Online multi-arm evaluation (only if L1 shows a signal)

Run only when L1 indicates a directional benefit.

### Design

- Three arms (`off`, `sham`, `real`) from the same initial state, with the ten
  existing control dimensions held equal.
- Identical decision-call budget, Experiment budget, retry budget, evaluation
  budget and stopping conditions.
- `off` retains current best and scoreboard (F5), asserted in tests.
- Read only directional metrics: `hypothesisDiversity`, `knownFailureRepetition`,
  `validEvidencePerBudget`, and both Director-stage costs.
- No significance testing. Require the same direction across 2–3 different
  Missions before drawing a conclusion.

### Non-comparability rule

Competitions are not repeatable. Do not run three arms on the same historical
competition and then compare them to a historical arm. L1 uses frozen historical
ledgers; L2 runs on new Missions and is reported separately. A report that mixes
them must be rejected by the evaluator.

### Cost honesty

Two Director stages cost money. Both stages are counted in every arm, including
the `off` arm's blind stage. An arm that wins by receiving extra thinking is not
a Memory result.

## 5. Relationship to forgetting / fork-and-flush

The `off` arm is the natural forgetting arm, but only if it retains current best
and scoreboard (F5). "Forgetting" must mean dropping historical narrative while
keeping the current optimum, not dropping all state.

Fork is out of scope here. It is constrained by the subagent transport spec:
delegated children currently require an empty workspace, so fork-with-workspace
needs artifact copying or a separate shared-workspace design. That is a
transport question, not a memory-evaluation question.

## 6. Implementation changes required

R1 — Add a decision-point evaluation entry that accepts one frozen decision point
and three packets, and returns per-arm proposals without dispatching Experiments.
It must not reuse `evaluateResearchMemory`'s one-arm-per-mode requirement, which
belongs to L2 whole-Mission comparison.

R2 — Add an explicit `offRetainsMissionState` assertion in both L1 and L2, with a
failing test when the `off` arm lacks current best or scoreboard.

R3 — Label the existing `evaluateResearchMemory` output as
`whole-mission-comparison` and refuse to run it when all arms derive from the
same MissionRecord. That is a guaranteed zero-delta input and should be an
explicit error, not a silent report.

R4 — Keep `replayResearchMemory` and its future-information check, but rename its
report section to `integrity` so it is never presented as value evidence.

R5 — Reports must carry the existing Sham caveat and the new
"L1 does not measure trajectory steering" caveat, plus the versioned
hindsight-scoring rule and its selection-bias caveat (§3).

## 7. Acceptance tests

A1. Replaying one MissionRecord under three modes is rejected as an invalid
    comparison instead of returning zero deltas.
A2. L1 produces different proposals for Off/Sham/Real at a decision point where
    Memory is relevant, with an identical base state.
A3. L1 refuses any packet containing information created after the decision
    point.
A4. The `off` arm includes current best and scoreboard; a test fails if either is
    missing.
A5. L1 never dispatches an Experiment and never consumes Experiment budget.
A6. L2 refuses to mix historical-replay arms with newly-run arms in one report.
A7. Both Director stages are counted in every arm's cost, including `off`.
A8. The report contains both caveats and no claim of statistical significance.
A9. `bun test --rerun-all-tests`, `bun run typecheck`, `git diff --check` stay at
    the known-failure baseline.

## 8. Out of scope

- Cross-Mission Research Memory (M2).
- Novelty/originality scoring. For competition Missions the objective is score,
  not novelty; this is a separate, lower-value feature.
- Live paid evaluation runs. L1 uses recorded outcomes; L2 requires separate
  budget authorization.
- Any change to evaluator, promotion, admission, budget or submission gates.

## 9. Settled: the hindsight reference

Settled by contract §3 "Hindsight scoring rule" (`evok.l1-hindsight-scoring/v1`,
#234): L1 scores against **the action actually taken**, not the best action among
those later measured. The taken action is cheap and unbiased; the best-later
variant needs comparable measurements and would introduce selection bias, so it
is a separate optional refinement with its own contract version. This is settled
before L1 implementation, which is what the metric's meaning depends on.
