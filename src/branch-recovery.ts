export type BranchRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PROMOTED" | "FAILED" | "CANCELLED" | "QUARANTINED" | "EXPIRED";

export interface BranchRunIdentity {
  readonly branchId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workspaceId: string;
  readonly fencingToken: number;
}

export interface BranchArtifact {
  readonly artifactId: string;
  readonly [key: string]: unknown;
}

export interface JoinPolicy {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly quorum: number;
  readonly timeoutMs: number;
  readonly terminalFailure: boolean;
}

export interface BranchState {
  readonly branchId: string;
  readonly status: BranchRunStatus;
  readonly attempt: number;
  readonly run?: BranchRunIdentity;
  readonly artifact?: BranchArtifact;
  readonly promoted: boolean;
}

export interface BudgetState {
  readonly maxAttempts: number;
  readonly maxUnits: number;
  readonly remainingUnits: number;
}

export interface ControlPlaneState {
  readonly missionId: string;
  readonly branches: Readonly<Record<string, BranchState>>;
  readonly budget: BudgetState;
  readonly join: JoinDecision;
}

export interface JoinDecision {
  readonly released: boolean;
  readonly closed: boolean;
  readonly reason: string;
  readonly requiredArtifacts: readonly string[];
  readonly optionalArtifacts: readonly string[];
}

export type LedgerEventType =
  | "BUDGET_RESERVED"
  | "RUN_STARTED"
  | "RUN_FAILED"
  | "RUN_COMPLETED"
  | "RUN_PROMOTED"
  | "RUN_CANCELLED"
  | "RUN_QUARANTINED"
  | "WATCHDOG_EXPIRED"
  | "JOIN_TIMEOUT_OBSERVED"
  | "JOIN_RELEASED"
  | "JOIN_CLOSED"
  | "EVENT_REJECTED";

export interface LedgerEvent {
  readonly sequence: number;
  readonly type: LedgerEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventLedger {
  append(event: Omit<LedgerEvent, "sequence">): LedgerEvent;
  /** Optional durable boundary for reservation plus start; append is the compatibility fallback. */
  reserveAndStart?(reservation: Omit<LedgerEvent, "sequence">, started: Omit<LedgerEvent, "sequence">): readonly LedgerEvent[];
  events(): readonly LedgerEvent[];
}

function copy<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  }
}

function validIdentity(value: unknown): value is BranchRunIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as object;
  const branchId = ownValue(identity, "branchId");
  const runId = ownValue(identity, "runId");
  const attempt = ownValue(identity, "attempt");
  const workspaceId = ownValue(identity, "workspaceId");
  const fencingToken = ownValue(identity, "fencingToken");
  return typeof branchId === "string" && branchId !== ""
    && typeof runId === "string" && runId !== ""
    && typeof workspaceId === "string" && workspaceId !== ""
    && typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1
    && typeof fencingToken === "number" && Number.isSafeInteger(fencingToken) && fencingToken >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function validArtifact(value: unknown): value is BranchArtifact {
  if (!isRecord(value)) return false;
  const artifactId = ownValue(value, "artifactId");
  return typeof artifactId === "string" && artifactId !== "";
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function ledgerEventKey(event: LedgerEvent): string {
  let payload = "";
  try { payload = JSON.stringify(event.payload) ?? ""; } catch { payload = String(event.payload); }
  return `${String(event.sequence)}:${event.type}:${payload}`;
}

function scopeKey(missionId: string, branchIds: readonly string[], maxAttempts: number, maxUnits: number, policy: JoinPolicy): string {
  return JSON.stringify({
    missionId,
    branchIds,
    maxAttempts,
    maxUnits,
    required: policy.required,
    optional: policy.optional,
    quorum: policy.quorum,
    timeoutMs: policy.timeoutMs,
    terminalFailure: policy.terminalFailure,
  });
}

function frozenCopy<T>(value: T): Readonly<T> {
  const cloned = copy(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Reflect.ownKeys(entry as object)) freeze((entry as Record<PropertyKey, unknown>)[child]);
    Object.freeze(entry);
  };
  freeze(cloned);
  return cloned as Readonly<T>;
}

export class InMemoryEventLedger implements EventLedger {
  private readonly entries: LedgerEvent[] = [];

  append(event: Omit<LedgerEvent, "sequence">): LedgerEvent {
    const entry = frozenCopy({ sequence: this.entries.length + 1, type: event.type, payload: copy(event.payload) }) as LedgerEvent;
    this.entries.push(entry);
    return entry;
  }

  reserveAndStart(reservation: Omit<LedgerEvent, "sequence">, started: Omit<LedgerEvent, "sequence">): readonly LedgerEvent[] {
    const entries = [reservation, started].map((event, index) => frozenCopy({
      sequence: this.entries.length + index + 1, type: event.type, payload: copy(event.payload),
    }) as LedgerEvent);
    this.entries.push(...entries);
    return frozenCopy(entries);
  }

  events(): readonly LedgerEvent[] { return frozenCopy(this.entries); }
}

export interface BranchRecoveryOptions {
  readonly missionId: string;
  readonly branchIds: readonly string[];
  readonly maxAttempts?: number;
  readonly budget?: number;
  readonly maxUnits?: number;
  readonly joinPolicy?: JoinPolicy;
  readonly clock?: () => number;
}

