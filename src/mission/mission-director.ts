/**
 * Mission Director decision seam (#113, T5; spec #108 US26–29/31–33/35/45,
 * ADR-0004 "Recovery and model-led research decisions").
 *
 * This is the missing feedback connection, NOT a second state model and NOT
 * another agent framework:
 *
 *   - The model (a MissionDirector port) REASONS from a trusted projection of
 *     the durable Mission: real evaluator observations, Positive and Negative
 *     Evidence with their references, the human-owned objective/policy, and
 *     remaining budget.
 *   - It returns a BOUNDED proposal. Runtime validation (validateDirectorProposal)
 *     owns budget, permissions, objective, and result authority: malformed,
 *     stale, unsupported, over-budget proposals; objective/permission/budget
 *     expansion; and model-asserted success/score claims are all rejected here,
 *     before any Task is generated or Run dispatched.
 *   - Accepted proposals are applied through the existing Task generation /
 *     Run / replan / independent-evaluation operations in mission-start.ts.
 *     The model's text is never itself a Task, a result, or evidence.
 *
 * A concrete Pi-backed director (createPiMissionDirector) runs one fresh
 * read-only Pi session per decision (ADR-0001); it carries no coding tools and
 * can neither measure, promote, submit, nor widen its own authority.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExperimentTrailEntry,
  MissionRecord,
  MissionStartContract,
} from "./mission-start";
import type { ModelConfigView, PiAgentRuntime, RuntimeUsage } from "../pi-agent-runtime";
import type { DraftPlanTask } from "./mission-draft";
import { taskContractErrors } from "./task-evaluator";
import type { ResearchDecisionPacket, ResearchMemoryEvaluationMode } from "../evidence/research-memory";
import type { DirectorInsightSidecar, RevisionInsightDispositionInput } from "./director-insight-sidecar";
import { classifyRunOutcome, type RunFailureKind, type RunOutcomeState } from "../evidence/run-outcome";
import { classifyTrailEntry } from "./mission-start";
import type { EvokResources } from "../evok-resources";
import { READ_ONLY_TOOLS } from "../pi-agent-runtime";
import { deepFreeze, digestValue } from "../security-boundary";

/** Bounded actions the decision model may choose within an authorized Mission. */
export const DIRECTOR_ACTIONS = [
  "investigate",
  "repair",
  "retry",
  "change-direction",
  "stop",
] as const;

export type DirectorAction = (typeof DIRECTOR_ACTIONS)[number];

/** Bounded further actions one proposal may declare as considered alternates. */
export const MAX_DIRECTOR_ALTERNATIVES = 4;

/** One further bounded next action the model also considered, in priority order.
 *  This is a decision alternative, NOT a Branch: it shares this decision's Task
 *  Contract and only matters when the revision promotes it to the head. */
export interface DirectorAlternative {
  readonly action: Exclude<DirectorAction, "stop">;
  readonly objective: string;
  readonly kind?: DraftPlanTask["kind"];
  readonly artifacts?: readonly string[];
  readonly expectedOutputs?: readonly string[];
  readonly constraints?: Readonly<Record<string, string | number | boolean>>;
  readonly expectedCost?: number;
}

