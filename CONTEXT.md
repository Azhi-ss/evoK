# evoK Domain Context

This context defines the vocabulary for evoK: a long-running system that conducts bounded autonomous research — including verifiable Method Improvement (task-internal RSI) — inside one Mission, while remaining compatible with existing competition arms and preserving evidence, human objectives, and safe external actions.

The product baseline is the task-internal RSI PRD v1.0 ([ADR-0014](docs/adr/0014-prd-rsi-baseline.md)). Mission is the only mainline.

## Mission and Research

**Mission**:
A bounded autonomous research effort with a human-owned objective, constraints, and an intended outcome. A Mission may target a Competition; Method Improvement happens inside the same Mission.
_Avoid_: Job, campaign, session, RSI project

**Competition**:
A rule-bound environment in which candidates are prepared, evaluated, compared, and possibly submitted.
_Avoid_: Benchmark (unless the environment is explicitly only a benchmark)

**Competition Adapter**:
The competition-specific boundary that explains the rules, inputs, preparation requirements, evaluation facts, and submission format without deciding whether a result should be promoted.
_Avoid_: Competition plugin, competition agent

**Deploy Arena**:
An orthogonal competition-serving arm. It opens only when a Task Contract sets `competitionId=deploy-arena`. It is not part of the Mission research / Method Improvement mainline, not a second control plane, and not a commercial contest OS.
_Avoid_: RSI deploy path, mainline serving, commercial OS

**Method Improvement**:
A Mission-internal action that proposes, verifies, enables, and inherits a change to the working method (task-internal RSI). It is not a separate project or a second mainline.
_Avoid_: RSI project, reflection-only improvement, research-equals-improvement

**Research Objective**:
The outcome the human wants the Mission to pursue; it defines what counts as relevant progress and cannot be changed implicitly by an agent.
_Avoid_: Prompt, task goal

**Task**:
A scoped piece of research or engineering work that contributes evidence or an artifact toward a Mission objective.
_Avoid_: Mission, step

**Task Contract**:
The explicit agreement for a Task: its objective, inputs, constraints, expected outputs, evidence requirements, and completion conditions.
_Avoid_: Prompt, ticket, instruction

**Hypothesis**:
A falsifiable explanation or proposed approach whose value is tested by a Candidate and its evidence.
_Avoid_: Idea (when a testable statement is intended)

**Candidate**:
A concrete proposed solution or implementation that can be materialized, tested, evaluated, and compared with other candidates.
_Avoid_: Answer, result

**Methodology Manifest**:
The structured, machine-checkable declaration accompanying a Candidate that indexes its methodology components — feature pipeline steps, ensemble composition and OOF protocol, and the split contract reference. It is a declarative index over the candidate artifact, never the source of truth: the artifact stays authoritative, and a manifest that disagrees with the artifact fails verification.
_Avoid_: Gene, candidate schema

**Split Contract**:
The task-level, immutable split discipline (kfold/time/group with purge and embargo) that every Candidate under a Task inherits by reference. Inner search cannot rewrite it; violating it is a rule failure, not merely a worse score.
_Avoid_: Folds, CV config

**Experiment**:
A controlled attempt to learn about a Candidate under a declared environment, budget, and evaluation contract.
_Avoid_: Run (a Run is one execution attempt)

**Run**:
One execution attempt for a Task or Candidate under a fixed input, environment, policy, and attempt identity.
_Avoid_: Experiment (when referring to the scientific activity rather than one attempt)

## Teamwork and Execution

**Team**:
A temporary group of role-bound agents assembled to complete one Task or milestone; the Team itself is not the durable Mission state.
_Avoid_: Swarm, permanent team

**Role**:
A bounded responsibility with defined inputs, outputs, completion conditions, and authority within a Team.
_Avoid_: Persona, specialist (unless the responsibility is explicit)

**Mission Director**:
The Mission-level decision maker that selects research Tasks, maintains alignment with the Research Objective, allocates Task scope, and decides whether to continue, revise, scale, or stop.
_Avoid_: Team Coordinator, manager

**Team Coordinator**:
The Task-level planner that proposes how Roles, topology, verification, and resources should be arranged for a Task; it does not own the Research Objective or final acceptance.
_Avoid_: Mission Director, final orchestrator