interface MutableBranchState {
  branchId: string;
  status: BranchRunStatus;
  attempt: number;
  run?: BranchRunIdentity;
  artifact?: BranchArtifact;
  promoted: boolean;
  startedAt?: number;
  lastEventSequence: number;
}

const terminalStatuses = new Set<BranchRunStatus>(["PROMOTED", "CANCELLED", "QUARANTINED", "EXPIRED"]);
const identityEventTypes = new Set([
  "BUDGET_RESERVED", "RUN_STARTED", "RUN_FAILED", "RUN_COMPLETED", "RUN_PROMOTED",
  "RUN_CANCELLED", "RUN_QUARANTINED", "WATCHDOG_EXPIRED",
]);
const knownEventTypes = new Set<string>([
  ...identityEventTypes, "JOIN_TIMEOUT_OBSERVED", "JOIN_RELEASED", "JOIN_CLOSED", "EVENT_REJECTED",
]);
const ledgerScopes = new WeakMap<object, string>();

function validateJoinPolicy(policy: JoinPolicy, branchIds: readonly string[]): JoinPolicy {
  if (!Array.isArray(policy.required) || !Array.isArray(policy.optional)) throw new TypeError("join policy branch sets are required");
  const all = new Set(branchIds);
  const required = Object.freeze([...policy.required]);
  const optional = Object.freeze([...policy.optional]);
  if (new Set(required).size !== required.length || new Set(optional).size !== optional.length) throw new RangeError("join policy branch sets must be unique");
  if (required.some((id) => !all.has(id)) || optional.some((id) => !all.has(id))) throw new RangeError("join policy references an unknown branch");
  if (required.some((id) => optional.includes(id))) throw new RangeError("required and optional branches must be disjoint");
  if (required.length + optional.length !== branchIds.length) throw new RangeError("join policy must classify every branch as required or optional");
  finiteInteger("joinPolicy.quorum", policy.quorum);
  if (policy.quorum > branchIds.length) throw new RangeError("join policy quorum exceeds available branches");
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0) throw new RangeError("joinPolicy.timeoutMs must be finite and >= 0");
  if (typeof policy.terminalFailure !== "boolean") throw new TypeError("joinPolicy.terminalFailure must be boolean");
  return Object.freeze({ required, optional, quorum: policy.quorum, timeoutMs: policy.timeoutMs, terminalFailure: policy.terminalFailure });
}

export interface EventOptions {
  readonly eventId?: string;
  readonly sequence?: number;
}

/** A deterministic projection over an append-only ledger. The ledger is replaceable for durable storage. */
export class BranchRecoveryControlPlane {
  readonly ledger: EventLedger;
  readonly joinPolicy: JoinPolicy;
  private readonly missionId: string;
  private readonly maxAttempts: number;
  private readonly maxUnits: number;
  private readonly scopeId: string;
  private readonly ledgerScopeId: string;
  private readonly clock: () => number;
  private readonly branches: Map<string, MutableBranchState>;
  private remainingUnits: number;
  private nextFence: number;
  private readonly seenEventIds = new Set<string>();
  private readonly reservedIdentities = new Set<string>();
  private readonly startedIdentities = new Set<string>();
  private readonly startedAtByIdentity = new Map<string, number>();
  private readonly timeoutObservations = new Map<string, number>();
  private readonly processedEvents = new Set<string>();
  private readonly replayRejectionKeys = new Set<string>();
  private readonly seenLedgerSequences = new Set<number>();
  private lastLedgerSequence = 0;
  private readonly pendingReservations = new Map<string, BranchRunIdentity>();
  private readonly joinState: {
    released: boolean;
    closed: boolean;
    reason?: string;
    requiredArtifacts?: readonly string[];
    optionalArtifacts?: readonly string[];
  } = { released: false, closed: false };

  constructor(options: BranchRecoveryOptions, ledger: EventLedger = new InMemoryEventLedger()) {
    if (typeof options.missionId !== "string" || options.missionId === "") throw new TypeError("missionId is required");
    if (options.branchIds.length === 0 || new Set(options.branchIds).size !== options.branchIds.length || options.branchIds.some((id) => typeof id !== "string" || id === "")) {
      throw new RangeError("branchIds must contain unique, non-empty strings");
    }
    this.missionId = options.missionId;
    this.maxAttempts = options.maxAttempts ?? 1;
    this.maxUnits = options.maxUnits ?? options.budget ?? options.branchIds.length;
    finiteInteger("maxAttempts", this.maxAttempts);
    finiteInteger("budget", this.maxUnits);
    this.clock = options.clock ?? (() => Date.now());
    this.joinPolicy = validateJoinPolicy(options.joinPolicy ?? {
      required: [...options.branchIds], optional: [], quorum: 1, timeoutMs: Number.MAX_SAFE_INTEGER, terminalFailure: true,
    }, options.branchIds);
    this.scopeId = scopeKey(this.missionId, options.branchIds, this.maxAttempts, this.maxUnits, this.joinPolicy);
    this.ledgerScopeId = ledgerScopes.get(ledger) ?? this.scopeId;
    if (!ledgerScopes.has(ledger)) ledgerScopes.set(ledger, this.scopeId);
    this.ledger = ledger;
    this.remainingUnits = this.maxUnits;
    this.nextFence = 1;
    this.branches = new Map(options.branchIds.map((branchId) => [branchId, {
      branchId, status: "QUEUED", attempt: 0, promoted: false, lastEventSequence: 0,
    }]));
    const events = ledger.events();
    for (const event of events) {
      const payload = isRecord(event?.payload) ? event.payload : undefined;
      if (event?.type === "EVENT_REJECTED" && typeof payload?.sourceEventKey === "string" && payload && this.scopeMatches(payload)) {
        this.replayRejectionKeys.add(this.rejectionKey(payload.sourceEventKey));
      }
    }
    this.replay(events);
  }

