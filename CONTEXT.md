# evoK Domain Context

This context defines the vocabulary for evoK: a long-running system that conducts bounded autonomous research for competitions while preserving evidence, human objectives, and safe external actions.

## Mission and Research

**Mission**:
A bounded autonomous research effort for one competition, with a human-owned objective, constraints, and an intended outcome.
_Avoid_: Job, campaign, session

**Competition**:
A rule-bound environment in which candidates are prepared, evaluated, compared, and possibly submitted.
_Avoid_: Benchmark (unless the environment is explicitly only a benchmark)

**Competition Adapter**:
The competition-specific boundary that explains the rules, inputs, preparation requirements, evaluation facts, and submission format without deciding whether a result should be promoted.
_Avoid_: Competition plugin, competition agent

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
A proposed, bounded arrangement of Team Roles, stages, dependencies, branch groups, verification gates, and reconciliation rules for one Task.
_Avoid_: Route, hard-coded mode

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
A reusable declaration of an execution shape and its required stages or gates; a Pattern is a capability description, not a task-specific route or executable program.
_Avoid_: Mode, hard-coded router

**Research Loop**:
The evidence-driven cycle of selecting Tasks, proposing and executing Experiments, evaluating their results, updating beliefs, and choosing the next research action within an authorized Mission. It advances without a human prompt for every iteration, while the Research Objective and Mission Policy remain human-owned.
_Avoid_: Chat loop, fixed execution script

**File Blueprint**:
The durable, content-addressed workspace files that make a Mission's GOAL, RULES, experiment log, and SCOREBOARD auditable outside the chat transcript. The files are Evidence; they do not score, promote, or authorize Stop by themselves.
_Avoid_: Shared notes, prompt memory, scoreboard-as-verdict

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

**Negative Evidence**:
Evidence that a Candidate or approach failed, was inconclusive, or violated a condition under a recorded set of circumstances.
_Avoid_: Error log

**Pitfall**:
A reusable, answer-agnostic failure pattern that can warn future Tasks without asserting that a particular Candidate is always wrong.
_Avoid_: Rejected answer

## Decisions and Outcomes

**Mission Policy**:
The non-negotiable limits and rules governing resources, safety, permissions, verification, promotion, and external actions for a Mission.
_Avoid_: Suggestion, preference

**Promotion**:
The decision to advance a Candidate to a stronger status after the required evidence and policy checks succeed.
_Avoid_: Evaluation, acceptance

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

## Vocabulary Rules

- Use **Mission** for the long-lived competition effort and **Task** for a scoped unit within it.
- Use **Branch** for an isolated alternative or dependency path, and **Run** for one attempt.
- Use **Evaluator** for objective measurement, **Promotion** for machine advancement, and **Human Acceptance** for the human decision.
- Use **Team Coordinator** for Task-level team planning and **Mission Director** for Mission-level research direction.
- Do not use “orchestrator” as an authority-bearing role without naming which of these two responsibilities is meant.
