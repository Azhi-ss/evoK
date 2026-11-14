/**
 * L1 decision-point counterfactual evaluation (#232, spec `docs/research-memory-evaluation-v2.md`
 * §3, parent #222).
 *
 * One FROZEN decision point — the trusted Director input plus the frozen Blind
 * Proposal that already existed — is re-decided once per Off/Sham/Real packet
 * over the SAME base state. The revision stage is the existing bounded one:
 * `buildDirectorInput`'s projection plus `DirectorDecisionPhase`, handed to the
 * existing `MissionDirector` port. Nothing is dispatched: this module has no
 * dispatch seam, reserves no Experiment budget, and measures no Run.
 *
 * Scoring is hindsight against THE ACTION ACTUALLY TAKEN (locked in #222): the
 * revised proposal the original Mission durably recorded and then executed.
 * "Best action among later measurements" is deliberately NOT used, because it
 * needs comparable measurements and would introduce selection bias.
 *
 * This is not `evaluateResearchMemory`: that reads whole Missions (L2) and
 * refuses a zero-delta replay. L1 asks a smaller question — did Memory change
 * ONE decision for the better — so its report states a DIRECTION only, always
 * carries the Sham control caveat and the trajectory-steering caveat, and makes
 * no significance claim at any sample size.
 */
import type { ResearchDecisionPacket, ResearchMemoryEvaluationMode } from "../memory";
import { RESEARCH_MEMORY_EVALUATION_MODES } from "../memory";
import { deepFreeze, digestValue } from "../execution/security-boundary";
import { RESEARCH_MEMORY_CONTROL_CAVEAT, assertNoFutureInformation } from "./memory-evaluation";
import { emptyDirectorInsightSidecar, type DirectorInsightSidecar, type DirectorInsightSidecarItem } from "./director-insight-sidecar";
import {
  assertOffRetainsMissionState,
  deriveDecisionDelta,
  missionRetainedState,
  type DecisionDelta,
  type DirectorInput,
  type DirectorProposal,
  type MissionDirector,
  type MissionRetainedState,
} from "./mission-director";

export const DECISION_POINT_EVALUATION_SCHEMA = "evok.decision-point-evaluation/v1" as const;

/** What one L1 report measures: a single decision, never a trajectory. */
export const DECISION_POINT_EVALUATION_KIND = "decision-point-counterfactual" as const;

/**
 * Sample target from the spec: below this the report refuses to state a
 * direction instead of reading noise as a signal.
 */
export const DECISION_POINT_MIN_SAMPLE = 50;

/**
 * The scope limit of every L1 reading: off-policy steps carry no propensity, so
 * the effect of Memory on exploration over many steps is invisible here.
 */
export const DECISION_POINT_TRAJECTORY_CAVEAT =
  "L1 does not measure trajectory steering: it re-decides one frozen decision point at a time, so it can show whether Memory changed the next bounded action but never where Memory steers exploration across many steps (off-policy trajectories carry no propensity).";

/**
 * Why the reference is the taken action and not a later-measured best one (#234,
 * contract §3). Versioned: this rule defines what the metric means, so it may
 * only change together with an explicit contract version bump.
 */
export const DECISION_POINT_HINDSIGHT_SCORING = deepFreeze({
  id: "evok.l1-hindsight-scoring/v1" as const,
  reference: "action-taken" as const,
  rationale:
    "The action actually taken is already recorded and measured by the Mission's own Evidence, so scoring against it costs no extra model call and needs no assumption about actions nobody ran.",
  biasLimits: [
    "Weak: the taken action is not the best action, so a proposal that beat it scores exactly like one that only matched it.",
    "Untaken actions have no counterfactual: L1 can never credit Memory for a better action the original Mission did not take.",
    "The taken action may itself have been a bad decision, so the rule measures agreement with the observed trajectory, not optimality.",
  ],
  changeRequires:
    "A versioned evaluation-contract change: bump this id and record why in docs/research-memory-evaluation-v2.md §3 before any report is scored against another reference.",
});

/**
 * The alternative this rule rejects, stated as a caveat so a report can never be
 * read as measuring optimality: picking the best action among later measurements
 * chooses the reference using information the arm could not have had.
 */
