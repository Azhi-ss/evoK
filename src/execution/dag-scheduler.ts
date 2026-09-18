/**
 * Team DAG scheduler and MissionQueue. Physical home: `src/execution/`
 * (ET-A4 / #124). JoinPolicy type is imported from mission branch-recovery.
 */
import type { JoinPolicy } from "../branch-recovery";

export type DagTaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "REPAIR"
  | "QUARANTINED"
  | "CANCELLED"
  | "BLOCKED";

export interface DagArtifactReference {
  readonly artifactId: string;
  readonly taskId: string;
  readonly address: string;
  readonly digest: string;
  /** Compatibility alias for branch-oriented artifact producers. */
  readonly branchId?: string;
}

export interface DagTaskResult {
  readonly taskId?: string;
  readonly status?: Exclude<DagTaskStatus, "QUEUED" | "RUNNING" | "BLOCKED">;
  readonly artifact?: DagArtifactReference | Record<string, unknown>;
  readonly artifacts?: readonly (DagArtifactReference | Record<string, unknown>)[];
  readonly output?: unknown;
  readonly error?: string;
  readonly objections?: readonly string[];
}

export interface DagTaskContext extends ReadonlyMap<string, Readonly<DagTaskResult>> {
  readonly missionId: string;
  readonly task: Readonly<DagTask>;
  readonly dependencies: ReadonlyMap<string, Readonly<DagTaskResult>>;
  readonly inputs: ReadonlyMap<string, Readonly<DagTaskResult>>;
  readonly artifacts: readonly DagArtifactReference[];
  readonly workspaceId: string;
  readonly attempt: number;
}

export type DagTaskExecutor = (context: DagTaskContext, task?: Readonly<DagTask>) => DagTaskResult | Promise<DagTaskResult>;
export type DagReducer = (context: DagTaskContext) => DagTaskResult | Promise<DagTaskResult>;

export interface DagTask {
  readonly taskId: string;
  readonly dependencies?: readonly string[];
  readonly requiredArtifacts?: readonly string[];
  readonly resources?: readonly string[] | Readonly<Record<string, number>>;
  readonly writeScopes?: readonly string[];
  readonly workspaceId?: string;
  readonly budget?: number;
  readonly maxAttempts?: number;
  readonly execute?: DagTaskExecutor;
  readonly reducer?: DagReducer;
  readonly joinPolicy?: JoinPolicy;
}

export interface DagTaskState {
  readonly taskId: string;
  readonly status: DagTaskStatus;
  readonly attempt: number;
  readonly runId?: string;
  readonly fencingToken?: number;
  readonly workspaceId?: string;
  readonly resources: readonly string[];
  readonly writeScopes: readonly string[];
  readonly artifacts: readonly DagArtifactReference[];
  readonly artifact?: DagArtifactReference;
  readonly output?: unknown;
  readonly error?: string;
  readonly objections: readonly string[];
}

export interface DagJoinDecision {
  readonly taskId: string;
  readonly released: boolean;
  readonly closed: boolean;
  readonly timedOut?: boolean;
  readonly reason: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly artifacts: readonly DagArtifactReference[];
}

export type DagEventType =
  | "MISSION_STARTED"
  | "TASK_READY"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_REPAIR"
  | "TASK_QUARANTINED"
  | "TASK_CANCELLED"
  | "TASK_BLOCKED"
  | "JOIN_RELEASED"
  | "JOIN_CLOSED"
  | "MISSION_COMPLETED"
  | "MISSION_STOPPED";