/** A proposal that survives runtime bounding; ready to apply via existing ops. */
export interface DirectorProposal {
  readonly stateVersion: number;
  readonly action: DirectorAction;
  readonly rationale: string;
  readonly stopReason?: string;
  readonly task?: {
    readonly objective: string;
    readonly kind?: DraftPlanTask["kind"];
    readonly artifacts?: readonly string[];
    readonly expectedOutputs?: readonly string[];
    readonly constraints?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly expectedCost?: number;
  readonly basedOn?: readonly string[];
  /** Ordered alternates the model also considered; only the head dispatches. */
  readonly alternatives?: readonly DirectorAlternative[];
}

/** One real observation: a measured result or a retained failed attempt. */
export interface DirectorObservation {
  readonly runId: string;
  readonly attempt: number;
  readonly kind: "baseline" | "experiment";
  readonly action: DirectorAction | "baseline";
  readonly ok: boolean;
  readonly score?: number;
  readonly ruleViolations?: readonly string[];
  readonly facts?: readonly { readonly name: string; readonly value: string | number | boolean; readonly source?: string }[];
  /**
   * True ONLY for a measured scientific refutation. An operational failure
   * (OOM, timeout, invalid measurement, protocol error) is never Negative
   * Evidence and cannot refute a Hypothesis (#213).
   */
  readonly negativeEvidence?: boolean;
  /** Scientific reading vs operational failure, so the two stay distinct. */
  readonly outcome?: RunOutcomeState;
  /** Set only for an operational failure. */
  readonly failure?: RunFailureKind;
  readonly error?: string;
  readonly evidenceRefs: readonly string[];
  readonly dispatchedAt: string;
}

/** The trusted, read-only state handed to the decision model. */
export interface DirectorInput {
  readonly missionId: string;
  readonly stateVersion: number;
  readonly objective: string;
  readonly contract: MissionStartContract;
  readonly policy: {
    readonly permissions: readonly string[];
    readonly hardRules: readonly string[];
  };
  readonly budget: {
    readonly total: number;
    readonly units: string;
    readonly consumed: number;
    readonly remaining: number;
    readonly reserved: number;
  };
  readonly stopConditions: readonly string[];
  /** Tasks already generated for this Mission (initial plan + applied proposals). */
  readonly tasks: readonly DraftPlanTask[];
  /** Chronological Positive and Negative Evidence with durable references. */
  readonly observations: readonly DirectorObservation[];
  /**
   * M1-T2: absent for the Memory-blind stage (the prompt then carries only the
   * trusted state, exactly as before); present only for the revision stage,
   * where it names the frozen Blind Proposal and one pinned Memory packet.
   */
  readonly decisionPhase?: DirectorDecisionPhase;
}

/** The Memory-informed half of a two-stage decision (M1-T2 / #211); its mere
 *  presence marks the revision stage, so absence is the Memory-blind stage. */
export interface DirectorDecisionPhase {
  /** The Blind Proposal frozen and persisted before any Memory was visible. */
  readonly blindProposal: DirectorProposal;
  /** Cards from exactly one pinned snapshot; absent when none is pinned. */
  readonly memoryPacket?: ResearchDecisionPacket;
  /**
   * #240: the pinned pending Insight this Revision reads. Required, because
   * loading it is part of the Revision step (§4.1): an empty sidecar states
   * "nothing pending" instead of quietly skipping the input.
   */
  readonly insightSidecar: DirectorInsightSidecar;
}

/** Controller-derived comparison of the blind and revised proposals. */
export type DecisionDelta =
  | "unchanged"
  | "reordered"
  | "replaced"
  | "withdrawn"
  | "expanded_via_existing_search";

/** What one bounded decision call actually consumed. */
export interface DirectorDecision {
  readonly proposal: DirectorProposal;
  readonly sessionId: string;
  readonly usage: RuntimeUsage;
  /** Actual model that served the decision (for trusted-side pricing). */
  readonly model?: ModelConfigView;
  /** Revision only: Memory card refs the model says it used (validated ⊆ packet). */
  readonly usedMemoryRefs?: readonly string[];
  /**
   * Revision only: the judgement the model recorded for each pinned Insight
   * (#240). Unvalidated here: the controller checks it against the sidecar it
   * actually delivered before any disposition becomes durable.
   */
  readonly insightDispositions?: readonly RevisionInsightDispositionInput[];
}

/**
 * The decision-model port. The production adapter is a fresh read-only Pi
 * session; tests inject a deterministic controller (which is exactly what the
 * controlled primary-seam test does).
 */
export interface MissionDirector {
  readonly id: string;
  /**
   * Propose the next bounded action. `attempt` is the 1-based correction
   * attempt at the current state version; every attempt is a fresh Run with
   * its own session and attempt identity (ADR-0001), never a hidden retry.
   */
  decide(input: DirectorInput, signal?: AbortSignal, attempt?: number): Promise<DirectorDecision>;
}

export class DirectorProposalRejectedError extends Error {
  readonly kind = "director-proposal-rejected" as const;
  /** Real usage of the rejected decision Run, so the controller can meter it. */
  readonly usage?: RuntimeUsage;
  readonly sessionId?: string;
  readonly model?: ModelConfigView;
  constructor(message: string, detail?: { usage?: RuntimeUsage; sessionId?: string; model?: ModelConfigView }) {
    super(message);
    this.name = "DirectorProposalRejectedError";
    this.usage = detail?.usage;
    this.sessionId = detail?.sessionId;
    this.model = detail?.model;
  }
}

export class DirectorDecisionFailedError extends Error {
  readonly kind = "director-decision-failed" as const;
  constructor(message: string) {
    super(message);
    this.name = "DirectorDecisionFailedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A token that asks for or claims authority the decision model does not own. */
const EXPANSION_PATTERN = /submi|external|network|internet|credential|deploy|publish|promot|elevate|sudo\b/i;

/** Top-level keys the model must never set (runtime owns them). */
const FORBIDDEN_TOP_KEYS = new Set([
  "objective", "permissions", "permission", "budget", "policy", "status",
  "success", "succeeded", "score", "scores", "result", "results", "verified",
  "evaluation", "measurement", "promotion", "promoted", "champion", "submission",
]);

/** Task-subobject keys the model may set; anything else is refused. */
const ALLOWED_TASK_KEYS = new Set(["objective", "kind", "artifacts", "expectedOutputs", "constraints"]);

/** Task-subobject keys that would assert a result instead of propose work. */
const FORBIDDEN_TASK_KEYS = new Set([
  "score", "success", "succeeded", "result", "verified", "ok", "pass", "passed",
]);

/** Keys one ordered alternative may declare; anything else is refused. */
const ALTERNATIVE_KEYS = new Set(["action", "objective", "kind", "artifacts", "expectedOutputs", "constraints", "expectedCost"]);

/**
 * Validate and bound a raw model proposal against the current trusted state.
 * Throws DirectorProposalRejectedError for anything malformed, stale,
 * unsupported, over-budget, authority-expanding, or success-claiming. Nothing
 * here executes; rejection is cheap and a correction attempt costs the same
 * bounded resources as any other decision call.
 */
export function validateDirectorProposal(raw: unknown, input: DirectorInput): DirectorProposal {
  if (!isRecord(raw)) {
    throw new DirectorProposalRejectedError("the decision model must return one JSON object proposal, not text or a list");
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_TOP_KEYS.has(key)) {
      throw new DirectorProposalRejectedError(
        `a proposal cannot set "${key}": objective, permissions, budget, status, promotion, submission, and results are outside model authority`,
      );
    }
  }

  const action = raw.action;
  if (typeof action !== "string" || !(DIRECTOR_ACTIONS as readonly string[]).includes(action)) {
    throw new DirectorProposalRejectedError(
      `action must be one of ${DIRECTOR_ACTIONS.join(", ")} (got ${JSON.stringify(action)})`,
    );
  }

  if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") {
    throw new DirectorProposalRejectedError("a proposal needs a non-empty string rationale tying it to the observed evidence");
  }
  if (raw.rationale.length > 4000) {
    throw new DirectorProposalRejectedError("proposal rationale is too long; state the evidence-based reason briefly");
  }

