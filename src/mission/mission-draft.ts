/**
 * Mission draft persistence (#111, T3; spec #108 US10/US38/US39/US44,
 * ADR-0004 "Project-local Mission storage").
 *
 * A Mission draft is the single current, chat-derived record produced by the
 * intake skill: Research Objective, success criteria, data, evaluation,
 * constraints/permissions, budget, outputs, stop conditions, unresolved
 * execution prerequisites, settled decisions, cited sources, and an initial
 * baseline-hypothesis plan. Task entries reuse the Task Contract vocabulary
 * (objective/expectedOutputs/constraints/evidenceRequirements/dependencies).
 * The budget view is a declared envelope ({total, units}); it is NOT the
 * ResearchBudgetState consumed/remaining ledger of an executing Mission.
 *
 * It is deliberately NOT an executing Mission and NOT a second authoritative
 * state model: status is locked to "draft" here. The later start slice
 * validates the draft against the existing Mission Director/ledger structures;
 * nothing in this module dispatches Experiments or starts a Research Loop.
 *
 * Layout: <project>/.evok/missions/<id>/draft.json (atomic write), with a
 * single shared .gitignore directly under .evok/missions/ so all generated
 * Mission storage is excluded from Git while .evok config and skills stay
 * versionable.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const MISSION_DRAFT_SCHEMA_VERSION = 1 as const;
export const MISSIONS_DIRNAME = "missions";
export const DRAFT_FILENAME = "draft.json";

/** Raised when stored draft bytes exist but cannot be trusted as this draft. */
export class MissionDraftCorruptionError extends Error {
  readonly kind = "mission-draft-corruption" as const;
  /** True for a missing file (safe to create); false for untrustworthy bytes. */
  readonly missing: boolean;
  constructor(message: string, missing = false) {
    super(message);
    this.name = "MissionDraftCorruptionError";
    this.missing = missing;
  }
}

export interface DraftDecision {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly recommendation?: string;
  readonly settled: boolean;
  /** ISO-8601 timestamp. */
  readonly at: string;
}

export interface DraftSource {
  /** Reference URL or doc identifier for an external claim. */
  readonly url: string;
  readonly title?: string;
  readonly claim: string;
  readonly retrievedAt: string;
}

/** Initial-plan Task entry using the existing Task Contract field names. */
export interface DraftPlanTask {
  readonly taskId: string;
  readonly objective: string;
  readonly expectedOutputs?: readonly string[];
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly evidenceRequirements?: readonly string[];
  readonly dependencies?: readonly string[];
}

export interface InitialPlan {
  /** The baseline to establish/reproduce and the first falsifiable hypothesis. */
  readonly baselineHypothesis: string;
  /** First steps only; later Tasks follow accumulated Evidence. */
  readonly tasks: readonly DraftPlanTask[];
}

export interface MissionDraft {
  readonly schemaVersion: typeof MISSION_DRAFT_SCHEMA_VERSION;
  readonly id: string;
  /** Locked for this slice: a saved draft never claims to be executing. */
  readonly status: "draft";
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly data: { readonly description: string; readonly sources?: readonly string[] };
  readonly evaluation: { readonly method: string; readonly metric?: string };
  readonly constraints: {
    readonly permissions?: readonly string[];
    readonly hardRules?: readonly string[];
  };
  readonly budget: { readonly total: number; readonly units: string; readonly note?: string };
  readonly outputs: readonly string[];
  readonly stopConditions: readonly string[];
  readonly unresolvedPrerequisites: readonly string[];
  readonly decisions: readonly DraftDecision[];
  readonly sources: readonly DraftSource[];
  readonly plan: InitialPlan;
  /** Discussion/model usage accumulated while drafting; never labeled free. */
  readonly usage: {
    readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
    readonly cost: { readonly total: number; readonly units: string };
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Epoch ms set by save; not trusted on load. */
  readonly savedAt?: number;
}

/** Model-facing partial: the record tool may omit fields still unknown. */
export type MissionDraftInput = Partial<Omit<MissionDraft, "id" | "status" | "schemaVersion">> & {
  readonly id: string;
  readonly objective: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new MissionDraftCorruptionError("draft field must be a list of strings");
  }
  return value as string[];
}