export interface DagEvent {
  readonly sequence: number;
  readonly type: DagEventType;
  readonly missionId: string;
  readonly taskId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DagRunResult {
  readonly missionId: string;
  readonly status: "QUEUED" | "RUNNING" | "COMPLETED" | "STOPPED";
  readonly tasks: Readonly<Record<string, DagTaskState>>;
  readonly results: Readonly<Record<string, DagTaskState>>;
  readonly readySet: readonly string[];
  readonly joins: Readonly<Record<string, DagJoinDecision>>;
  readonly events: readonly DagEvent[];
  readonly remainingBudget: number;
}

export interface DagSchedulerOptions {
  readonly missionId: string;
  readonly tasks: readonly DagTask[];
  readonly maxParallelTasks?: number;
  readonly maxReadyTasks?: number;
  readonly maxAttempts?: number;
  readonly budget?: number;
  readonly resourceLimits?: Readonly<Record<string, number>>;
  readonly resources?: readonly string[] | Readonly<Record<string, number>>;
  readonly maxWorkspaceOwners?: number;
  readonly clock?: () => number;
  readonly executor?: DagTaskExecutor;
}

interface MutableDagTaskState {
  taskId: string;
  status: DagTaskStatus;
  attempt: number;
  runId?: string;
  fencingToken?: number;
  workspaceId?: string;
  resources: string[];
  writeScopes: string[];
  artifacts: DagArtifactReference[];
  output?: unknown;
  error?: string;
  objections: string[];
}

interface ResourceReservation {
  readonly resources: Readonly<Record<string, number>>;
  readonly writeScopes: readonly string[];
  readonly workspaceOwner: string;
  readonly budget: number;
}

interface ActiveTask extends ResourceReservation {
  readonly taskId: string;
  readonly runId: string;
  readonly promise: Promise<{ taskId: string; result?: DagTaskResult; error?: unknown }>;
  fenced: boolean;
}

interface NormalizedJoinPolicy {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly quorum: number;
  readonly timeoutMs: number;
  readonly terminalFailure: boolean;
  readonly requiredArtifacts: readonly string[];
}

function normalizeJoinPolicy(task: DagTask, taskIdValue: string, declaredDependencies: readonly string[], supplied = task.joinPolicy): { dependencies: readonly string[]; policy: NormalizedJoinPolicy } {
  if (declaredDependencies.length > 0 && supplied === undefined) {
    throw new RangeError(`task ${taskIdValue} requires an explicit join policy`);
  }
  if (supplied && (!Array.isArray(supplied.required) || !Array.isArray(supplied.optional))) {
    throw new TypeError(`task ${taskIdValue} join policy sets are required`);
  }
  const requiredMembers = supplied ? [...supplied.required] : [];
  const optionalMembers = supplied ? [...supplied.optional] : [];
  const members = [...new Set([...requiredMembers, ...optionalMembers])];
  const deps = declaredDependencies.length > 0 ? [...declaredDependencies] : members;
  if (deps.some((dependency) => typeof dependency !== "string" || dependency.trim() === "") || new Set(deps).size !== deps.length) {
    throw new RangeError(`task ${taskIdValue} dependencies must be unique, non-empty strings`);
  }
  if (supplied) {
    if (requiredMembers.some((member) => typeof member !== "string" || member.trim() === "")
      || optionalMembers.some((member) => typeof member !== "string" || member.trim() === "")) {
      throw new RangeError(`task ${taskIdValue} join policy members must be non-empty strings`);
    }
    if (new Set(requiredMembers).size !== requiredMembers.length || new Set(optionalMembers).size !== optionalMembers.length) {
      throw new RangeError(`task ${taskIdValue} join policy members must be unique`);
    }
    if (requiredMembers.some((member) => optionalMembers.includes(member))) {
      throw new RangeError(`task ${taskIdValue} join policy members must be disjoint`);
    }
    if (requiredMembers.some((member) => !deps.includes(member)) || optionalMembers.some((member) => !deps.includes(member))) {
      throw new RangeError(`task ${taskIdValue} join policy references an unknown dependency`);
    }
    if (deps.some((dependency) => !members.includes(dependency))) throw new RangeError(`task ${taskIdValue} join policy must classify every dependency`);
    positiveInteger(`task ${taskIdValue} join quorum`, supplied.quorum);
    if (supplied.quorum > members.length) throw new RangeError(`task ${taskIdValue} join quorum exceeds dependencies`);
    if (!Number.isFinite(supplied.timeoutMs) || supplied.timeoutMs < 0) throw new RangeError(`task ${taskIdValue} join timeout must be finite and >= 0`);
    if (typeof supplied.terminalFailure !== "boolean") throw new TypeError(`task ${taskIdValue} join terminalFailure must be boolean`);
  }
  const required = supplied ? requiredMembers : [...deps];
  const optional = supplied ? optionalMembers : [];
  if (task.requiredArtifacts !== undefined && !Array.isArray(task.requiredArtifacts)) {
    throw new TypeError(`task ${taskIdValue} required artifacts must be an array`);
  }
  const requiredArtifacts = task.requiredArtifacts === undefined ? [] : [...task.requiredArtifacts];
  if (requiredArtifacts.some((artifact) => typeof artifact !== "string" || artifact.trim() === "")
    || new Set(requiredArtifacts).size !== requiredArtifacts.length) {
    throw new RangeError(`task ${taskIdValue} required artifacts must be unique, non-empty strings`);
  }
  return {
    dependencies: deps,
    policy: Object.freeze({
      required: Object.freeze(required),
      optional: Object.freeze(optional),
      quorum: supplied?.quorum ?? (deps.length > 0 ? deps.length : 0),
      timeoutMs: supplied?.timeoutMs ?? Number.POSITIVE_INFINITY,
      terminalFailure: supplied?.terminalFailure ?? true,
      requiredArtifacts: Object.freeze(requiredArtifacts),
    }),
  };
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value as Readonly<T>;
  for (const key of Reflect.ownKeys(value as object)) {
    freeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value) as Readonly<T>;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a finite integer >= 1`);
}

function nonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and >= 0`);
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function taskId(task: DagTask): string {
  if (typeof task.taskId !== "string" || task.taskId.trim() === "") throw new RangeError("DAG task ids must be non-empty strings");
  return task.taskId;
}

function dependencies(task: DagTask): readonly string[] {
  const values = task.dependencies;
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("dependencies must be an array");
  return [...values];
}

function scopes(task: DagTask): string[] {
  const values = task.writeScopes ?? [];
  if (!Array.isArray(values)) throw new TypeError("write scopes must be an array");
  if (values.some((value) => typeof value !== "string" || value.trim() === "")) throw new RangeError("write scopes must be non-empty strings");
  if (new Set(values).size !== values.length) throw new RangeError("write scopes must be unique");
  return [...values];
}

function taskView(task: DagTask): Readonly<DagTask> {
  return freeze({
    ...task,
    ...(task.dependencies === undefined ? {} : { dependencies: [...task.dependencies] }),
    ...(task.requiredArtifacts === undefined ? {} : { requiredArtifacts: [...task.requiredArtifacts] }),
    ...(Array.isArray(task.resources) ? { resources: [...task.resources] } : task.resources === undefined ? {} : { resources: { ...task.resources } }),
    ...(task.writeScopes === undefined ? {} : { writeScopes: [...task.writeScopes] }),
    ...(task.joinPolicy === undefined ? {} : { joinPolicy: { ...task.joinPolicy, required: [...task.joinPolicy.required], optional: [...task.joinPolicy.optional] } }),
  });
}

function resourceNeeds(task: DagTask): Record<string, number> {
  const declared = task.resources;
  if (declared === undefined) return {};
  if (Array.isArray(declared)) {
    if (declared.some((resource) => typeof resource !== "string" || resource.trim() === "")) throw new RangeError("resources must be non-empty strings");
    const result = dictionary<number>();
    for (const resource of declared) result[resource] = (result[resource] ?? 0) + 1;
    return result;
  }
  if (!declared || typeof declared !== "object") throw new TypeError("resources must be a list or capacity map");
  const result = dictionary<number>();
  for (const [resource, amount] of Object.entries(declared)) {
    if (resource.trim() === "") throw new RangeError("resource names must be non-empty strings");
    positiveInteger(`resource ${resource}`, amount);
    result[resource] = amount;
  }
  return result;
}

function readOnlyMap(entries: readonly (readonly [string, Readonly<DagTaskResult>])[]): ReadonlyMap<string, Readonly<DagTaskResult>> {
  const map = new Map(entries);
  return Object.freeze({
    get size() { return map.size; },
    get(key: string) { return map.get(key); },
    has(key: string) { return map.has(key); },
    entries() { return map.entries(); },
    keys() { return map.keys(); },
    values() { return map.values(); },
    forEach(callbackfn: (value: Readonly<DagTaskResult>, key: string, map: ReadonlyMap<string, Readonly<DagTaskResult>>) => void, thisArg?: unknown) {
      map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
    },
    [Symbol.iterator]() { return map[Symbol.iterator](); },
  });
}

class TaskInput implements DagTaskContext {
  private readonly source: ReadonlyMap<string, Readonly<DagTaskResult>>;
  readonly missionId: string;
  readonly task: Readonly<DagTask>;
  readonly dependencies: ReadonlyMap<string, Readonly<DagTaskResult>>;
  readonly inputs: ReadonlyMap<string, Readonly<DagTaskResult>>;
  readonly artifacts: readonly DagArtifactReference[];
  readonly workspaceId: string;
  readonly attempt: number;

