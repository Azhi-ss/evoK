/**
 * Deterministic offline evaluation of Research Memory (M1-T9 / #218).
 *
 * Memory Off, Schema-only Sham and Real Memory are trusted-configuration arms of
 * the SAME Mission lifecycle: `mode` is supplied by the controller/CLI (never by
 * a Run or an agent) and selects which Memory projection reaches the revision
 * stage. This module turns three such arms into one report and adds the
 * offline-replay seam, which pins every Run to the Mission state, snapshot and
 * proposals visible BEFORE that Run began — so Run N can never see information
 * produced after Run N started.
 *
 * The report is a comparison reading, not a causal proof: a Schema-only Sham can
 * match card structure, field surface and bounds, but not semantic information,
 * so it is a control input and never a perfect causal control. It is also a pure
 * read over authoritative durable records: it dispatches nothing, measures
 * nothing, and changes no evaluator, Promotion, Admission, Budget, hang or
 * Broker rule.
 */
import { deepFreeze, digestValue } from "../security-boundary";
import {
  RESEARCH_MEMORY_EVALUATION_MODES,
  projectResearchDecisionPacket,
  projectResearchMemorySnapshot,
  shamResearchDecisionPacket,
  shamResearchMemorySnapshot,
  type ResearchMemoryEvaluationMode,
} from "../evidence/research-memory";
import { projectDecisionAccountability } from "./decision-accountability";
import {
  classifyTrailEntry,
  missionResearchSource,
  type DecisionRecord,
  type ExperimentTrailEntry,
  type MissionRecord,
} from "./mission-start";

export const RESEARCH_MEMORY_EVALUATION_SCHEMA = "evok.research-memory-evaluation/v1" as const;

export type { ResearchMemoryEvaluationMode } from "../evidence/research-memory";

/**
 * The one honest limit of the three-arm design: a Sham can match structure and
 * bounds, never information content, so it is a control input rather than a
 * perfect causal control. Reported next to every reading.
 */
export const RESEARCH_MEMORY_CONTROL_CAVEAT =
  "Schema-only Sham matches card structure, field surface and bounds but cannot match semantic information, so it is a control input and not a perfect causal control: only the direction of a reading is meaningful.";

export const RESEARCH_MEMORY_EVALUATION_ASSUMPTIONS: readonly string[] = [
  RESEARCH_MEMORY_CONTROL_CAVEAT,
  "Rejected alternatives stay counterfactually unobserved unless a later comparable measured Experiment supplies the counterfactual Evidence.",
  "Offline replay pins each Run to Mission state, proposals and snapshot visible before it began; no live model provider and no GPU are required.",
  "Arms are comparable only when model version, prompts, tools, decision calls, budgets, stopping conditions and initial state were held equal.",
];

/** Runs visible before one replayed Run, and the bounded Memory it could see. */
export interface ReplayedRunMemory {
  readonly runId: string;
  readonly mode: ResearchMemoryEvaluationMode;
  /** Only Runs (and therefore facts) that already existed when this Run began. */
  readonly visibleRunIds: readonly string[];
  /** Ledger revision the Mission served this Run; legacy records use the prefix ordinal. */
  readonly ledgerRevision: number;
  readonly snapshotId?: string;
  readonly snapshotDigest?: string;
  readonly packetDigest?: string;
  readonly cardCount: number;
  /** True when the delivered input was a Schema-only Sham control packet. */
  readonly control: boolean;
}