/**
 * Validate and normalize a draft. Throws MissionDraftCorruptionError for
 * untrusted loaded bytes and plain TypeError for programming mistakes; the
 * status lock and id shape are enforced for both so neither the model tool
 * nor a damaged file can create an "executing" or mis-identified record.
 *
 * Intake is deliberately allowed to save HONEST PARTIAL drafts (unknown
 * descriptions, zero budget, an empty task list): completeness for later
 * start review is judged by draftReadyForReview, not by this validator. The
 * validator enforces types/shapes and rejects damaged stored bytes; it does
 * not force placeholder content. The one always-required content field is the
 * Research Objective — nothing can be drafted without it.
 */
export const MISSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isMissionId(value: unknown): value is string {
  return typeof value === "string" && MISSION_ID_PATTERN.test(value);
}

export function completeDraft(input: MissionDraftInput, options: { fromDisk?: boolean } = {}): MissionDraft {
  const fail: (message: string) => never = options.fromDisk
    ? (message: string) => { throw new MissionDraftCorruptionError(message); }
    : (message: string) => { throw new TypeError(message); };

  if (!isRecord(input)) fail("draft must be a JSON object");
  const record = input as Record<string, any>;

  const { id } = record;
  if (!isMissionId(id)) fail("draft id is missing or malformed");
  if (record.status !== undefined && record.status !== "draft") {
    fail(`mission draft status must be "draft", got ${JSON.stringify(record.status)} — start authorization is a later slice`);
  }
  if (typeof record.objective !== "string" || record.objective.trim() === "") fail("research objective is required");

  const data: Record<string, any> = isRecord(record.data) ? record.data : {};
  const evaluation: Record<string, any> = isRecord(record.evaluation) ? record.evaluation : {};
  const constraints: Record<string, any> = isRecord(record.constraints) ? record.constraints : {};
  const budgetIn: Record<string, any> = isRecord(record.budget) ? record.budget : {};
  const plan: Record<string, any> = isRecord(record.plan) ? record.plan : {};
  const usage: Record<string, any> = isRecord(record.usage) ? record.usage : {};
  const usageTokens: Record<string, any> = isRecord(usage.tokens) ? usage.tokens : {};
  const usageCost: Record<string, any> = isRecord(usage.cost) ? usage.cost : {};

  // Shape checks only: present fields must have the right types, but unknown/
  // missing content is a valid partial draft, not a reason to reject a save.
  if (data.description !== undefined && typeof data.description !== "string") fail("data.description must be a string");
  if (evaluation.method !== undefined && typeof evaluation.method !== "string") fail("evaluation.method must be a string");
  if (typeof evaluation.metric !== "undefined" && typeof evaluation.metric !== "string") fail("evaluation.metric must be a string");
  const budgetTotal = budgetIn.total ?? 0;
  if (typeof budgetTotal !== "number" || !Number.isFinite(budgetTotal) || budgetTotal < 0) fail("budget.total must be a non-negative number");
  let budgetUnits = budgetIn.units;
  if (budgetUnits === undefined) {
    if (options.fromDisk) fail("budget.units is required");
    budgetUnits = "model-USD";
  }
  if (typeof budgetUnits !== "string" || budgetUnits.trim() === "") fail("budget.units must be a non-empty string");
  if (plan.baselineHypothesis !== undefined && typeof plan.baselineHypothesis !== "string") {
    fail("plan.baselineHypothesis must be a string");
  }
  if (plan.tasks !== undefined && !Array.isArray(plan.tasks)) fail("plan.tasks must be a list");
  (Array.isArray(plan.tasks) ? plan.tasks : []).forEach((task: unknown, index: number) => {
    if (!isRecord(task) || typeof task.taskId !== "string" || typeof task.objective !== "string") {
      fail(`plan.tasks[${index}] needs taskId and objective`);
    }
  });
  if (record.decisions !== undefined && !Array.isArray(record.decisions)) fail("decisions must be a list");
  (Array.isArray(record.decisions) ? record.decisions : []).forEach((decision: unknown, index: number) => {
    if (!isRecord(decision) || typeof decision.question !== "string" || typeof decision.answer !== "string") {
      fail(`decisions[${index}] needs question and answer strings`);
    }
  });
  if (record.sources !== undefined && !Array.isArray(record.sources)) fail("sources must be a list");
  (Array.isArray(record.sources) ? record.sources : []).forEach((source: unknown, index: number) => {
    if (!isRecord(source) || typeof source.url !== "string" || typeof source.claim !== "string") {
      fail(`sources[${index}] needs url and claim strings`);
    }
  });

  // A timestamp we cannot parse is a damaged record (and meaningless for a
  // model-supplied draft); never silently replace it with "now".
  const iso = (value: unknown, field: string): string => {
    if (value === undefined) return new Date().toISOString();
    if (typeof value !== "string") fail(`${field} must be an ISO-8601 timestamp, got ${JSON.stringify(value)}`);
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) fail(`${field} must be an ISO-8601 timestamp, got ${JSON.stringify(value)}`);
    return value;
  };

  return {
    schemaVersion: MISSION_DRAFT_SCHEMA_VERSION,
    id,
    status: "draft",
    objective: record.objective,
    successCriteria: stringList(record.successCriteria ?? []),
    data: {
      description: typeof data.description === "string" ? data.description : "",
      ...(Array.isArray(data.sources) ? { sources: stringList(data.sources) } : {}),
    },
    evaluation: {
      method: typeof evaluation.method === "string" ? evaluation.method : "",
      ...(typeof evaluation.metric === "string" ? { metric: evaluation.metric } : {}),
    },
    constraints: {
      ...(Array.isArray(constraints.permissions) ? { permissions: stringList(constraints.permissions) } : {}),
      ...(Array.isArray(constraints.hardRules) ? { hardRules: stringList(constraints.hardRules) } : {}),
    },
    budget: {
      total: budgetTotal,
      units: budgetUnits,
      ...(typeof budgetIn.note === "string" ? { note: budgetIn.note } : {}),
    },
    outputs: stringList(record.outputs ?? []),
    stopConditions: stringList(record.stopConditions ?? []),
    unresolvedPrerequisites: stringList(record.unresolvedPrerequisites ?? []),
    decisions: ((Array.isArray(record.decisions) ? record.decisions : []) as Record<string, any>[]).map((decision, index) => ({
      id: typeof decision.id === "string" ? decision.id : `d${index + 1}`,
      question: decision.question,
      answer: decision.answer,
      ...(typeof decision.recommendation === "string" ? { recommendation: decision.recommendation } : {}),
      settled: decision.settled !== false,
      at: iso(decision.at, `decisions[${index}].at`),
    })),
    sources: ((Array.isArray(record.sources) ? record.sources : []) as Record<string, any>[]).map((source, index) => ({
      url: source.url,
      ...(typeof source.title === "string" ? { title: source.title } : {}),
      claim: source.claim,
      retrievedAt: iso(source.retrievedAt, `sources[${index}].retrievedAt`),
    })),
    plan: {
      baselineHypothesis: typeof plan.baselineHypothesis === "string" ? plan.baselineHypothesis : "",
      tasks: ((Array.isArray(plan.tasks) ? plan.tasks : []) as Record<string, any>[]).map((task) => ({
        taskId: task.taskId,
        objective: task.objective,
        ...(Array.isArray(task.expectedOutputs) ? { expectedOutputs: stringList(task.expectedOutputs) } : {}),
        ...(isRecord(task.constraints) ? { constraints: task.constraints } : {}),
        ...(Array.isArray(task.evidenceRequirements) ? { evidenceRequirements: stringList(task.evidenceRequirements) } : {}),
        ...(Array.isArray(task.dependencies) ? { dependencies: stringList(task.dependencies) } : {}),
      })),
    },
    usage: {
      tokens: {
        input: typeof usageTokens.input === "number" ? usageTokens.input : 0,
        output: typeof usageTokens.output === "number" ? usageTokens.output : 0,
        total: typeof usageTokens.total === "number"
          ? usageTokens.total
          : (typeof usageTokens.input === "number" ? usageTokens.input : 0)
            + (typeof usageTokens.output === "number" ? usageTokens.output : 0),
      },
      cost: {
        total: typeof usageCost.total === "number" ? usageCost.total : 0,
        units: typeof usageCost.units === "string" ? usageCost.units : budgetUnits,
      },
    },
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt"),
  };
}