**Execution Plan**:
A proposed, bounded arrangement of Team Roles, stages, dependencies, branch groups, verification gates, and reconciliation rules for one Task. It is a capability description, not Promotion or gate-pass proof.
_Avoid_: Route, hard-coded mode, promotion key

**Branch**:
An isolated line of work derived from one Task Contract, either as an alternative strategy or as one independent dependency branch.
_Avoid_: Copy, worker thread

**Fan-Out**:
The deliberate creation of multiple bounded Branches or independent Task executions from one eligible point in a plan.
_Avoid_: Unbounded spawning, duplication

**Fan-In**:
The explicit reconciliation of Branch outputs through a declared join, comparison, synthesis, or reduction rule.
_Avoid_: Shared-folder merge, silent selection

**Join Policy**:
The rule that says which Branch outputs are required or optional, what quorum and timeout apply, and how failure or partial evidence closes a Fan-In.
_Avoid_: Barrier (when the completion rule is more than waiting)

**Pattern**:
A reusable declaration of an execution shape and its required stages or gates; a Pattern is a capability description, not a task-specific route, executable program, or Promotion proof.
_Avoid_: Mode, hard-coded router, v1 must-have roster

**Thin execution default**:
The v1 product default for a Task is one Branch. Multi-branch Fan-Out and verification Roles (Falsifier, Critic, Challenger, and kin) are an on-demand capability library, not the gated default and not a standing roster.
_Avoid_: Standing verification roster, multi-branch as v1 must-have, Execution Plan as Promotion proof

- Default Branch width is 1. Multi-branch Fan-Out is raised on demand.
- Falsifier, Critic, Challenger, and kin are raised on demand — not a standing roster.
- Execution Plan, Pattern, and Role names describe capability; they are not Promotion or gate-pass proof. Elite or Team Fan-Out is not a Promotion key.
- Code defaults stay reserved (B) for a later explicit order locked to execution planning. Thickening the Pattern library or a full standing roster as v1 must-haves is rejected (C).
- True assets remain the Evidence ledger, hang/T48 gates, and explicit live authorization. The execution roster accelerates; it does not prove a gate.

**Research Loop**:
The evidence-driven cycle of selecting Tasks, proposing and executing Experiments, evaluating their results, updating beliefs, and choosing the next research action within an authorized Mission. It advances without a human prompt for every iteration, while the Research Objective and Mission Policy remain human-owned. It is the product control plane: authorize, continue, repair, and stop. A chat transcript is not Mission authority.
_Avoid_: Chat loop, fixed execution script, chat-as-authority

**Mission Retained State**:
The measured Mission state an arm is never denied, however much Memory it is given or denied: the scoreboard of measured Run scores and the current best row among them. Memory Off drops historical narrative, never the current optimum; an arm that lost both would measure amnesia rather than absence of Memory.
_Avoid_: Memory slice, agent state, scoreboard-as-verdict

**File Blueprint**:
The durable, content-addressed workspace files that make a Mission's GOAL, RULES, experiment log, and SCOREBOARD auditable outside the chat transcript. The files are Evidence; they do not score, promote, or authorize Stop by themselves.
_Avoid_: Shared notes, prompt memory, scoreboard-as-verdict

**ToyHarness**:
The fixture/test facade (`ToyCompetitionHarness` and kin) used to exercise contracts offline. It is not a product control plane and cannot authorize, continue, repair, or stop a Mission.
_Avoid_: Second Mission loop, production harness, chat-driven controller

**Search Plugin**:
A removable strong-search / MCTS adapter (SEA) a search host may mount or unmount. The default parent-selection path is `fixed_uct` and does not depend on any plugin. Progressive / MCTS / StrongSearch remain explicit opt-in. The plugin is not Promotion authority and is not a second control plane.
_Avoid_: Competition plugin, default MCTS, welded strong search

**Skill**:
A named, versioned instruction pack a Mission may load on demand.
_Avoid_: System-prompt dump, hidden prompt

**Skill State**:
Whether a Skill is a candidate, accepted, or demoted relative to a Mission or method. Disclosure level is not acceptance. A candidate is never default-injected; accepted requires Admission; demoted is the rollback path.
_Avoid_: Installed, enabled (when lifecycle is intended)

**Cross-review**:
A two-phase (author then reviewer) critique whose output is a content-addressed Artifact and ledger Evidence ref that later Tasks can read. Cross-review is advisory and never authoritative for evaluation or promotion.
_Avoid_: Cross-model check (that is model-tier agreement at the promotion gate), judge, promotion review

