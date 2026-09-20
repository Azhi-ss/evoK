/**
 * W1 Mission event / recovery skeleton + thin `/research` product entry
 * (ET-M1-EVT / #138).
 *
 * Authority stays in mission/: authorize / continue / repair / stop. The chat
 * transcript is not authority. Events-only / file-metric continue stays the
 * yellow-light skeleton experiment entry. After a measured suite-metric
 * baseline, one authorized continue runs the search-owned lift circle
 * (ET-RSI-LIFT): independent pass_rate + promotion hang, then a measured
 * lift or an honest kill archived under evidence/. It does not dispatch a
 * Pi Run or register Pi slash commands. When a BudgetDecision is passed
 * in, over-budget or unreserved refuses continue (ET-M1-BUD). Budget pass
 * is not Admission pass and is not Mission authorization.
 *
 * `/research` is an evoK product interface parsed by the thin CLI shell and
 * mirrored in TUI (#148). It must not intercept Pi `/model` / `/new` / `/resume`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { budgetDecisionIsPass, type BudgetDecision } from "../evidence/budget-gate";
import type { KillTestOutcome } from "../evidence/hypothesis-ledger";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  PROGRESSIVE_MCGS_OPT_IN_ID,
  SELECTION_POLICY_40,
  SELECTION_POLICY_40_OPT_IN,
  type SearchSelectionAdapterId,
  type SelectionPolicy40State,
} from "../search/search-selection-port";
import { isMissionId, missionsDir } from "./mission-draft";
import {
  circleFromLiftExperiment,
  trySuiteLiftCircle,
  type ResearchCircleVerdict,
  type ResearchLiftCircleView,
  type ResearchLiftOptions,
} from "./research-continue-lift";
import {
  loadMissionRecord,
  MissionRecordCorruptionError,
  MissionStartRejectedError,
  RESUMABLE_STATUSES,
  type ExperimentTrailEntry,
  type MissionRecord,
} from "./mission-start";

export type { ResearchCircleVerdict, ResearchLiftCircleView, ResearchLiftOptions } from "./research-continue-lift";

export type MissionControlAction = "authorize" | "continue" | "repair" | "stop";

export type MissionControlEventType =
  | "MISSION_AUTHORIZED"
  | "BASELINE_RECORDED"
  | "EXPERIMENT_ENTERED"
  | "MISSION_CONTINUED"
  | "MISSION_REPAIRED"
  | "MISSION_STOPPED";

export interface MissionControlEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: MissionControlEventType;
  readonly at: string;
  readonly missionId: string;
  readonly action?: MissionControlAction;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type ResearchVerb = "status" | "continue" | "repair" | "stop";

export interface ResearchCommand {
  readonly verb: ResearchVerb;
  readonly missionId?: string;
}

export interface ResearchAuthorization {
  readonly requested: boolean;
  readonly token: string;
  readonly missionSelector: string;
  readonly source?: "user" | "model";
}

export interface ResearchBaselineView {
  readonly runId: string;
  readonly ok: boolean;
  readonly score?: number;
  readonly at: string;
}

export type ResearchExperimentSource = "skeleton" | "mission-record" | "suite-lift";

export interface ResearchExperimentEntry {
  readonly experimentId: string;
  readonly objective: string;
  readonly source: ResearchExperimentSource;
  readonly at: string;
  readonly runId?: string;
  readonly verdict?: ResearchCircleVerdict;
  readonly measuredScore?: number;
  readonly baselineScore?: number;
  readonly liftTarget?: number;
  readonly evidencePath?: string;
  readonly promotionBlocked?: boolean;
  readonly hangOutcome?: KillTestOutcome;
  readonly selectionId?: SearchSelectionAdapterId;
  readonly selectionPolicy40?: SelectionPolicy40State;
  readonly reason?: string;
}

export type ResearchPhase = "unauthorized" | "authorized" | "baseline" | "experimenting" | "stopped";

export type ResearchRecoverySource = "events" | "mission-record" | "events+mission-record";

export interface ResearchStatusView {
  readonly missionId: string;
  readonly phase: ResearchPhase;
  readonly authorized: boolean;
  readonly objective?: string;
  readonly baseline?: ResearchBaselineView;
  readonly experiments: readonly ResearchExperimentEntry[];
  readonly lastAction?: MissionControlAction;
  readonly stopReason?: string;
  readonly recoveredFrom: ResearchRecoverySource;
  readonly circle?: ResearchLiftCircleView;
}

export interface ContinueResearchOptions {
  readonly projectRoot: string;
  readonly missionId: string;
  readonly authorization: ResearchAuthorization;
  /** Optional in-memory bootstrap written before the continue (tests / skeleton). */
  readonly seedEvents?: readonly MissionControlEvent[];
  /**
   * Optional Budget Gate decision. When present, over-budget or unreserved
   * refuses continue. Budget pass is not Admission pass and is not Mission
   * authorization.
   */
  readonly budget?: BudgetDecision;
  /**
   * Optional suite-metric lift knobs (search-owned harness). File-metric
   * and events-only Missions ignore this and stay on the skeleton path.
   */
  readonly lift?: ResearchLiftOptions;
  readonly clock?: () => string;
  readonly nextId?: () => string;
}