  if (typeof raw.stateVersion !== "number" || !Number.isInteger(raw.stateVersion)) {
    throw new DirectorProposalRejectedError("a proposal must echo the current integer stateVersion");
  }
  if (raw.stateVersion !== input.stateVersion) {
    throw new DirectorProposalRejectedError(
      `stale proposal: it answers stateVersion ${raw.stateVersion} but the authoritative state is ${input.stateVersion}`,
    );
  }

  if (raw.stopReason !== undefined && (typeof raw.stopReason !== "string" || raw.stopReason.trim() === "")) {
    throw new DirectorProposalRejectedError("stopReason must be a non-empty string when present");
  }
  if (raw.expectedCost !== undefined) {
    if (typeof raw.expectedCost !== "number" || !Number.isFinite(raw.expectedCost) || raw.expectedCost < 0) {
      throw new DirectorProposalRejectedError("expectedCost must be a finite non-negative number in the declared budget unit");
    }
  }
  if (raw.basedOn !== undefined && (!Array.isArray(raw.basedOn) || raw.basedOn.some((ref) => typeof ref !== "string" || ref.trim() === ""))) {
    throw new DirectorProposalRejectedError("basedOn must be a list of existing evidence/run references when present");
  }
  const knownRefs = new Set<string>();
  for (const observation of input.observations) {
    knownRefs.add(observation.runId);
    for (const ref of observation.evidenceRefs) knownRefs.add(ref);
  }

  const proposal: DirectorProposal = {
    stateVersion: raw.stateVersion,
    action: action as DirectorAction,
    rationale: raw.rationale.trim(),
    ...(typeof raw.stopReason === "string" ? { stopReason: raw.stopReason.trim() } : {}),
    ...(typeof raw.expectedCost === "number" ? { expectedCost: raw.expectedCost } : {}),
    ...(Array.isArray(raw.basedOn) ? { basedOn: raw.basedOn } : {}),
  };

  if (action === "stop") {
    if (raw.task !== undefined) {
      throw new DirectorProposalRejectedError("a stop proposal must not also carry a task to execute");
    }
    if (proposal.expectedCost !== undefined && proposal.expectedCost > 0) {
      throw new DirectorProposalRejectedError("a stop proposal must not reserve experiment cost");
    }
    if (raw.alternatives !== undefined) {
      throw new DirectorProposalRejectedError("a stop proposal must not also carry alternative actions");
    }
    return proposal;
  }

  // Every non-stop action must become one bounded Task for the existing ops.
  if (!isRecord(raw.task)) {
    throw new DirectorProposalRejectedError(`a ${action} proposal must include a task {objective, expectedOutputs?} to execute`);
  }
  const task = boundedTask(raw.task);

  // A retry/repair acts ON a prior attempt; it must name the real reference.
  if (action === "retry" || action === "repair") {
    const refs = proposal.basedOn;
    if (!refs || refs.length === 0) {
      throw new DirectorProposalRejectedError(`a ${action} proposal must reference the prior attempt in basedOn`);
    }
    if (!refs.every((ref) => knownRefs.has(ref))) {
      throw new DirectorProposalRejectedError(`a ${action} proposal references an unknown run/evidence reference`);
    }
  }
  if (proposal.basedOn) {
    for (const ref of proposal.basedOn) {
      if (!knownRefs.has(ref)) throw new DirectorProposalRejectedError(`basedOn references an unknown run/evidence: ${ref}`);
    }
  }

  const available = input.budget.remaining - input.budget.reserved;
  const requested = proposal.expectedCost ?? 0;
  if (requested > available + 1e-12) {
    throw new DirectorProposalRejectedError(
      `over-budget proposal: it expects ${requested} ${input.budget.units} but only ${available} is available; propose within the remaining budget or stop`,
    );
  }

