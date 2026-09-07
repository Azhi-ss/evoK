/**
 * In-memory Hypothesis / KillTest ledger (H1 schema + H2 write/projection).
 *
 * Deepens the existing T48 evidence catalog (`EvidenceMemory`,
 * `MissionDirector` artifacts) instead of a second mission store.
 * Writes append events; `projectHypothesisLedger` / `replay` fold the log.
 * Expand is ledger-only (optional Campaign·Task enqueue) and has no
 * UCT / SelectionPolicy / search-node write path. Kill-test `fail`
 * may auto-`killed`; `pass` / `inconclusive` never auto-kill.
 * Durable sqlite, K2 hang points, and S* param-space/MMD are out of scope.
 */
import { deepFreeze } from "./security-boundary";
import {
  EvidenceMemory,
  type MissionDirector,
  type ResearchTask,
} from "./research-loop";

export type HypothesisStatus = "open" | "supported" | "killed" | "superseded";
export type KillTestOutcome = "pass" | "fail" | "inconclusive";

export type HypothesisEventType =
  | "hypothesis.created"
  | "hypothesis.status_changed"
  | "hypothesis.expand_requested"
  | "kill_test.planned"
  | "kill_test.finished";

export interface HypothesisEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly type: HypothesisEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface HypothesisLedgerStore {
  append(event: Omit<HypothesisEvent, "sequence" | "eventId"> & { readonly sequence?: number; readonly eventId?: string }): HypothesisEvent;
  events(): readonly HypothesisEvent[];
}

const HYPOTHESIS_EVENT_TYPES: ReadonlySet<HypothesisEventType> = new Set([
  "hypothesis.created",
  "hypothesis.status_changed",
  "hypothesis.expand_requested",
  "kill_test.planned",
  "kill_test.finished",
]);

const HYPOTHESIS_STATUSES: ReadonlySet<HypothesisStatus> = new Set(["open", "supported", "killed", "superseded"]);
const KILL_TEST_OUTCOMES: ReadonlySet<KillTestOutcome> = new Set(["pass", "fail", "inconclusive"]);
const SCORE_KEY_FIELDS = ["mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score"] as const;

export type T48RefKind = "evidence" | "artifact";

declare const t48EvidenceBrand: unique symbol;
declare const t48ArtifactBrand: unique symbol;

export type T48EvidenceId = string & { readonly [t48EvidenceBrand]: "evidence" };
export type T48ArtifactId = string & { readonly [t48ArtifactBrand]: "artifact" };

/** T48-mapped Evidence or Artifact id. Raw side-slot / MMD scores are not this type. */
export interface T48MappedRef {
  readonly kind: T48RefKind;
  readonly id: T48EvidenceId | T48ArtifactId;
}

export interface CampaignTask {
  readonly campaignId: string;
  readonly task: ResearchTask;
}

export interface Hypothesis {
  readonly hypothesisId: string;
  readonly statement: string;
  readonly status: HypothesisStatus;
  readonly evidenceRefs: readonly T48MappedRef[];
  readonly killTestPlanIds: readonly string[];
  readonly supersededBy?: string;
}

export interface KillTestPlan {
  readonly planId: string;
  readonly hypothesisId: string;
  readonly predicate: string;
  readonly evidenceRefs: readonly T48MappedRef[];
}

export interface KillTestResult {
  readonly resultId: string;
  readonly planId: string;
  readonly hypothesisId: string;
  readonly outcome: KillTestOutcome;
  readonly evidenceRefs: readonly T48MappedRef[];
}

export interface SearchNode {
  readonly nodeId: string;
}

export interface QueuedCampaignTask {
  readonly hypothesisId: string;
  readonly task: CampaignTask;
}

export interface HypothesisLedgerState {
  readonly hypotheses: Readonly<Record<string, Hypothesis>>;
  readonly plans: Readonly<Record<string, KillTestPlan>>;
  readonly results: Readonly<Record<string, KillTestResult>>;
  readonly queuedCampaignTasks: readonly CampaignTask[];
  readonly expandQueue: readonly QueuedCampaignTask[];
  /** Write-log order as projected from the event stream. */
  readonly eventOrder: readonly HypothesisEventType[];
  /** Always empty: this ledger never writes search nodes. */
  readonly searchNodes: readonly SearchNode[];
}

export interface HypothesisLedgerOptions {
  readonly catalog: T48MappedCatalog;
  readonly clock?: () => number;
}