export const DECISION_POINT_SELECTION_BIAS_CAVEAT =
  "L1 scores against the action actually taken, never the best action among those later measured: the set of later-measured actions depends on what the original Mission chose, so ranking them to pick a reference would introduce selection bias — the reference would be chosen with knowledge the arms could not have, and would move between samples.";

/** Every L1 report carries all three limits; none is optional. */
export const DECISION_POINT_CAVEATS: readonly string[] = [
  RESEARCH_MEMORY_CONTROL_CAVEAT,
  DECISION_POINT_TRAJECTORY_CAVEAT,
  DECISION_POINT_SELECTION_BIAS_CAVEAT,
];

/** One arm's Memory input for the same point: absent only for the off arm. */
export interface DecisionPointPacket {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly packet?: ResearchDecisionPacket;
}

/** One arm's Insight input: the pinned snapshot that arm's Revision reads. */
export interface DecisionPointInsightArm {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly sidecar: DirectorInsightSidecar;
}

/**
 * How the whole point treats human Insight (#238 D7 / §6): one identical pin per
 * arm, or `"disabled"` because the run exists to evaluate Memory and must not
 * measure the operator's intuition instead.
 */
export type DecisionPointInsight = "disabled" | readonly DecisionPointInsightArm[];

/** One pinned Insight: the id and version a Revision was shown, never its text. */
export type DecisionPointInsightPin = Pick<DirectorInsightSidecarItem, "insightId" | "version">;

/** The pinned Insight one point's arms read, and whether Insight was on at all. */
export interface DecisionPointInsightReading {
  readonly state: "disabled" | "identical";
  /** Every pin the arms read, in the snapshot's order; empty when disabled. */
  readonly pinned: readonly DecisionPointInsightPin[];
  /** Digest of the identical snapshot every arm read; absent when disabled. */
  readonly digest?: string;
}

/**
 * What the run supplied as Insight. Identity is guaranteed per decision point
 * (see the results), not across the sample: points from different Missions have
 * their own Inbox, so this is the union of everything supplied, never a
 * snapshot any single Revision read.
 */
export interface DecisionPointInsightSupply {
  readonly state: "disabled" | "identical";
  /** Every distinct id/version supplied, in first-seen order; empty when disabled. */
  readonly pinned: readonly DecisionPointInsightPin[];
  /** The distinct snapshot digests the sample read; empty when disabled. */
  readonly digests: readonly string[];
}

/** The revised proposal the original Mission executed, and its measured Run. */
export interface DecisionPointActionTaken {
  readonly runId: string;
  readonly proposal: DirectorProposal;
}

/**
 * A decision point captured from a completed Mission: the trusted state and
 * frozen Blind Proposal that existed BEFORE the original decision, one packet
 * per arm, the durable Mission state no arm may lose, and the action the
 * original Mission actually took (the hindsight reference, never an arm input).
 */
export interface FrozenDecisionPoint {
  readonly pointId: string;
  /** The trusted Director input at that instant; identical in every arm. */
  readonly baseState: DirectorInput;
  /**
   * The Mission's measured state AS OF this point (the record projected to that
   * instant), read independently of the projection. An arm may lose Memory,
   * never this state; a record-state snapshot from AFTER the point would name
   * Runs the base state cannot carry yet.
   */
  readonly missionState: MissionRetainedState;
  /** The Blind Proposal frozen before any Memory was visible. */
  readonly blindProposal: DirectorProposal;
  readonly packets: readonly DecisionPointPacket[];
  /**
   * The Insight every arm reads: one identical snapshot per arm (same ids,
   * versions and order, D7), or `"disabled"` for a Memory-evaluation run.
   */
  readonly insight: DecisionPointInsight;
  readonly actionTaken: DecisionPointActionTaken;
  /** Runs/refs produced AFTER this point; a packet naming one leaks the future. */
  readonly futureRunIds: readonly string[];
}

export interface DecisionPointArmResult {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly proposal: DirectorProposal;
  /** Controller-derived change from the frozen Blind Proposal. */
  readonly delta: DecisionDelta;
  /** Hindsight score against the action actually taken. */
  readonly matchedActionTaken: boolean;
}