## Verification and Evidence

**Self-Verification**:
A Candidate-side completeness and consistency check for contract coverage, expected outputs, test evidence, and artifact identity; it is advisory and cannot establish objective correctness.
_Avoid_: Proof, independent evaluation

**Falsifier**:
A Role whose sole purpose is to actively find a counterexample, failure condition, or rule violation in one Candidate or Branch.
_Avoid_: Reviewer, approver

**Critic**:
A Role that identifies structural, logical, or implementation defects in a proposed Candidate.
_Avoid_: Falsifier (unless the role is specifically attacking failure conditions)

**Challenger**:
A Role that probes boundary cases, worst-case inputs, and adversarial conditions against a Candidate.
_Avoid_: Falsifier (when the broader challenge protocol matters)

**Auditor**:
A Role that checks whether evidence, source references, rules, and claimed execution are genuine and traceable.
_Avoid_: Reviewer, judge

**Success Auditor**:
A Role that checks each part of a success claim against the required evidence before the result is treated as an accepted outcome.
_Avoid_: Evaluator, approver

**Evaluator**:
An independent mechanism that measures a Candidate against the Competition's evaluation facts and returns observations, scores, and rule findings.
_Avoid_: Judge (the Evaluator measures; promotion is a separate decision)

**Evidence**:
A traceable observation or artifact that supports or contradicts a finding, including the conditions under which it was obtained.
_Avoid_: Claim, opinion

**Artifact**:
A durable, addressable output of a Task or Run, such as candidate code, data, logs, metrics, or a report.
_Avoid_: Message, transient output

**Snapshot**:
An immutable, evaluation-ready representation of the Candidate and its relevant inputs at a specific point in a Run.
_Avoid_: Live workspace, current files

**Finding**:
A conclusion drawn from one or more Evidence items within stated conditions and scope.
_Avoid_: Claim (a Claim may communicate a Finding externally)

**Research Memory**:
A deterministic, versioned, Mission-scoped projection of authoritative Mission history into bounded reading cards. It is derived and advisory — never a second write ledger — and a trusted Mission-level switch can disable it.
_Avoid_: Transcript memory, second evidence ledger, session memory

**Finding Card**:
A bounded presentation projection of one Finding: a short summary, applicability label, lifecycle, and typed source refs. It is not an authoritative Evidence record.
_Avoid_: Evidence, claim, full history

**Synthesis Proposal**:
A structured, reference-first interpretation (Hypothesis, Finding, or Pitfall) an authorized Agent or Director submits for storage. The controller validates its identity, schema, sensitive content, typed refs, visibility, applicability, and idempotency; storage outcomes are `accepted_for_storage` or `rejected`, and neither is a Verified Claim or scientific approval.
_Avoid_: Memory write, model insight, verified claim

**Synthesis Finding Card**:
A reading card projected from an accepted Finding Proposal: a conditional conclusion with applicability, its known limitations, and typed source refs. It is unverified and provisional, unlike a measured Finding Card.
_Avoid_: Measured finding, Evidence

**Hypothesis Card**:
A reading card projected from one accepted Synthesis Proposal: a conditional claim with supporting refs, contradicting refs, competing Hypothesis refs, unknowns, applicability, and an optional advisory next-validation suggestion.
_Avoid_: Verified hypothesis, second Evidence ledger

**Pitfall Card**:
A reading card projected from an accepted operational/protocol Pitfall Proposal: the reproducible conditions, source Run refs, and an avoidance suggestion.
_Avoid_: Rejected answer, error log

**Blind Proposal**:
The Mission Director's bounded next action formed from the trusted Mission state and measured Evidence BEFORE any Research Memory is visible. It is validated, durably frozen, and kept as the counterfactual baseline for the later revision.
_Avoid_: Draft decision, first guess, history-blind proposal

**Revised Proposal**:
The Memory-informed revision of one Blind Proposal, formed from the same frozen base state plus one pinned Research Decision Packet. Only the Revised Proposal can dispatch; Research Memory adds context, never authority.
_Avoid_: Memory output, second opinion, Memory-approved action

**Research Decision Packet**:
The bounded Memory view one Memory-informed decision stage receives: cards from exactly one pinned Research Memory snapshot, an omission count, and that snapshot's identity. It is a presentation projection, never a new ledger, and a decision may only cite card ids it actually received.
_Avoid_: Memory dump, second snapshot, full history