  constructor(missionId: string, task: Readonly<DagTask>, values: ReadonlyMap<string, Readonly<DagTaskResult>>, artifacts: readonly DagArtifactReference[], workspaceId: string, attempt: number) {
    this.missionId = missionId;
    this.task = task;
    this.source = values;
    this.dependencies = values;
    this.inputs = values;
    this.artifacts = artifacts;
    this.workspaceId = workspaceId;
    this.attempt = attempt;
  }

  get size(): number { return this.source.size; }
  get(key: string): Readonly<DagTaskResult> | undefined { return this.source.get(key); }
  has(key: string): boolean { return this.source.has(key); }
  entries(): MapIterator<[string, Readonly<DagTaskResult>]> { return new Map(this.source).entries(); }
  keys(): MapIterator<string> { return new Map(this.source).keys(); }
  values(): MapIterator<Readonly<DagTaskResult>> { return new Map(this.source).values(); }
  forEach(callbackfn: (value: Readonly<DagTaskResult>, key: string, map: ReadonlyMap<string, Readonly<DagTaskResult>>) => void, thisArg?: unknown): void {
    this.source.forEach(callbackfn, thisArg);
  }
  [Symbol.iterator](): MapIterator<[string, Readonly<DagTaskResult>]> { return this.entries(); }
}

function artifactCandidate(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).artifactId === "string";
}

function normalizeArtifact(taskIdValue: string, value: unknown): DagArtifactReference {
  if (!artifactCandidate(value)) throw new TypeError("task artifact must contain an artifactId");
  const candidate = value as Record<string, unknown>;
  if (candidate.artifactId === "") throw new TypeError("task artifact requires a non-empty artifactId");
  if ((candidate.taskId !== undefined && candidate.taskId !== taskIdValue)
    || (candidate.branchId !== undefined && candidate.branchId !== taskIdValue)) {
    throw new TypeError("task artifact belongs to another task");
  }
  if (typeof candidate.address !== "string" || candidate.address === "" || typeof candidate.digest !== "string" || candidate.digest === "") {
    throw new TypeError("task artifact requires address and digest");
  }
  return Object.freeze({
    artifactId: candidate.artifactId as string,
    taskId: taskIdValue,
    address: candidate.address,
    digest: candidate.digest,
  });
}