export interface CreateHypothesisInput {
  readonly hypothesisId?: string;
  readonly statement: string;
  readonly evidenceRefs?: readonly unknown[];
  readonly operationId?: string;
}

export interface PlanKillTestInput {
  readonly planId?: string;
  readonly hypothesisId: string;
  readonly predicate: string;
  readonly evidenceRefs?: readonly unknown[];
  readonly operationId?: string;
}

export interface FinishKillTestInput {
  readonly resultId?: string;
  readonly planId: string;
  readonly outcome: KillTestOutcome;
  readonly evidenceRefs: readonly unknown[];
  readonly operationId?: string;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function frozenArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze(values.map((value) => deepFreeze(clone(value)))) as readonly T[];
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNumericString(value: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

function looksLikeScoreKey(value: unknown): boolean {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string" && isNumericString(value)) return true;
  if (!isPlainRecord(value)) return false;
  return SCORE_KEY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function brandEvidence(id: string): T48EvidenceId {
  return id as T48EvidenceId;
}

function brandArtifact(id: string): T48ArtifactId {
  return id as T48ArtifactId;
}

function freezeRef(kind: T48RefKind, id: string): T48MappedRef {
  return deepFreeze({
    kind,
    id: kind === "evidence" ? brandEvidence(id) : brandArtifact(id),
  }) as T48MappedRef;
}

export function killTestOutcomeIsPass(outcome: KillTestOutcome): outcome is "pass" {
  return outcome === "pass";
}

/** Narrow a kill-test outcome to pass. Inconclusive and fail are never pass. */
export function asKillTestPass(outcome: KillTestOutcome): "pass" {
  if (outcome === "inconclusive") throw new TypeError("inconclusive kill-test outcome is not pass");
  if (outcome !== "pass") throw new TypeError("kill-test outcome is not pass");
  return outcome;
}

/**
 * Spec #50/#52 hang-point default: fail may kill the hypothesis.
 * Pass and inconclusive must not auto-kill (pass may later become supported).
 */
export function killTestOutcomeKillsHypothesis(outcome: KillTestOutcome): boolean {
  return outcome === "fail";
}

/** A replaceable in-memory log. Durable sqlite is out of scope for H1. */
export class InMemoryHypothesisLedger implements HypothesisLedgerStore {
  private readonly entries: HypothesisEvent[] = [];

  append(event: Omit<HypothesisEvent, "sequence" | "eventId"> & { readonly sequence?: number; readonly eventId?: string }): HypothesisEvent {
    if (!HYPOTHESIS_EVENT_TYPES.has(event.type)) throw new RangeError(`unknown hypothesis event type: ${String(event.type)}`);
    const sequence = event.sequence ?? this.entries.length + 1;
    if (sequence !== this.entries.length + 1) throw new Error("hypothesis event sequence must be monotonic");
    const eventId = event.eventId ?? `hypothesis-event-${sequence}`;
    nonEmpty("eventId", eventId);
    if (this.entries.some((entry) => entry.eventId === eventId)) throw new Error(`duplicate hypothesis eventId: ${eventId}`);
    const entry = deepFreeze({ sequence, eventId, type: event.type, payload: deepFreeze(clone(event.payload)) }) as HypothesisEvent;
    this.entries.push(entry);
    return entry;
  }

  events(): readonly HypothesisEvent[] { return frozenArray(this.entries); }
}

/**
 * Promotion keys are Evidence / Artifact ids already present in the T48
 * (research / methodology) catalog. Side-slot and MMD scalars never qualify.
 */
export class T48MappedCatalog {
  private readonly evidence = new Set<string>();
  private readonly artifacts = new Set<string>();

  static fromMemory(memory: EvidenceMemory, artifacts: readonly { readonly artifactId: string }[] = []): T48MappedCatalog {
    const catalog = new T48MappedCatalog();
    for (const record of memory.records()) {
      if (record.verified === false) continue;
      catalog.evidence.add(record.id);
    }
    for (const artifact of artifacts) {
      nonEmpty("artifactId", artifact.artifactId);
      catalog.artifacts.add(artifact.artifactId);
    }
    return catalog;
  }

  static fromMission(director: Pick<MissionDirector, "evidenceMemory" | "state">): T48MappedCatalog {
    return T48MappedCatalog.fromMemory(director.evidenceMemory(), director.state().artifacts);
  }

  has(id: string): boolean {
    return this.evidence.has(id) || this.artifacts.has(id);
  }

  map(value: unknown): T48MappedRef {
    if (looksLikeScoreKey(value)) {
      throw new TypeError("side-slot/MMD scalar scores cannot be T48 promotion keys");
    }
    if (typeof value === "string") {
      nonEmpty("evidence_refs id", value);
      if (this.evidence.has(value)) return freezeRef("evidence", value);
      if (this.artifacts.has(value)) return freezeRef("artifact", value);
      throw new Error(`unknown T48-mapped evidence or artifact id: ${value}`);
    }
    if (!isPlainRecord(value)) throw new TypeError("evidence_refs must be T48-mapped Evidence or Artifact ids");
    const kind = value.kind;
    const id = typeof value.id === "string" ? value.id : typeof value.artifactId === "string" ? value.artifactId : typeof value.evidenceId === "string" ? value.evidenceId : undefined;
    if (id === undefined) throw new TypeError("evidence_refs must be T48-mapped Evidence or Artifact ids");
    nonEmpty("evidence_refs id", id);
    if (kind === "evidence" || this.evidence.has(id) && kind !== "artifact") {
      if (!this.evidence.has(id)) throw new Error(`unknown T48-mapped evidence id: ${id}`);
      return freezeRef("evidence", id);
    }
    if (kind === "artifact" || this.artifacts.has(id)) {
      if (!this.artifacts.has(id)) throw new Error(`unknown T48-mapped artifact id: ${id}`);
      return freezeRef("artifact", id);
    }
    throw new Error(`unknown T48-mapped evidence or artifact id: ${id}`);
  }

  mapAll(values: readonly unknown[] | undefined): readonly T48MappedRef[] {
    if (values === undefined) return Object.freeze([]);
    if (!Array.isArray(values)) throw new TypeError("evidence_refs must be an array");
    const mapped = values.map((value) => this.map(value));
    const seen = new Set<string>();
    for (const ref of mapped) {
      const key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) throw new TypeError("evidence_refs must be unique");
      seen.add(key);
    }
    return frozenArray(mapped);
  }
}

function normalizeCampaignTask(value: CampaignTask): CampaignTask {
  if (!isPlainRecord(value) || !isPlainRecord(value.task)) throw new TypeError("campaign task must be an ordinary object");
  nonEmpty("campaignId", value.campaignId);
  nonEmpty("task.taskId", value.task.taskId);
  nonEmpty("task.objective", value.task.objective);
  const estimatedCost = value.task.estimatedCost;
  if (estimatedCost !== undefined && (typeof estimatedCost !== "number" || !Number.isFinite(estimatedCost) || estimatedCost <= 0)) {
    throw new RangeError("task estimatedCost must be finite and > 0");
  }
  return deepFreeze({
    campaignId: value.campaignId,
    task: {
      taskId: value.task.taskId,
      objective: value.task.objective,
      ...(estimatedCost === undefined ? {} : { estimatedCost }),
    },
  }) as CampaignTask;
}

function normalizeStatus(value: unknown): HypothesisStatus {
  if (typeof value !== "string" || !HYPOTHESIS_STATUSES.has(value as HypothesisStatus)) {
    throw new RangeError(`unknown hypothesis status: ${String(value)}`);
  }
  return value as HypothesisStatus;
}

function normalizeOutcome(value: unknown): KillTestOutcome {
  if (typeof value !== "string" || !KILL_TEST_OUTCOMES.has(value as KillTestOutcome)) {
    throw new RangeError(`unknown kill-test outcome: ${String(value)}`);
  }
  return value as KillTestOutcome;
}

interface MutableHypothesisState {
  hypotheses: Map<string, Hypothesis>;
  plans: Map<string, KillTestPlan>;
  results: Map<string, KillTestResult>;
  queued: QueuedCampaignTask[];
  operations: Map<string, { type: HypothesisEventType; payload: Readonly<Record<string, unknown>> }>;
}

function emptyState(): MutableHypothesisState {
  return { hypotheses: new Map(), plans: new Map(), results: new Map(), queued: [], operations: new Map() };
}

function publicState(state: MutableHypothesisState, events: readonly HypothesisEvent[]): HypothesisLedgerState {
  return deepFreeze({
    hypotheses: Object.fromEntries(state.hypotheses),
    plans: Object.fromEntries(state.plans),
    results: Object.fromEntries(state.results),
    queuedCampaignTasks: frozenArray(state.queued.map((entry) => entry.task)),
    expandQueue: frozenArray(state.queued),
    eventOrder: Object.freeze(events.map((event) => event.type)),
    searchNodes: Object.freeze([]),
  }) as HypothesisLedgerState;
}

function knownOperation(state: MutableHypothesisState, event: HypothesisEvent): boolean {
  const operationId = event.payload.operationId;
  if (typeof operationId !== "string" || operationId.trim() === "") return false;
  const existing = state.operations.get(operationId);
  if (!existing) {
    state.operations.set(operationId, { type: event.type, payload: event.payload });
    return false;
  }
  if (existing.type !== event.type || !same(existing.payload, event.payload)) {
    throw new Error(`operationId already contains a different hypothesis operation: ${operationId}`);
  }
  return true;
}

function applyEvent(state: MutableHypothesisState, event: HypothesisEvent): void {
  if (!isPlainRecord(event.payload)) return;
  if (knownOperation(state, event)) return;
  const p = event.payload;
  switch (event.type) {
    case "hypothesis.created": {
      const hypothesis = p.hypothesis as Hypothesis;
      if (state.hypotheses.has(hypothesis.hypothesisId)) throw new Error(`hypothesis already exists: ${hypothesis.hypothesisId}`);
      state.hypotheses.set(hypothesis.hypothesisId, deepFreeze({ ...hypothesis, killTestPlanIds: [...hypothesis.killTestPlanIds] }) as Hypothesis);
      return;
    }
    case "hypothesis.status_changed": {
      const hypothesisId = p.hypothesisId as string;
      const current = state.hypotheses.get(hypothesisId);
      if (!current) throw new Error(`unknown hypothesis: ${hypothesisId}`);
      const status = normalizeStatus(p.status);
      const supersededBy = typeof p.supersededBy === "string" ? p.supersededBy : current.supersededBy;
      state.hypotheses.set(hypothesisId, deepFreeze({
        ...current,
        status,
        ...(supersededBy === undefined ? {} : { supersededBy }),
      }) as Hypothesis);
      return;
    }
    case "hypothesis.expand_requested": {
      const hypothesisId = p.hypothesisId as string;
      if (!state.hypotheses.has(hypothesisId)) throw new Error(`unknown hypothesis: ${hypothesisId}`);
      if (p.enqueue !== undefined) {
        state.queued.push(deepFreeze({
          hypothesisId,
          task: normalizeCampaignTask(p.enqueue as CampaignTask),
        }) as QueuedCampaignTask);
      }
      return;
    }
    case "kill_test.planned": {
      const plan = p.plan as KillTestPlan;
      if (!state.hypotheses.has(plan.hypothesisId)) throw new Error(`unknown hypothesis: ${plan.hypothesisId}`);
      if (state.plans.has(plan.planId)) throw new Error(`kill-test plan already exists: ${plan.planId}`);
      state.plans.set(plan.planId, deepFreeze(plan) as KillTestPlan);
      const hypothesis = state.hypotheses.get(plan.hypothesisId)!;
      state.hypotheses.set(plan.hypothesisId, deepFreeze({
        ...hypothesis,
        killTestPlanIds: [...hypothesis.killTestPlanIds, plan.planId],
      }) as Hypothesis);
      return;
    }
    case "kill_test.finished": {
      const result = p.result as KillTestResult;
      if (!state.plans.has(result.planId)) throw new Error(`unknown kill-test plan: ${result.planId}`);
      if (state.results.has(result.resultId)) throw new Error(`kill-test result already exists: ${result.resultId}`);
      if ([...state.results.values()].some((entry) => entry.planId === result.planId)) {
        throw new Error(`kill-test plan already has a result: ${result.planId}`);
      }
      state.results.set(result.resultId, deepFreeze(result) as KillTestResult);
      return;
    }
  }
}

function project(events: readonly HypothesisEvent[]): MutableHypothesisState {
  const state = emptyState();
  let expected = 1;
  const seen = new Set<string>();
  for (const event of events) {
    if (event.sequence !== expected) throw new Error(`hypothesis ledger sequence gap at ${expected}`);
    if (seen.has(event.eventId)) throw new Error(`hypothesis ledger repeats eventId: ${event.eventId}`);
    seen.add(event.eventId);
    applyEvent(state, event);
    expected += 1;
  }
  return state;
}

/** Fold an append-only write log. Expand never contributes search nodes. */
export function projectHypothesisLedger(events: readonly HypothesisEvent[]): HypothesisLedgerState {
  return publicState(project(events), events);
}

export class HypothesisLedger {
  readonly store: HypothesisLedgerStore;
  private readonly catalog: T48MappedCatalog;
  private readonly clock: () => number;
  private nextOperation = 1;

  constructor(options: HypothesisLedgerOptions, store: HypothesisLedgerStore = new InMemoryHypothesisLedger()) {
    this.catalog = options.catalog;
    this.clock = options.clock ?? (() => Date.now());
    this.store = store;
  }

  static replay(events: readonly HypothesisEvent[]): HypothesisLedgerState {
    return projectHypothesisLedger(events);
  }

  static fromEvents(options: HypothesisLedgerOptions, events: readonly HypothesisEvent[]): HypothesisLedger {
    const store = new InMemoryHypothesisLedger();
    for (const event of events) {
      store.append({ sequence: event.sequence, type: event.type, payload: clone(event.payload), eventId: event.eventId });
    }
    return new HypothesisLedger(options, store);
  }

  private operation(prefix: string, supplied?: string): string {
    if (supplied !== undefined) { nonEmpty("operationId", supplied); return supplied; }
    let operation: string;
    do operation = `${prefix}-${this.nextOperation++}`;
    while (this.store.events().some((event) => event.payload.operationId === operation));
    return operation;
  }

  private operationEvent(operationId: string | undefined): HypothesisEvent | undefined {
    if (operationId === undefined) return undefined;
    nonEmpty("operationId", operationId);
    return this.store.events().find((event) => event.payload.operationId === operationId);
  }

  private append(type: HypothesisEventType, payload: Record<string, unknown>, operationId: string): boolean {
    const expectedPayload = { ...payload, operationId };
    const existing = this.operationEvent(operationId);
    if (existing) {
      if (existing.type !== type || !same(existing.payload, expectedPayload)) {
        throw new Error(`operationId already contains a different hypothesis operation: ${operationId}`);
      }
      return false;
    }
    this.store.append({ type, payload: expectedPayload });
    return true;
  }

  events(): readonly HypothesisEvent[] { return this.store.events(); }
  state(): HypothesisLedgerState { return projectHypothesisLedger(this.store.events()); }

  plansFor(hypothesisId: string): readonly KillTestPlan[] {
    return frozenArray(this.state().hypotheses[hypothesisId]?.killTestPlanIds.map((id) => this.state().plans[id]!).filter(Boolean) ?? []);
  }

  resultFor(planId: string): KillTestResult | undefined {
    return Object.values(this.state().results).find((result) => result.planId === planId);
  }

  queuedCampaignTasks(): readonly CampaignTask[] { return this.state().queuedCampaignTasks; }

  campaignTasksFor(hypothesisId: string): readonly CampaignTask[] {
    return frozenArray(
      this.state().expandQueue
        .filter((entry) => entry.hypothesisId === hypothesisId)
        .map((entry) => entry.task),
    );
  }

  /** Expand never writes search nodes; this projection stays empty. */
  searchNodes(): readonly SearchNode[] { return this.state().searchNodes; }

  createHypothesis(input: CreateHypothesisInput): Hypothesis {
    nonEmpty("hypothesis statement", input.statement);
    const evidenceRefs = this.catalog.mapAll(input.evidenceRefs);
    const hypothesisId = input.hypothesisId ?? this.operation("hypothesis");
    nonEmpty("hypothesisId", hypothesisId);
    const hypothesis: Hypothesis = deepFreeze({
      hypothesisId,
      statement: input.statement,
      status: "open",
      evidenceRefs,
      killTestPlanIds: [],
    }) as Hypothesis;
    const operationId = this.operation(`create-${hypothesisId}`, input.operationId);
    this.append("hypothesis.created", { hypothesis, createdAt: this.clock() }, operationId);
    const recorded = this.state().hypotheses[hypothesisId];
    if (!recorded) throw new Error(`failed to record hypothesis: ${hypothesisId}`);
    return recorded;
  }

  changeStatus(hypothesisId: string, status: HypothesisStatus, options: { readonly supersededBy?: string; readonly operationId?: string } = {}): Hypothesis {
    nonEmpty("hypothesisId", hypothesisId);
    const current = this.state().hypotheses[hypothesisId];
    if (!current) throw new Error(`unknown hypothesis: ${hypothesisId}`);
    const next = normalizeStatus(status);
    if (next === "superseded") nonEmpty("supersededBy", options.supersededBy);
    if (options.supersededBy !== undefined && this.state().hypotheses[options.supersededBy] === undefined) {
      throw new Error(`unknown successor hypothesis: ${options.supersededBy}`);
    }
    const operationId = this.operation(`status-${hypothesisId}-${next}`, options.operationId);
    this.append("hypothesis.status_changed", {
      hypothesisId,
      from: current.status,
      status: next,
      ...(options.supersededBy === undefined ? {} : { supersededBy: options.supersededBy }),
    }, operationId);
    return this.state().hypotheses[hypothesisId]!;
  }

  planKillTest(input: PlanKillTestInput): KillTestPlan {
    nonEmpty("hypothesisId", input.hypothesisId);
    nonEmpty("kill-test predicate", input.predicate);
    const hypothesis = this.state().hypotheses[input.hypothesisId];
    if (!hypothesis) throw new Error(`unknown hypothesis: ${input.hypothesisId}`);
    if (hypothesis.status === "killed" || hypothesis.status === "superseded") {
      throw new Error(`cannot plan a kill-test for a ${hypothesis.status} hypothesis`);
    }
    const evidenceRefs = this.catalog.mapAll(input.evidenceRefs);
    const planId = input.planId ?? this.operation("kill-test");
    nonEmpty("planId", planId);
    const plan: KillTestPlan = deepFreeze({
      planId,
      hypothesisId: input.hypothesisId,
      predicate: input.predicate,
      evidenceRefs,
    }) as KillTestPlan;
    const operationId = this.operation(`plan-${planId}`, input.operationId);
    this.append("kill_test.planned", { plan }, operationId);
    return this.state().plans[planId]!;
  }

  finishKillTest(input: FinishKillTestInput): KillTestResult {
    nonEmpty("planId", input.planId);
    const plan = this.state().plans[input.planId];
    if (!plan) throw new Error(`unknown kill-test plan: ${input.planId}`);
    const outcome = normalizeOutcome(input.outcome);
    const evidenceRefs = this.catalog.mapAll(input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new Error("kill-test result requires T48-mapped evidence_refs");
    const resultId = input.resultId ?? this.operation("kill-test-result");
    nonEmpty("resultId", resultId);
    const result: KillTestResult = deepFreeze({
      resultId,
      planId: input.planId,
      hypothesisId: plan.hypothesisId,
      outcome,
      evidenceRefs,
    }) as KillTestResult;
    const operationId = this.operation(`finish-${input.planId}`, input.operationId);
    this.append("kill_test.finished", { result }, operationId);
    if (killTestOutcomeKillsHypothesis(outcome)) {
      const current = this.state().hypotheses[plan.hypothesisId];
      if (current && current.status !== "killed") {
        this.append("hypothesis.status_changed", { hypothesisId: plan.hypothesisId, from: current.status, status: "killed" }, `${operationId}-killed`);
      }
    }
    return this.state().results[resultId] ?? this.resultFor(input.planId)!;
  }

  /**
   * Ledger-only expand. May enqueue a Campaign·Task. Must not call UCT /
   * SelectionPolicy or write search nodes (K1/K2 and S* stay out of scope).
   */
  requestExpand(hypothesisId: string, options: { readonly enqueue?: CampaignTask; readonly operationId?: string } = {}): Hypothesis {
    nonEmpty("hypothesisId", hypothesisId);
    const hypothesis = this.state().hypotheses[hypothesisId];
    if (!hypothesis) throw new Error(`unknown hypothesis: ${hypothesisId}`);
    if (hypothesis.status === "killed" || hypothesis.status === "superseded") {
      throw new Error(`cannot expand a ${hypothesis.status} hypothesis`);
    }
    const enqueue = options.enqueue === undefined ? undefined : normalizeCampaignTask(options.enqueue);
    const operationId = this.operation(`expand-${hypothesisId}`, options.operationId);
    this.append("hypothesis.expand_requested", {
      hypothesisId,
      requestedAt: this.clock(),
      ...(enqueue === undefined ? {} : { enqueue }),
    }, operationId);
    return this.state().hypotheses[hypothesisId]!;
  }
}