  private append(type: LedgerEventType, payload: Record<string, unknown>): LedgerEvent {
    const event = this.ledger.append({ type, payload: copy({ ...payload, missionId: this.missionId, scopeId: this.scopeId }) });
    this.replay([event]);
    return event;
  }

  private rejectionKey(sourceEventKey: string): string {
    return `${this.scopeId}\u0000${sourceEventKey}`;
  }

  private replayReject(event: LedgerEvent, reason: string, payload: Record<string, unknown> = {}): void {
    const sourceEventKey = ledgerEventKey(event);
    const rejectionKey = this.rejectionKey(sourceEventKey);
    if (this.replayRejectionKeys.has(rejectionKey)) return;
    this.replayRejectionKeys.add(rejectionKey);
    this.append("EVENT_REJECTED", { ...payload, reason, sourceEventKey, sourceType: event.type, sourceSequence: event.sequence });
  }

  private sync(): void {
    this.replay(this.ledger.events());
  }

  private identityMatchesMission(identity: BranchRunIdentity): boolean {
    return identity.runId.startsWith(`${this.missionId}:${identity.branchId}:`)
      && identity.workspaceId.startsWith(`${this.missionId}:${identity.branchId}:`);
  }

  private scopeMatches(payload: Record<string, unknown>): boolean {
    const hasMission = Object.prototype.hasOwnProperty.call(payload, "missionId");
    const hasScope = Object.prototype.hasOwnProperty.call(payload, "scopeId");
    const identity = ownValue(payload, "identity");
    if (hasMission || hasScope) {
      if (!hasMission || !hasScope || payload.missionId !== this.missionId || payload.scopeId !== this.scopeId) return false;
      if (!validIdentity(identity) || this.identityMatchesMission(identity)) return true;
      const branch = this.branches.get(identity.branchId);
      return (!!branch?.run && this.matchesCurrent(branch, identity))
        || this.pendingReservations.get(identity.branchId) !== undefined
          && this.reservationKey(this.pendingReservations.get(identity.branchId)!) === this.reservationKey(identity);
    }
    if (this.ledgerScopeId !== this.scopeId) return false;
    if (validIdentity(identity) && !this.identityMatchesMission(identity)) return false;
    return true;
  }

  private settleJoin(): void {
    if (this.joinState.released || this.joinState.closed) return;
    const decision = this.calculateJoin();
    if (!decision.closed) return;
    const now = this.clock();
    const timedOut = [...this.branches.values()]
      .filter((branch) => branch.status === "RUNNING" && branch.run && branch.startedAt !== undefined
        && now - branch.startedAt >= this.joinPolicy.timeoutMs)
      .map((branch) => branch.run!);
    const missingEvidence = timedOut.filter((identity) => !this.timeoutObservations.has(this.reservationKey(identity)));
    if (missingEvidence.length > 0) this.append("JOIN_TIMEOUT_OBSERVED", { observedAt: now, identities: missingEvidence });
    const observedAt = timedOut.map((identity) => this.timeoutObservations.get(this.reservationKey(identity)))
      .filter((value): value is number => value !== undefined);
    this.append("JOIN_CLOSED", {
      reason: decision.reason,
      closedAt: observedAt.length > 0 ? Math.min(now, ...observedAt) : now,
      requiredArtifacts: decision.requiredArtifacts,
      optionalArtifacts: decision.optionalArtifacts,
    });
  }

  private reject(reason: string, payload: Record<string, unknown> = {}): false {
    this.append("EVENT_REJECTED", { ...payload, reason });
    return false;
  }

  private branchFor(identity: BranchRunIdentity): MutableBranchState | undefined {
    return validIdentity(identity) ? this.branches.get(identity.branchId) : undefined;
  }

  private matchesCurrent(branch: MutableBranchState, identity: BranchRunIdentity): boolean {
    return !!branch.run && branch.run.runId === identity.runId && branch.run.workspaceId === identity.workspaceId
      && branch.run.attempt === identity.attempt && branch.run.fencingToken === identity.fencingToken;
  }