  const alternatives = raw.alternatives === undefined ? undefined : boundedAlternatives(raw.alternatives, available, input.budget.units);
  return { ...proposal, task, ...(alternatives ? { alternatives } : {}) };
}

/** Bound one task subobject; shared by the proposal head and each alternative. */
function boundedTask(taskRaw: Record<string, unknown>): NonNullable<DirectorProposal["task"]> {
  for (const key of Object.keys(taskRaw)) {
    if (FORBIDDEN_TASK_KEYS.has(key)) {
      throw new DirectorProposalRejectedError(`a proposed task cannot assert "${key}": only the independent evaluator establishes results`);
    }
    if (!ALLOWED_TASK_KEYS.has(key)) {
      throw new DirectorProposalRejectedError(`unsupported task field "${key}"; a bounded task is objective, expectedOutputs, and constraints`);
    }
  }
  if (typeof taskRaw.objective !== "string" || taskRaw.objective.trim() === "") {
    throw new DirectorProposalRejectedError("a proposed task needs a non-empty objective");
  }
  if (taskRaw.objective.length > 2000) {
    throw new DirectorProposalRejectedError("proposed task objective is too long");
  }
  const contractErrors = taskContractErrors({
    ...(taskRaw.kind !== undefined ? { kind: taskRaw.kind as DraftPlanTask["kind"] } : {}),
    ...(Array.isArray(taskRaw.artifacts) ? { artifacts: taskRaw.artifacts as string[] } : {}),
  });
  if (contractErrors.length > 0) throw new DirectorProposalRejectedError(contractErrors.join("; "));
  if (taskRaw.artifacts !== undefined && (!Array.isArray(taskRaw.artifacts)
    || taskRaw.artifacts.some((path) => typeof path !== "string" || path.trim() === ""))) {
    throw new DirectorProposalRejectedError("task artifacts must be a list of relative workspace paths");
  }
  if (taskRaw.expectedOutputs !== undefined && (
    !Array.isArray(taskRaw.expectedOutputs)
    || taskRaw.expectedOutputs.some((out) => typeof out !== "string" || out.trim() === "")
  )) {
    throw new DirectorProposalRejectedError("task expectedOutputs must be a list of non-empty strings when present");
  }
  let constraints: Record<string, string | number | boolean> | undefined;
  if (taskRaw.constraints !== undefined) {
    if (!isRecord(taskRaw.constraints)) {
      throw new DirectorProposalRejectedError("task constraints must be an object of scalar key/value pairs when present");
    }
    constraints = {};
    for (const [key, value] of Object.entries(taskRaw.constraints)) {
      if (EXPANSION_PATTERN.test(key) || (typeof value === "string" && EXPANSION_PATTERN.test(value))) {
        throw new DirectorProposalRejectedError(
          `task constraint "${key}" asks for authority outside the Mission (network/external/submission/credentials are never granted by a proposal)`,
        );
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new DirectorProposalRejectedError(`task constraint "${key}" must be a scalar value`);
      }
      constraints[key] = value;
    }
  }
  return {
    objective: (taskRaw.objective as string).trim(),
    ...(taskRaw.kind !== undefined ? { kind: taskRaw.kind as DraftPlanTask["kind"] } : {}),
    ...(Array.isArray(taskRaw.artifacts) ? { artifacts: [...taskRaw.artifacts] as string[] } : {}),
    ...(Array.isArray(taskRaw.expectedOutputs) ? { expectedOutputs: [...taskRaw.expectedOutputs] as string[] } : {}),
    ...(constraints ? { constraints } : {}),
  };
}

/** Ordered alternates are bounded and held to the same authority/budget rules. */
function boundedAlternatives(raw: unknown, available: number, units: string): DirectorAlternative[] {
  if (!Array.isArray(raw)) {
    throw new DirectorProposalRejectedError("alternatives must be a list of bounded actions when present");
  }
  if (raw.length > MAX_DIRECTOR_ALTERNATIVES) {
    throw new DirectorProposalRejectedError(`at most ${MAX_DIRECTOR_ALTERNATIVES} alternatives may accompany one proposal`);
  }
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new DirectorProposalRejectedError("each alternative must be an object");
    const action = entry.action;
    if (typeof action !== "string" || action === "stop" || !(DIRECTOR_ACTIONS as readonly string[]).includes(action)) {
      throw new DirectorProposalRejectedError(`an alternative action must be one of ${DIRECTOR_ACTIONS.filter((a) => a !== "stop").join(", ")}`);
    }
    for (const key of Object.keys(entry)) {
      if (!ALTERNATIVE_KEYS.has(key)) throw new DirectorProposalRejectedError(`unsupported alternative field "${key}"`);
    }
    const alternative: DirectorAlternative = {
      action: action as Exclude<DirectorAction, "stop">,
      ...boundedTask({
        objective: entry.objective,
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        ...(entry.artifacts !== undefined ? { artifacts: entry.artifacts } : {}),
        ...(entry.expectedOutputs !== undefined ? { expectedOutputs: entry.expectedOutputs } : {}),
        ...(entry.constraints !== undefined ? { constraints: entry.constraints } : {}),
      }),
    };
    if (entry.expectedCost !== undefined) {
      if (typeof entry.expectedCost !== "number" || !Number.isFinite(entry.expectedCost) || entry.expectedCost < 0) {
        throw new DirectorProposalRejectedError("an alternative expectedCost must be a finite non-negative number in the declared budget unit");
      }
      if (entry.expectedCost > available + 1e-12) {
        throw new DirectorProposalRejectedError(
          `over-budget alternative: it expects ${entry.expectedCost} ${units} but only ${available} is available`,
        );
      }
      return { ...alternative, expectedCost: entry.expectedCost };
    }
    return alternative;
  });
}

/** Stable comparison key for one proposed action (the head or an alternate). */
function actionKey(option: { readonly action: string; readonly objective: string; readonly expectedOutputs?: readonly string[]; readonly constraints?: Readonly<Record<string, unknown>> }): string {
  const constraints = option.constraints
    ? Object.keys(option.constraints).sort().map((key) => `${key}=${String(option.constraints![key])}`).join(",")
    : "";
  return [option.action, option.objective.trim(), (option.expectedOutputs ?? []).join("\u0000"), constraints].join("\u0001");
}

/** Ordered action set of one proposal: the head first, then its alternates. */
function optionKeys(proposal: DirectorProposal): string[] {
  if (proposal.action === "stop") return [];
  return [
    actionKey({ action: proposal.action, objective: proposal.task?.objective ?? "", expectedOutputs: proposal.task?.expectedOutputs, constraints: proposal.task?.constraints }),
    ...(proposal.alternatives ?? []).map((alternative) => actionKey(alternative)),
  ];
}

/**
 * Derives the decision delta from the two proposals themselves (#211 AC5). A
 * model-declared delta is never trusted: this compares the controller-validated
 * actions, so the audit shows what Memory actually changed. The delta describes
 * the action that would DISPATCH, so a tail-only change to undispatched
 * alternatives is `unchanged`; those alternatives are audited separately.
 * expectedCost and basedOn are sizing/provenance, not direction, so they are
 * excluded from action identity.
 */
export function deriveDecisionDelta(blind: DirectorProposal, revised: DirectorProposal): DecisionDelta {
  const blindKeys = optionKeys(blind);
  const revisedKeys = optionKeys(revised);
  if (blindKeys.length === 0 && revisedKeys.length === 0) return "unchanged";
  if (revisedKeys.length === 0) return "withdrawn";
  if (blindKeys.length === 0) return "replaced";
  if (blindKeys.join("\u0002") === revisedKeys.join("\u0002")) return "unchanged";
  if (blindKeys[0] === revisedKeys[0]) return "unchanged";
  const sortedBlind = [...blindKeys].sort();
  const sortedRevised = [...revisedKeys].sort();
  const sameSet = sortedBlind.length === sortedRevised.length
    && sortedBlind.every((key, index) => key === sortedRevised[index]);
  // The dispatched action changed but the considered set did not: a reorder.
  if (sameSet) return "reordered";
  // The same action/objective with a wider declared output set is an expansion
  // that still has to pass the existing action/Task validation.
  if (blind.task && revised.task && blind.action === revised.action && blind.task.objective === revised.task.objective) {
    const blindOutputs = new Set(blind.task.expectedOutputs ?? []);
    const revisedOutputs = new Set(revised.task.expectedOutputs ?? []);
    const wider = revisedOutputs.size > blindOutputs.size && [...blindOutputs].every((output) => revisedOutputs.has(output));
    if (wider) return "expanded_via_existing_search";
  }
  return "replaced";
}

