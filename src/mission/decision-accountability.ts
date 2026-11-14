/**
 * Decision accountability and anti-collapse safeguards (M1-T6 / #215).
 *
 * A Memory-informed revision must stay auditable: the direction it rejected keeps
 * its Memory refs, applicability, reason and — crucially — its counterfactual
 * status. An unexecuted alternative has an UNOBSERVED outcome: it is never a
 * failure, never Negative Evidence, and never Decision Regret. Only a later
 * comparable Experiment that actually measured that direction supplies the
 * counterfactual Evidence that makes regret recordable.
 *
 * The same projection monitors anchoring: how many directions the Mission
 * actually explored (Hypothesis diversity and Branch coverage) and whether
 * Memory repeatedly funnelled decisions into one direction without any new
 * discriminating Evidence. That recommendation is advisory by construction —
 * this module is a pure read over authoritative Mission history. It cannot
 * dispatch, reserve budget, force an action, impose an exploration quota or
 * change Search math.
 */
import { deepFreeze } from "../execution/security-boundary";
import type { DecisionDelta, DirectorAction } from "./mission-director";
import type { RunOutcomeState } from "../evidence/run-outcome";
import { classifyTrailEntry, configurationLabel, type DecisionRecord, type ExperimentTrailEntry } from "./mission-start";

/** Two consecutive Memory-driven changes to one direction is a concentration. */
export const DIRECTION_CONCENTRATION_MIN_REVISIONS = 2;

export type CounterfactualStatus = "unobserved" | "observed";

/** The applicability the influencing cards declared, as the revision saw it. */
export interface RejectedDirectionApplicability {
  readonly declared: readonly string[];
  /** `unknown` when no influencing card declared applicability: never assumed compatible. */
  readonly status: "declared" | "unknown";
}

/** One direction the revision did not choose, with its counterfactual reading. */
export interface RejectedDirectionAccountability {
  readonly action: DirectorAction;
  readonly objective?: string;
  readonly reason: string;
  readonly influencingMemoryRefs: readonly string[];
  readonly applicability: RejectedDirectionApplicability;
  readonly counterfactualStatus: CounterfactualStatus;
  /** Later comparable measured Experiments that supplied the counterfactual. */
  readonly counterfactualRunIds: readonly string[];
  /** How each of those Runs came out; the reading regret is based on. */
  readonly counterfactualOutcomes: readonly RunOutcomeState[];
  /**
   * Recorded ONLY when actual counterfactual Evidence exists AND it shows the
   * rejected direction was viable. A comparable Run that refutes the rejected
   * direction is evidence for the choice, never regret.
   */
  readonly decisionRegret?: { readonly observedFrom: readonly string[] };
}

/** One Memory-informed revision as a readable accountability record. */
export interface DecisionAccountability {
  readonly decisionGroupId: string;
  readonly decisionId: string;
  readonly stateVersion: number;
  readonly delta: DecisionDelta;
  readonly chosen: { readonly action: DirectorAction; readonly objective?: string };
  readonly influencingMemoryRefs: readonly string[];
  readonly reason: string;
  readonly rejected: readonly RejectedDirectionAccountability[];
}

/**
 * Measurable exploration across Runs. Mission history records Task objectives,
 * not Hypothesis identities, so this reads the objectives a Mission actually
 * executed; each executed Experiment is one isolated Branch of that objective.
 */
export interface ResearchDiversity {
  readonly memoryInformedDecisions: number;
  readonly memoryChangedDecisions: number;
  /** Distinct normalized Task objectives actually executed (exploration width). */
  readonly objectives: readonly string[];
  /** Branch coverage: the isolated Run ids executed per objective. */
  readonly branches: readonly { readonly objective: string; readonly runIds: readonly string[] }[];
  readonly runs: number;
}

/** Advisory: repeated concentration never becomes a gate or a quota. */
export interface DirectionConcentrationReview {
  readonly kind: "direction-concentration";
  readonly objective: string;
  readonly decisionGroupIds: readonly string[];
  readonly memoryChangedDecisions: number;
  readonly advisory: true;
  readonly recommendation: string;
}