  private acceptEvent(branch: MutableBranchState, identity: BranchRunIdentity, options: EventOptions): boolean {
    if (!validIdentity(identity)) return this.reject("invalid or non-finite run identity", { branchId: (identity as unknown as Record<string, unknown> | undefined)?.branchId });
    if (!this.matchesCurrent(branch, identity)) return this.reject("stale fencing token or run identity", { branchId: identity.branchId, runId: identity.runId, fencingToken: identity.fencingToken });
    if (options.eventId !== undefined && (typeof options.eventId !== "string" || options.eventId === "")) return this.reject("invalid event id", { branchId: identity.branchId });
    if (options.eventId !== undefined && this.seenEventIds.has(options.eventId)) return this.reject("duplicate event id", { branchId: identity.branchId, eventId: options.eventId });
    if (options.sequence !== undefined && (!Number.isSafeInteger(options.sequence) || options.sequence < 1 || options.sequence <= branch.lastEventSequence)) {
      return this.reject("out-of-order event sequence", { branchId: identity.branchId, sequence: options.sequence });
    }
    return true;
  }

  private eventMetadata(options: EventOptions): Record<string, unknown> {
    return {
      ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
      ...(options.sequence === undefined ? {} : { eventSequence: options.sequence }),
    };
  }

  private reservationKey(identity: BranchRunIdentity): string {
    return `${identity.branchId}\u0000${identity.runId}\u0000${identity.workspaceId}\u0000${identity.attempt}\u0000${identity.fencingToken}`;
  }

  private appendReservationAndStart(identity: BranchRunIdentity): boolean {
    const reservation = { type: "BUDGET_RESERVED" as const, payload: { identity, units: 1, missionId: this.missionId, scopeId: this.scopeId } };
    const started = { type: "RUN_STARTED" as const, payload: { identity, startedAt: this.clock(), missionId: this.missionId, scopeId: this.scopeId } };
    if (this.ledger.reserveAndStart) this.replay(this.ledger.reserveAndStart(reservation, started));
    else {
      this.append("BUDGET_RESERVED", reservation.payload);
      this.append("RUN_STARTED", started.payload);
    }
    const branch = this.branches.get(identity.branchId);
    return !!branch && branch.status === "RUNNING" && this.matchesCurrent(branch, identity);
  }

  startRun(branchId: string): BranchRunIdentity | undefined {
    this.sync();
    const branch = this.branches.get(branchId);
    if (!branch) { this.reject("unknown branch", { branchId }); return undefined; }
    if (this.joinState.closed) { this.reject("join is closed", { branchId }); return undefined; }
    if (branch.run && branch.status === "RUNNING") return frozenCopy(branch.run);
    if (branch.status === "COMPLETED") return undefined;
    if (terminalStatuses.has(branch.status)) { this.reject("branch is terminal and cannot be retried", { branchId }); return undefined; }
    if (branch.status === "FAILED" && branch.attempt >= this.maxAttempts) { this.reject("max attempts exhausted", { branchId }); return undefined; }
    if (branch.attempt >= this.maxAttempts) { this.reject("max attempts exhausted", { branchId }); return undefined; }
    const pending = this.pendingReservations.get(branchId);
    if (pending) {
      if (pending.attempt > this.maxAttempts) { this.reject("max attempts exhausted", { branchId }); return undefined; }
      this.append("RUN_STARTED", { identity: pending, startedAt: this.clock() });
      const current = this.branches.get(branchId);
      if (!current || current.status !== "RUNNING" || !this.matchesCurrent(current, pending)) {
        this.reject("run start rejected", { branchId });
        return undefined;
      }
      return frozenCopy(pending);
    }
    if (this.remainingUnits < 1) { this.reject("budget exhausted", { branchId }); return undefined; }
    if (!Number.isSafeInteger(this.nextFence) || this.nextFence >= Number.MAX_SAFE_INTEGER) {
      this.reject("fencing token exhausted", { branchId });
      return undefined;
    }
    const attempt = branch.attempt + 1;
    const fencingToken = this.nextFence;
    const identity = Object.freeze({
      branchId, attempt, fencingToken,
      runId: `${this.missionId}:${branchId}:run-${attempt}`,
      workspaceId: `${this.missionId}:${branchId}:workspace-${attempt}`,
    });
    if (!this.appendReservationAndStart(identity)) {
      this.reject("run start rejected", { branchId, fencingToken });
      return undefined;
    }
    return frozenCopy(identity);
  }

  retry(identity: BranchRunIdentity, reason: "infrastructure" | "cancel" | "quarantine" | "watchdog"): BranchRunIdentity | undefined {
    this.sync();
    const branch = this.branchFor(identity);
    if (!branch) { this.reject("invalid or non-finite run identity"); return undefined; }
    if (this.joinState.closed) { this.reject("join is closed", { branchId: identity.branchId }); return undefined; }
    if (!this.matchesCurrent(branch, identity) || branch.status !== "RUNNING") { this.reject("retry rejected for stale or non-running run", { branchId: identity.branchId }); return undefined; }
    if (reason !== "infrastructure") { this.reject("only infrastructure failure is retryable", { branchId: identity.branchId, reason }); return undefined; }
    this.append("RUN_FAILED", { identity, reason });
    const failedBranch = this.branches.get(identity.branchId);
    if (!failedBranch || failedBranch.status !== "FAILED" || !this.matchesCurrent(failedBranch, identity)) {
      this.reject("run failure rejected", { branchId: identity.branchId });
      return undefined;
    }
    if (branch.attempt >= this.maxAttempts || this.remainingUnits < 1) {
      this.settleJoin();
      return undefined;
    }
    return this.startRun(identity.branchId);
  }