/** Map one independent measurement to its trusted observation projection. */
function measuredObservation(args: {
  runId: string;
  attempt: number;
  kind: "baseline" | "experiment";
  action: DirectorAction | "baseline";
  evaluation: ExperimentTrailEntry["evaluation"];
  evidenceRefs: readonly string[];
  dispatchedAt: string;
}): DirectorObservation {
  const evaluation = args.evaluation!;
  const base: DirectorObservation = {
    runId: args.runId,
    attempt: args.attempt,
    kind: args.kind,
    action: args.action,
    ok: evaluation.ok,
    evidenceRefs: args.evidenceRefs,
    dispatchedAt: args.dispatchedAt,
    ...(typeof evaluation.score === "number" ? { score: evaluation.score } : {}),
    ...(evaluation.ruleViolations?.length ? { ruleViolations: [...evaluation.ruleViolations] } : {}),
    ...(evaluation.facts?.length ? { facts: evaluation.facts.map((fact) => ({ ...fact })) } : {}),
  };
  // A measured rule failure is Negative Evidence, not a dropped observation; an
  // invalid measurement is an operational outcome instead.
  const classification = classifyRunOutcome(evaluation);
  return {
    ...base,
    outcome: classification.state,
    ...(classification.failure !== undefined ? { failure: classification.failure } : {}),
    ...(classification.scientificNegativeEvidence ? { negativeEvidence: true } : {}),
  };
}

/** One measured score the Mission state may never lose, however much Memory an arm is denied. */
export interface MissionScoreboardRow {
  readonly runId: string;
  readonly kind: "baseline" | "experiment";
  readonly attempt: number;
  readonly action: DirectorAction | "baseline";
  readonly score: number;
}

/**
 * F5 (#231): the Mission's measured state, which is NOT Memory. An arm denied
 * Research Memory still receives the current best and the full scoreboard, so
 * "off" measures absence of Memory rather than amnesia.
 */
export interface MissionRetainedState {
  /** Best measured Run. shortcut: the Mission contract records no metric
   *  direction, so this is the highest score; a minimized metric needs
   *  direction-aware selection. */
  readonly currentBest?: MissionScoreboardRow;
  /** Every measured Run's score, in stable run-id order. */
  readonly scoreboard: readonly MissionScoreboardRow[];
  /** Stable identity of the scoreboard, so a prompt can name what it carried. */
  readonly digest: string;
}

/** Orders and digests the measured rows and selects the current best. */
export function missionScoreboard(rows: readonly MissionScoreboardRow[]): MissionRetainedState {
  const scoreboard = [...rows].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  let currentBest: MissionScoreboardRow | undefined;
  for (const row of scoreboard) {
    if (currentBest === undefined || row.score > currentBest.score) currentBest = row;
  }
  return deepFreeze({
    ...(currentBest === undefined ? {} : { currentBest }),
    scoreboard,
    digest: digestValue(scoreboard),
  });
}

/** The retained Mission state implied by the observations a decision Run is handed. */
export function missionRetainedState(observations: readonly DirectorObservation[]): MissionRetainedState {
  return missionScoreboard(observations.flatMap((observation) => typeof observation.score === "number"
    ? [{ runId: observation.runId, kind: observation.kind, attempt: observation.attempt, action: observation.action, score: observation.score }]
    : []));
}

/**
 * The durable measured scores of one Mission: the reference a decision
 * projection must keep. It reads the record directly instead of going through
 * `buildDirectorInput`, so a projection that stops serving a measured score
 * shows up as a difference instead of cancelling itself out.
 */
export function recordRetainedState(record: MissionRecord): MissionRetainedState {
  const rows: MissionScoreboardRow[] = [];
  const baseline = record.baseline;
  if (baseline !== undefined && typeof baseline.evaluation.score === "number") {
    rows.push({
      runId: baseline.runId,
      kind: "baseline",
      attempt: record.runs?.[baseline.runId]?.attempt ?? 1,
      action: "baseline",
      score: baseline.evaluation.score,
    });
  }
  for (const entry of record.experiments ?? []) {
    const score = entry.evaluation?.score;
    if (typeof score !== "number") continue;
    rows.push({ runId: entry.runId, kind: "experiment", attempt: entry.attempt, action: entry.action, score });
  }
  return missionScoreboard(rows);
}

/**
 * The state a decision point hands its Director, through the trusted projection
 * (only the observations matter here; the policy fields are inert).
 */
export function decisionRetainedState(record: MissionRecord): MissionRetainedState {
  return missionRetainedState(buildDirectorInput(record, {
    permissions: record.permissions ?? [],
    hardRules: record.contract.hardRules,
    stopConditions: record.stopConditions ?? [],
  }).observations);
}

/**
 * Where Mission-state retention is checked: the decision point where the state
 * is handed to the Director, or a whole-Mission comparison arm (L2).
 */
export type OffRetainsMissionStateScope = "decision-point" | "whole-mission";

/**
 * F5 (#231): an `off` arm keeps the Mission's current best and scoreboard, so
 * "no Memory" never becomes "no state". An arm that is denied Memory AND loses
 * state would measure amnesia and bias the reading in Memory's favour by
 * construction, so this is a hard assertion at both evaluation seams.
 */