function timeOf(at: string | undefined): number {
  const parsed = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * One Run in authoritative trail order (baseline first, then each attempt),
 * with the two instants replay must not conflate: `beganAt` (dispatch) and
 * `producedAt` (confirmed outcome). Using the outcome instant for both would
 * let a concurrently-finished Branch into a Run's visible state even though it
 * finished AFTER that Run began.
 */
interface TrailRun {
  readonly runId: string;
  readonly beganAt: string;
  readonly producedAt: string;
}

function trailRunsOf(record: MissionRecord): TrailRun[] {
  const runs = record.runs ?? {};
  const instant = (runId: string, fallback: string): TrailRun => ({
    runId,
    beganAt: runs[runId]?.dispatchedAt ?? fallback,
    producedAt: runs[runId]?.finishedAt ?? fallback,
  });
  const trail: TrailRun[] = [];
  if (record.baseline) trail.push(instant(record.baseline.runId, record.createdAt));
  for (const entry of record.experiments ?? []) trail.push(instant(entry.runId, entry.at));
  return trail;
}

/**
 * The record as it stood when `beganAt` happened: an outcome or a stored
 * Proposal produced at or after that instant is invisible, however early the
 * replayed Run itself finishes.
 */
function recordBefore(record: MissionRecord, beganAt: string): MissionRecord {
  const limit = timeOf(beganAt);
  const runs = record.runs ?? {};
  const producedBefore = (runId: string, fallback: string) => timeOf(runs[runId]?.finishedAt ?? fallback) < limit;
  return {
    ...record,
    ...(record.baseline && producedBefore(record.baseline.runId, record.createdAt) ? {} : { baseline: undefined }),
    experiments: (record.experiments ?? []).filter((entry) => producedBefore(entry.runId, entry.at)),
    synthesisProposals: (record.synthesisProposals ?? []).filter((entry) => timeOf(entry.at) < limit),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fails closed if any delivered text mentions a Run that did not exist yet.
 * Without this guard a projection built from the full record would leak the
 * future into an earlier Run's Memory and turn replay into hindsight.
 */
function assertNoFutureInformation(cards: readonly { readonly summary?: string; readonly sourceRefs?: readonly string[]; readonly applicability?: readonly string[] }[], futureRunIds: readonly string[], at: TrailRun): void {
  const text = JSON.stringify(cards);
  for (const runId of futureRunIds) {
    // `:<digits>` trail suffix: `exp:1` must not match `exp:10`.
    if (new RegExp(`${escapeRegExp(runId)}(?![0-9])`).test(text)) {
      throw new Error(`offline replay for Run "${at.runId}" leaked information produced after it began (${runId})`);
    }
  }
}

/**
 * The ledger revision the Mission durably served for one Run: the published
 * snapshot the Run actually consumed. A legacy Run record (or a Run dispatched
 * before any snapshot existed) has no served revision, so replay keeps the
 * pre-existing prefix ordinal.
 */
function durableLedgerRevision(record: MissionRecord, runId: string, ordinal: number): number {
  return record.runs?.[runId]?.researchMemory?.ledgerRevision ?? ordinal;
}

/**
 * Replays one durable Mission under one evaluation arm. Every Run is pinned to
 * the deterministic snapshot projected from the state visible before it began;
 * `off` delivers no Memory, `sham` delivers the Schema-only control packet and
 * `real` the Research Memory packet. Deterministic: same record, same output.
 */
export function replayResearchMemory(options: {
  readonly record: MissionRecord;
  readonly mode: ResearchMemoryEvaluationMode;
}): readonly ReplayedRunMemory[] {
  const runs = trailRunsOf(options.record);
  const mode = options.mode;
  return runs.map((run, index) => {
    const ledgerRevision = durableLedgerRevision(options.record, run.runId, index);
    const visibleRunIds = runs.filter((other) => timeOf(other.producedAt) < timeOf(run.beganAt)).map((other) => other.runId);
    const futureRunIds = runs
      .filter((other) => other.runId !== run.runId && timeOf(other.producedAt) >= timeOf(run.beganAt))
      .map((other) => other.runId);
    if (mode === "off") {
      return deepFreeze({
        runId: run.runId,
        mode,
        visibleRunIds,
        ledgerRevision,
        cardCount: 0,
        control: false,
      });
    }
    // The revision the Mission actually served this Run, published BEFORE it
    // began, never the final stateVersion the future advanced to.
    const source = { ...missionResearchSource(recordBefore(options.record, run.beganAt)), ledgerRevision };
    const real = projectResearchMemorySnapshot(source);
    // A Sham arm serves the CONTROL snapshot, so its pinned identity must be the
    // same one a live Sham arm publishes (never the real snapshot's address).
    const snapshot = mode === "sham" ? shamResearchMemorySnapshot(real) : real;
    const projected = projectResearchDecisionPacket(snapshot);
    const packet = mode === "sham" ? shamResearchDecisionPacket(projected) : projected;
    assertNoFutureInformation(packet.cards, futureRunIds, run);
    return deepFreeze({
      runId: run.runId,
      mode,
      visibleRunIds,
      ledgerRevision,
      snapshotId: packet.snapshotId,
      snapshotDigest: packet.snapshotDigest,
      packetDigest: packet.digest,
      cardCount: packet.cards.length,
      control: packet.control === "sham",
    });
  });
}

// ── Report over completed arms ─────────────────────────────────────────────

/**
 * The trusted-runner controls that Mission records do not publish (prompts,
 * tool allowlist, non-token budgets). Each arm DECLARES them; the report checks
 * every arm agrees with the plan instead of assuming it.
 */
export interface ResearchMemoryArmControls {
  readonly modelVersion: string;
  readonly basePromptRevision: string;
  readonly tools: readonly string[];
  readonly experimentBudget: number;
  readonly retryBudget: number;
  readonly evaluationBudget: number;
}

/** One completed comparison arm: the durable record of one authorized Mission. */
export interface ResearchMemoryEvaluationArm {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly record: MissionRecord;
  readonly controls?: ResearchMemoryArmControls;
}

export interface ResearchMemoryStageCosts {
  readonly blind: number;
  readonly revision: number;
}

/** Priced decision calls, split across the two Director stages. */
export interface ResearchMemoryStageCalls {
  readonly blind: number;
  readonly revision: number;
}

export interface ResearchMemoryArmMetrics {
  readonly mode: ResearchMemoryEvaluationMode;
  /** Priced decision calls, correction attempts included (both stages). */
  readonly decisionCalls: number;
  readonly stageCalls: ResearchMemoryStageCalls;
  readonly stageCosts: ResearchMemoryStageCosts;
  /** Revision stages whose controller-derived delta is not `unchanged`. */
  readonly decisionDivergence: number;
  readonly rejectedDirections: number;
  readonly rejectedDirectionsObserved: number;
  readonly observedDecisionRegret: number;
  /** Distinct executed Task objectives (exploration width). */
  readonly hypothesisDiversity: number;
  /** Isolated Branch Runs executed across those objectives. */
  readonly branchCoverage: number;
  /** Repeats of an already-measured objective that produced usable Evidence. */
  readonly usefulReplication: number;
  /** Repeats of an objective+configuration that already failed operationally. */
  readonly knownFailureRepetition: number;
  readonly validEvidence: number;
  readonly consumedBudget: number;
  /** Valid Evidence per unit of consumed budget (0 budget reads as 0). */
  readonly validEvidencePerBudget: number;
}

function normalizeObjective(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

function isOperational(entry: ExperimentTrailEntry): boolean {
  return classifyTrailEntry(entry).state === "operational";
}

function stageCostsOf(decisions: readonly DecisionRecord[]): ResearchMemoryStageCosts {
  let blind = 0;
  let revision = 0;
  for (const decision of decisions) {
    if (decision.phase === "revision") revision += decision.cost;
    else blind += decision.cost;
  }
  return deepFreeze({ blind, revision });
}

function countReplication(experiments: readonly ExperimentTrailEntry[]): {
  readonly usefulReplication: number;
  readonly knownFailureRepetition: number;
} {
  const seen = new Map<string, Set<string>>();
  let usefulReplication = 0;
  let knownFailureRepetition = 0;
  for (const entry of experiments) {
    const objective = normalizeObjective(entry.taskObjective);
    if (objective === undefined) continue;
    const classification = classifyTrailEntry(entry);
    const failure = classification.state === "operational" ? `${classification.failure}:${entry.configuration ?? ""}` : undefined;
    const priorFailures = seen.get(objective);
    if (priorFailures !== undefined) {
      // A repeat is useful only when it produced usable Evidence. Repeating an
      // objective+configuration that already failed operationally is NOT
      // replication value; it is known-failure repetition.
      if (failure !== undefined && priorFailures.has(failure)) knownFailureRepetition += 1;
      else if (classification.state !== "operational") usefulReplication += 1;
    }
    if (failure !== undefined) {
      if (priorFailures === undefined) seen.set(objective, new Set([failure]));
      else priorFailures.add(failure);
    } else if (priorFailures === undefined) {
      seen.set(objective, new Set());
    }
  }
  return { usefulReplication, knownFailureRepetition };
}

/** The read-only metrics of one completed arm. */
export function researchMemoryArmMetrics(arm: ResearchMemoryEvaluationArm): ResearchMemoryArmMetrics {
  const record = arm.record;
  const decisions = record.decisions ?? [];
  const experiments = record.experiments ?? [];
  const accountability = projectDecisionAccountability({ decisions, experiments });
  const revisions = decisions.filter((decision) => decision.phase === "revision");
  const rejected = revisions.flatMap((decision) => decision.rejectedAlternatives ?? []);
  // Counterfactuals are re-derived read-only: a durable `unobserved` may be
  // observed later by a comparable measured Run, and only that projection can
  // record regret.
  const projectedRejected = accountability.decisions.flatMap((decision) => decision.rejected);
  const replication = countReplication(experiments);
  const validEvidence = experiments.filter((entry) => !isOperational(entry)).length;
  const consumedBudget = record.budget.consumed;
  return deepFreeze({
    mode: arm.mode,
    decisionCalls: decisions.length,
    stageCalls: {
      blind: decisions.filter((decision) => decision.phase !== "revision").length,
      revision: revisions.length,
    },
    stageCosts: stageCostsOf(decisions),
    decisionDivergence: revisions.filter((decision) => decision.delta !== undefined && decision.delta !== "unchanged").length,
    rejectedDirections: rejected.length,
    rejectedDirectionsObserved: projectedRejected.filter((alternative) => alternative.counterfactualStatus === "observed").length,
    observedDecisionRegret: projectedRejected.filter((alternative) => alternative.decisionRegret !== undefined).length,
    hypothesisDiversity: accountability.diversity.objectives.length,
    branchCoverage: accountability.diversity.runs,
    usefulReplication: replication.usefulReplication,
    knownFailureRepetition: replication.knownFailureRepetition,
    validEvidence,
    consumedBudget,
    validEvidencePerBudget: consumedBudget > 0 ? validEvidence / consumedBudget : 0,
  });
}

export type ResearchMemoryComparisonReading = "overall-benefit" | "content-contribution" | "context-effect";

export interface ResearchMemoryComparisonDelta {
  readonly validEvidencePerBudget: number;
  readonly decisionDivergence: number;
  readonly hypothesisDiversity: number;
  readonly branchCoverage: number;
  readonly usefulReplication: number;
  readonly knownFailureRepetition: number;
  readonly observedDecisionRegret: number;
  readonly decisionCost: number;
}

/** One treatment-minus-control reading, never a claim of causal proof. */
export interface ResearchMemoryComparison {
  readonly baseline: ResearchMemoryEvaluationMode;
  readonly treatment: ResearchMemoryEvaluationMode;
  readonly reading: ResearchMemoryComparisonReading;
  readonly description: string;
  readonly delta: ResearchMemoryComparisonDelta;
  readonly perfectCausalControl: false;
  readonly caveat: string;
}

const COMPARISON_READINGS: readonly {
  readonly baseline: ResearchMemoryEvaluationMode;
  readonly treatment: ResearchMemoryEvaluationMode;
  readonly reading: ResearchMemoryComparisonReading;
  readonly description: string;
}[] = [
  {
    baseline: "off",
    treatment: "real",
    reading: "overall-benefit",
    description: "overall Real Memory benefit",
  },
  {
    baseline: "sham",
    treatment: "real",
    reading: "content-contribution",
    description: "research-content contribution above identical structure",
  },
  {
    baseline: "off",
    treatment: "sham",
    reading: "context-effect",
    description: "format/extra-context effect without research content",
  },
];

/** Compares the arms that are present; a missing arm yields no reading. */
export function compareResearchMemoryArms(arms: readonly ResearchMemoryEvaluationArm[]): readonly ResearchMemoryComparison[] {
  const metrics = new Map(arms.map((arm) => [arm.mode, researchMemoryArmMetrics(arm)]));
  return COMPARISON_READINGS.flatMap((reading) => {
    const control = metrics.get(reading.baseline);
    const treatment = metrics.get(reading.treatment);
    if (control === undefined || treatment === undefined) return [];
    return [deepFreeze({
      baseline: reading.baseline,
      treatment: reading.treatment,
      reading: reading.reading,
      description: reading.description,
      delta: {
        validEvidencePerBudget: treatment.validEvidencePerBudget - control.validEvidencePerBudget,
        decisionDivergence: treatment.decisionDivergence - control.decisionDivergence,
        hypothesisDiversity: treatment.hypothesisDiversity - control.hypothesisDiversity,
        branchCoverage: treatment.branchCoverage - control.branchCoverage,
        usefulReplication: treatment.usefulReplication - control.usefulReplication,
        knownFailureRepetition: treatment.knownFailureRepetition - control.knownFailureRepetition,
        observedDecisionRegret: treatment.observedDecisionRegret - control.observedDecisionRegret,
        decisionCost: treatment.stageCosts.blind + treatment.stageCosts.revision - (control.stageCosts.blind + control.stageCosts.revision),
      },
      perfectCausalControl: false as const,
      caveat: RESEARCH_MEMORY_CONTROL_CAVEAT,
    })];
  });
}

export type ResearchMemoryControlName =
  | "model-version"
  | "base-prompts"
  | "tools"
  | "decision-calls"
  | "token-budget"
  | "experiment-budget"
  | "retry-budget"
  | "evaluation-budget"
  | "stopping-conditions"
  | "initial-state";

/** One controlled dimension of the comparison, and whether the arms kept it. */
export interface ResearchMemoryControlCheck {
  readonly control: ResearchMemoryControlName;
  /** `record` facts are verified from the durable records; `plan` is declared. */
  readonly source: "record" | "plan";
  readonly matched: boolean;
  readonly values: readonly string[];
}

/**
 * The trusted evaluation configuration every arm was run under. `evaluate`
 * records it verbatim and checks the durable arms against everything the
 * records can prove; prompts/tools/retry/evaluation bounds are trusted-plan
 * declarations because Mission records do not publish them.
 */
export interface ResearchMemoryEvaluationPlan {
  readonly modelVersion: string;
  readonly basePromptRevision: string;
  readonly tools: readonly string[];
  readonly decisionCalls: number;
  readonly budgets: {
    readonly token: number;
    readonly experiment: number;
    readonly retry: number;
    readonly evaluation: number;
  };
  readonly stoppingConditions: readonly string[];
  readonly initialStateDigest: string;
}

/** The initial state shared by every arm: objective + intake Task plan. */
export function initialStateDigestOf(record: MissionRecord): string {
  return digestValue({
    objective: record.objective,
    tasks: (record.tasks ?? [])
      .filter((task) => task.source !== "director")
      .map((task) => ({ taskId: task.taskId, objective: task.objective, expectedOutputs: task.expectedOutputs ?? [] })),
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function controlChecks(plan: ResearchMemoryEvaluationPlan, arms: readonly ResearchMemoryEvaluationArm[]): ResearchMemoryControlCheck[] {
  const records = arms.map((arm) => arm.record);
  // A `plan` control is matched when the same trusted plan governed every arm;
  // a `record` control must additionally agree across the durable records.
  const check = (
    control: ResearchMemoryControlName,
    source: "record" | "plan",
    values: readonly string[],
    matched: boolean,
  ): ResearchMemoryControlCheck => deepFreeze({
    control,
    source,
    matched,
    values: unique(values),
  });
  const tier = records.map((record) => `${record.modelTier ?? "unknown"}/${record.baseline?.evaluator.id ?? "unknown"}`);
  const budget = records.map((record) => `${record.budget.total} ${record.budget.units}`);
  const contract = records.map((record) => digestValue(record.contract));
  const stopping = records.map((record) => JSON.stringify(record.stopConditions ?? []));
  const initial = records.map((record) => initialStateDigestOf(record));
  const calls = records.map((record) => String((record.decisions ?? []).length));
  // A declared control only matches when EVERY arm declares the plan's value.
  const declared = (of: (controls: ResearchMemoryArmControls) => string, expected: string) =>
    arms.map((arm) => (arm.controls === undefined ? "undeclared" : of(arm.controls)))
      .every((value) => value === expected);
  const declaredValues = (of: (controls: ResearchMemoryArmControls) => string) =>
    arms.map((arm) => (arm.controls === undefined ? "undeclared" : of(arm.controls)));
  return [
    check("model-version", "record", [...tier, ...declaredValues((controls) => controls.modelVersion)], unique(tier).length === 1 && declared((controls) => controls.modelVersion, plan.modelVersion)),
    check("base-prompts", "plan", declaredValues((controls) => controls.basePromptRevision), declared((controls) => controls.basePromptRevision, plan.basePromptRevision)),
    check("tools", "plan", declaredValues((controls) => controls.tools.join(",")), declared((controls) => controls.tools.join(","), plan.tools.join(","))),
    check("decision-calls", "record", calls, calls.every((value) => Number(value) === plan.decisionCalls)),
    check("token-budget", "record", budget, unique(budget).length === 1 && budget.every((value) => value === `${plan.budgets.token} ${records[0]?.budget.units}`)),
    check("experiment-budget", "plan", declaredValues((controls) => String(controls.experimentBudget)), declared((controls) => String(controls.experimentBudget), String(plan.budgets.experiment))),
    check("retry-budget", "plan", declaredValues((controls) => String(controls.retryBudget)), declared((controls) => String(controls.retryBudget), String(plan.budgets.retry))),
    check("evaluation-budget", "record", [...contract, ...declaredValues((controls) => String(controls.evaluationBudget))], unique(contract).length === 1 && declared((controls) => String(controls.evaluationBudget), String(plan.budgets.evaluation))),
    check("stopping-conditions", "record", stopping, unique(stopping).length === 1 && JSON.stringify(plan.stoppingConditions) === stopping[0]),
    check("initial-state", "record", initial, unique(initial).length === 1 && initial.every((value) => value === plan.initialStateDigest)),
  ];
}

export interface ResearchMemoryEvaluationReplay {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly runs: readonly ReplayedRunMemory[];
}

export interface ResearchMemoryEvaluationReport {
  readonly schema: typeof RESEARCH_MEMORY_EVALUATION_SCHEMA;
  readonly missionIds: readonly string[];
  readonly arms: readonly ResearchMemoryArmMetrics[];
  readonly comparisons: readonly ResearchMemoryComparison[];
  readonly controls: readonly ResearchMemoryControlCheck[];
  /** Every arm's offline replay, so future-information leakage is auditable. */
  readonly replay: readonly ResearchMemoryEvaluationReplay[];
  readonly assumptions: readonly string[];
}

/**
 * Builds the deterministic offline report from one durable record per arm. It
 * refuses a duplicate or missing arm: a reading is only defined against the
 * other two modes.
 */
export function evaluateResearchMemory(options: {
  readonly plan: ResearchMemoryEvaluationPlan;
  readonly arms: readonly ResearchMemoryEvaluationArm[];
}): ResearchMemoryEvaluationReport {
  const modes = options.arms.map((arm) => arm.mode);
  const missing = RESEARCH_MEMORY_EVALUATION_MODES.filter((mode) => !modes.includes(mode));
  const duplicated = modes.filter((mode, index) => modes.indexOf(mode) !== index);
  if (missing.length > 0 || duplicated.length > 0) {
    throw new Error(`a Research Memory evaluation needs exactly one arm per mode (${RESEARCH_MEMORY_EVALUATION_MODES.join("/")}); missing [${missing.join(",")}], duplicate [${duplicated.join(",")}]`);
  }
  const ordered = [...options.arms].sort((a, b) => RESEARCH_MEMORY_EVALUATION_MODES.indexOf(a.mode) - RESEARCH_MEMORY_EVALUATION_MODES.indexOf(b.mode));
  const controls = controlChecks(options.plan, ordered);
  const drifted = controls.filter((control) => !control.matched).map((control) => control.control);
  // A comparison is only meaningful when the controlled configuration held; a
  // drifted arm is refused instead of being reported as a Memory benefit.
  if (drifted.length > 0) {
    throw new Error(`these arms do not share the controlled evaluation configuration: ${drifted.join(", ")}`);
  }
  return deepFreeze({
    schema: RESEARCH_MEMORY_EVALUATION_SCHEMA,
    missionIds: ordered.map((arm) => arm.record.id),
    arms: ordered.map((arm) => researchMemoryArmMetrics(arm)),
    comparisons: compareResearchMemoryArms(ordered),
    controls,
    replay: ordered.map((arm) => ({ mode: arm.mode, runs: replayResearchMemory({ record: arm.record, mode: arm.mode }) })),
    assumptions: RESEARCH_MEMORY_EVALUATION_ASSUMPTIONS,
  });
}