function normalizeResult(taskIdValue: string, value: unknown): DagTaskResult {
  if (artifactCandidate(value)) {
    const artifact = normalizeArtifact(taskIdValue, value);
    return { taskId: taskIdValue, status: "COMPLETED", artifact, artifacts: [artifact] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("task executor must return a result object");
  const result = value as Record<string, unknown>;
  const declaredTaskId = result.taskId;
  if (declaredTaskId !== undefined && declaredTaskId !== taskIdValue) throw new TypeError("task result belongs to another task");
  const rawArtifacts = result.artifacts !== undefined ? result.artifacts : result.artifact === undefined ? [] : [result.artifact];
  if (!Array.isArray(rawArtifacts)) throw new TypeError("task artifacts must be an array");
  const artifacts = rawArtifacts.map((artifact) => normalizeArtifact(taskIdValue, artifact));
  const status = result.status === undefined ? "COMPLETED" : result.status;
  const validStatuses: readonly string[] = ["COMPLETED", "FAILED", "REPAIR", "QUARANTINED", "CANCELLED"];
  if (typeof status !== "string" || !validStatuses.includes(status)) {
    throw new TypeError("invalid task result status");
  }
  return {
    taskId: taskIdValue,
    status: status as DagTaskResult["status"],
    artifacts,
    ...(artifacts[0] === undefined ? {} : { artifact: artifacts[0] }),
    output: clone(result.output),
    error: typeof result.error === "string" ? result.error : undefined,
    objections: Array.isArray(result.objections) ? result.objections.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return left.some((a) => right.some((b) => {
    const first = normalized(a);
    const second = normalized(b);
    return first === "/" || second === "/" || first === second
      || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
  }));
}

function taskStateCopy(state: MutableDagTaskState): DagTaskState {
  const artifacts = freeze(clone(state.artifacts));
  return freeze({
    taskId: state.taskId,
    status: state.status,
    attempt: state.attempt,
    ...(state.runId === undefined ? {} : { runId: state.runId }),
    ...(state.fencingToken === undefined ? {} : { fencingToken: state.fencingToken }),
    ...(state.workspaceId === undefined ? {} : { workspaceId: state.workspaceId }),
    resources: [...state.resources],
    writeScopes: [...state.writeScopes],
    artifacts,
    ...(artifacts[0] === undefined ? {} : { artifact: artifacts[0] }),
    ...(state.output === undefined ? {} : { output: clone(state.output) }),
    ...(state.error === undefined ? {} : { error: state.error }),
    objections: [...state.objections],
  });
}

export class DAGScheduler {
  private readonly missionId: string;
  private readonly taskMap = new Map<string, DagTask>();
  private readonly defaultExecutor?: DagTaskExecutor;
  private readonly order: string[];
  private readonly dependencyMap = new Map<string, readonly string[]>();
  private readonly joinPolicies = new Map<string, NormalizedJoinPolicy>();
  private readonly releasedJoins = new Set<string>();
  private readonly closedJoins = new Set<string>();
  private readonly joinWaitStartedAt = new Map<string, number>();
  private readonly states = new Map<string, MutableDagTaskState>();
  private readonly needs = new Map<string, Record<string, number>>();
  private readonly capacities: Record<string, number>;
  private readonly maxParallel: number;
  private readonly maxReady: number;
  private readonly defaultMaxAttempts: number;
  private readonly maxWorkspaceOwners: number;
  private readonly hasResourcePolicy: boolean;
  private readonly clock: () => number;
  private remaining: number;
  private readonly active = new Map<string, ActiveTask>();
  private readonly artifactOwners = new Map<string, string>();
  private readonly eventsLog: DagEvent[] = [];
  private phase: DagRunResult["status"] = "QUEUED";
  private nextFence = 1;
  private running?: Promise<DagRunResult>;

  constructor(options: DagSchedulerOptions) {
    if (typeof options.missionId !== "string" || options.missionId.trim() === "") throw new TypeError("missionId is required");
    const tasks = options.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw new RangeError("DAG requires at least one task");
    this.missionId = options.missionId;
    this.defaultExecutor = options.executor;
    this.order = tasks.map((task) => {
      const id = taskId(task);
      if (this.taskMap.has(id)) throw new RangeError("DAG task ids must be unique");
      this.taskMap.set(id, task);
      return id;
    });
    for (const id of this.order) {
      const task = this.taskMap.get(id)!;
      const normalized = normalizeJoinPolicy(task, id, dependencies(task), task.joinPolicy);
      const deps = normalized.dependencies;
      if (deps.some((dependency) => typeof dependency !== "string" || dependency === "" || !this.taskMap.has(dependency))) {
        throw new RangeError(`task ${id} references an unknown dependency`);
      }
      if (deps.includes(id)) throw new RangeError(`task ${id} has invalid dependencies`);
      this.dependencyMap.set(id, deps);
      this.joinPolicies.set(id, normalized.policy);
      this.needs.set(id, resourceNeeds(task));
      const cost = task.budget ?? 1;
      nonNegativeNumber(`task ${id} budget`, cost);
      const writeScopes = scopes(task);
      this.states.set(id, { taskId: id, status: "QUEUED", attempt: 0, resources: Object.keys(this.needs.get(id)!), writeScopes, artifacts: [], objections: [] });
    }
    for (const [id, task] of this.taskMap) this.taskMap.set(id, taskView(task));
    this.assertAcyclic();
    this.maxParallel = options.maxParallelTasks ?? 1;
    positiveInteger("maxParallelTasks", this.maxParallel);
    this.maxReady = options.maxReadyTasks ?? this.maxParallel;
    positiveInteger("maxReadyTasks", this.maxReady);
    if (options.maxAttempts !== undefined) positiveInteger("maxAttempts", options.maxAttempts);
    for (const [id, task] of this.taskMap) {
      if (task.maxAttempts !== undefined) positiveInteger(`task ${id} maxAttempts`, task.maxAttempts);
      const owner = task.workspaceId;
      if (owner !== undefined && (typeof owner !== "string" || owner.trim() === "")) throw new RangeError(`task ${id} workspace owner must be a non-empty string`);
    }
    if (Array.isArray(options.resources)
      && (options.resources.some((resource) => typeof resource !== "string" || resource.trim() === "")
        || new Set(options.resources).size !== options.resources.length)) {
      throw new RangeError("resources must contain unique, non-empty names");
    }
    const rawCapacities = dictionary<number>();
    if (options.resourceLimits !== undefined) {
      if (!options.resourceLimits || typeof options.resourceLimits !== "object" || Array.isArray(options.resourceLimits)) {
        throw new TypeError("resourceLimits must be a capacity map");
      }
      for (const [resource, capacity] of Object.entries(options.resourceLimits)) rawCapacities[resource] = capacity;
    } else if (Array.isArray(options.resources)) {
      for (const resource of options.resources) rawCapacities[resource] = 1;
    } else if (options.resources !== undefined) {
      if (!options.resources || typeof options.resources !== "object") throw new TypeError("resources must be a list or capacity map");
      for (const [resource, capacity] of Object.entries(options.resources)) rawCapacities[resource] = capacity;
    }
    this.hasResourcePolicy = options.resourceLimits !== undefined || options.resources !== undefined;
    this.capacities = dictionary<number>();
    for (const [resource, capacity] of Object.entries(rawCapacities)) {
      if (resource.trim() === "") throw new RangeError("resource names must be non-empty strings");
      positiveInteger(`resource limit ${resource}`, capacity);
      this.capacities[resource] = capacity;
    }
    for (const [id, needs] of this.needs) {
      for (const [resource, amount] of Object.entries(needs)) {
        if (this.capacities[resource] === undefined) {
          if (this.hasResourcePolicy) throw new RangeError(`task ${id} requests unavailable resource ${resource}`);
          this.capacities[resource] = 1;
        }
        if (amount > this.capacities[resource]!) throw new RangeError(`task ${id} exceeds resource capacity for ${resource}`);
      }
    }
    const configuredBudget = options.budget ?? Number.POSITIVE_INFINITY;
    if (configuredBudget !== Number.POSITIVE_INFINITY) nonNegativeNumber("budget", configuredBudget);
    this.remaining = configuredBudget;
    this.defaultMaxAttempts = options.maxAttempts ?? 1;
    this.maxWorkspaceOwners = options.maxWorkspaceOwners ?? this.maxParallel;
    positiveInteger("maxWorkspaceOwners", this.maxWorkspaceOwners);
    if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("clock must be a function");
    this.clock = options.clock ?? (() => Date.now());
  }

  private assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new RangeError("DAG contains a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.dependencyMap.get(id) ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.order) visit(id);
  }

  private append(type: DagEventType, taskId?: string, payload: Record<string, unknown> = {}): void {
    this.eventsLog.push(freeze({ sequence: this.eventsLog.length + 1, type, missionId: this.missionId, ...(taskId === undefined ? {} : { taskId }), payload: clone(payload) }) as DagEvent);
  }

  private taskCost(id: string): number {
    return this.taskMap.get(id)!.budget ?? 1;
  }

  private joinDecisionFor(id: string): DagJoinDecision {
    const policy = this.joinPolicies.get(id)!;
    const deps = this.dependencyMap.get(id) ?? [];
    if (deps.length > 0 && !this.joinWaitStartedAt.has(id)
      && deps.some((dependency) => this.states.get(dependency)!.attempt > 0)) {
      this.joinWaitStartedAt.set(id, this.clock());
    }
    const memberReady = (member: string): boolean => {
      const state = this.states.get(member)!;
      return state.status === "COMPLETED" && state.artifacts.length > 0;
    };
    const requiredReady = policy.required.every(memberReady);
    const availableMembers = [...policy.required, ...policy.optional].filter(memberReady);
    const availableArtifacts = availableMembers.flatMap((member) => this.states.get(member)!.artifacts);
    const requiredArtifactsReady = policy.requiredArtifacts.every((required) => availableArtifacts.some((artifact) => artifact.artifactId === required));
    const released = requiredReady && requiredArtifactsReady && availableMembers.length >= policy.quorum;
    const terminal = (member: string): boolean => {
      const state = this.states.get(member)!;
      return ["FAILED", "REPAIR", "QUARANTINED", "CANCELLED", "BLOCKED"].includes(state.status)
        && (state.status !== "REPAIR" || (this.taskMap.get(member)!.maxAttempts ?? this.defaultMaxAttempts) <= state.attempt);
    };
    const requiredTerminal = policy.required.some((member) => terminal(member));
    const requiredArtifactImpossible = policy.required.some((member) => {
      const state = this.states.get(member)!;
      return state.status === "COMPLETED" && state.artifacts.length === 0;
    });
    const allMembersSettled = [...policy.required, ...policy.optional].every((member) => {
      const state = this.states.get(member)!;
      return state.status === "COMPLETED" || terminal(member);
    });
    const explicitArtifactImpossible = policy.requiredArtifacts.length > 0 && allMembersSettled && !requiredArtifactsReady;
    const startedAt = this.joinWaitStartedAt.get(id);
    const timedOut = startedAt !== undefined && Number.isFinite(policy.timeoutMs) && this.clock() - startedAt >= policy.timeoutMs;
    let possible = availableMembers.length;
    let budget = this.remaining;
    for (const member of [...policy.required, ...policy.optional]) {
      if (availableMembers.includes(member)) continue;
      const state = this.states.get(member)!;
      const canProduce = state.status === "RUNNING"
        || state.status === "QUEUED"
        || (state.status === "REPAIR" && state.attempt < (this.taskMap.get(member)!.maxAttempts ?? this.defaultMaxAttempts));
      if (!canProduce) continue;
      const cost = state.status === "RUNNING" ? 0 : this.taskCost(member);
      if (cost <= budget) {
        possible += 1;
        budget -= cost;
      }
    }
    const closed = !released && policy.terminalFailure
      && (requiredTerminal || requiredArtifactImpossible || explicitArtifactImpossible || possible < policy.quorum || timedOut);
    return {
      taskId: id,
      released,
      closed,
      timedOut,
      reason: released ? "join requirements satisfied" : timedOut ? "join timed out" : closed ? "join terminal failure" : "join waiting for required dependencies or artifacts",
      required: Object.freeze([...policy.required]),
      optional: Object.freeze([...policy.optional]),
      requiredArtifacts: Object.freeze([...policy.requiredArtifacts]),
      artifacts: freeze(clone(availableArtifacts)),
    };
  }

  join(taskIdValue: string): DagJoinDecision {
    if (!this.taskMap.has(taskIdValue)) throw new RangeError(`unknown task ${taskIdValue}`);
    return freeze(clone(this.joinDecisionFor(taskIdValue)));
  }

  private dependenciesReady(id: string): boolean {
    const deps = this.dependencyMap.get(id) ?? [];
    return deps.length === 0 ? true : this.joinDecisionFor(id).released;
  }

  private allReadyIds(): string[] {
    return this.order.filter((id) => this.states.get(id)!.status === "QUEUED" && this.dependenciesReady(id));
  }

  private reservationFor(id: string): ResourceReservation {
    const task = this.taskMap.get(id)!;
    return {
      resources: this.needs.get(id)!,
      writeScopes: this.states.get(id)!.writeScopes,
      workspaceOwner: task.workspaceId ?? `${this.missionId}:${id}`,
      budget: task.budget ?? 1,
    };
  }

  private readyIds(): string[] {
    const selected: string[] = [];
    const reservations: ResourceReservation[] = [];
    for (const id of this.allReadyIds()) {
      if (selected.length >= this.maxReady) break;
      if (!this.canStart(id, reservations)) continue;
      selected.push(id);
      reservations.push(this.reservationFor(id));
    }
    return selected;
  }

  readySet(): readonly string[] { return Object.freeze([...this.readyIds()]); }

  state(): DagRunResult {
    return this.snapshot(this.phase);
  }

  events(): readonly DagEvent[] { return freeze(clone(this.eventsLog)); }

  private snapshot(status: DagRunResult["status"]): DagRunResult {
    const tasks = Object.fromEntries(this.order.map((id) => [id, taskStateCopy(this.states.get(id)!)]));
    const joins = Object.fromEntries(this.order.filter((id) => (this.dependencyMap.get(id) ?? []).length > 0).map((id) => [id, this.joinDecisionFor(id)]));
    return freeze({
      missionId: this.missionId,
      status,
      tasks,
      results: tasks,
      readySet: this.readySet(),
      joins,
      events: this.events(),
      remainingBudget: this.remaining,
    });
  }

  private activeResourceUse(): Record<string, number> {
    const used = dictionary<number>();
    for (const active of this.active.values()) {
      for (const [resource, amount] of Object.entries(active.resources)) used[resource] = (used[resource] ?? 0) + amount;
    }
    return used;
  }

  private canStart(id: string, reservations: readonly ResourceReservation[] = []): boolean {
    if (this.active.size + reservations.length >= this.maxParallel) return false;
    const reservation = this.reservationFor(id);
    const reservedBudget = reservations.reduce((total, entry) => total + entry.budget, 0);
    if (reservation.budget > this.remaining - reservedBudget) return false;
    const used = this.activeResourceUse();
    for (const entry of reservations) {
      for (const [resource, amount] of Object.entries(entry.resources)) used[resource] = (used[resource] ?? 0) + amount;
    }
    if (Object.entries(reservation.resources).some(([resource, amount]) => (used[resource] ?? 0) + amount > this.capacities[resource]!)) return false;
    const occupied = [...this.active.values(), ...reservations];
    if (occupied.some((entry) => overlaps(reservation.writeScopes, entry.writeScopes))) return false;
    const owners = new Set(occupied.map((entry) => entry.workspaceOwner));
    if (owners.has(reservation.workspaceOwner) || owners.size >= this.maxWorkspaceOwners) return false;
    return true;
  }

  private contextFor(id: string): DagTaskContext {
    const task = this.taskMap.get(id)!;
    const state = this.states.get(id)!;
    const entries: Array<readonly [string, Readonly<DagTaskResult>]> = (this.dependencyMap.get(id) ?? []).map((dependency) => [dependency, freeze({
      status: (this.states.get(dependency)!.status === "COMPLETED" ? "COMPLETED" : this.states.get(dependency)!.status) as DagTaskResult["status"],
      artifacts: clone(this.states.get(dependency)!.artifacts),
      ...(this.states.get(dependency)!.artifacts[0] === undefined ? {} : { artifact: clone(this.states.get(dependency)!.artifacts[0]) }),
      ...(this.states.get(dependency)!.output === undefined ? {} : { output: clone(this.states.get(dependency)!.output) }),
      ...(this.states.get(dependency)!.error === undefined ? {} : { error: this.states.get(dependency)!.error }),
    }) as DagTaskResult]);
    const values = readOnlyMap(entries);
    const artifacts = Object.freeze(entries.flatMap(([, result]) => result.artifacts ?? []).map((artifact) => normalizeArtifact((artifact as DagArtifactReference).taskId, artifact)));
    return Object.freeze(new TaskInput(this.missionId, task, values, artifacts, state.workspaceId!, state.attempt));
  }

  private start(id: string, fallback?: DagTaskExecutor): void {
    const task = this.taskMap.get(id)!;
    const state = this.states.get(id)!;
    const cost = task.budget ?? 1;
    const executor = task.reducer ?? task.execute ?? fallback ?? this.defaultExecutor;
    const runId = `${this.missionId}:${id}:run-${state.attempt + 1}`;
    const workspaceOwner = task.workspaceId ?? `${this.missionId}:${id}`;
    const workspaceId = `${workspaceOwner}:run-${state.attempt + 1}`;
    state.attempt += 1;
    state.status = "RUNNING";
    state.runId = runId;
    state.fencingToken = this.nextFence++;
    state.workspaceId = workspaceId;
    state.artifacts = [];
    state.output = undefined;
    state.error = undefined;
    state.objections = [];
    this.remaining -= cost;
    const startedAt = this.clock();
    for (const [joinId, dependencies] of this.dependencyMap) {
      if (dependencies.includes(id) && !this.joinWaitStartedAt.has(joinId)) this.joinWaitStartedAt.set(joinId, startedAt);
    }
    const context = this.contextFor(id);
    const promise = Promise.resolve().then(() => {
      if (!executor) throw new TypeError(`task ${id} has no executor or reducer`);
      return executor(context, task);
    }).then(
      (result) => ({ taskId: id, result }),
      (error: unknown) => ({ taskId: id, error: error === undefined ? new Error("task execution failed") : error }),
    );
    const active: ActiveTask = { taskId: id, runId, resources: this.needs.get(id)!, writeScopes: [...state.writeScopes], workspaceOwner, budget: cost, promise, fenced: false };
    this.active.set(id, active);
    this.append("TASK_STARTED", id, { runId, fencingToken: state.fencingToken, workspaceId, startedAt });
  }

  private canRetry(id: string): boolean {
    return this.states.get(id)!.attempt < (this.taskMap.get(id)!.maxAttempts ?? this.defaultMaxAttempts);
  }

  private queueRepair(id: string, runId: string): void {
    const state = this.states.get(id)!;
    if (!this.canRetry(id)) return;
    state.status = "QUEUED";
    this.append("TASK_REPAIR", id, { runId, nextAttempt: state.attempt + 1 });
  }

  private finish(completion: { taskId: string; result?: DagTaskResult; error?: unknown }): void {
    const active = this.active.get(completion.taskId);
    if (!active) return;
    this.active.delete(completion.taskId);
    if (active.fenced) return;
    const state = this.states.get(completion.taskId)!;
    if (completion.error !== undefined) {
      state.status = "FAILED";
      state.error = completion.error instanceof Error ? completion.error.message : String(completion.error);
      state.objections = [state.error];
      this.append("TASK_FAILED", completion.taskId, { error: state.error, runId: active.runId });
      this.queueRepair(completion.taskId, active.runId);
      return;
    }
    try {
      const result = normalizeResult(completion.taskId, completion.result);
      const status = result.status ?? "COMPLETED";
      const artifacts = status === "COMPLETED"
        ? (result.artifacts ?? []).map((artifact) => normalizeArtifact(completion.taskId, artifact))
        : [];
      const ids = new Set<string>();
      let duplicate: DagArtifactReference | undefined;
      for (const artifact of artifacts) {
        if (ids.has(artifact.artifactId) || this.artifactOwners.has(artifact.artifactId)) {
          duplicate = artifact;
          break;
        }
        ids.add(artifact.artifactId);
      }
      if (duplicate) throw new TypeError(`duplicate artifact reference ${duplicate.artifactId}`);
      const output = clone(result.output);
      for (const artifact of artifacts) this.artifactOwners.set(artifact.artifactId, completion.taskId);
      state.status = status;
      state.artifacts = artifacts;
      state.output = output;
      state.error = result.error;
      state.objections = [...(result.objections ?? [])];
      const event = state.status === "COMPLETED" ? "TASK_COMPLETED"
        : state.status === "FAILED" ? "TASK_FAILED"
          : state.status === "REPAIR" ? "TASK_REPAIR"
            : state.status === "QUARANTINED" ? "TASK_QUARANTINED" : "TASK_CANCELLED";
      this.append(event, completion.taskId, { runId: active.runId, artifacts: state.artifacts, ...(state.error === undefined ? {} : { error: state.error }), objections: state.objections });
      if (state.status === "REPAIR") this.queueRepair(completion.taskId, active.runId);
    } catch (error) {
      state.status = "FAILED";
      state.error = error instanceof Error ? error.message : String(error);
      state.objections = [state.error];
      this.append("TASK_FAILED", completion.taskId, { error: state.error, runId: active.runId });
    }
  }

  private closeImpossibleJoins(force = false): void {
    for (const id of this.order) {
      if ((this.dependencyMap.get(id) ?? []).length === 0 || this.closedJoins.has(id)) continue;
      const decision = this.joinDecisionFor(id);
      if (!decision.closed) continue;
      if (!force && !decision.timedOut && this.allReadyIds().some((candidate) => (this.dependencyMap.get(id) ?? []).includes(candidate))) continue;
      this.closedJoins.add(id);
      this.append("JOIN_CLOSED", id, { reason: decision.reason, required: decision.required, optional: decision.optional, requiredArtifacts: decision.requiredArtifacts });
      const state = this.states.get(id)!;
      if (state.status === "QUEUED") {
        state.status = "BLOCKED";
        state.error = decision.reason;
        this.append("TASK_BLOCKED", id, { reason: state.error });
      }
    }
  }

  private blockRemaining(): void {
    this.closeImpossibleJoins(true);
    for (const id of this.order) {
      const state = this.states.get(id)!;
      if (state.status !== "QUEUED") continue;
      const dependencies = this.dependencyMap.get(id) ?? [];
      if (dependencies.length > 0 && !this.joinPolicies.get(id)!.terminalFailure && !this.joinDecisionFor(id).released) continue;
      state.status = "BLOCKED";
      state.error = this.allReadyIds().includes(id) ? "scheduler capacity or budget exhausted" : "dependency not satisfied";
      this.append("TASK_BLOCKED", id, { reason: state.error });
    }
    this.closeImpossibleJoins(true);
  }

  private nextTimeoutDelay(): number | undefined {
    const now = this.clock();
    let delay: number | undefined;
    for (const id of this.order) {
      if ((this.dependencyMap.get(id) ?? []).length === 0 || this.releasedJoins.has(id) || this.closedJoins.has(id)) continue;
      const policy = this.joinPolicies.get(id)!;
      const startedAt = this.joinWaitStartedAt.get(id);
      if (!policy.terminalFailure || startedAt === undefined || !Number.isFinite(policy.timeoutMs)) continue;
      const remaining = Math.max(0, startedAt + policy.timeoutMs - now);
      delay = delay === undefined ? remaining : Math.min(delay, remaining);
    }
    return delay;
  }

  private expireTimedOutRuns(): void {
    this.closeImpossibleJoins();
    const membersByTimedOutJoin = new Set<string>();
    for (const id of this.order) {
      const decision = this.joinDecisionFor(id);
      if (decision.timedOut && decision.closed) {
        for (const member of [...decision.required, ...decision.optional]) membersByTimedOutJoin.add(member);
      }
    }
    for (const taskId of membersByTimedOutJoin) {
      const state = this.states.get(taskId)!;
      if (state.status !== "QUEUED") continue;
      state.status = "BLOCKED";
      state.error = "join timed out";
      state.objections = [state.error];
      this.append("TASK_BLOCKED", taskId, { reason: state.error });
    }
    for (const active of [...this.active.values()]) {
      if (!membersByTimedOutJoin.has(active.taskId)) continue;
      active.fenced = true;
      const state = this.states.get(active.taskId)!;
      state.status = "FAILED";
      state.error = "join timed out";
      state.objections = [state.error];
      this.append("TASK_FAILED", active.taskId, { runId: active.runId, error: state.error });
    }
  }

  private async waitForCompletion(): Promise<{ taskId: string; result?: DagTaskResult; error?: unknown } | undefined> {
    const completion = Promise.race([...this.active.values()].map((active) => active.promise));
    const delay = this.nextTimeoutDelay();
    if (delay === undefined) return completion;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), delay);
    });
    const winner = await Promise.race([
      completion.then((value) => ({ kind: "completion" as const, value })),
      timeout.then(() => ({ kind: "timeout" as const })),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (winner.kind === "timeout") {
      this.expireTimedOutRuns();
      return undefined;
    }
    return winner.value;
  }

  private async execute(fallback?: DagTaskExecutor): Promise<DagRunResult> {
    this.phase = "RUNNING";
    this.append("MISSION_STARTED");
    while (true) {
      this.closeImpossibleJoins();
      let started = false;
      for (const id of this.readyIds()) {
        if (!this.canStart(id)) continue;
        if ((this.dependencyMap.get(id) ?? []).length > 0 && !this.releasedJoins.has(id)) {
          this.releasedJoins.add(id);
          const decision = this.joinDecisionFor(id);
          this.append("JOIN_RELEASED", id, { required: decision.required, optional: decision.optional, requiredArtifacts: decision.requiredArtifacts, artifacts: decision.artifacts });
        }
        this.append("TASK_READY", id);
        this.start(id, fallback);
        started = true;
      }
      if (this.active.size > 0) {
        const completion = await this.waitForCompletion();
        if (completion) this.finish(completion);
        continue;
      }
      if (!started) break;
    }
    this.blockRemaining();
    const complete = this.order.every((id) => ["COMPLETED", "FAILED", "REPAIR", "QUARANTINED", "CANCELLED", "BLOCKED"].includes(this.states.get(id)!.status));
    const hasSuccessor = new Set([...this.dependencyMap.values()].flat());
    const sinks = this.order.filter((id) => !hasSuccessor.has(id));
    const succeeded = complete && sinks.length > 0 && sinks.every((id) => this.states.get(id)!.status === "COMPLETED");
    this.phase = succeeded && complete ? "COMPLETED" : "STOPPED";
    this.append(this.phase === "COMPLETED" ? "MISSION_COMPLETED" : "MISSION_STOPPED", undefined, { reason: succeeded ? "all terminal tasks completed" : "one or more terminal tasks did not complete" });
    return this.snapshot(this.phase);
  }

  run(fallback?: DagTaskExecutor): Promise<DagRunResult> {
    this.running ??= this.execute(fallback);
    return this.running;
  }
}

export interface MissionQueueTask<T> {
  readonly missionId: string;
  readonly run: () => T | Promise<T>;
}

interface PendingMission<T> {
  readonly task: MissionQueueTask<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export class MissionQueue<T = unknown> {
  private readonly pending: PendingMission<T>[] = [];
  private draining?: Promise<readonly T[]>;

  constructor(initial: readonly MissionQueueTask<T>[] = []) {
    for (const task of initial) this.enqueue(task);
  }

  enqueue(task: MissionQueueTask<T>): Promise<T>;
  enqueue(missionId: string, run: () => T | Promise<T>): Promise<T>;
  enqueue(taskOrMissionId: MissionQueueTask<T> | string, run?: () => T | Promise<T>): Promise<T> {
    const task = typeof taskOrMissionId === "string" ? { missionId: taskOrMissionId, run: run! } : taskOrMissionId;
    if (!task || typeof task !== "object" || typeof task.missionId !== "string" || task.missionId.trim() === "" || typeof task.run !== "function") {
      return Promise.reject(new TypeError("mission queue tasks require a missionId and run function"));
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
    });
    return promise;
  }

  add(task: MissionQueueTask<T>): Promise<T> { return this.enqueue(task); }

  size(): number { return this.pending.length; }

  drain(): Promise<readonly T[]> {
    if (this.draining) return this.draining;
    if (this.pending.length === 0) return Promise.resolve(Object.freeze([]));
    this.draining = (async () => {
      const results: T[] = [];
      let failure: unknown;
      let failed = false;
      while (this.pending.length > 0) {
        const item = this.pending.shift()!;
        try {
          const result = await item.task.run();
          results.push(result);
          item.resolve(result);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
          item.reject(error);
        }
      }
      this.draining = undefined;
      if (failed) throw failure;
      return Object.freeze(results);
    })();
    return this.draining;
  }

  run(): Promise<readonly T[]> { return this.drain(); }
}

export { DAGScheduler as DagScheduler };
export type { JoinPolicy } from "../branch-recovery";