export function assertOffRetainsMissionState(input: {
  readonly mode: ResearchMemoryEvaluationMode;
  readonly scope: OffRetainsMissionStateScope;
  /** The state the off arm actually hands its Director. */
  readonly retained: MissionRetainedState;
  /** The same Mission's durable measurements, read independently of the projection. */
  readonly expected: MissionRetainedState;
  readonly runId?: string;
}): void {
  // Only the Memory-denied arm can lose state by construction.
  if (input.mode !== "off") return;
  const where = input.runId === undefined
    ? `off arm (${input.scope})`
    : `off arm (${input.scope}) for Run "${input.runId}"`;
  const carried = new Map(input.retained.scoreboard.map((row) => [row.runId, row.score]));
  const lost = input.expected.scoreboard.filter((row) => carried.get(row.runId) !== row.score);
  if (lost.length > 0) {
    throw new Error(`${where} lost the Mission scoreboard (${lost.map((row) => row.runId).join(", ")} missing from the state it was handed); an off arm may lose Memory but never Mission state`);
  }
  if (input.expected.currentBest !== undefined && input.retained.currentBest === undefined) {
    // Guards a caller-built state: every in-repo producer derives currentBest
    // from its own rows, so only an arm that assembles its state elsewhere
    // (the L1 decision-point evaluation) can reach this.
    throw new Error(`${where} lost the Mission's current best (Run "${input.expected.currentBest.runId}" scoring ${input.expected.currentBest.score}); an off arm may lose Memory but never Mission state`);
  }
}

/**
 * Build the trusted model-facing projection from the durable Mission record.
 * Reads only authoritative fields; the model never sees credentials or raw
 * transcripts, and every observation carries its durable evidence references.
 */
export function buildDirectorInput(
  record: MissionRecord,
  policy: {
    permissions: readonly string[];
    hardRules: readonly string[];
    stopConditions: readonly string[];
  },
): DirectorInput {
  const observations: DirectorObservation[] = [];

  if (record.baseline && record.baselineRunId) {
    observations.push(measuredObservation({
      runId: record.baselineRunId,
      attempt: record.runs[record.baselineRunId]?.attempt ?? 1,
      kind: "baseline",
      action: "baseline",
      evaluation: record.baseline.evaluation,
      evidenceRefs: record.baseline.evidenceRefs,
      dispatchedAt: record.runs[record.baselineRunId]?.dispatchedAt ?? record.baseline.measuredAt,
    }));
  }
  for (const experiment of record.experiments ?? []) {
    const run = record.runs[experiment.runId];
    if (experiment.evaluation) {
      observations.push(measuredObservation({
        runId: experiment.runId,
        attempt: experiment.attempt,
        kind: "experiment",
        action: experiment.action,
        evaluation: experiment.evaluation,
        evidenceRefs: experiment.evidenceRefs,
        dispatchedAt: run?.dispatchedAt ?? experiment.at,
      }));
    } else {
      // A dispatch/run failure with no measurement keeps its Run Outcome but is
      // an OPERATIONAL failure: it cannot refute the Hypothesis it was testing.
      const classification = classifyTrailEntry(experiment);
      observations.push({
        runId: experiment.runId,
        attempt: experiment.attempt,
        kind: "experiment",
        action: experiment.action,
        ok: false,
        outcome: classification.state,
        ...(classification.failure !== undefined ? { failure: classification.failure } : {}),
        ...(experiment.error ? { error: experiment.error } : {}),
        ...(experiment.ruleViolations?.length ? { ruleViolations: [...experiment.ruleViolations] } : {}),
        evidenceRefs: experiment.evidenceRefs,
        dispatchedAt: run?.dispatchedAt ?? experiment.at,
      });
    }
  }

  return {
    missionId: record.id,
    stateVersion: record.stateVersion ?? 0,
    objective: record.objective,
    contract: record.contract,
    policy: { permissions: policy.permissions, hardRules: policy.hardRules },
    budget: {
      total: record.budget.total,
      units: record.budget.units,
      consumed: record.budget.consumed,
      remaining: record.budget.remaining,
      reserved: record.reserved,
    },
    stopConditions: policy.stopConditions,
    tasks: record.tasks ?? [],
    observations,
  };
}