export interface DecisionPointResult {
  readonly pointId: string;
  readonly missionId: string;
  readonly actionTakenRunId: string;
  readonly arms: readonly DecisionPointArmResult[];
  /** Which Insight ids/versions every arm read, or that Insight was disabled. */
  readonly insight: DecisionPointInsightReading;
  /** Structural: L1 has no dispatch seam, so it can never spend Experiment budget. */
  readonly dispatchedExperiments: 0;
}

function packetOf(point: FrozenDecisionPoint, mode: ResearchMemoryEvaluationMode): DecisionPointPacket {
  const matches = point.packets.filter((entry) => entry.mode === mode);
  return matches[0]!;
}

/** Refuses an arm set that is not exactly one entry per mode: that is not a comparison. */
function assertOneArmPerMode(modes: readonly ResearchMemoryEvaluationMode[], subject: string): void {
  const missing = RESEARCH_MEMORY_EVALUATION_MODES.filter((mode) => !modes.includes(mode));
  const duplicated = modes.filter((mode, index) => modes.indexOf(mode) !== index);
  if (missing.length > 0 || duplicated.length > 0) {
    throw new Error(`${subject}: missing [${missing.join(",")}], duplicate [${duplicated.join(",")}]`);
  }
}

/**
 * Refuses any arm set that would make the comparison fake: a missing or
 * duplicated arm, an off arm carrying Memory, a Sham arm without the control
 * packet, or packets that do not come from ONE bounded presentation of the same
 * point (different Mission, ledger revision or card bound).
 */
function assertArmPackets(point: FrozenDecisionPoint): void {
  assertOneArmPerMode(point.packets.map((entry) => entry.mode), `a decision-point evaluation needs exactly one arm per mode (${RESEARCH_MEMORY_EVALUATION_MODES.join("/")})`);
  const off = packetOf(point, "off");
  if (off.packet !== undefined) {
    throw new Error(`the off arm carries no Memory packet: it is the Memory-denied arm, so a packet there would hide Memory in the control`);
  }
  const sham = packetOf(point, "sham").packet;
  const real = packetOf(point, "real").packet;
  if (sham === undefined || sham.control !== "sham") {
    throw new Error(`the sham arm needs the schema-only sham control packet; a research packet there is not a control input`);
  }
  if (real === undefined || real.control !== undefined) {
    throw new Error(`the real arm needs the Research Memory packet, not a control input`);
  }
  const samePoint = sham.missionId === point.baseState.missionId
    && real.missionId === point.baseState.missionId
    && sham.ledgerRevision === real.ledgerRevision
    && sham.cards.length === real.cards.length;
  if (!samePoint) {
    throw new Error(`the sham and real packets must be one bounded presentation of the same decision point (same mission, ledger revision and card count)`);
  }
}

/**
 * Returns the one Insight snapshot every arm must read, or `undefined` when
 * Insight is disabled for the point. A point whose arms read different Insight
 * cannot attribute a measured change to Memory, so it is refused here — before
 * any priced decision call — naming the arm and the pins that differ.
 */
function assertArmInsight(point: FrozenDecisionPoint): DirectorInsightSidecar | undefined {
  const insight = point.insight;
  if (insight === "disabled") return undefined;
  assertOneArmPerMode(insight.map((entry) => entry.mode), "every arm of a decision-point evaluation needs its own Insight snapshot, identical across arms or disabled for all of them");
  const label = (sidecar: DirectorInsightSidecar) => `${sidecar.items.map(pinKey).join(", ")} (digest ${sidecar.digest.slice(0, 12)}...)`;
  const [reference, ...others] = insight;
  for (const arm of insight) {
    if (arm.sidecar.missionId !== point.baseState.missionId) {
      throw new Error(`Insight is Mission-scoped: the ${arm.mode} arm's snapshot belongs to ${arm.sidecar.missionId}, not to decision point "${point.pointId}" in ${point.baseState.missionId}`);
    }
  }
  for (const arm of others) {
    // The whole snapshot, not just the id set: a differing version, order,
    // text or truncation makes the arms measure something other than Memory.
    if (arm.sidecar.digest !== reference!.sidecar.digest) {
      throw new Error(`the arms of one decision-point comparison must read an identical Insight snapshot: ${reference!.mode} read [${label(reference!.sidecar)}] but ${arm.mode} read [${label(arm.sidecar)}]`);
    }
  }
  return reference!.sidecar;
}