**Delegated Memory Slice**:
The Research Memory slice a delegated child agent receives: newly generated for the child's own Mission/Task/Run/targetAgent from the parent's pinned Research Memory snapshot. It is never the parent's, a sibling's, or a previous Run's slice, and it can never carry a wider packet than the parent was shown.
_Avoid_: Inherited slice, parent memory, copied snapshot

**Decision Regret**:
The record that a direction a Memory-informed revision rejected was later measured as viable by a comparable Experiment. An unexecuted or never-compared direction stays `unobserved`; it is never a failure, Negative Evidence, or regret, and no numeric regret score is computed.
_Avoid_: Rejected-answer penalty, counterfactual score

**Direction-Concentration Review**:
A durable, advisory recommendation written when Memory repeatedly changed decisions toward the same direction without new discriminating (refuting) Evidence. It recommends reevaluating that direction; it cannot force an action, impose an exploration quota, alter Search math, or consume execution authority.
_Avoid_: Memory veto, exploration quota, forced diversity target

**Decision Delta**:
The controller-derived comparison of a Blind Proposal and its Revised Proposal: unchanged, reordered, replaced, withdrawn, or expanded-via-existing-search. It is computed from the proposals, never declared by the model.
_Avoid_: Model-reported change, Memory score

**Memory Evaluation Arm**:
The trusted configuration value that selects which Memory projection a comparison Mission runs: Memory Off, Schema-only Sham, or Real Memory. It is durable on the Mission record, so a resume cannot silently switch arms, and it grants no authority beyond the existing no-Memory baseline.
_Avoid_: Memory feature flag, per-Run toggle

**Schema-only Sham**:
A control input shaped like the real Research Decision Packet — same card count, order, kinds and bounds — whose slots are neutral placeholders explicitly marked as control, carrying no research fact, Evidence ref, applicability, or directional advice. It estimates format and extra-context effects; it is never Memory content and never a perfect causal control.
_Avoid_: Fake Memory, synthetic evidence

**Control Card**:
One Schema-only Sham slot: it occupies the same position and kind as one real Memory card but is explicitly marked as a control input, with no research fact, Evidence ref, applicability, or directional advice. It is presentation structure, never Memory content.
_Avoid_: Placeholder evidence, fake finding

**Offline Memory Replay**:
A deterministic re-projection that pins each Run to the Mission state, stored Proposals, and Memory snapshot that existed before that Run began, so Run N can never see information produced after it started. It compares arms without a live model provider or GPU.
_Avoid_: Hindsight replay, transcript replay

**Negative Evidence**:
Evidence that a Candidate or approach failed, was inconclusive, or violated a condition under a recorded set of circumstances. Only a real measurement creates it; an operational failure alone never does.
_Avoid_: Error log

**Operational Outcome**:
The non-scientific reading of one Run: an OOM, timeout, invalid measurement, or other infrastructure/protocol failure. It keeps its Run Outcome and may support an Operational Pitfall, but it is never Negative Evidence and cannot refute a Hypothesis.
_Avoid_: Failed experiment, negative result, refutation

**Operational Pitfall Card**:
A reading card projected from one operational Run failure: its failure kind, reproducing conditions, and source Run refs. It is advisory and never a scientific claim.
_Avoid_: Negative Evidence, refuted hypothesis

**Replication Context**:
Advisory context attached to a repeated Experiment objective: the prior Runs and their outcomes. A repeat may be seed replication or a critical ablation, so it is context, never an automatic rejection or a Memory-owned veto.
_Avoid_: Duplicate rejection, Memory veto

**Applicability**:
The claim-specific conditions a Memory card states it is true under, as `dimension:value` pairs over Mission scope, Task scope, Objective, Evaluation protocol, Dataset version, Method/configuration, Runtime, and Contract digest. No card must declare every dimension; an undeclared dimension stays unknown, and Contract digest equality alone never establishes scientific compatibility.
_Avoid_: Universal fingerprint, compatibility score, metadata tag

**Direct Prior**:
A Memory card that may be reused as an authoritative starting point for the current retrieval: every critical dimension is declared and matches, every declared dimension has a supplied current value, the card is active, and it is visible. A declared difference, a declared dimension the retrieval cannot compare, an undeclared critical dimension, a retired lifecycle, or a stale/revalidation marker all deny direct-prior use while the card stays visible as context.
_Avoid_: Applicable record, visible record, matching contract