/** Deterministic, human-traceable draft id from the Research Objective. */
export function deriveMissionId(objective: string): string {
  return `m-${createHash("sha256").update(objective.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

export function missionsDir(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new TypeError(`research project root must be an absolute path: ${projectRoot}`);
  }
  return join(resolve(projectRoot), ".evok", MISSIONS_DIRNAME);
}

export function draftPath(projectRoot: string, missionId: string): string {
  return join(missionsDir(projectRoot), missionId, DRAFT_FILENAME);
}

/**
 * Persist the draft atomically (temp file + rename) and ensure the shared
 * Git exclude for generated Mission storage exists at .evok/missions/.gitignore
 * (one file covering every Mission directory; config/skills stay versionable).
 */
export async function saveMissionDraft(projectRoot: string, input: MissionDraftInput): Promise<MissionDraft> {
  const existing = await loadMissionDraft(projectRoot, input.id).catch((error) => {
    if (error instanceof MissionDraftCorruptionError) {
      if (error.missing) return undefined;
      throw error; // damaged bytes: never overwrite as a new Mission
    }
    throw error;
  });
  const draft = completeDraft({
    ...input,
    createdAt: existing?.createdAt ?? input.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const missions = missionsDir(projectRoot);
  await mkdir(join(missions, draft.id), { recursive: true });
  // Fail visibly if the Git exclude cannot be installed (ADR-0004) rather than
  // silently leaving generated Mission state committable. Write it BEFORE the
  // atomic rename so a failed exclude never leaves an exposed draft.
  await writeFile(join(missions, ".gitignore"), "# Generated Mission storage (ADR-0004); config and skills stay versionable.\n*\n", "utf8");
  const tmp = join(missions, draft.id, `${DRAFT_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, JSON.stringify(draft, null, 2), "utf8");
  await rename(tmp, join(missions, draft.id, DRAFT_FILENAME));
  return { ...draft, savedAt: Date.now() };
}