  complete(identity: BranchRunIdentity, artifact?: BranchArtifact, options: EventOptions = {}): boolean {
    this.sync();
    const branch = this.branchFor(identity);
    if (!branch) return this.reject("invalid or non-finite run identity");
    if (this.joinState.closed) return this.reject("join is closed", { branchId: identity.branchId });
    if (!this.acceptEvent(branch, identity, options)) return false;
    if (branch.status !== "RUNNING") return this.reject("run is not running", { branchId: identity.branchId });
    if (artifact !== undefined && !validArtifact(artifact)) return this.reject("missing or invalid artifact", { branchId: identity.branchId });
    this.append("RUN_COMPLETED", { identity, ...this.eventMetadata(options), ...(artifact ? { artifact: copy(artifact) } : {}) });
    const completedBranch = this.branches.get(identity.branchId);
    if (!completedBranch || completedBranch.status !== "COMPLETED" || !this.matchesCurrent(completedBranch, identity)
      || (artifact ? completedBranch.artifact?.artifactId !== artifact.artifactId : completedBranch.artifact !== undefined)) {
      return this.reject("completion rejected", { branchId: identity.branchId });
    }
    this.settleJoin();
    return true;
  }

  promote(identity: BranchRunIdentity, options: EventOptions = {}): boolean {
    this.sync();
    const branch = this.branchFor(identity);
    if (!branch) return this.reject("invalid or non-finite run identity");
    if (this.joinState.closed) return this.reject("join is closed", { branchId: identity.branchId });
    if (!this.acceptEvent(branch, identity, options)) return false;
    if (branch.status !== "COMPLETED" || !branch.artifact) return this.reject("promotion requires a completed run with an artifact", { branchId: identity.branchId });
    this.append("RUN_PROMOTED", { identity, ...this.eventMetadata(options) });
    const promotedBranch = this.branches.get(identity.branchId);
    if (!promotedBranch || promotedBranch.status !== "PROMOTED" || !this.matchesCurrent(promotedBranch, identity)) {
      return this.reject("promotion rejected", { branchId: identity.branchId });
    }
    this.settleJoin();
    return true;
  }

  cancel(identity: BranchRunIdentity): boolean { return this.terminal(identity, "RUN_CANCELLED", "cancelled"); }
  quarantine(identity: BranchRunIdentity): boolean { return this.terminal(identity, "RUN_QUARANTINED", "quarantined"); }

  private terminal(identity: BranchRunIdentity, type: "RUN_CANCELLED" | "RUN_QUARANTINED", reason: string): boolean {
    this.sync();
    const branch = this.branchFor(identity);
    if (!branch) return this.reject("invalid or non-finite run identity");
    if (this.joinState.closed) return this.reject("join is closed", { branchId: identity.branchId, reason });
    if (!this.matchesCurrent(branch, identity) || branch.status !== "RUNNING") return this.reject("late terminal event rejected", { branchId: identity.branchId, reason });
    this.append(type, { identity, reason });
    const expected = type === "RUN_CANCELLED" ? "CANCELLED" : "QUARANTINED";
    const terminalBranch = this.branches.get(identity.branchId);
    if (!terminalBranch || terminalBranch.status !== expected || !this.matchesCurrent(terminalBranch, identity)) {
      return this.reject("terminal event rejected", { branchId: identity.branchId, reason });
    }
    this.settleJoin();
    return true;
  }

  watchdog(): number {
    this.sync();
    let expired = 0;
    const now = this.clock();
    for (const branch of this.branches.values()) {
      if (branch.status !== "RUNNING" || branch.startedAt === undefined || now - branch.startedAt < this.joinPolicy.timeoutMs) continue;
      this.append("WATCHDOG_EXPIRED", { identity: branch.run!, reason: "watchdog expiry", expiredAt: now });
      if (this.branches.get(branch.branchId)?.status === "EXPIRED") expired += 1;
    }
    this.settleJoin();
    return expired;
  }

  join(): JoinDecision {
    this.sync();
    this.settleJoin();
    const decision = this.calculateJoin();
    if (!decision.closed && !decision.released && decision.reason === "quorum satisfied; release pending") {
      this.append("JOIN_RELEASED", {
        requiredArtifacts: decision.requiredArtifacts,
        optionalArtifacts: decision.optionalArtifacts,
      });
    } else {
      this.settleJoin();
    }
    return this.calculateJoin();
  }

  releaseDownstream(): boolean { return this.join().released; }