**Revalidation Required**:
The marker on a card whose declared critical condition (Objective, Evaluation, Dataset, Method, Runtime, Contract) changed since the card was derived. It is downgraded to `stale` in the next deterministic Snapshot, never silently reused, and the previously published Snapshot stays historical. Only a condition the authoritative record publishes mission-wide (the Evaluation protocol) is derived today; the Objective dimension is a Task/experiment objective, never the Mission research objective.
_Avoid_: Auto-update, silent compatibility, expiry

**Card Lineage**:
The explicit derived-from and supersedes relations of a Memory card, plus its revision number. Equivalent Hypotheses become revisions with `supersededBy`/`supersedes` instead of last-write-wins, same-condition conflicts coexist as contested, and withdrawal retires future reads without rewriting Evidence or old snapshots.
_Avoid_: Overwrite, dedupe by name, History rewrite

**Pitfall**:
A reusable, answer-agnostic failure pattern that can warn future Tasks without asserting that a particular Candidate is always wrong.
_Avoid_: Rejected answer

**Experiment Validity**:
Whether an Experiment produced usable gate evidence. Effectiveness on official samples is not optimality; inconclusive is not pass.
_Avoid_: Score-up, success (when the question is whether the Experiment is usable evidence)

## Decisions and Outcomes

**Mission Policy**:
The non-negotiable limits and rules governing resources, safety, permissions, verification, promotion, and external actions for a Mission.
_Avoid_: Suggestion, preference

**Promotion**:
The decision to advance a Candidate to a stronger status after the required evidence and policy checks succeed.
_Avoid_: Evaluation, acceptance, Admission (Admission is the method/Skill writeback gate)

**Admission**:
The evidence-gated decision to write a Method Improvement or Skill into accepted Skill State. The minimal set is official samples + an adversarial-labeled subset + a protected holdout; a missing holdout refuses Admission. Elite or Team Fan-Out is not an Admission key.
_Avoid_: Promotion, install, score-up

**Method Writeback**:
The one-slice lifecycle that proposes a method or Skill change, runs regression, then admits or rolls back. File-body Skill mutation may remain unopened while this lifecycle slice is open. Writeback also requires a Budget Gate pass when a ledger is consulted; Budget pass is not Admission pass.
_Avoid_: Silent edit, batch skill rewrite

**Budget Gate**:
The evidence-gated reserve → settle contract that refuses continue or writeback when spend is unreserved or over the Mission Policy cap. An optional Method Improvement sub-cap can account that spend separately. Budget pass is not Admission pass.
_Avoid_: Admission, silent restore, score-as-budget

**Method-version stats**:
Visit/value statistics scoped to one method version. After a Method Improvement version switch, old-version stats remain historical and must not become the new version's search authority.
_Avoid_: Shared UCT bank, silent stat carry-over

**Reserve**:
Holding units against the Budget Gate before continue or writeback. Settle without a Reserve fails closed.
_Avoid_: Pre-pay, lock

**Settle**:
Consuming reserved units after an action. Settling more than the Reserve is over-budget and refuses the action without consuming.
_Avoid_: Write-off, silent top-up

**Local Champion**:
The best Candidate currently promoted within evoK's internal scope; it is not automatically a human-approved conclusion or an external submission.
_Avoid_: Winner, final answer

**Human Acceptance**:
The human objective owner's explicit decision that the Mission's result and interpretation are acceptable for the intended purpose.
_Avoid_: Model approval, local promotion

**External Submission**:
An intentional action that delivers a Candidate or result to an outside Competition system and may create an irreversible side effect.
_Avoid_: Promotion, publish

**Stop Reason**:
The recorded explanation for ending or pausing a Mission, such as budget exhaustion, insufficient evidence, rule risk, infrastructure failure, or human decision.
_Avoid_: Error message

## Six-pack ownership

Logical packages pin authority. Physical packages are **in place** (P6 / [ADR-0013](docs/adr/0013-six-pack-physical-closeout.md); product baseline [ADR-0014](docs/adr/0014-prd-rsi-baseline.md); as-is [docs/arch-as-is.md](docs/arch-as-is.md)):