function pinKey(pin: DecisionPointInsightPin): string {
  return `${pin.insightId}@v${pin.version}`;
}

function insightReadingOf(sidecar: DirectorInsightSidecar | undefined): DecisionPointInsightReading {
  return sidecar === undefined
    ? { state: "disabled", pinned: [] }
    : { state: "identical", pinned: sidecar.items.map((item) => ({ insightId: item.insightId, version: item.version })), digest: sidecar.digest };
}

/**
 * Re-decides one frozen decision point in every arm and scores the proposals
 * against the action the original Mission took. Deterministic given the same
 * Director; no Experiment is dispatched and no budget is reserved.
 */
export async function evaluateDecisionPoint(options: {
  readonly point: FrozenDecisionPoint;
  readonly director: Pick<MissionDirector, "decide">;
}): Promise<DecisionPointResult> {
  const point = options.point;
  assertArmPackets(point);
  const insight = assertArmInsight(point);
  // No future information: a packet may only carry what already existed at this
  // point, so the pinned-ledger guard runs BEFORE any priced decision call.
  for (const mode of ["sham", "real"] as const) {
    assertNoFutureInformation(packetOf(point, mode).packet!.cards, point.futureRunIds, `decision point "${point.pointId}" had a ${mode} packet`);
  }
  const expected = point.missionState;
  const arms: DecisionPointArmResult[] = [];
  for (const mode of RESEARCH_MEMORY_EVALUATION_MODES) {
    const packet = packetOf(point, mode).packet;
    // The base state is copied, never shared: an arm can only differ by packet.
    const state = structuredClone(point.baseState);
    const handed: DirectorInput = deepFreeze({
      ...state,
      decisionPhase: {
        blindProposal: point.blindProposal,
        ...(packet === undefined ? {} : { memoryPacket: packet }),
        // #240: the Revision stage always carries an Insight sidecar. #241: every
        // arm reads the SAME pinned snapshot, or the explicit empty pin of a run
        // with Insight disabled.
        insightSidecar: insight ?? emptyDirectorInsightSidecar(point.baseState.missionId),
      },
    });
    // F5 (#231): Memory Off drops narrative, never Mission state.
    assertOffRetainsMissionState({
      mode,
      scope: "decision-point",
      retained: missionRetainedState(handed.observations),
      expected,
      runId: point.actionTaken.runId,
    });
    const decision = await options.director.decide(handed);
    const againstTaken = deriveDecisionDelta(point.actionTaken.proposal, decision.proposal);
    arms.push({
      mode,
      proposal: decision.proposal,
      delta: deriveDecisionDelta(point.blindProposal, decision.proposal),
      // Only the dispatched head matters, so this is the same controller-derived
      // comparison used for the delta, against the action actually taken. A
      // wider declared output set is still the taken action, not a different one.
      matchedActionTaken: againstTaken === "unchanged" || againstTaken === "expanded_via_existing_search",
    });
  }
  return deepFreeze({
    pointId: point.pointId,
    missionId: point.baseState.missionId,
    actionTakenRunId: point.actionTaken.runId,
    arms,
    insight: insightReadingOf(insight),
    dispatchedExperiments: 0 as const,
  });
}

export interface DecisionPointArmReading {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly proposals: number;
  /** How Memory changed the decision, over the whole sample. */
  readonly deltas: Readonly<Record<DecisionDelta, number>>;
  /** Hindsight matches against the action actually taken. */
  readonly matchedActionTaken: number;
  /** Revision stages whose controller-derived delta is not `unchanged`. */
  readonly divergent: number;
}

export type DecisionPointDirection = "treatment-higher" | "treatment-lower" | "flat";

export interface DecisionPointDirectionReading {
  readonly metric: "matched-action-taken";
  readonly baseline: ResearchMemoryEvaluationMode;
  readonly treatment: ResearchMemoryEvaluationMode;
  /** Sign only: no effect size, no interval. */
  readonly direction: DecisionPointDirection;
}