  private calculateJoin(): JoinDecision {
    const artifacts = (ids: readonly string[]) => ids.filter((id) => {
      const branch = this.branches.get(id);
      return !!branch?.artifact && (branch.status === "COMPLETED" || branch.status === "PROMOTED");
    });
    const requiredArtifacts = artifacts(this.joinPolicy.required);
    const optionalArtifacts = artifacts(this.joinPolicy.optional);
    const count = requiredArtifacts.length + optionalArtifacts.length;
    if (this.joinState.released) return {
      released: true,
      closed: false,
      reason: "quorum satisfied",
      requiredArtifacts: this.joinState.requiredArtifacts ?? requiredArtifacts,
      optionalArtifacts: this.joinState.optionalArtifacts ?? optionalArtifacts,
    };
    if (this.joinState.closed) return {
      released: false,
      closed: true,
      reason: this.joinState.reason ?? "join terminal failure",
      requiredArtifacts: this.joinState.requiredArtifacts ?? requiredArtifacts,
      optionalArtifacts: this.joinState.optionalArtifacts ?? optionalArtifacts,
    };
    if (requiredArtifacts.length === this.joinPolicy.required.length && count >= this.joinPolicy.quorum) {
      return { released: false, closed: false, reason: "quorum satisfied; release pending", requiredArtifacts, optionalArtifacts };
    }
    const canStillProduce = (branch: MutableBranchState): boolean => {
      if (branch.artifact) return false;
      if (this.pendingReservations.has(branch.branchId) || branch.status === "RUNNING") return true;
      if (this.remainingUnits < 1) return false;
      return branch.status === "QUEUED" || (branch.status === "FAILED" && branch.attempt < this.maxAttempts);
    };
    const requiredTerminal = this.joinPolicy.required.some((id) => {
      const branch = this.branches.get(id);
      return !!branch && !artifacts([id]).length && !canStillProduce(branch);
    });
    const timedOut = [...this.branches.values()].some((branch) => branch.status === "RUNNING" && branch.startedAt !== undefined && this.clock() - branch.startedAt >= this.joinPolicy.timeoutMs);
    const available = count;
    const inFlight = [...this.branches.values()].filter((branch) => !branch.artifact && (this.pendingReservations.has(branch.branchId) || branch.status === "RUNNING")).length;
    const newlyStartable = [...this.branches.values()].filter((branch) => canStillProduce(branch)
      && !this.pendingReservations.has(branch.branchId) && branch.status !== "RUNNING").length;
    const possible = available + inFlight + Math.min(newlyStartable, this.remainingUnits);
    const closed = this.joinPolicy.terminalFailure && (requiredTerminal || timedOut || possible < this.joinPolicy.quorum);
    return { released: false, closed, reason: closed ? "join terminal failure" : "join waiting for required artifacts or quorum", requiredArtifacts, optionalArtifacts };
  }

  state(): ControlPlaneState {
    this.sync();
    this.settleJoin();
    const branches = Object.fromEntries([...this.branches].map(([id, branch]) => [id, frozenCopy({ branchId: id, status: branch.status, attempt: branch.attempt, run: branch.run, artifact: branch.artifact, promoted: branch.promoted })]));
    return frozenCopy({ missionId: this.missionId, branches, budget: { maxAttempts: this.maxAttempts, maxUnits: this.maxUnits, remainingUnits: this.remainingUnits }, join: this.calculateJoin() });
  }

  audit(): readonly LedgerEvent[] {
    this.sync();
    return frozenCopy(this.ledger.events().filter((event) => event.type === "EVENT_REJECTED"
      && isRecord(event.payload) && this.scopeMatches(event.payload)));
  }
  events(): readonly LedgerEvent[] {
    this.sync();
    return frozenCopy(this.ledger.events());
  }

  private replay(events: readonly LedgerEvent[]): void {
    const pending: Array<{ event: LedgerEvent; payload: Record<string, unknown>; key: string; sequenceIssue?: string }> = [];
    for (const rawEvent of events) {
      if (!isRecord(rawEvent)) continue;
      const event = rawEvent as unknown as LedgerEvent;
      const key = ledgerEventKey(event);
      if (this.processedEvents.has(key)) continue;
      this.processedEvents.add(key);
      pending.push({ event, payload: isRecord(event.payload) ? event.payload : {}, key });
    }

    let previousSequence = this.lastLedgerSequence;
    for (const item of pending) {
      const sequence = item.event.sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        item.sequenceIssue = "invalid ledger sequence";
        continue;
      }
      if (this.seenLedgerSequences.has(sequence)) item.sequenceIssue = "duplicate ledger sequence";
      else if (sequence < previousSequence) item.sequenceIssue = "out-of-order ledger sequence";
      this.seenLedgerSequences.add(sequence);
      if (sequence > previousSequence) previousSequence = sequence;
    }
    this.lastLedgerSequence = Math.max(this.lastLedgerSequence, previousSequence);