export class ResearchAuthorityRejectedError extends Error {
  readonly kind = "research-authority-rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "ResearchAuthorityRejectedError";
  }
}

export class ResearchContinueRejectedError extends Error {
  readonly kind = "research-continue-rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "ResearchContinueRejectedError";
  }
}

export class ResearchStatusRejectedError extends Error {
  readonly kind = "research-status-rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "ResearchStatusRejectedError";
  }
}

const CONTROL_EVENTS_FILENAME = "control-events.jsonl";
const KNOWN_EVENT_TYPES = new Set<string>([
  "MISSION_AUTHORIZED",
  "BASELINE_RECORDED",
  "EXPERIMENT_ENTERED",
  "MISSION_CONTINUED",
  "MISSION_REPAIRED",
  "MISSION_STOPPED",
]);
const RESEARCH_VERBS = new Set<ResearchVerb>(["status", "continue", "repair", "stop"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlEventsPath(projectRoot: string, missionId: string): string {
  return join(missionsDir(projectRoot), missionId, CONTROL_EVENTS_FILENAME);
}

function copy<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozenCopy<T>(value: T): T {
  return Object.freeze(copy(value)) as T;
}

function phaseOf(state: {
  authorized: boolean;
  stopped: boolean;
  baseline?: ResearchBaselineView;
  experiments: readonly ResearchExperimentEntry[];
}): ResearchPhase {
  if (state.stopped) return "stopped";
  if (state.experiments.length > 0) return "experimenting";
  if (state.baseline) return "baseline";
  if (state.authorized) return "authorized";
  return "unauthorized";
}

function asBaseline(payload: Record<string, unknown>, at: string): ResearchBaselineView | undefined {
  if (typeof payload.runId !== "string" || payload.runId === "") return undefined;
  if (typeof payload.ok !== "boolean") return undefined;
  const score = payload.score;
  return {
    runId: payload.runId,
    ok: payload.ok,
    ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
    at: typeof payload.at === "string" && payload.at !== "" ? payload.at : at,
  };
}

function asExperimentSource(value: unknown): ResearchExperimentSource | undefined {
  if (value === "mission-record" || value === "skeleton" || value === "suite-lift") return value;
  return undefined;
}

function asExperiment(payload: Record<string, unknown>, at: string): ResearchExperimentEntry | undefined {
  if (typeof payload.experimentId !== "string" || payload.experimentId === "") return undefined;
  if (typeof payload.objective !== "string" || payload.objective === "") return undefined;
  const source = asExperimentSource(payload.source);
  if (!source) return undefined;
  const hangOutcome = payload.hangOutcome;
  const verdict = payload.verdict;
  return {
    experimentId: payload.experimentId,
    objective: payload.objective,
    source,
    at: typeof payload.at === "string" && payload.at !== "" ? payload.at : at,
    ...(typeof payload.runId === "string" && payload.runId !== "" ? { runId: payload.runId } : {}),
    ...(verdict === "lifted" || verdict === "killed" ? { verdict } : {}),
    ...(typeof payload.measuredScore === "number" && Number.isFinite(payload.measuredScore)
      ? { measuredScore: payload.measuredScore }
      : {}),
    ...(typeof payload.baselineScore === "number" && Number.isFinite(payload.baselineScore)
      ? { baselineScore: payload.baselineScore }
      : {}),
    ...(typeof payload.liftTarget === "number" && Number.isFinite(payload.liftTarget)
      ? { liftTarget: payload.liftTarget }
      : {}),
    ...(typeof payload.evidencePath === "string" && payload.evidencePath !== ""
      ? { evidencePath: payload.evidencePath }
      : {}),
    ...(typeof payload.promotionBlocked === "boolean" ? { promotionBlocked: payload.promotionBlocked } : {}),
    ...(hangOutcome === "pass" || hangOutcome === "fail" || hangOutcome === "inconclusive"
      ? { hangOutcome }
      : {}),
    ...(payload.selectionId === DEFAULT_SEARCH_SELECTION_ID || payload.selectionId === PROGRESSIVE_MCGS_OPT_IN_ID
      ? { selectionId: payload.selectionId }
      : {}),
    ...(payload.selectionPolicy40 === SELECTION_POLICY_40 || payload.selectionPolicy40 === SELECTION_POLICY_40_OPT_IN
      ? { selectionPolicy40: payload.selectionPolicy40 }
      : {}),
    ...(typeof payload.reason === "string" && payload.reason !== "" ? { reason: payload.reason } : {}),
  };
}

function attachCircle(view: ResearchStatusView): ResearchStatusView {
  if (view.circle) return view;
  for (let index = view.experiments.length - 1; index >= 0; index -= 1) {
    const circle = circleFromLiftExperiment(view.experiments[index]!);
    if (circle) return frozenCopy({ ...view, circle });
  }
  return view;
}

/**
 * Project a Research status view from durable control events. Unknown or
 * duplicate events are skipped; a chat-shaped payload never authorizes.
 */
export function recoverResearchStatus(
  events: readonly MissionControlEvent[],
  missionId = events.find((event) => typeof event?.missionId === "string" && event.missionId !== "")?.missionId ?? "",
): ResearchStatusView {
  const seen = new Set<string>();
  let authorized = false;
  let stopped = false;
  let objective: string | undefined;
  let baseline: ResearchBaselineView | undefined;
  let lastAction: MissionControlAction | undefined;
  let stopReason: string | undefined;
  const experiments: ResearchExperimentEntry[] = [];

  for (const raw of events) {
    if (!isRecord(raw)) continue;
    const eventId = raw.eventId;
    if (typeof eventId !== "string" || eventId === "" || seen.has(eventId)) continue;
    seen.add(eventId);
    if (typeof raw.missionId === "string" && raw.missionId !== "" && raw.missionId !== missionId) continue;
    if (!KNOWN_EVENT_TYPES.has(raw.type)) continue;
    const payload = isRecord(raw.payload) ? raw.payload : {};
    const at = typeof raw.at === "string" ? raw.at : "";
    const action = raw.action;

    switch (raw.type) {
      case "MISSION_AUTHORIZED": {
        authorized = true;
        if (typeof payload.objective === "string" && payload.objective !== "") objective = payload.objective;
        if (action === "authorize") lastAction = "authorize";
        break;
      }
      case "BASELINE_RECORDED": {
        if (!authorized || stopped) break;
        const next = asBaseline(payload, at);
        if (next) baseline = next;
        break;
      }
      case "EXPERIMENT_ENTERED": {
        if (!authorized || stopped || !baseline) break;
        const next = asExperiment(payload, at);
        if (next) experiments.push(next);
        break;
      }
      case "MISSION_CONTINUED": {
        if (!authorized || stopped) break;
        lastAction = "continue";
        break;
      }
      case "MISSION_REPAIRED": {
        if (!authorized || stopped) break;
        lastAction = "repair";
        break;
      }
      case "MISSION_STOPPED": {
        if (!authorized) break;
        stopped = true;
        lastAction = "stop";
        if (typeof payload.reason === "string" && payload.reason !== "") stopReason = payload.reason;
        break;
      }
      default:
        break;
    }
  }

  return attachCircle(frozenCopy({
    missionId,
    phase: phaseOf({ authorized, stopped, baseline, experiments }),
    authorized,
    ...(objective ? { objective } : {}),
    ...(baseline ? { baseline } : {}),
    experiments: Object.freeze([...experiments]),
    ...(lastAction ? { lastAction } : {}),
    ...(stopReason ? { stopReason } : {}),
    recoveredFrom: "events",
  }));
}

function hydrateBaseline(record: MissionRecord): ResearchBaselineView | undefined {
  const baseline = record.baseline;
  if (!baseline || typeof baseline.runId !== "string" || baseline.runId === "") return undefined;
  const ok = baseline.evaluation?.ok;
  if (typeof ok !== "boolean") return undefined;
  const score = baseline.evaluation?.score;
  return {
    runId: baseline.runId,
    ok,
    ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
    at: typeof baseline.measuredAt === "string" ? baseline.measuredAt : record.updatedAt,
  };
}

function hydrateExperiments(record: MissionRecord): readonly ResearchExperimentEntry[] {
  const trail = record.experiments ?? [];
  return trail.flatMap((entry: ExperimentTrailEntry): ResearchExperimentEntry[] => {
    if (typeof entry.runId !== "string" || entry.runId === "") return [];
    if (typeof entry.taskObjective !== "string" || entry.taskObjective === "") return [];
    return [{
      experimentId: entry.runId,
      objective: entry.taskObjective,
      source: "mission-record",
      at: typeof entry.at === "string" ? entry.at : record.updatedAt,
      runId: entry.runId,
    }];
  });
}

function mergeRecord(view: ResearchStatusView, record: MissionRecord | undefined): ResearchStatusView {
  if (!record) return view;
  const eventsProjected = view.authorized || view.baseline !== undefined || view.experiments.length > 0;
  const recordStopped = !RESUMABLE_STATUSES.has(record.status);
  const authorized = true;
  const objective = view.objective ?? record.objective;
  const baseline = view.baseline ?? hydrateBaseline(record);
  const experiments = view.experiments.length > 0 ? view.experiments : hydrateExperiments(record);
  const filledFromRecord = view.objective === undefined && objective === record.objective
    || view.baseline === undefined && baseline !== undefined
    || view.experiments.length === 0 && experiments.length > 0;
  const recoveredFrom: ResearchRecoverySource = eventsProjected
    ? (filledFromRecord ? "events+mission-record" : "events")
    : "mission-record";
  const stopped = view.phase === "stopped" || recordStopped;
  const stopReason = view.stopReason ?? record.stopReason;
  return attachCircle(frozenCopy({
    missionId: view.missionId || record.id,
    phase: phaseOf({ authorized, stopped, baseline, experiments }),
    authorized,
    ...(objective ? { objective } : {}),
    ...(baseline ? { baseline } : {}),
    experiments: Object.freeze([...experiments]),
    ...(stopped ? { lastAction: view.lastAction ?? "stop" } : view.lastAction ? { lastAction: view.lastAction } : {}),
    ...(stopReason ? { stopReason } : {}),
    recoveredFrom,
    ...(view.circle ? { circle: view.circle } : {}),
  }));
}

/**
 * `/research` is an evoK product command. Pi native slashes (`/model`, `/new`)
 * and Mission `/start` `/resume` stay on their own seams.
 */
export function parseResearchCommand(text: string): ResearchCommand | undefined {
  const trimmed = text.trim();
  const match = /^\/research(?:\s+(status|continue|repair|stop))?(?:\s+(\S+))?\s*$/i.exec(trimmed);
  if (!match) return undefined;
  const verb = (match[1]?.toLowerCase() ?? "status") as ResearchVerb;
  if (!RESEARCH_VERBS.has(verb)) return undefined;
  const rawId = match[2];
  if (rawId !== undefined) {
    if (!isMissionId(rawId)) return undefined;
    return { verb, missionId: rawId };
  }
  return { verb };
}

export function isExplicitResearchContinue(text: string): boolean {
  return parseResearchCommand(text)?.verb === "continue";
}

async function readEventLog(projectRoot: string, missionId: string): Promise<MissionControlEvent[]> {
  let raw: string;
  try {
    raw = await readFile(controlEventsPath(projectRoot, missionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: MissionControlEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (typeof parsed.eventId !== "string" || typeof parsed.type !== "string") continue;
    if (typeof parsed.sequence !== "number" || !Number.isSafeInteger(parsed.sequence)) continue;
    events.push(parsed as unknown as MissionControlEvent);
  }
  return events;
}

async function writeEventLog(projectRoot: string, missionId: string, events: readonly MissionControlEvent[]): Promise<void> {
  const dir = join(missionsDir(projectRoot), missionId);
  await mkdir(dir, { recursive: true });
  const file = controlEventsPath(projectRoot, missionId);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  await writeFile(tmp, body, "utf8");
  await rename(tmp, file);
}

async function loadOptionalRecord(projectRoot: string, missionId: string): Promise<MissionRecord | undefined> {
  try {
    return await loadMissionRecord(projectRoot, missionId);
  } catch (error) {
    if (error instanceof MissionStartRejectedError) return undefined;
    if (error instanceof MissionRecordCorruptionError) throw error;
    throw error;
  }
}

function appendUnique(existing: MissionControlEvent[], incoming: readonly MissionControlEvent[]): MissionControlEvent[] {
  const seen = new Set(existing.map((event) => event.eventId));
  const next = [...existing];
  for (const event of incoming) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    next.push(event);
  }
  return next;
}

function projectView(
  events: readonly MissionControlEvent[],
  record: MissionRecord | undefined,
  missionId: string,
): ResearchStatusView {
  const fromEvents = recoverResearchStatus(events, missionId);
  return record ? mergeRecord(fromEvents, record) : fromEvents;
}

function nextSequence(events: readonly MissionControlEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0);
}

/** Persist implied authorize/baseline so a later replay does not need the record. */
function authorityEventsFromView(
  events: readonly MissionControlEvent[],
  view: ResearchStatusView,
  missionId: string,
  at: string,
): MissionControlEvent[] {
  const types = new Set(events.map((event) => event.type));
  const extra: MissionControlEvent[] = [];
  let sequence = nextSequence(events);
  if (!types.has("MISSION_AUTHORIZED")) {
    extra.push({
      eventId: `authorize-${missionId}`,
      sequence: ++sequence,
      type: "MISSION_AUTHORIZED",
      at: view.baseline?.at ?? at,
      missionId,
      action: "authorize",
      payload: { ...(view.objective ? { objective: view.objective } : {}), source: "mission-record" },
    });
  }
  if (!types.has("BASELINE_RECORDED") && view.baseline) {
    extra.push({
      eventId: `baseline-${view.baseline.runId}`,
      sequence: ++sequence,
      type: "BASELINE_RECORDED",
      at: view.baseline.at,
      missionId,
      payload: {
        runId: view.baseline.runId,
        ok: view.baseline.ok,
        ...(view.baseline.score !== undefined ? { score: view.baseline.score } : {}),
        source: "mission-record",
      },
    });
  }
  return extra;
}

async function projectFromDisk(projectRoot: string, missionId: string): Promise<{
  view: ResearchStatusView;
  events: MissionControlEvent[];
  record: MissionRecord | undefined;
}> {
  if (!isMissionId(missionId)) {
    throw new ResearchStatusRejectedError(`malformed mission id: ${missionId}`);
  }
  const events = await readEventLog(projectRoot, missionId);
  const record = await loadOptionalRecord(projectRoot, missionId);
  const view = projectView(events, record, missionId);
  if (!record && events.length === 0) {
    throw new ResearchStatusRejectedError(`mission ${missionId} has no research events or accepted Mission record`);
  }
  return { view, events, record };
}

export async function readResearchStatus(projectRoot: string, missionId: string): Promise<ResearchStatusView> {
  return (await projectFromDisk(projectRoot, missionId)).view;
}

function assertContinueAuthorization(auth: ResearchAuthorization, missionId: string): void {
  if (auth.source === "model") {
    throw new ResearchAuthorityRejectedError("research continue must come from the user; a model-authored approval cannot continue a Mission");
  }
  if (!auth.requested || !isExplicitResearchContinue(auth.token)) {
    throw new ResearchAuthorityRejectedError("research continue intent is ambiguous or absent; chatting about research does not continue a Mission");
  }
  if (auth.missionSelector !== "displayed" && auth.missionSelector !== missionId) {
    throw new ResearchAuthorityRejectedError(`research continue targets mission ${auth.missionSelector} but the displayed mission is ${missionId}`);
  }
}

export async function continueResearch(options: ContinueResearchOptions): Promise<ResearchStatusView> {
  const { projectRoot, missionId } = options;
  if (!isMissionId(missionId)) {
    throw new ResearchContinueRejectedError(`malformed mission id: ${missionId}`);
  }
  let events = await readEventLog(projectRoot, missionId);
  if (options.seedEvents && options.seedEvents.length > 0) {
    events = appendUnique(events, options.seedEvents);
    await writeEventLog(projectRoot, missionId, events);
  }
  assertContinueAuthorization(options.authorization, missionId);
  if (options.budget !== undefined && !budgetDecisionIsPass(options.budget, "continue")) {
    throw new ResearchContinueRejectedError(
      options.budget.objections[0] ?? `mission ${missionId} budget refused continue`,
    );
  }
  const record = await loadOptionalRecord(projectRoot, missionId);
  const view = projectView(events, record, missionId);
  if (!view.authorized) {
    throw new ResearchContinueRejectedError(`mission ${missionId} is not authorized; /research continue cannot originate authority`);
  }
  if (view.phase === "stopped") {
    throw new ResearchContinueRejectedError(`mission ${missionId} is stopped; /research continue is refused`);
  }
  if (!view.baseline) {
    throw new ResearchContinueRejectedError(`mission ${missionId} has no baseline; /research continue waits for a recorded baseline`);
  }

  const at = (options.clock ?? (() => new Date().toISOString()))();
  const experimentId = (options.nextId ?? (() => `exp-${events.length + 1}`))();
  const circle = await trySuiteLiftCircle({
    projectRoot,
    missionId,
    experimentId,
    at,
    objective: view.objective,
    baseline: view.baseline,
    ...(options.lift ? { lift: options.lift } : {}),
  });
  events = appendUnique(events, authorityEventsFromView(events, view, missionId, at));
  const sequence = nextSequence(events);
  const continued: MissionControlEvent = {
    eventId: `continue-${at}`,
    sequence: sequence + 1,
    type: "MISSION_CONTINUED",
    at,
    missionId,
    action: "continue",
    payload: {},
  };
  const entered: MissionControlEvent = {
    eventId: `experiment-${experimentId}`,
    sequence: sequence + 2,
    type: "EXPERIMENT_ENTERED",
    at,
    missionId,
    payload: circle
      ? {
        experimentId,
        objective: view.objective ?? missionId,
        source: "suite-lift",
        runId: experimentId,
        verdict: circle.verdict,
        measuredScore: circle.measuredScore,
        baselineScore: circle.baselineScore,
        liftTarget: circle.liftTarget,
        evidencePath: circle.evidencePath,
        promotionBlocked: circle.promotionBlocked,
        hangOutcome: circle.hangOutcome,
        selectionId: circle.selectionId,
        selectionPolicy40: circle.selectionPolicy40,
        reason: circle.reason,
      }
      : {
        experimentId,
        objective: view.objective ?? missionId,
        source: "skeleton",
      },
  };
  events = appendUnique(events, [continued, entered]);
  await writeEventLog(projectRoot, missionId, events);
  return projectView(events, record, missionId);
}

export function formatResearchStatus(view: ResearchStatusView): string {
  const lines = [
    `-- research ${view.missionId} · phase ${view.phase} · authorized=${view.authorized}`,
  ];
  if (view.objective) lines.push(`   objective: ${view.objective}`);
  if (view.stopReason) lines.push(`   stop reason: ${view.stopReason}`);
  if (view.lastAction) lines.push(`   last action: ${view.lastAction}`);
  if (view.baseline) {
    const score = typeof view.baseline.score === "number" ? ` score=${view.baseline.score}` : "";
    lines.push(`   baseline: ${view.baseline.runId} ok=${view.baseline.ok}${score}`);
  } else {
    lines.push("   baseline: (none yet)");
  }
  lines.push(`   experiments: ${view.experiments.length}`);
  for (const experiment of view.experiments) {
    lines.push(`     - ${experiment.experimentId} [${experiment.source}] ${experiment.objective}`);
  }
  if (view.circle) {
    const baseline = typeof view.circle.baselineScore === "number" ? String(view.circle.baselineScore) : "?";
    const measured = typeof view.circle.measuredScore === "number" ? String(view.circle.measuredScore) : "?";
    lines.push(`   circle: suite-lift verdict ${view.circle.verdict} pass_rate baseline=${baseline} measured=${measured} target=${view.circle.liftTarget}`);
    lines.push(`   promotion hang: outcome=${view.circle.hangOutcome} blocked=${view.circle.promotionBlocked}`);
    lines.push(`   evidence: ${view.circle.evidencePath}`);
    lines.push(`   selection: ${view.circle.selectionId} (#40 ${view.circle.selectionPolicy40})`);
    lines.push(`   submit: frozen — true External Submission is not authorized`);
  }
  lines.push(`   recovered from: ${view.recoveredFrom} (chat transcript is not authority)`);
  return `${lines.join("\n")}\n`;
}

export async function resolveResearchMissionId(projectRoot: string, requested?: string): Promise<string> {
  if (requested) {
    if (!isMissionId(requested)) throw new ResearchStatusRejectedError(`malformed mission id: ${requested}`);
    return requested;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(missionsDir(projectRoot), { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const ids = entries.filter((entry) => entry.isDirectory() && isMissionId(entry.name)).map((entry) => entry.name);
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) {
    throw new ResearchStatusRejectedError("no Mission in this project; /research needs --mission <id> or a single saved Mission");
  }
  throw new ResearchStatusRejectedError("multiple Missions in this project; pass --mission <id> or `/research status <id>`");
}