const DIRECTOR_INSTRUCTIONS = `You are the Mission Director for ONE authorized evoK research Mission.
You reason about research direction FROM MEASURED EVIDENCE ONLY. The input is a
JSON object: the human-owned objective and contract, immutable policy
(permissions/hard rules), remaining budget in explicit units, already-generated
tasks, and chronological observations. Each observation is an independent
evaluator measurement (with score/facts/rule violations) or a retained failed
attempt with durable evidence references. Each observation carries "outcome":
"positive" | "negative" | "operational". Only a measured refutation sets
negativeEvidence=true; an operational failure (OOM, timeout, invalid
measurement, protocol error) is NOT scientific evidence and never refutes a
hypothesis — treat it as a condition to work around. The "scoreboard" holds the
Mission's measured scores and "currentBest"; that is Mission state, not Memory,
and it is present even when no Research Memory packet is pinned. currentBest is
the highest-scoring measured Run: if the metric is minimized, the best row is the
lowest score instead.

Choose the single most useful NEXT action within the authorized objective:
- "investigate": inspect/understand before changing the candidate;
- "repair": fix a defect in the previously attempted approach;
- "retry": re-attempt the same approach (must name it in basedOn);
- "change-direction": materially different hypothesis/approach;
- "stop": an authorized stopping condition applies (budget insufficient for
  another bounded Experiment, the evidence is conclusive, or a declared stop
  condition is met). Give stopReason.

Respond with ONE minified JSON object and nothing else:
{"stateVersion":<echo the input stateVersion exactly>,"action":<one of the actions>,"rationale":<short evidence-based reason>,"task":{"kind":"measure|investigate|repair","objective":<bounded task objective>,"artifacts":[<relative artifact paths required for investigate/repair>],"expectedOutputs":[<required artifact names>]},"expectedCost":<finite non-negative number in the budget unit>,"basedOn":[<existing run ids/evidence refs>] }
For action "stop" omit task/expectedCost and provide "stopReason" instead.
Task kind "measure" runs the Mission's independent numeric evaluator. Use it only
for an actual controlled measurement. "investigate" and "repair" are evaluated
only on their declared artifacts and never produce a scientific score; choose
those kinds for diagnosis, literature review, or execution repair instead of
forcing every task through the metric hill-climb.
You may add "alternatives":[{"action":<a non-stop action>,"kind":"measure|investigate|repair","objective":<bounded objective>,"artifacts":[<paths required for investigate/repair>],"expectedOutputs":[<names>]}] (at most ${MAX_DIRECTOR_ALTERNATIVES}) for bounded work you also considered; only your chosen action is executed.

Hard boundaries you cannot cross in a proposal:
- Do not change the objective, policy, permissions, or budget. Do not request
  network, external submission, deployment, credentials, or promotion.
- Do not report a score, success, verification, or result. You do not measure:
  an independent evaluator measures the immutable snapshot after a Run. Failed
  and inconclusive attempts are evidence to learn from, never to erase or relabel.
- Base the choice on the ACTUAL observations and their references. A task count
  is not a budget: expectedCost is in the declared budget unit and must fit the
  remaining budget. Prefer investigation or a changed approach over repeating a
  measured failure without a reason.`;

export interface PiMissionDirectorOptions {
  readonly resources: EvokResources;
  /** Builds one fresh PiAgentRuntime per decision (fresh session/workspace). */
  readonly runtimeFactory: (workspaceRoot: string) => PiAgentRuntime;
  readonly tier?: string;
  /** Parent for disposable decision workspaces (default: OS temp dir). */
  readonly workspaceRoot?: string;
}

/**
 * Assembles the one prompt a decision Run sees. The Memory-blind stage's prompt
 * is exactly the trusted-state prompt; a revision prompt is that SAME prompt
 * plus one segment carrying only the frozen Blind Proposal and the pinned
 * Memory packet, so no other input can differ between the two stages (#211).
 */
export function buildDirectorPrompt(input: DirectorInput): string {
  const retained = missionRetainedState(input.observations);
  const stateJson = JSON.stringify({
    missionId: input.missionId,
    stateVersion: input.stateVersion,
    objective: input.objective,
    contract: input.contract,
    policy: input.policy,
    budget: input.budget,
    stopConditions: input.stopConditions,
    tasks: input.tasks,
    observations: input.observations,
    // F5 (#231): Mission state, not Memory: every arm receives it, including
    // the off arm that pins no Research Memory packet at all.
    scoreboard: {
      ...(retained.currentBest === undefined ? {} : { currentBest: retained.currentBest }),
      rows: retained.scoreboard,
      digest: retained.digest,
    },
  });
  const base = `${DIRECTOR_INSTRUCTIONS}\n\nCURRENT AUTHORITATIVE MISSION STATE (JSON):\n${stateJson}`;
  const phase = input.decisionPhase;
  if (phase === undefined) return base;
  const packet = phase.memoryPacket;
  const sidecar = phase.insightSidecar;
  return [
    base,
    "",
    "REVISION STAGE (Memory-informed). Your Blind Proposal below was frozen from the state above BEFORE any Research Memory was visible. Keep it, reorder it, replace it, withdraw it (action \"stop\"), or expand it with bounded work, and say why in rationale. Research Memory is advisory: it grants no objective, permission, budget, or submission authority.",
    "BLIND PROPOSAL (frozen, JSON):",
    JSON.stringify(phase.blindProposal),
    packet === undefined
      ? "RESEARCH DECISION PACKET: none pinned (no Research Memory snapshot is pinned for this Mission yet)."
      : `RESEARCH DECISION PACKET (one pinned snapshot, JSON):\n${JSON.stringify(packet)}`,
    // #215: a bounded packet must never read as the complete research history.
    ...(packet?.truncated
      ? ["The packet above is TRUNCATED: its omissions/omittedCardCount fields count the cards it does not carry, so it is not the complete history."]
      : []),
    // #238 D6 / #240: the human side of the same Revision. It is advisory
    // context with no epistemic authority and no dispatch path of its own.
    sidecar.items.length === 0
      ? "INSIGHT SIDECAR: no pending human Insight is pinned for this Revision (an explicit empty sidecar, not a skipped input)."
      : `INSIGHT SIDECAR (advisor context only: pending human Insight, pinned ids and versions, JSON):\n${JSON.stringify(sidecar)}`,
    ...(sidecar.items.length === 0
      ? []
      : [
        "Human Insight has zero epistemic authority: it proves nothing, it is never Evidence or a Verified Claim, and it grants no objective, permission, budget, submission or dispatch authority. It may only inform this Revised Proposal — an Insight never runs an Experiment by itself.",
        "Answer every pinned Insight: add \"insightDispositions\" as a list of {insightId, disposition, reason?, proposalRef?}. disposition is one of \"ignored\" (seen, not worth pursuing), \"rejected\" (refuted — reason required), \"experiment_proposed\" (worth testing — proposalRef required, naming this Revision's proposal) and \"deferred\" (not now — say when to revisit). \"ignored\" and \"rejected\" are different answers: unpursuable is not disproved.",
      ]),
    ...(sidecar.truncated
      ? ["The sidecar above is TRUNCATED: its omittedCount field counts pending Insight it does not carry, so it is not the whole Inbox."]
      : []),
    "Respond with the same JSON shape; you may add \"alternatives\" (bounded actions only), \"usedMemoryRefs\" (card ids from this packet only) and \"insightDispositions\" (pinned Insight ids only).",
  ].join("\n");
}

