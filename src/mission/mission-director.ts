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
import type { EvokResources } from "../evok-resources";
import { READ_ONLY_TOOLS } from "../pi-agent-runtime";

/** Bounded actions the decision model may choose within an authorized Mission. */
export const DIRECTOR_ACTIONS = [
  "investigate",
  "repair",
  "retry",
  "change-direction",
  "stop",
] as const;

export type DirectorAction = (typeof DIRECTOR_ACTIONS)[number];

/** A proposal that survives runtime bounding; ready to apply via existing ops. */
export interface DirectorProposal {
  readonly stateVersion: number;
  readonly action: DirectorAction;
  readonly rationale: string;
  readonly stopReason?: string;
  readonly task?: {
    readonly objective: string;
    readonly expectedOutputs?: readonly string[];
    readonly constraints?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly expectedCost?: number;
  readonly basedOn?: readonly string[];
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
  /** True for failed/inconclusive attempts retained as Negative Evidence. */
  readonly negativeEvidence?: boolean;
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
}

/** What one bounded decision call actually consumed. */
export interface DirectorDecision {
  readonly proposal: DirectorProposal;
  readonly sessionId: string;
  readonly usage: RuntimeUsage;
  /** Actual model that served the decision (for trusted-side pricing). */
  readonly model?: ModelConfigView;
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
const ALLOWED_TASK_KEYS = new Set(["objective", "expectedOutputs", "constraints"]);

/** Task-subobject keys that would assert a result instead of propose work. */
const FORBIDDEN_TASK_KEYS = new Set([
  "score", "success", "succeeded", "result", "verified", "ok", "pass", "passed",
]);

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
    return proposal;
  }

  // Every non-stop action must become one bounded Task for the existing ops.
  if (!isRecord(raw.task)) {
    throw new DirectorProposalRejectedError(`a ${action} proposal must include a task {objective, expectedOutputs?} to execute`);
  }
  const taskRaw = raw.task;
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

  const task: DirectorProposal["task"] = {
    objective: taskRaw.objective.trim(),
    ...(Array.isArray(taskRaw.expectedOutputs) ? { expectedOutputs: [...taskRaw.expectedOutputs] } : {}),
    ...(constraints ? { constraints } : {}),
  };

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

  return { ...proposal, task };
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
  // A measured rule failure is Negative Evidence, not a dropped observation.
  return evaluation.ok ? base : { ...base, negativeEvidence: true };
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
      // A dispatch/run failure with no measurement: still Negative Evidence.
      observations.push({
        runId: experiment.runId,
        attempt: experiment.attempt,
        kind: "experiment",
        action: experiment.action,
        ok: false,
        negativeEvidence: true,
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
attempt (negativeEvidence=true) with durable evidence references.

Choose the single most useful NEXT action within the authorized objective:
- "investigate": inspect/understand before changing the candidate;
- "repair": fix a defect in the previously attempted approach;
- "retry": re-attempt the same approach (must name it in basedOn);
- "change-direction": materially different hypothesis/approach;
- "stop": an authorized stopping condition applies (budget insufficient for
  another bounded Experiment, the evidence is conclusive, or a declared stop
  condition is met). Give stopReason.

Respond with ONE minified JSON object and nothing else:
{"stateVersion":<echo the input stateVersion exactly>,"action":<one of the actions>,"rationale":<short evidence-based reason>,"task":{"objective":<bounded task objective>,"expectedOutputs":[<required artifact names>]},"expectedCost":<finite non-negative number in the budget unit>,"basedOn":[<existing run ids/evidence refs>] }
For action "stop" omit task/expectedCost and provide "stopReason" instead.

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
      });
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
              // The trusted projection is embedded verbatim after the role
              // instructions; this is the ONLY state the decision Run sees.
              instructions: `${DIRECTOR_INSTRUCTIONS}\n\nCURRENT AUTHORITATIVE MISSION STATE (JSON):\n${stateJson}`,
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
      return { proposal, sessionId: result.sessionId, usage: result.usage, model: result.model };
    },
  };
}