    for (const item of pending) {
      const { event, payload: p } = item;
      if (event.type === "EVENT_REJECTED") continue;
      if (item.sequenceIssue) {
        this.replayReject(event, item.sequenceIssue);
        continue;
      }
      if (!this.scopeMatches(p)) {
        this.replayReject(event, "event belongs to another mission or ledger scope");
        continue;
      }
      if (!knownEventTypes.has(event.type)) {
        this.replayReject(event, "unknown ledger event type");
        continue;
      }

      if (event.type === "JOIN_TIMEOUT_OBSERVED") {
        if (this.joinState.closed || this.joinState.released) {
          this.replayReject(event, "conflicting timeout observation event");
          continue;
        }
        const observedAt = p.observedAt;
        const identities = p.identities;
        const parsed = Array.isArray(identities) && identities.every(validIdentity) ? identities as BranchRunIdentity[] : undefined;
        const unique = parsed && new Set(parsed.map((identity) => this.reservationKey(identity))).size === parsed.length;
        const valid = typeof observedAt === "number" && Number.isFinite(observedAt) && !!parsed && parsed.length > 0 && unique
          && parsed.every((identity) => {
            const branch = this.branches.get(identity.branchId);
            return !!branch && branch.status === "RUNNING" && this.matchesCurrent(branch, identity)
              && branch.startedAt !== undefined && Number.isFinite(branch.startedAt)
              && Number.isFinite(observedAt - branch.startedAt)
              && observedAt - branch.startedAt >= this.joinPolicy.timeoutMs;
          });
        if (!valid) {
          this.replayReject(event, "invalid timeout observation event");
          continue;
        }
        for (const identity of parsed) {
          const key = this.reservationKey(identity);
          this.timeoutObservations.set(key, Math.max(this.timeoutObservations.get(key) ?? Number.NEGATIVE_INFINITY, observedAt));
        }
        continue;
      }

      if (event.type === "JOIN_RELEASED") {
        if (this.joinState.closed || this.joinState.released) {
          this.replayReject(event, "conflicting join release event");
          continue;
        }
        const decision = this.calculateJoin();
        if (decision.reason !== "quorum satisfied; release pending"
          || !sameStrings(p.requiredArtifacts, decision.requiredArtifacts)
          || !sameStrings(p.optionalArtifacts, decision.optionalArtifacts)) {
          this.replayReject(event, "invalid join release event");
          continue;
        }
        this.joinState.released = true;
        this.joinState.requiredArtifacts = Object.freeze([...decision.requiredArtifacts]);
        this.joinState.optionalArtifacts = Object.freeze([...decision.optionalArtifacts]);
        continue;
      }

      if (event.type === "JOIN_CLOSED") {
        if (this.joinState.released || this.joinState.closed) {
          this.replayReject(event, "conflicting join closure event");
          continue;
        }
        const decision = this.calculateJoin();
        const closedAtValid = p.closedAt === undefined || (typeof p.closedAt === "number" && Number.isFinite(p.closedAt));
        const closedAt = typeof p.closedAt === "number" ? p.closedAt : undefined;
        const observedAt = [...this.timeoutObservations.values()].reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
        const historicalTimeout = decision.reason !== "quorum satisfied; release pending"
          && observedAt !== Number.NEGATIVE_INFINITY
          && (closedAt === undefined || closedAt <= observedAt);
        const artifactsMatch = (p.requiredArtifacts === undefined || sameStrings(p.requiredArtifacts, decision.requiredArtifacts))
          && (p.optionalArtifacts === undefined || sameStrings(p.optionalArtifacts, decision.optionalArtifacts));
        if (!this.joinPolicy.terminalFailure || p.reason !== "join terminal failure" || !closedAtValid || !artifactsMatch
          || (!decision.closed && !historicalTimeout)) {
          this.replayReject(event, "invalid join closure event");
          continue;
        }
        this.joinState.closed = true;
        this.joinState.reason = "join terminal failure";
        this.joinState.requiredArtifacts = Object.freeze([...decision.requiredArtifacts]);
        this.joinState.optionalArtifacts = Object.freeze([...decision.optionalArtifacts]);
        continue;
      }

      if (!identityEventTypes.has(event.type)) continue;
      const identity = p.identity;
      if (!validIdentity(identity)) {
        this.replayReject(event, "invalid or non-finite run identity");
        continue;
      }
      const branch = this.branches.get(identity.branchId);
      if (!branch) {
        this.replayReject(event, "unknown branch", { branchId: identity.branchId });
        continue;
      }
      const key = this.reservationKey(identity);
      const metadataIsFresh = (): boolean => {
        if (p.eventId !== undefined && (typeof p.eventId !== "string" || p.eventId === "" || this.seenEventIds.has(p.eventId))) return false;
        if (p.eventSequence !== undefined && (typeof p.eventSequence !== "number" || !Number.isSafeInteger(p.eventSequence)
          || p.eventSequence < 1 || p.eventSequence <= branch.lastEventSequence)) return false;
        return true;
      };
      const recordMetadata = (): void => {
        if (typeof p.eventId === "string" && p.eventId !== "") this.seenEventIds.add(p.eventId);
        if (typeof p.eventSequence === "number" && Number.isSafeInteger(p.eventSequence) && p.eventSequence > branch.lastEventSequence) {
          branch.lastEventSequence = p.eventSequence;
        }
      };
      const rejectEvent = (reason: string): void => this.replayReject(event, reason, {
        branchId: identity.branchId, runId: identity.runId, fencingToken: identity.fencingToken,
      });
      if (this.joinState.closed && event.type !== "WATCHDOG_EXPIRED") {
        rejectEvent("join is closed");
        continue;
      }

      switch (event.type) {
        case "BUDGET_RESERVED": {
          if (this.reservedIdentities.has(key)) {
            if (p.units !== 1) rejectEvent("conflicting duplicate budget reservation");
            break;
          }
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (p.units !== 1) { rejectEvent("budget reservation must reserve one unit"); break; }
          if (branch.status === "RUNNING" || branch.status === "COMPLETED" || terminalStatuses.has(branch.status)) {
            rejectEvent("budget reservation is not legal for the current branch state");
            break;
          }
          if (this.pendingReservations.has(branch.branchId)) { rejectEvent("branch already has a pending reservation"); break; }
          if (identity.attempt > this.maxAttempts || identity.attempt !== branch.attempt + 1) {
            rejectEvent("budget reservation attempt is not the next attempt");
            break;
          }
          if (identity.fencingToken >= Number.MAX_SAFE_INTEGER || identity.fencingToken < this.nextFence
            || identity.fencingToken <= (branch.run?.fencingToken ?? 0)) {
            rejectEvent("budget reservation has a stale or exhausted fencing token");
            break;
          }
          if (this.remainingUnits < 1) { rejectEvent("budget exhausted"); break; }
          this.reservedIdentities.add(key);
          this.remainingUnits -= 1;
          this.pendingReservations.set(branch.branchId, frozenCopy(identity));
          this.nextFence = identity.fencingToken + 1;
          recordMetadata();
          break;
        }
        case "RUN_STARTED": {
          if (this.startedIdentities.has(key)) {
            const startedAt = this.startedAtByIdentity.get(key);
            if (typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt) || p.startedAt !== startedAt) {
              rejectEvent("conflicting duplicate run start");
            }
            break;
          }
          const pendingReservation = this.pendingReservations.get(branch.branchId);
          if (!pendingReservation || this.reservationKey(pendingReservation) !== key) {
            rejectEvent("run start missing matching budget reservation");
            break;
          }
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (branch.status === "RUNNING" || branch.status === "COMPLETED" || terminalStatuses.has(branch.status)) {
            rejectEvent("run start is not legal for the current branch state");
            break;
          }
          if (identity.attempt > this.maxAttempts || identity.attempt !== branch.attempt + 1) {
            rejectEvent("run start attempt is not the next attempt");
            break;
          }
          if (identity.fencingToken <= (branch.run?.fencingToken ?? 0)) {
            rejectEvent("run start has a stale fencing token");
            break;
          }
          if (typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt)) {
            rejectEvent("run start timestamp is invalid");
            break;
          }
          branch.attempt = identity.attempt;
          branch.run = frozenCopy(identity);
          branch.status = "RUNNING";
          branch.startedAt = p.startedAt;
          this.pendingReservations.delete(branch.branchId);
          this.startedIdentities.add(key);
          this.startedAtByIdentity.set(key, p.startedAt);
          recordMetadata();
          break;
        }
        case "RUN_FAILED":
          if (p.reason !== "infrastructure") { rejectEvent("only infrastructure failures are retryable"); break; }
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("stale fencing token or run identity"); break; }
          if (branch.status !== "RUNNING") { rejectEvent("run is not running"); break; }
          branch.status = "FAILED";
          recordMetadata();
          break;
        case "RUN_COMPLETED": {
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("stale fencing token or run identity"); break; }
          if (branch.status !== "RUNNING") { rejectEvent("run is not running"); break; }
          if (Object.prototype.hasOwnProperty.call(p, "artifact") && p.artifact !== undefined && !validArtifact(p.artifact)) {
            rejectEvent("missing or invalid artifact");
            break;
          }
          branch.status = "COMPLETED";
          branch.artifact = validArtifact(p.artifact) ? frozenCopy(p.artifact) : undefined;
          recordMetadata();
          break;
        }
        case "RUN_PROMOTED":
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("stale fencing token or run identity"); break; }
          if (branch.status !== "COMPLETED" || !branch.artifact) {
            rejectEvent("promotion requires a completed run with an artifact");
            break;
          }
          branch.status = "PROMOTED";
          branch.promoted = true;
          recordMetadata();
          break;
        case "RUN_CANCELLED":
          if (p.reason !== "cancelled") { rejectEvent("invalid cancellation reason"); break; }
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("late terminal event rejected"); break; }
          if (branch.status !== "RUNNING") { rejectEvent("late terminal event rejected"); break; }
          branch.status = "CANCELLED";
          recordMetadata();
          break;
        case "RUN_QUARANTINED":
          if (p.reason !== "quarantined") { rejectEvent("invalid quarantine reason"); break; }
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("late terminal event rejected"); break; }
          if (branch.status !== "RUNNING") { rejectEvent("late terminal event rejected"); break; }
          branch.status = "QUARANTINED";
          recordMetadata();
          break;
        case "WATCHDOG_EXPIRED": {
          if (!metadataIsFresh()) { rejectEvent("stale or duplicate event metadata"); break; }
          if (!this.matchesCurrent(branch, identity)) { rejectEvent("late watchdog event rejected"); break; }
          if (branch.status !== "RUNNING") { rejectEvent("late watchdog event rejected"); break; }
          const expiredAt = p.expiredAt === undefined ? this.clock() : p.expiredAt;
          if (p.reason !== "watchdog expiry" || typeof expiredAt !== "number" || !Number.isFinite(expiredAt)
            || branch.startedAt === undefined || expiredAt - branch.startedAt < this.joinPolicy.timeoutMs) {
            rejectEvent("watchdog event is premature or malformed");
            break;
          }
          branch.status = "EXPIRED";
          this.timeoutObservations.set(key, Math.max(this.timeoutObservations.get(key) ?? Number.NEGATIVE_INFINITY, expiredAt));
          recordMetadata();
          break;
        }
      }
    }
  }
}

export { BranchRecoveryControlPlane as BranchRunControlPlane };