/** Extract the first JSON object/array from a model response. */
function jsonFromText(text: string | undefined): unknown {
  if (!text) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"));
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body.trim());
  } catch {
    return undefined;
  }
}

/**
 * The model's own judgement list, kept as returned: the controller validates it
 * against the pinned sidecar, so a malformed entry is rejected with a reason
 * instead of being silently dropped (a dropped entry would read as "no answer").
 * Only a non-object list member is skipped; anything shaped like a judgement is
 * passed on for that validation.
 */
function insightDispositionsOf(raw: readonly unknown[]): RevisionInsightDispositionInput[] {
  return raw.filter(isRecord).map((entry) => ({
    insightId: typeof entry.insightId === "string" ? entry.insightId : "",
    disposition: (typeof entry.disposition === "string" ? entry.disposition : "") as RevisionInsightDispositionInput["disposition"],
    ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    ...(typeof entry.proposalRef === "string" ? { proposalRef: entry.proposalRef } : {}),
  }));
}

/**
 * Pi-backed Mission Director: one FRESH read-only Pi session per decision
 * (ADR-0001). It carries read tools only — no write/edit/bash, no evaluator,
 * no promotion, no submission — so model reasoning cannot become execution
 * authority. Each decision is an ordinary priced model call; the controller
 * meters it against the same explicit-unit budget.
 */
export function createPiMissionDirector(options: PiMissionDirectorOptions): MissionDirector {
  return {
    id: "pi-mission-director",
    async decide(input: DirectorInput, signal?: AbortSignal, attempt = 1): Promise<DirectorDecision> {
      // ADR-0001: a fresh runtime/session/workspace AND attempt identity per
      // decision correction; no cross-iteration transcript, no hidden retry.
      const workspaceParent = join(
        options.workspaceRoot ?? tmpdir(),
        `evok-director-${input.missionId.replace(/[^a-z0-9._-]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const runtime = options.runtimeFactory(workspaceParent);
      const prompt = buildDirectorPrompt(input);
      let result;
      try {
        result = await runtime.execute(
          {
            task: {
              objective: "Choose the next bounded research action from the measured evidence",
              constraints: { missionId: input.missionId, stateVersion: input.stateVersion },
            },
            role: {
              name: "evok-mission-director",
              // The trusted projection (plus, in the revision stage only, the
              // frozen proposal and pinned packet) is the ONLY state this
              // decision Run sees; the model never reads Mission records.
              instructions: prompt,
              // READ-ONLY decision boundary: the prompt carries the trusted
              // projection; the role may inspect the project but can never
              // write a candidate, a score, or a controller record.
              tools: [...READ_ONLY_TOOLS],
              allowCodingTools: false,
            },
            workspace: {
              path: join(workspaceParent, "decision"),
              isolated: true,
              approved: true,
              readRoots: [options.resources.projectRoot, ...options.resources.readRoots],
              sandbox: {
                allowBash: false,
                network: "none",
                allowedTools: [...READ_ONLY_TOOLS],
                // The decision role may read the project but never controller
                // mission records or the approved skill source directories.
                // Credential stores (Pi agent dir) stay protected the same way
                // as candidate Runs; network is off, so this role cannot exfiltrate.
                protectedPaths: [
                  join(options.resources.projectRoot, ".evok", "missions"),
                  ...options.resources.readRoots,
                  getAgentDir(),
                ],
                ...(options.resources.userRoot
                  ? { credentialPaths: [options.resources.userRoot, getAgentDir()] }
                  : { credentialPaths: [getAgentDir()] }),
              },
            },
            tier: options.tier ?? "default",
            intentId: `${input.missionId}:director:${input.stateVersion + 1}:${attempt}`,
            identity: {
              branchId: "director",
              runId: `${input.missionId}:director:${input.stateVersion + 1}:${attempt}`,
              attempt,
              workspaceId: "director",
              fencingToken: attempt,
            },
          },
          signal,
        );
      } catch (error) {
        await rm(workspaceParent, { recursive: true, force: true }).catch(() => {});
        if ((error as Error).name === "AbortError") throw error;
        throw new DirectorDecisionFailedError(`decision-model run failed: ${(error as Error).message}`);
      }
      const parsed = jsonFromText(result.text);
      await rm(workspaceParent, { recursive: true, force: true }).catch(() => {});
      if (!isRecord(parsed)) {
        // The rejected Run still made a real priced model call: carry its
        // usage so the controller meters the correction attempt (AC6).
        throw new DirectorProposalRejectedError(
          `decision model did not return a JSON object proposal (stopReason: ${result.stopReason})`,
          { usage: result.usage, sessionId: result.sessionId, model: result.model },
        );
      }
      // Validation is the controller's job; re-thrown with usage so a rejected
      // call is still metered rather than treated as free.
      let proposal: DirectorProposal;
      try {
        proposal = validateDirectorProposal(parsed, input);
      } catch (error) {
        if (error instanceof DirectorProposalRejectedError) {
          throw new DirectorProposalRejectedError(error.message, { usage: result.usage, sessionId: result.sessionId, model: result.model });
        }
        throw error;
      }
      return {
        proposal,
        sessionId: result.sessionId,
        usage: result.usage,
        model: result.model,
        ...(Array.isArray(parsed.usedMemoryRefs)
          ? { usedMemoryRefs: parsed.usedMemoryRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "") }
          : {}),
        ...(Array.isArray(parsed.insightDispositions) ? { insightDispositions: insightDispositionsOf(parsed.insightDispositions) } : {}),
      };
    },
  };
}