export interface DecisionAccountabilitySource {
  readonly decisions?: readonly DecisionRecord[];
  readonly experiments?: readonly ExperimentTrailEntry[];
}

export interface DecisionAccountabilityView {
  readonly decisions: readonly DecisionAccountability[];
  readonly diversity: ResearchDiversity;
  readonly concentration: readonly DirectionConcentrationReview[];
}

export const DIRECTION_CONCENTRATION_RECOMMENDATION =
  "reevaluate the concentrated direction against competing Hypotheses before committing further resources";

function normalizeObjective(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

/** Millisecond reading of a durable timestamp; an unparsable one orders nothing. */
function timeOf(at: string | undefined): number | undefined {
  const parsed = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A real measurement is the only thing that supplies counterfactual Evidence. */
function outcomeOf(entry: ExperimentTrailEntry): RunOutcomeState {
  return classifyTrailEntry(entry).state;
}

function isMemoryInformed(decision: DecisionRecord): boolean {
  return decision.phase === "revision" && decision.accepted && decision.memory !== undefined;
}

/**
 * Reads ONE rejected direction against later comparable Experiments. `later` is
 * the durable trail order: a Run measured before the decision was already part
 * of what the Blind Proposal saw, so it is not a counterfactual.
 */
function counterfactualOf(
  alternative: NonNullable<DecisionRecord["rejectedAlternatives"]>[number],
  decision: DecisionRecord,
  experiments: readonly ExperimentTrailEntry[],
): Pick<RejectedDirectionAccountability, "counterfactualStatus" | "counterfactualRunIds" | "counterfactualOutcomes" | "decisionRegret"> {
  const objective = normalizeObjective(alternative.objective ?? alternative.proposal?.task?.objective);
  const decidedAt = timeOf(decision.at);
  // shortcut: comparability is the same objective under the same declared
  // Task configuration; upgrade when a Run records full card applicability.
  const configuration = configurationLabel(alternative.proposal?.task?.constraints);
  const comparable = objective === undefined || decidedAt === undefined
    ? []
    : experiments.filter((entry) =>
      normalizeObjective(entry.taskObjective) === objective
      // A Run measured before the decision was already visible to the Blind
      // Proposal, and an unreadable timestamp can order nothing.
      && (timeOf(entry.at) ?? -Infinity) >= decidedAt
      // Unknown on either side is not compatibility: only an exact declared
      // configuration match makes a Run a comparable counterfactual.
      && (configuration === undefined ? entry.configuration === undefined : entry.configuration === configuration)
      && outcomeOf(entry) !== "operational");
  if (comparable.length === 0) {
    // The durable decision-time reading is a floor: this projection may observe
    // a counterfactual later, never retract one.
    return {
      counterfactualStatus: alternative.counterfactualStatus ?? "unobserved",
      counterfactualRunIds: [],
      counterfactualOutcomes: [],
    };
  }
  const runIds = comparable.map((entry) => entry.runId);
  const outcomes = comparable.map(outcomeOf);
  return {
    counterfactualStatus: "observed",
    counterfactualRunIds: runIds,
    counterfactualOutcomes: outcomes,
    // Regret only when the rejected direction measured as viable; a refutation
    // of it (or an operational failure, excluded above) is not regret.
    ...(outcomes.includes("positive") ? { decisionRegret: { observedFrom: runIds } } : {}),
  };
}

function accountabilityOf(
  decision: DecisionRecord,
  experiments: readonly ExperimentTrailEntry[],
): DecisionAccountability {
  const influencingMemoryRefs = decision.memory?.usedCardRefs ?? [];
  const rejected = (decision.rejectedAlternatives ?? []).map((alternative) => deepFreeze({
    action: alternative.action,
    ...(alternative.objective !== undefined ? { objective: alternative.objective } : {}),
    reason: alternative.reason,
    // A legacy record kept no refs: the audit says so instead of guessing.
    influencingMemoryRefs: [...(alternative.influencingMemoryRefs ?? [])],
    applicability: alternative.applicability ?? { declared: [] as string[], status: "unknown" as const },
    ...counterfactualOf(alternative, decision, experiments),
  }));
  return deepFreeze({
    decisionGroupId: decision.decisionGroupId ?? decision.decisionId,
    decisionId: decision.decisionId,
    stateVersion: decision.stateVersion,
    delta: decision.delta ?? "unchanged",
    chosen: {
      action: decision.proposal?.action ?? "stop",
      ...(decision.proposal?.task?.objective !== undefined ? { objective: decision.proposal.task.objective } : {}),
    },
    influencingMemoryRefs: [...influencingMemoryRefs],
    reason: decision.revisionReason ?? decision.proposal?.rationale ?? "",
    rejected,
  });
}

function diversityOf(
  revisions: readonly DecisionRecord[],
  experiments: readonly ExperimentTrailEntry[],
): ResearchDiversity {
  const grouped = new Map<string, string[]>();
  for (const entry of experiments) {
    const objective = normalizeObjective(entry.taskObjective);
    if (objective === undefined) continue;
    const bucket = grouped.get(objective);
    if (bucket === undefined) grouped.set(objective, [entry.runId]);
    else bucket.push(entry.runId);
  }
  const objectives = [...grouped.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return deepFreeze({
    memoryInformedDecisions: revisions.length,
    memoryChangedDecisions: revisions.filter((decision) => decision.delta !== undefined && decision.delta !== "unchanged").length,
    objectives,
    branches: objectives.map((objective) => deepFreeze({ objective, runIds: [...grouped.get(objective)!] })),
    runs: experiments.length,
  });
}

/**
 * Repeated Memory-driven changes toward the SAME direction, with no new
 * discriminating Evidence (a measured refutation) in between. Positive results
 * confirm a direction; only Negative Evidence discriminates between competing
 * Hypotheses, so only it clears the signal.
 */
function concentrationOf(
  revisions: readonly DecisionRecord[],
  experiments: readonly ExperimentTrailEntry[],
): DirectionConcentrationReview[] {
  const changes = revisions.filter((decision) => decision.delta !== undefined && decision.delta !== "unchanged");
  const reviews: DirectionConcentrationReview[] = [];
  let index = 0;
  while (index < changes.length) {
    const objective = normalizeObjective(changes[index]!.proposal?.task?.objective);
    const window: DecisionRecord[] = [];
    while (index < changes.length && normalizeObjective(changes[index]!.proposal?.task?.objective) === objective) {
      window.push(changes[index]!);
      index += 1;
    }
    if (objective === undefined || window.length < DIRECTION_CONCENTRATION_MIN_REVISIONS) continue;
    const since = timeOf(window[0]!.at) ?? Number.NEGATIVE_INFINITY;
    // Only a measured refutation OF THIS direction discriminates between the
    // competing positions; a refutation elsewhere says nothing about it.
    const discriminating = experiments.some((entry) =>
      (timeOf(entry.at) ?? Number.NEGATIVE_INFINITY) >= since
      && normalizeObjective(entry.taskObjective) === objective
      && classifyTrailEntry(entry).scientificNegativeEvidence);
    if (discriminating) continue;
    reviews.push(deepFreeze({
      kind: "direction-concentration" as const,
      objective,
      decisionGroupIds: window.map((decision) => decision.decisionGroupId ?? decision.decisionId),
      memoryChangedDecisions: window.length,
      advisory: true as const,
      recommendation: DIRECTION_CONCENTRATION_RECOMMENDATION,
    }));
  }
  return reviews;
}

/** The one read-only accountability view over authoritative Mission history. */
export function projectDecisionAccountability(source: DecisionAccountabilitySource): DecisionAccountabilityView {
  const decisions = source.decisions ?? [];
  const experiments = source.experiments ?? [];
  const revisions = decisions
    .filter(isMemoryInformed)
    .slice()
    .sort((a, b) => {
      const order = (timeOf(a.at) ?? Number.POSITIVE_INFINITY) - (timeOf(b.at) ?? Number.POSITIVE_INFINITY);
      return order !== 0 ? order : (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0);
    });
  return deepFreeze({
    decisions: revisions.map((decision) => accountabilityOf(decision, experiments)),
    diversity: diversityOf(revisions, experiments),
    concentration: concentrationOf(revisions, experiments),
  });
}