| Package | Directory | 物理就位 |
|---|---|---|
| **mission** | `src/mission/` ([ADR-0010](docs/adr/0010-mission-cli-physical-pack.md)) | 勾 |
| **evidence** | `src/evidence/` ([ADR-0008](docs/adr/0008-evidence-physical-pack.md)) | 勾 |
| **execution** | `src/execution/` ([ADR-0011](docs/adr/0011-execution-physical-pack.md)) | 勾 |
| **search** | `src/search/` ([ADR-0009](docs/adr/0009-search-physical-pack.md)); ToyHarness in `src/search/fixtures/` | 勾 |
| **competition** | `src/competition/` ([ADR-0012](docs/adr/0012-competition-physical-pack.md)) | 勾 |
| **cli** | `src/cli/` ([ADR-0010](docs/adr/0010-mission-cli-physical-pack.md)) | 勾 |

Remaining **pack-shim** flat `src/*.ts` files (not shared wiring such as `evok-model`) are migration-period re-exports for one more release (ADR-0013). Recorded in [ADR-0007](docs/adr/0007-six-pack-ownership.md).

| Package | Owns | Does not own |
|---|---|---|
| **mission** | Mission Director, authorize, budget, Task Contract, continue / repair / stop, thin `/research` entry, Skills routing shell | Business/competition code; search-graph authority; Team blueprint details; Admission / writeback (EXP); Budget Gate predicates (BUD) |
| **evidence** | Ledger, T48, kill/hang, promotion gates, Admission / Method Writeback, Budget Gate (reserve → settle), contest-arm auto-submit (all-green only), authoritative edge results | Search tree structure; Team Coordinator / Role planning |
| **execution** | Dynamic Team: Pattern, Team Coordinator, Roles, runtime, Policy Guard | Gate override; replacing the Evaluator. Thin execution default already landed — do not reopen C thickening |
| **search** | Pluggable harness, candidate/attempt graph, failure neighborhood, retrieval slicing, SEA mount/unmount, method-version stats isolation | Promotion; gate override; Admission / Budget predicates |
| **competition** | Contest and local Evaluator adapters; Deploy Arena graph / COI (opt-in `competitionId=deploy-arena`, not mainline) | Auto-submit authority (evidence-owned, fail-closed) |
| **cli** | Thin Mission CLI shell + Pi native TUI (CLI-equivalent mirror slashes; Pi owns Pi shorts) | A second control plane |

The product control plane is the Research Loop (authorize / continue / repair / stop). Agents are replaceable Run execution (ADR-0005); they do not own Mission decisions. The interactive surface is Pi native TUI (ADR-0014). ToyHarness is fixtures and tests only — not a second control plane.

## Vocabulary Rules

- Use **Mission** for the long-lived research effort and **Task** for a scoped unit within it. Method Improvement is an action inside that Mission, not a second RSI project.
- Use **Branch** for an isolated alternative or dependency path, and **Run** for one attempt.
- Use **Evaluator** for objective measurement, **Promotion** for Candidate advancement, **Admission** for method/Skill accepted writeback, and **Human Acceptance** for the human decision.
- Use **Team Coordinator** for Task-level team planning and **Mission Director** for Mission-level research direction.
- Do not use “orchestrator” as an authority-bearing role without naming which of these two responsibilities is meant.
- The v1 default Team is a single Branch; raise multi-branch Fan-Out and verification Roles only on demand. An Execution Plan, Pattern, Role roster, or Elite/Team Fan-Out is not Promotion proof.
- The six logical packages (mission, evidence, execution, search, competition, cli) own the rows in Six-pack ownership. The Research Loop is the product control plane; the chat transcript, Pi native TUI, and ToyHarness are not.
- A Search Plugin is removable. Default parent selection stays `fixed_uct`. Method-version stats do not carry across a version switch and are not Promotion proof.
- Contest-arm auto-submit is allowed only when every promotion/evidence gate is green; the hang gate requires a ledger KillTestPlan. Every attempt is ledged, and any non-green gate fails closed. Expanding budget or permissions past Mission Policy, and changing Human Acceptance on the direct Broker path, remain human-owned. `#40` Progressive is explicit Mission/config opt-in only; the product default stays `fixed_uct` / off. Elite ≠ 晋级 / Promotion / Admission / Broker / kill-test key. Deploy Arena is an orthogonal opt-in arm (`competitionId=deploy-arena`); env never opens live; missing playground/bohr credentials fail closed. It is not a commercial contest OS.