/** True only for the not-found class of draft error (safe to create). */
export function isMissingDraftError(error: unknown): boolean {
  return error instanceof MissionDraftCorruptionError && error.missing;
}

/** Reopen a draft. Missing directory is a not-found error; bad bytes are corruption. */
export async function loadMissionDraft(projectRoot: string, missionId: string): Promise<MissionDraft> {
  if (!isMissionId(missionId)) {
    throw new MissionDraftCorruptionError(`malformed mission id: ${missionId}`);
  }
  const file = draftPath(projectRoot, missionId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissionDraftCorruptionError(`mission draft not found: ${missionId} (${file})`, true);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MissionDraftCorruptionError(`draft.json for ${missionId} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new MissionDraftCorruptionError(`draft.json for ${missionId} must be a JSON object`);
  if (parsed.status !== "draft") {
    throw new MissionDraftCorruptionError(`draft.json for ${missionId} claims status ${JSON.stringify(parsed.status)}; an executing Mission cannot be reopened as a draft`);
  }
  if (parsed.schemaVersion !== MISSION_DRAFT_SCHEMA_VERSION) {
    throw new MissionDraftCorruptionError(`draft.json for ${missionId} has unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  }
  const draft = completeDraft({ ...parsed, id: missionId } as MissionDraftInput, { fromDisk: true });
  if (parsed.id !== missionId) {
    throw new MissionDraftCorruptionError(`draft.json id ${JSON.stringify(parsed.id)} does not match directory ${missionId}`);
  }
  return draft;
}