export interface DecisionPointEvaluationReport {
  readonly schema: typeof DECISION_POINT_EVALUATION_SCHEMA;
  readonly kind: typeof DECISION_POINT_EVALUATION_KIND;
  readonly decisionPoints: number;
  readonly missions: readonly string[];
  readonly arms: readonly DecisionPointArmReading[];
  readonly directions: readonly DecisionPointDirectionReading[];
  /** Which Insight ids/versions were supplied, or that Insight was off for the run. */
  readonly insight: DecisionPointInsightSupply;
  /** A direction is claimed, never an effect size. */
  readonly directionOnly: true;
  readonly statisticalSignificance: "none";
  /** The versioned rule behind every `matchedActionTaken` count below (#234). */
  readonly hindsightScoring: typeof DECISION_POINT_HINDSIGHT_SCORING;
  readonly caveats: readonly string[];
  readonly dispatchedExperiments: 0;
}

function directionOf(baseline: number, treatment: number): DecisionPointDirection {
  return treatment > baseline ? "treatment-higher" : treatment < baseline ? "treatment-lower" : "flat";
}

/**
 * Aggregates evaluated points into a report. It refuses an under-powered
 * sample: below the declared minimum a direction would be noise, so no report
 * is produced. Above it the report stays directional and caveated.
 */
export function summarizeDecisionPoints(results: readonly DecisionPointResult[]): DecisionPointEvaluationReport {
  if (results.length < DECISION_POINT_MIN_SAMPLE) {
    throw new Error(`an L1 decision-point report needs at least ${DECISION_POINT_MIN_SAMPLE} decision points to state a direction (got ${results.length}); collect more frozen decision points instead of reading noise`);
  }
  if (new Set(results.map((result) => result.pointId)).size !== results.length) {
    throw new Error("an L1 decision-point report needs distinct decision points: a repeated pointId inflates the sample without adding evidence");
  }
  const reading = (mode: ResearchMemoryEvaluationMode): DecisionPointArmReading => {
    const arms = results.flatMap((result) => result.arms.filter((arm) => arm.mode === mode));
    const deltas: Record<DecisionDelta, number> = { unchanged: 0, reordered: 0, replaced: 0, withdrawn: 0, expanded_via_existing_search: 0 };
    for (const arm of arms) deltas[arm.delta] += 1;
    return deepFreeze({
      mode,
      proposals: arms.length,
      deltas,
      matchedActionTaken: arms.filter((arm) => arm.matchedActionTaken).length,
      divergent: arms.filter((arm) => arm.delta !== "unchanged").length,
    });
  };
  // A sample that turns Insight on for some points and off for others cannot be
  // attributed to Memory either, so it is refused rather than averaged.
  const states = [...new Set(results.map((result) => result.insight.state))];
  if (states.length > 1) {
    throw new Error(`an L1 decision-point report mixes Insight on and off (${states.join(", ")}): a comparison whose arms differ in Insight measures the operator's intuition, not Memory`);
  }
  const pinned = new Map<string, DecisionPointInsightPin>();
  const digests = new Set<string>();
  for (const result of results) {
    for (const pin of result.insight.pinned) pinned.set(pinKey(pin), pin);
    if (result.insight.digest !== undefined) digests.add(result.insight.digest);
  }
  const insight: DecisionPointInsightSupply = deepFreeze({ state: states[0]!, pinned: [...pinned.values()], digests: [...digests] });
  const arms = RESEARCH_MEMORY_EVALUATION_MODES.map(reading);
  const matched = (mode: ResearchMemoryEvaluationMode) => arms.find((arm) => arm.mode === mode)!.matchedActionTaken;
  return deepFreeze({
    schema: DECISION_POINT_EVALUATION_SCHEMA,
    kind: DECISION_POINT_EVALUATION_KIND,
    decisionPoints: results.length,
    missions: [...new Set(results.map((result) => result.missionId))],
    arms,
    directions: [
      { metric: "matched-action-taken", baseline: "off", treatment: "real", direction: directionOf(matched("off"), matched("real")) },
      { metric: "matched-action-taken", baseline: "sham", treatment: "real", direction: directionOf(matched("sham"), matched("real")) },
    ],
    directionOnly: true as const,
    statisticalSignificance: "none" as const,
    hindsightScoring: DECISION_POINT_HINDSIGHT_SCORING,
    insight,
    caveats: DECISION_POINT_CAVEATS,
    dispatchedExperiments: 0 as const,
  });
}
