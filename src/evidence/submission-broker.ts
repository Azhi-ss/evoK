import { isDeepStrictEqual } from "node:util";
import {
  HumanAcceptanceGate,
  SecretRedactor,
  assertSnapshotIntegrity,
  deepFreeze,
} from "../security-boundary";
import type { CandidateSnapshot } from "../toy-harness";

export type SubmissionMode = "dry-run" | "external";
export type SubmissionStatus = "PENDING" | "APPROVED" | "DRY_RUN" | "SUCCEEDED" | "FAILED" | "REJECTED";

export type SubmissionRejectionCode =
  | "invalid-request"
  | "mission-mismatch"
  | "champion-not-found"
  | "champion-not-eligible"
  | "competition-not-allowlisted"
  | "target-not-allowlisted"
  | "artifact-digest-mismatch"
  | "artifact-not-allowlisted"
  | "credential-required"
  | "credential-scope-denied"
  | "credential-expired"
  | "request-expired"
  | "human-acceptance-required"
  | "human-acceptance-expired"
  | "approval-mismatch"
  | "rate-limit-exceeded"
  | "submission-quota-exhausted"
  | "gain-below-threshold"
  | "destination-unavailable"
  | "request-not-found"
  | "request-id-conflict"
  | "request-already-completed";

export class SubmissionRejected extends Error {
  readonly retryable = false;

  constructor(
    readonly code: SubmissionRejectionCode,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "SubmissionRejected";
  }
}

export interface SubmissionArtifact {
  readonly artifactId?: string;
  readonly address?: string;
  readonly digest: string;
  /** Runtime-only material passed to the destination; it is never put in the ledger. */
  readonly payload?: unknown;
}

export interface SubmissionChampion {
  readonly missionId: string;
  readonly competition?: string;
  readonly branchId: string;
  /** Evaluator-owned score of the champion; required for gain-threshold checks. */
  readonly score?: number;
  readonly championDigest?: string;
  /** Alias accepted for adapters that call the champion identity simply `digest`. */
  readonly digest?: string;
  readonly artifactDigest?: string;
  readonly artifact?: SubmissionArtifact;
  readonly snapshot?: Readonly<CandidateSnapshot>;
  readonly evaluatorSucceeded?: boolean;
  readonly evaluatorPassed?: boolean;
  readonly successAuditorPassed?: boolean;
  readonly successAudited?: boolean;
  readonly promotionApproved?: boolean;
  readonly promoted?: boolean;
  readonly verification?: Readonly<Record<string, boolean>>;
  readonly status?: string;
}

export interface SubmissionCredential {
  readonly id: string;
  readonly scopes?: readonly string[];
  readonly scope?: string;
  readonly expiresAt?: number;
  readonly competition?: string;
  readonly target?: string;
  /** The broker never records this value in provenance events. */
  readonly token?: string;
}

export interface SubmissionRequestInput {
  readonly missionId: string;
  readonly competition?: string;
  readonly competitionId?: string;
  readonly target?: string;
  readonly destinationTarget?: string;
  readonly champion?: SubmissionChampion;
  readonly localChampion?: SubmissionChampion;
  readonly candidate?: SubmissionChampion;
  readonly artifact?: SubmissionArtifact;
  readonly artifactRef?: SubmissionArtifact;
  readonly artifactDigest?: string;
  readonly artifactId?: string;
  readonly artifactAddress?: string;
  readonly credential?: SubmissionCredential;
  readonly credentialScopes?: readonly string[];
  readonly requiredCredentialScopes?: readonly string[];
  readonly credentialScope?: string;
  readonly dryRun?: boolean;
  readonly expiresAt?: number;
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export interface SubmissionRequest {
  readonly requestId: string;
  readonly missionId: string;
  readonly competition: string;
  readonly competitionId: string;
  readonly target: string;
  readonly championDigest: string;
  readonly artifactDigest: string;
  readonly artifactId?: string;
  readonly artifactAddress?: string;
  readonly credentialId?: string;
  readonly credentialScopes: readonly string[];
  readonly requestedAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly dryRun: boolean;
  readonly mode: SubmissionMode;
  readonly status: SubmissionStatus;
  readonly reason?: string;
}

export interface SubmissionApproval {
  readonly requestId: string;
  readonly decisionId: string;
  readonly championDigest: string;
  readonly artifactDigest: string;
  readonly acceptedBy: string;
  readonly acceptedAt: number;
  readonly expiresAt: number;
  readonly reason?: string;
}

export interface SubmissionDestinationInput {
  readonly request: Readonly<SubmissionRequest>;
  readonly submission?: Readonly<SubmissionRequest>;
  readonly artifact: Readonly<SubmissionArtifact>;
  readonly credential: Readonly<SubmissionCredential>;
  readonly requestId?: string;
  readonly competition?: string;
  readonly target?: string;
  readonly artifactDigest?: string;
}

export interface SubmissionDestinationResult {
  readonly submissionId?: string;
  readonly [key: string]: unknown;
}

export type SubmissionDestinationHandler = (
  input: SubmissionDestinationInput,
  artifact?: Readonly<SubmissionArtifact>,
  credential?: Readonly<SubmissionCredential>,
) => SubmissionDestinationResult | Promise<SubmissionDestinationResult>;

export interface SubmissionDestination {
  readonly submit?: SubmissionDestinationHandler;
  readonly send?: SubmissionDestinationHandler;
}

export type SubmissionEventType =
  | "SUBMISSION_REQUESTED"
  | "HUMAN_ACCEPTED"
  | "SUBMISSION_APPROVED"
  | "SUBMISSION_REJECTED"
  | "SUBMISSION_RESULT";

export interface SubmissionEvent {
  readonly sequence?: number;
  readonly type: SubmissionEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SubmissionEventSink {
  append(event: { readonly type: SubmissionEventType; readonly payload: Record<string, unknown> }): unknown;
  events?(): readonly SubmissionEvent[];
}

export class InMemorySubmissionLedger implements SubmissionEventSink {
  private readonly entries: SubmissionEvent[] = [];

  append(event: { readonly type: SubmissionEventType; readonly payload: Record<string, unknown> }): SubmissionEvent {
    if (!event || !SUBMISSION_EVENT_TYPES.has(event.type) || !isPlainRecord(event.payload)) {
      throw new TypeError("invalid submission ledger event");
    }
    const entry = deepFreeze({
      sequence: this.entries.length + 1,
      type: event.type,
      payload: clone(event.payload),
    }) as SubmissionEvent;
    this.entries.push(entry);
    return entry;
  }

  events(): readonly SubmissionEvent[] {
    return freezeClone(this.entries);
  }
}

export type SubmissionAllowlist = readonly string[] | Readonly<Record<string, readonly string[]>>;

export interface SubmissionRateLimit {
  readonly maxSubmissions?: number;
  readonly max?: number;
  readonly maxRequests?: number;
  readonly limit?: number;
  readonly windowMs: number;
}

/**
 * First-class external-submission budget (T42). Total real submissions ever
 * spent from the mission quota; dry-runs never consume it. A balance is
 * projected from the ledger so a restarted broker keeps the same quota.
 */
export interface SubmissionQuotaBalance {
  readonly limit: number | undefined;
  readonly used: number;
  /** Undefined when no quota limit is configured. */
  readonly remaining?: number;
}

/** Minimal ledger event shape used to count spent quota (structural projection). */
export interface SubmissionEventLike {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** External SUBMISSION_RESULT events (SUCCEEDED or FAILED) consume real quota; dry-runs do not. */
export function externalSubmissionsFromEvents(events: readonly SubmissionEventLike[]): number {
  return events.reduce((count, event) => {
    if (event.type !== "SUBMISSION_RESULT") return count;
    return event.payload?.mode === "external" ? count + 1 : count;
  }, 0);
}

/** Score of the last SUCCESSFULLY submitted champion; the gain baseline for the next real submission. */
export function submissionGainBaselineFromEvents(events: readonly SubmissionEventLike[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "SUBMISSION_RESULT" || event.payload?.mode !== "external" || event.payload?.status !== "SUCCEEDED") continue;
    const score = event.payload?.championScore;
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  return undefined;
}

export interface SubmissionBrokerOptions {
  readonly allowedCompetitions?: readonly string[];
  readonly competitionAllowlist?: readonly string[];
  readonly allowedTargets?: SubmissionAllowlist;
  readonly targetAllowlist?: SubmissionAllowlist;
  readonly allowedCredentialScopes?: SubmissionAllowlist;
  readonly credentialScopeAllowlist?: SubmissionAllowlist;
  /** Optional static digest policy; a trusted champion digest is still checked on every request. */
  readonly allowedArtifactDigests?: SubmissionAllowlist;
  readonly artifactDigestAllowlist?: SubmissionAllowlist;
  readonly defaultCredentialScopes?: readonly string[];
  readonly rateLimit?: SubmissionRateLimit;
  /**
   * Total external submissions the mission quota allows (submission_quota
   * budget dimension). undefined = unlimited. Every external result
   * (SUCCEEDED/FAILED) consumes one; dry-runs never do.
   */
  readonly submissionQuota?: number;
  /**
   * Minimum evaluator-score gain over the last SUCCESSFULLY submitted champion
   * required to spend another real submission. undefined/0 = gain not gated.
   * Every submitted champion must carry an evaluator score; the first
   * successful submission establishes the baseline.
   */
  readonly gainThreshold?: number;
  readonly destination?: SubmissionDestination | SubmissionDestinationHandler;
  readonly ledger?: SubmissionEventSink;
  /** Required authoritative harness source; request champion data is only a digest assertion. */
  readonly championProvider?: (missionId: string) => SubmissionChampion | undefined;
  /** Convenience for a broker bound to one already-verified local champion. */
  readonly champion?: SubmissionChampion;
  readonly localChampion?: SubmissionChampion;
  readonly clock?: () => number;
  readonly requestTtlMs?: number;
  readonly approvalTtlMs?: number;
  /** Kept for configuration compatibility; it never disables the human gate. */
  readonly autoSubmit?: boolean;
  readonly secrets?: readonly string[];
}

export interface SubmissionResult {
  readonly requestId: string;
  readonly mode: SubmissionMode;
  readonly status: "DRY_RUN" | "SUCCEEDED" | "FAILED";
  readonly submittedAt: number;
  readonly submissionId?: string;
  readonly response?: Readonly<Record<string, unknown>>;
}

interface StoredRequest extends Omit<SubmissionRequest, "status"> {
  status: SubmissionStatus;
  artifact: SubmissionArtifact;
  credential?: SubmissionCredential;
  /** The verified digest proof retained for replay when no live provider is available. */
  champion?: SubmissionChampion;
}

interface GenericAcceptance {
  readonly decisionId: string;
  readonly championDigest: string;
  readonly artifactDigest?: string;
  readonly acceptedBy: string;
  readonly acceptedAt: number;
  readonly expiresAt?: number;
  readonly reason?: string;
}

const SUBMISSION_EVENT_TYPES = new Set<SubmissionEventType>([
  "SUBMISSION_REQUESTED",
  "HUMAN_ACCEPTED",
  "SUBMISSION_APPROVED",
  "SUBMISSION_REJECTED",
  "SUBMISSION_RESULT",
]);

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, clone(entry)])) as T;
}

function freezeClone<T>(value: T): Readonly<T> {
  return deepFreeze(clone(value)) as Readonly<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (entry && "value" in entry) result[key] = entry.value;
  }
  return result;
}

function nonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function finiteNumber(name: string, value: unknown, minimum = Number.NEGATIVE_INFINITY): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new RangeError(`${name} must be finite and >= ${minimum}`);
}

function uniqueStrings(name: string, value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "") || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must contain unique, non-empty strings`);
  }
  return [...value];
}

function normalizeSecrets(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((secret) => typeof secret !== "string" || secret.length === 0)) {
    throw new TypeError("secrets must contain non-empty strings");
  }
  return Object.freeze([...new Set(value)]);
}

function normalizeAllowlist(name: string, value: SubmissionAllowlist | undefined): readonly string[] | Readonly<Record<string, readonly string[]>> {
  if (value === undefined) return Object.freeze([]);
  if (Array.isArray(value)) {
    const entries = uniqueStrings(name, value);
    if (entries.length === 0) throw new RangeError(`${name} cannot be empty`);
    return Object.freeze(entries);
  }
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be an array or ordinary object`);
  const result: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const [key, entries] of Object.entries(value)) {
    nonEmpty(`${name} key`, key);
    const normalized = uniqueStrings(`${name}.${key}`, entries);
    if (normalized.length === 0) throw new RangeError(`${name}.${key} cannot be empty`);
    result[key] = Object.freeze(normalized);
  }
  if (Object.keys(result).length === 0) throw new RangeError(`${name} cannot be empty`);
  return deepFreeze(result);
}

function allowlistEntries(value: readonly string[] | Readonly<Record<string, readonly string[]>>, key: string): readonly string[] {
  return Array.isArray(value) ? value : (value as Readonly<Record<string, readonly string[]>>)[key] ?? [];
}

function containsExact(value: readonly string[], expected: string): boolean {
  return value.some((entry) => entry === expected);
}

function subset(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => containsExact(allowed, value));
}

function safeLedgerValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((entry) => safeLedgerValue(entry, seen));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    const safe = safeLedgerValue(entry, seen);
    if (safe !== undefined) result[key] = safe;
  }
  seen.delete(value);
  return result;
}

function normalizeArtifact(value: unknown, fallbackDigest?: string): SubmissionArtifact {
  if (value === undefined) {
    nonEmpty("artifact digest", fallbackDigest);
    return Object.freeze({ digest: fallbackDigest });
  }
  if (!isPlainRecord(value)) throw new TypeError("artifact must be an ordinary object");
  const artifactId = ownValue(value, "artifactId");
  const address = ownValue(value, "address");
  const digest = ownValue(value, "digest") ?? fallbackDigest;
  const payload = ownValue(value, "payload");
  nonEmpty("artifact digest", digest);
  if (artifactId !== undefined) nonEmpty("artifactId", artifactId);
  if (address !== undefined) nonEmpty("artifact address", address);
  return deepFreeze({
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(address === undefined ? {} : { address }),
    digest,
    ...(payload === undefined ? {} : { payload: clone(payload) }),
  }) as SubmissionArtifact;
}

function sameArtifactIdentity(left: SubmissionArtifact, right: SubmissionArtifact): boolean {
  return left.digest === right.digest && left.artifactId === right.artifactId && left.address === right.address;
}

function championArtifact(champion: SubmissionChampion, digest: string): SubmissionArtifact {
  const value = ownValue(champion, "artifact");
  return normalizeArtifact(value, digest);
}

function championDigest(champion: SubmissionChampion): string {
  const snapshot = ownValue(champion, "snapshot");
  const value = ownValue(champion, "championDigest")
    ?? ownValue(champion, "digest")
    ?? (isRecord(snapshot) ? ownValue(snapshot, "digest") : undefined);
  nonEmpty("champion digest", value);
  return value;
}

function championArtifactDigest(champion: SubmissionChampion, digest: string): string {
  const artifact = ownValue(champion, "artifact");
  const value = ownValue(champion, "artifactDigest")
    ?? (isRecord(artifact) ? ownValue(artifact, "digest") : undefined)
    ?? digest;
  nonEmpty("champion artifact digest", value);
  return value;
}

function eligibleChampion(champion: SubmissionChampion): boolean {
  const verification = ownValue(champion, "verification");
  const evaluator = ownValue(champion, "evaluatorSucceeded") === true || ownValue(champion, "evaluatorPassed") === true;
  const successAuditor = ownValue(champion, "successAuditorPassed") === true
    || ownValue(champion, "successAudited") === true
    || (isRecord(verification) && ownValue(verification, "SuccessAuditor") === true);
  const promoted = ownValue(champion, "promotionApproved") === true || ownValue(champion, "promoted") === true || ownValue(champion, "status") === "PROMOTED_LOCAL";
  return evaluator && successAuditor && promoted;
}

/** Same promotion predicate the Broker uses; request flags are not a second policy. */
export function submissionChampionIsEligible(champion: SubmissionChampion): boolean {
  return eligibleChampion(champion);
}

function normalizeChampion(value: unknown): SubmissionChampion {
  if (!isPlainRecord(value)) throw new TypeError("champion is required");
  const missionId = ownValue(value, "missionId");
  const branchId = ownValue(value, "branchId");
  nonEmpty("champion missionId", missionId);
  nonEmpty("champion branchId", branchId);
  const explicitDigest = ownValue(value, "championDigest");
  const aliasDigest = ownValue(value, "digest");
  if (explicitDigest !== undefined && aliasDigest !== undefined && explicitDigest !== aliasDigest) {
    throw new SubmissionRejected("artifact-digest-mismatch", "champion digest aliases do not agree");
  }
  const sourceArtifact = ownValue(value, "artifact");
  const explicitArtifactDigest = ownValue(value, "artifactDigest");
  const sourceArtifactDigest = isPlainRecord(sourceArtifact) ? ownValue(sourceArtifact, "digest") : undefined;
  if (explicitArtifactDigest !== undefined && sourceArtifactDigest !== undefined && explicitArtifactDigest !== sourceArtifactDigest) {
    throw new SubmissionRejected("artifact-digest-mismatch", "champion artifact digest aliases do not agree");
  }
  const sourceSnapshot = ownValue(value, "snapshot");
  if (sourceSnapshot !== undefined && !isPlainRecord(sourceSnapshot)) throw new TypeError("champion snapshot must be an ordinary object");
  const snapshot = sourceSnapshot === undefined ? undefined : clone(sourceSnapshot as unknown as CandidateSnapshot);
  const result = {
    ...value,
    missionId,
    branchId,
    ...(snapshot === undefined ? {} : { snapshot: deepFreeze(snapshot) }),
  } as SubmissionChampion;
  const digest = championDigest(result);
  if (isRecord(result.snapshot) && ownValue(result.snapshot, "digest") !== undefined && ownValue(result.snapshot, "digest") !== digest) {
    throw new SubmissionRejected("artifact-digest-mismatch", "champion snapshot digest does not match the champion", undefined);
  }
  // A complete snapshot is checked at the broker boundary; lightweight fakes may only carry a digest.
  const normalizedSnapshot = result.snapshot;
  if (normalizedSnapshot && ["files", "contract", "provenance", "snapshotDigest", "filesDigest", "contractDigest"].some((key) => key in normalizedSnapshot)) {
    if (ownValue(normalizedSnapshot, "missionId") !== result.missionId || ownValue(normalizedSnapshot, "branchId") !== result.branchId) {
      throw new SubmissionRejected("mission-mismatch", "champion snapshot belongs to another mission or branch");
    }
    try { assertSnapshotIntegrity(normalizedSnapshot as unknown as Record<string, unknown>); } catch {
      throw new SubmissionRejected("artifact-digest-mismatch", "champion snapshot failed integrity validation");
    }
  }
  if (!eligibleChampion(result)) throw new SubmissionRejected("champion-not-eligible", "champion has not passed evaluator, Success Auditor, and promotion policy");
  const artifact = result.artifact === undefined ? undefined : normalizeArtifact(result.artifact, digest);
  const verification = result.verification === undefined ? undefined : freezeClone(result.verification);
  championArtifactDigest({ ...result, ...(artifact === undefined ? {} : { artifact }) }, digest);
  return deepFreeze({
    ...result,
    ...(artifact === undefined ? {} : { artifact }),
    ...(verification === undefined ? {} : { verification }),
  }) as SubmissionChampion;
}

function publicRequest(request: StoredRequest): SubmissionRequest {
  const { artifact: _artifact, credential: _credential, champion: _champion, ...metadata } = request;
  return freezeClone(metadata);
}

function sameRequest(left: SubmissionRequest, right: SubmissionRequest): boolean {
  return left.requestId === right.requestId
    && left.missionId === right.missionId
    && left.competition === right.competition
    && left.competitionId === right.competitionId
    && left.target === right.target
    && left.championDigest === right.championDigest
    && left.artifactDigest === right.artifactDigest
    && left.artifactId === right.artifactId
    && left.artifactAddress === right.artifactAddress
    && left.credentialId === right.credentialId
    && left.dryRun === right.dryRun
    && left.mode === right.mode
    && left.expiresAt === right.expiresAt
    && left.reason === right.reason
    && left.credentialScopes.length === right.credentialScopes.length
    && left.credentialScopes.every((scope, index) => scope === right.credentialScopes[index]);
}

export class SubmissionBroker {
  readonly ledger: SubmissionEventSink;
  private readonly competitions: readonly string[];
  private readonly targets: readonly string[] | Readonly<Record<string, readonly string[]>>;
  private readonly credentialScopes: readonly string[] | Readonly<Record<string, readonly string[]>>;
  private readonly artifactDigests?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  private readonly defaultCredentialScopes: readonly string[];
  private readonly maxSubmissions: number;
  private readonly rateWindowMs: number;
  /** External submission budget; undefined = unlimited. */
  private readonly submissionQuota?: number;
  /** Minimum score gain over the last submitted champion; undefined = gain not gated. */
  private readonly gainThreshold?: number;
  private readonly destination?: SubmissionDestination | SubmissionDestinationHandler;
  private readonly championProvider?: (missionId: string) => SubmissionChampion | undefined;
  private readonly clock: () => number;
  private readonly requestTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly gate = new HumanAcceptanceGate();
  private readonly secrets: readonly string[];
  private readonly redactor: SecretRedactor;
  private readonly requests = new Map<string, StoredRequest>();
  private readonly approvals = new Map<string, SubmissionApproval>();
  private readonly results = new Map<string, SubmissionResult>();
  private readonly submissionTimes: number[] = [];
  private readonly inFlight = new Set<string>();
  /**
   * T42: external submissions whose quota was synchronously reserved before the
   * (async) destination call — prevents concurrent submits from overspending.
   * Released once the result is recorded (the ledger then counts them).
   */
  private readonly quotaReserved = new Set<string>();
  private nextRequest = 1;

  constructor(options: SubmissionBrokerOptions) {
    const competitions = options.allowedCompetitions ?? options.competitionAllowlist;
    const targets = options.allowedTargets ?? options.targetAllowlist;
    const scopes = options.allowedCredentialScopes ?? options.credentialScopeAllowlist;
    const artifactDigests = options.allowedArtifactDigests ?? options.artifactDigestAllowlist;
    if (!competitions) throw new TypeError("competition allowlist is required");
    if (!targets) throw new TypeError("target allowlist is required");
    if (!scopes) throw new TypeError("credential scope allowlist is required");
    this.competitions = uniqueStrings("competition allowlist", competitions);
    if (this.competitions.length === 0) throw new RangeError("competition allowlist cannot be empty");
    this.targets = normalizeAllowlist("target allowlist", targets);
    this.credentialScopes = normalizeAllowlist("credential scope allowlist", scopes);
    this.artifactDigests = artifactDigests === undefined ? undefined : normalizeAllowlist("artifact digest allowlist", artifactDigests);
    this.defaultCredentialScopes = Object.freeze(uniqueStrings("default credential scopes", options.defaultCredentialScopes));
    const rate = options.rateLimit ?? { maxSubmissions: 1, windowMs: 60_000 };
    const max = rate.maxSubmissions ?? rate.max ?? rate.maxRequests ?? rate.limit;
    finiteNumber("rateLimit.maxSubmissions", max, 1);
    if (!Number.isSafeInteger(max)) throw new RangeError("rateLimit.maxSubmissions must be a safe integer");
    finiteNumber("rateLimit.windowMs", rate.windowMs, 1);
    this.maxSubmissions = max;
    this.rateWindowMs = rate.windowMs;
    if (options.submissionQuota !== undefined) {
      finiteNumber("submissionQuota", options.submissionQuota, 0);
      if (!Number.isSafeInteger(options.submissionQuota)) throw new RangeError("submissionQuota must be a safe integer");
      this.submissionQuota = options.submissionQuota;
    }
    if (options.gainThreshold !== undefined) {
      finiteNumber("gainThreshold", options.gainThreshold, 0);
      this.gainThreshold = options.gainThreshold;
    }
    this.destination = options.destination;
    const configuredChampion = options.champion ?? options.localChampion;
    if (configuredChampion !== undefined) {
      const trustedChampion = normalizeChampion(configuredChampion);
      this.championProvider = options.championProvider ?? (() => trustedChampion);
    } else {
      this.championProvider = options.championProvider;
    }
    this.clock = options.clock ?? (() => Date.now());
    this.requestTtlMs = options.requestTtlMs ?? 15 * 60_000;
    this.approvalTtlMs = options.approvalTtlMs ?? this.requestTtlMs;
    finiteNumber("requestTtlMs", this.requestTtlMs, 1);
    finiteNumber("approvalTtlMs", this.approvalTtlMs, 1);
    this.secrets = normalizeSecrets(options.secrets);
    this.redactor = new SecretRedactor(this.secrets);
    this.ledger = options.ledger ?? new InMemorySubmissionLedger();
    this.hydrate();
  }

  private now(): number {
    const value = this.clock();
    finiteNumber("clock", value);
    return value;
  }

  private requestId(supplied?: string): string {
    if (supplied !== undefined) {
      nonEmpty("requestId", supplied);
      return supplied;
    }
    let value: string;
    do value = `submission-${this.nextRequest++}`;
    while (this.requests.has(value));
    return value;
  }

  private append(type: SubmissionEventType, payload: Record<string, unknown>, credential?: SubmissionCredential): void {
    const redactor = credential?.token
      ? new SecretRedactor([...this.secrets, credential.token])
      : this.redactor;
    const redacted = redactor.redact(safeLedgerValue(payload)) as Record<string, unknown>;
    this.ledger.append({ type, payload: clone(redacted) });
  }

  private hydrate(): void {
    const events = this.ledger.events?.() ?? [];
    if (!Array.isArray(events)) throw new TypeError("submission ledger events must be an array");
    for (const event of events) {
      if (!event || !SUBMISSION_EVENT_TYPES.has(event.type) || !isPlainRecord(event.payload)) continue;
      const payload = ownRecord(event.payload);
      if (event.type === "SUBMISSION_REQUESTED" && typeof payload.requestId === "string") {
        const request = this.requestFromPayload(payload);
        if (request && !this.requests.has(request.requestId)) {
          this.requests.set(request.requestId, request);
        }
        continue;
      }
      if (event.type === "HUMAN_ACCEPTED") {
        if (typeof payload.requestId === "string") {
          const request = this.requests.get(payload.requestId);
          const approval = this.approvalFromPayload(payload);
          if (request && approval && approval.championDigest === request.championDigest
            && approval.artifactDigest === request.artifactDigest) {
            this.approvals.set(approval.requestId, approval);
            request.status = "APPROVED";
          } else if (request) {
            const acceptance = this.genericAcceptanceFromPayload(payload);
            if (acceptance && acceptance.championDigest === request.championDigest
              && (acceptance.artifactDigest === undefined || acceptance.artifactDigest === request.artifactDigest)
              && acceptance.acceptedAt >= request.requestedAt
              && (acceptance.expiresAt ?? request.expiresAt) <= request.expiresAt) {
              this.approvals.set(request.requestId, freezeClone({
                requestId: request.requestId,
                decisionId: acceptance.decisionId,
                championDigest: acceptance.championDigest,
                artifactDigest: request.artifactDigest,
                acceptedBy: acceptance.acceptedBy,
                acceptedAt: acceptance.acceptedAt,
                expiresAt: acceptance.expiresAt ?? request.expiresAt,
                ...(acceptance.reason === undefined ? {} : { reason: acceptance.reason }),
              }));
              request.status = "APPROVED";
            }
          }
        }
        continue;
      }
      if (event.type === "SUBMISSION_REJECTED" && typeof payload.requestId === "string") {
        const request = this.requests.get(payload.requestId);
        if (request) request.status = "REJECTED";
        continue;
      }
      if (event.type === "SUBMISSION_RESULT" && typeof payload.requestId === "string") {
        const result = this.resultFromPayload(payload);
        const request = this.requests.get(payload.requestId);
        const modeMatches = request && (result?.mode === (request.dryRun ? "dry-run" : "external"));
        const approvalExists = request?.dryRun || this.approvals.has(payload.requestId);
        if (request && result && modeMatches && approvalExists && !this.results.has(result.requestId)) {
          this.results.set(result.requestId, result);
          request.status = result.status === "DRY_RUN" ? "DRY_RUN" : result.status;
          if (result.mode === "external") this.submissionTimes.push(result.submittedAt);
        }
      }
    }
    this.nextRequest = Math.max(this.nextRequest, this.requests.size + 1);
  }

  private requestFromPayload(payload: Record<string, unknown>): StoredRequest | undefined {
    if (typeof payload.requestId !== "string" || payload.requestId.trim() === ""
      || typeof payload.missionId !== "string" || payload.missionId.trim() === ""
      || typeof payload.competition !== "string" || payload.competition.trim() === ""
      || typeof payload.target !== "string" || payload.target.trim() === ""
      || (payload.competitionId !== undefined && (typeof payload.competitionId !== "string" || payload.competitionId.trim() === ""))
      || typeof payload.championDigest !== "string" || payload.championDigest.trim() === ""
      || typeof payload.artifactDigest !== "string" || payload.artifactDigest.trim() === ""
      || typeof payload.requestedAt !== "number" || !Number.isFinite(payload.requestedAt)
      || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= payload.requestedAt
      || typeof payload.dryRun !== "boolean" || !Array.isArray(payload.credentialScopes)) return undefined;
    const scopes = payload.credentialScopes.filter((scope): scope is string => typeof scope === "string");
    if (scopes.length !== payload.credentialScopes.length) return undefined;
    let normalizedScopes: string[];
    try { normalizedScopes = uniqueStrings("credential scopes", scopes); } catch { return undefined; }
    const createdAt = typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
      ? payload.createdAt : payload.requestedAt;
    if (createdAt > payload.expiresAt) return undefined;
    const champion = typeof payload.championBranchId === "string" && payload.championBranchId.trim() !== "" && payload.verifiedChampion === true
      ? Object.freeze({
        missionId: payload.missionId,
        branchId: payload.championBranchId,
        championDigest: payload.championDigest,
        artifactDigest: payload.artifactDigest,
        evaluatorSucceeded: true,
        successAuditorPassed: true,
        promotionApproved: true,
      }) as SubmissionChampion
      : undefined;
    const request = {
      requestId: payload.requestId,
      missionId: payload.missionId,
      competition: payload.competition,
      competitionId: typeof payload.competitionId === "string" && payload.competitionId.trim() !== "" ? payload.competitionId : payload.competition,
      target: payload.target,
      championDigest: payload.championDigest,
      artifactDigest: payload.artifactDigest,
      ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
      ...(typeof payload.artifactAddress === "string" ? { artifactAddress: payload.artifactAddress } : {}),
      ...(typeof payload.credentialId === "string" && payload.credentialId.trim() !== "" ? { credentialId: payload.credentialId } : {}),
      credentialScopes: Object.freeze(normalizedScopes),
      requestedAt: payload.requestedAt,
      createdAt,
      expiresAt: payload.expiresAt,
      dryRun: payload.dryRun,
      mode: payload.dryRun ? "dry-run" as const : "external" as const,
      status: "PENDING" as const,
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      artifact: Object.freeze({
        ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
        ...(typeof payload.artifactAddress === "string" ? { address: payload.artifactAddress } : {}),
        digest: payload.artifactDigest,
      }),
      ...(champion === undefined ? {} : { champion }),
    } satisfies StoredRequest;
    return request;
  }

  private approvalFromPayload(payload: Record<string, unknown>): SubmissionApproval | undefined {
    if (typeof payload.requestId !== "string" || payload.requestId.trim() === "" || typeof payload.decisionId !== "string" || payload.decisionId.trim() === ""
      || typeof payload.championDigest !== "string" || payload.championDigest.trim() === ""
      || typeof payload.artifactDigest !== "string" || payload.artifactDigest.trim() === ""
      || typeof payload.acceptedBy !== "string" || payload.acceptedBy.trim() === ""
      || typeof payload.acceptedAt !== "number" || !Number.isFinite(payload.acceptedAt)
      || typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= payload.acceptedAt) return undefined;
    return freezeClone({
      requestId: payload.requestId,
      decisionId: payload.decisionId,
      championDigest: payload.championDigest,
      artifactDigest: payload.artifactDigest,
      acceptedBy: payload.acceptedBy,
      acceptedAt: payload.acceptedAt,
      expiresAt: payload.expiresAt,
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    });
  }

  private genericAcceptanceFromPayload(payload: Record<string, unknown>): GenericAcceptance | undefined {
    if (typeof payload.decisionId !== "string" || payload.decisionId.trim() === "" || typeof payload.championDigest !== "string" || payload.championDigest.trim() === ""
      || typeof payload.acceptedBy !== "string" || payload.acceptedBy.trim() === ""
      || typeof payload.acceptedAt !== "number" || !Number.isFinite(payload.acceptedAt)) return undefined;
    if (payload.artifactDigest !== undefined && (typeof payload.artifactDigest !== "string" || payload.artifactDigest.trim() === "")) return undefined;
    if (payload.expiresAt !== undefined && (typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= payload.acceptedAt)) return undefined;
    return freezeClone({
      decisionId: payload.decisionId,
      championDigest: payload.championDigest,
      ...(payload.artifactDigest === undefined ? {} : { artifactDigest: payload.artifactDigest }),
      acceptedBy: payload.acceptedBy,
      acceptedAt: payload.acceptedAt,
      ...(typeof payload.expiresAt === "number" ? { expiresAt: payload.expiresAt } : {}),
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    });
  }

  private resultFromPayload(payload: Record<string, unknown>): SubmissionResult | undefined {
    if (typeof payload.requestId !== "string" || payload.requestId.trim() === "" || !["dry-run", "external"].includes(payload.mode as string)
      || !["DRY_RUN", "SUCCEEDED", "FAILED"].includes(payload.status as string)
      || typeof payload.submittedAt !== "number" || !Number.isFinite(payload.submittedAt)) return undefined;
    if ((payload.mode === "dry-run" && payload.status !== "DRY_RUN")
      || (payload.mode === "external" && payload.status === "DRY_RUN")) return undefined;
    const response = isRecord(payload.response) ? freezeClone(payload.response) : undefined;
    return freezeClone({
      requestId: payload.requestId,
      mode: payload.mode,
      status: payload.status,
      submittedAt: payload.submittedAt,
      ...(typeof payload.submissionId === "string" ? { submissionId: payload.submissionId } : {}),
      ...(response === undefined ? {} : { response }),
    }) as SubmissionResult;
  }

  private reject(code: SubmissionRejectionCode, message: string, requestId?: string, extra: Record<string, unknown> = {}): never {
    const safeMessage = this.redactor.redactText(message);
    if (requestId !== undefined) {
      const request = this.requests.get(requestId);
      if (request) request.status = "REJECTED";
    }
    this.append("SUBMISSION_REJECTED", {
      ...(requestId === undefined ? {} : { requestId }),
      code,
      reason: safeMessage,
      rejectedAt: this.now(),
      ...extra,
    });
    throw new SubmissionRejected(code, safeMessage, requestId);
  }

  private resolveChampion(missionId: string, supplied: SubmissionChampion | undefined, requestId?: string): SubmissionChampion {
    if (!this.championProvider) {
      this.reject("champion-not-found", "a trusted champion provider is required", requestId);
    }
    const authoritative = this.championProvider(missionId);
    if (!authoritative) this.reject("champion-not-found", "mission has no local champion", requestId);
    if (supplied) {
      const suppliedDigest = championDigest(supplied);
      const authoritativeDigest = championDigest(authoritative);
      if (suppliedDigest !== authoritativeDigest) this.reject("artifact-digest-mismatch", "request champion is not the current local champion", requestId);
    }
    const champion = authoritative;
    let normalized: SubmissionChampion;
    try { normalized = normalizeChampion(champion); } catch (error) {
      if (error instanceof SubmissionRejected) this.reject(error.code, error.message, requestId);
      throw error;
    }
    if (normalized.missionId !== missionId) this.reject("mission-mismatch", "champion belongs to another mission", requestId);
    return normalized;
  }

  private currentChampion(request: StoredRequest): SubmissionChampion {
    if (this.championProvider) return this.resolveChampion(request.missionId, undefined, request.requestId);
    if (!request.champion) this.reject("champion-not-found", "the verified champion is not available for this request", request.requestId);
    return request.champion;
  }

  private requiredScopes(input: SubmissionRequestInput, credential: SubmissionCredential | undefined, competition: string): string[] {
    const supplied = input.credentialScopes ?? input.requiredCredentialScopes
      ?? (input.credentialScope === undefined ? undefined : [input.credentialScope]);
    const allowed = allowlistEntries(this.credentialScopes, competition);
    const fallback = this.defaultCredentialScopes.length > 0
      ? this.defaultCredentialScopes
      : allowed.length === 1 ? allowed : [];
    const credentialScopes = credential?.scopes ?? (credential?.scope === undefined ? undefined : [credential.scope]);
    const values = supplied ?? credentialScopes ?? fallback;
    return uniqueStrings("credential scopes", values);
  }

  private validateCredential(
    input: SubmissionRequestInput,
    competition: string,
    target: string,
    required: readonly string[],
    now: number,
    dryRun: boolean,
    requestId?: string,
  ): SubmissionCredential | undefined {
    const credential = input.credential;
    const allowed = allowlistEntries(this.credentialScopes, competition);
    if (!subset(required, allowed)) this.reject("credential-scope-denied", "requested credential scope is not allowlisted", requestId);
    if (!credential) return undefined;
    try {
      if (!isPlainRecord(credential)) throw new TypeError("credential must be an ordinary object");
      const id = ownValue(credential, "id");
      const scope = ownValue(credential, "scope");
      const scopeList = ownValue(credential, "scopes");
      const expiresAt = ownValue(credential, "expiresAt");
      const credentialCompetition = ownValue(credential, "competition");
      const credentialTarget = ownValue(credential, "target");
      const token = ownValue(credential, "token");
      nonEmpty("credential id", id);
      if (scope !== undefined) nonEmpty("credential scope", scope);
      if (credentialCompetition !== undefined) nonEmpty("credential competition", credentialCompetition);
      if (credentialTarget !== undefined) nonEmpty("credential target", credentialTarget);
      const credentialScopeInput = (scopeList ?? (scope === undefined ? undefined : [scope])) as readonly string[] | undefined;
      const credentialScopeList = uniqueStrings("credential scopes", credentialScopeInput);
      if (scope !== undefined && !credentialScopeList.includes(scope)) {
        this.reject("credential-scope-denied", "credential scope aliases do not agree", requestId);
      }
      if (token !== undefined) nonEmpty("credential token", token);
      if (!subset(credentialScopeList, allowed) || !subset(required, credentialScopeList) || !subset(credentialScopeList, required)) {
        this.reject("credential-scope-denied", "credential scope is broader than the broker allowlist or requested scope", requestId);
      }
      if (expiresAt !== undefined) finiteNumber("credential.expiresAt", expiresAt);
      if (!dryRun && (expiresAt === undefined || expiresAt <= now)) {
        this.reject("credential-expired", "credential is missing or expired", requestId);
      }
      if (credentialCompetition !== undefined && credentialCompetition !== competition) {
        this.reject("credential-scope-denied", "credential is bound to another competition", requestId);
      }
      if (credentialTarget !== undefined && credentialTarget !== target) {
        this.reject("credential-scope-denied", "credential is bound to another target", requestId);
      }
      return freezeClone({
        id,
        scopes: credentialScopeList,
        ...(scope === undefined ? {} : { scope }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(credentialCompetition === undefined ? {} : { competition: credentialCompetition }),
        ...(credentialTarget === undefined ? {} : { target: credentialTarget }),
        ...(token === undefined ? {} : { token }),
      });
    } catch (error) {
      if (error instanceof SubmissionRejected) throw error;
      this.reject("invalid-request", error instanceof Error ? error.message : "invalid credential", requestId);
    }
  }

  private validateAllowlist(competition: string, target: string, requestId?: string, displayCompetition = competition): void {
    if (!containsExact(this.competitions, competition)) this.reject("competition-not-allowlisted", `competition is not allowlisted: ${competition}`, requestId);
    if (displayCompetition !== competition && !containsExact(this.competitions, displayCompetition)) {
      this.reject("competition-not-allowlisted", `competition is not allowlisted: ${displayCompetition}`, requestId);
    }
    const allowedTargets = allowlistEntries(this.targets, competition);
    if (!containsExact(allowedTargets, target)) this.reject("target-not-allowlisted", `target is not allowlisted for ${competition}: ${target}`, requestId);
  }

  private validateArtifactAllowlist(competition: string, target: string, digest: string, requestId?: string): void {
    if (this.artifactDigests === undefined) return;
    const allowed = Array.isArray(this.artifactDigests)
      ? this.artifactDigests
      : (this.artifactDigests as Readonly<Record<string, readonly string[]>>)[`${competition}:${target}`]
        ?? (this.artifactDigests as Readonly<Record<string, readonly string[]>>)[competition]
        ?? (this.artifactDigests as Readonly<Record<string, readonly string[]>>)[target]
        ?? (this.artifactDigests as Readonly<Record<string, readonly string[]>>)["*"];
    if (!allowed || !containsExact(allowed, digest)) {
      this.reject("artifact-not-allowlisted", `artifact digest is not allowlisted for ${competition}: ${digest}`, requestId);
    }
  }

  createRequest(input: SubmissionRequestInput): SubmissionRequest {
    let requestId = "";
    try {
      const sourceInput = input;
      requestId = this.requestId(isPlainRecord(sourceInput) && typeof ownValue(sourceInput, "requestId") === "string"
        ? ownValue(sourceInput, "requestId") as string
        : isPlainRecord(sourceInput) && typeof ownValue(sourceInput, "idempotencyKey") === "string"
          ? ownValue(sourceInput, "idempotencyKey") as string : undefined);
      if (!isPlainRecord(sourceInput)) throw new TypeError("submission request must be an ordinary object");
      input = { ...sourceInput } as SubmissionRequestInput;
      if (input.requestId !== undefined && typeof input.requestId !== "string") throw new TypeError("requestId must be a string");
      if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string") throw new TypeError("idempotencyKey must be a string");
      if (input.reason !== undefined && typeof input.reason !== "string") throw new TypeError("reason must be a string");
      if (input.expiresAt !== undefined && (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt))) throw new TypeError("expiresAt must be finite");
      if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new TypeError("dryRun must be boolean");
      if (input.target !== undefined && input.destinationTarget !== undefined && input.target !== input.destinationTarget) {
        this.reject("target-not-allowlisted", "target aliases do not agree", requestId);
      }
      nonEmpty("missionId", input.missionId);
      const competition = input.competition ?? input.competitionId;
      const competitionId = input.competitionId ?? competition;
      const target = input.target ?? input.destinationTarget;
      nonEmpty("competition", competition);
      nonEmpty("competitionId", competitionId);
      nonEmpty("target", target);
      this.validateAllowlist(competitionId, target, requestId, competition);
      const supplied = input.champion ?? input.localChampion ?? input.candidate;
      const champion = this.resolveChampion(input.missionId, supplied, requestId);
      if (champion.competition !== undefined && champion.competition !== competition && champion.competition !== competitionId) {
        this.reject("mission-mismatch", "champion belongs to another competition", requestId);
      }
      const championDigestValue = championDigest(champion);
      const expectedArtifactDigest = championArtifactDigest(champion, championDigestValue);
      const trustedArtifact = championArtifact(champion, expectedArtifactDigest);
      const suppliedArtifact = input.artifact ?? input.artifactRef;
      if (suppliedArtifact !== undefined) {
        this.assertArtifactCandidate(
          trustedArtifact,
          normalizeArtifact(suppliedArtifact, expectedArtifactDigest),
          requestId,
          championDigestValue,
        );
      }
      if (input.artifactDigest !== undefined && input.artifactDigest !== trustedArtifact.digest) {
        this.reject("artifact-digest-mismatch", "submission artifact digest does not match the verified champion", requestId);
      }
      if (input.artifactId !== undefined && input.artifactId !== trustedArtifact.artifactId) {
        this.reject("artifact-digest-mismatch", "submission artifact identity does not match the verified artifact", requestId);
      }
      if (input.artifactAddress !== undefined && input.artifactAddress !== trustedArtifact.address) {
        this.reject("artifact-digest-mismatch", "submission artifact identity does not match the verified artifact", requestId);
      }
      const artifact = trustedArtifact;
      this.validateArtifactAllowlist(competitionId, target, artifact.digest, requestId);
      this.validateArtifactPayload(artifact, requestId, championDigestValue);
      const dryRun = input.dryRun !== false;
      const now = this.now();
      const expiresAt = input.expiresAt ?? now + this.requestTtlMs;
      finiteNumber("request expiresAt", expiresAt);
      if (expiresAt <= now) this.reject("request-expired", "submission request is already expired", requestId);
      const requiredScopes = this.requiredScopes(input, input.credential, competitionId);
      if (requiredScopes.length === 0) this.reject("credential-scope-denied", "at least one credential scope is required", requestId);
      const credential = this.validateCredential(input, competitionId, target, requiredScopes, now, dryRun, requestId);
      const requestRedactor = credential?.token
        ? new SecretRedactor([...this.secrets, credential.token])
        : this.redactor;
      const reason = typeof input.reason === "string" && input.reason.trim() !== ""
        ? requestRedactor.redactText(input.reason) : undefined;
      const request: StoredRequest = {
        requestId,
        missionId: input.missionId,
        competition,
        competitionId,
        target,
        championDigest: championDigestValue,
        artifactDigest: artifact.digest,
        ...(artifact.artifactId === undefined ? {} : { artifactId: artifact.artifactId }),
        ...(artifact.address === undefined ? {} : { artifactAddress: artifact.address }),
        ...(credential === undefined ? {} : { credentialId: credential.id }),
        credentialScopes: Object.freeze(requiredScopes),
        requestedAt: now,
        createdAt: now,
        expiresAt,
        dryRun,
        mode: dryRun ? "dry-run" : "external",
        status: "PENDING",
        ...(reason === undefined ? {} : { reason }),
        artifact,
        ...(credential === undefined ? {} : { credential }),
        champion,
      };
      const existing = this.requests.get(requestId);
      if (existing) {
        if (!sameRequest(existing, request)) this.reject("request-id-conflict", "requestId already identifies different submission data", requestId);
        return publicRequest(existing);
      }
      this.requests.set(requestId, request);
      this.append("SUBMISSION_REQUESTED", {
        requestId, missionId: request.missionId, competition: request.competition, competitionId: request.competitionId,
        target: request.target, championDigest: request.championDigest, artifactDigest: request.artifactDigest,
        championBranchId: champion.branchId,
        verifiedChampion: true,
        ...(request.artifactId === undefined ? {} : { artifactId: request.artifactId }),
        ...(request.artifactAddress === undefined ? {} : { artifactAddress: request.artifactAddress }),
        ...(request.credentialId === undefined ? {} : { credentialId: request.credentialId }),
        credentialScopes: request.credentialScopes, requestedAt: request.requestedAt, createdAt: request.createdAt,
        expiresAt: request.expiresAt, dryRun: request.dryRun, mode: request.mode,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }, credential);
      return publicRequest(request);
    } catch (error) {
      if (error instanceof SubmissionRejected) {
        if (error.requestId === requestId) throw error;
        this.reject(error.code, error.message, requestId);
      }
      this.reject("invalid-request", error instanceof Error ? error.message : "invalid submission request", requestId);
    }
  }

  createDryRun(input: SubmissionRequestInput): SubmissionRequest {
    return this.createRequest({ ...input, dryRun: true });
  }

  requestSubmission(input: SubmissionRequestInput): SubmissionRequest {
    return this.createRequest(input);
  }

  getRequest(requestId: string): SubmissionRequest | undefined {
    return this.requests.has(requestId) ? publicRequest(this.requests.get(requestId)!) : undefined;
  }

  approve(
    requestOrId: string | SubmissionRequest,
    acceptance: {
      readonly acceptedBy: string;
      readonly decisionId?: string;
      readonly acceptedAt?: number;
      readonly expiresAt?: number;
      readonly reason?: string;
      readonly championDigest?: string;
      readonly artifactDigest?: string;
    },
  ): SubmissionApproval {
    const requestId = typeof requestOrId === "string"
      ? requestOrId
      : isPlainRecord(requestOrId) && typeof ownValue(requestOrId, "requestId") === "string" ? ownValue(requestOrId, "requestId") as string : "";
    if (requestId.trim() === "") this.reject("invalid-request", "submission requestId is required");
    if (!isPlainRecord(acceptance)) this.reject("invalid-request", "human acceptance must be an ordinary object", requestId);
    acceptance = { ...acceptance };
    const request = this.requests.get(requestId);
    if (!request) this.reject("request-not-found", `unknown submission request: ${requestId}`, requestId);
    const existingResult = this.results.get(requestId);
    if (existingResult) {
      const existingApproval = this.approvals.get(requestId) ?? this.ledgerApproval(request);
      if (existingApproval) return existingApproval;
      this.reject("request-already-completed", "submission request already has a result", requestId);
    }
    const now = this.now();
    const existingApproval = this.approvals.get(requestId) ?? this.ledgerApproval(request);
    if (existingApproval) {
      if (existingApproval.championDigest !== request.championDigest || existingApproval.artifactDigest !== request.artifactDigest) {
        this.reject("approval-mismatch", "request already has a different human acceptance", requestId);
      }
      if (existingApproval.acceptedAt >= request.requestedAt && existingApproval.acceptedAt <= now
        && existingApproval.expiresAt <= request.expiresAt && existingApproval.expiresAt > now) {
        this.approvals.set(requestId, existingApproval);
        request.status = "APPROVED";
        return existingApproval;
      }
      this.approvals.delete(requestId);
    }
    if (request.expiresAt <= now) this.reject("request-expired", "submission request has expired", requestId);
    this.validateAllowlist(request.competitionId, request.target, requestId, request.competition);
    let champion: SubmissionChampion;
    try {
      champion = this.currentChampion(request);
    } catch (error) {
      if (error instanceof SubmissionRejected) throw error;
      this.reject("invalid-request", error instanceof Error ? error.message : "unable to read local champion", requestId);
    }
    if (champion.competition !== undefined && champion.competition !== request.competition
      && champion.competition !== request.competitionId) {
      this.reject("mission-mismatch", "current champion belongs to another competition", requestId);
    }
    const digest = championDigest(champion);
    const artifactDigest = championArtifactDigest(champion, digest);
    if (digest !== request.championDigest || artifactDigest !== request.artifactDigest) {
      this.reject("artifact-digest-mismatch", "current champion no longer matches the request", requestId);
    }
    if (acceptance.championDigest !== undefined && acceptance.championDigest !== request.championDigest) {
      this.reject("approval-mismatch", "human acceptance names another champion", requestId);
    }
    if (acceptance.artifactDigest !== undefined && acceptance.artifactDigest !== request.artifactDigest) {
      this.reject("approval-mismatch", "human acceptance names another artifact", requestId);
    }
    if (acceptance.acceptedAt !== undefined && (typeof acceptance.acceptedAt !== "number" || !Number.isFinite(acceptance.acceptedAt))) {
      this.reject("invalid-request", "acceptance acceptedAt must be finite", requestId);
    }
    const acceptedAt = acceptance.acceptedAt === undefined ? now : acceptance.acceptedAt;
    if (acceptedAt > now) this.reject("human-acceptance-expired", "human acceptance is from the future", requestId);
    if (acceptedAt < request.requestedAt) this.reject("approval-mismatch", "human acceptance predates the submission request", requestId);
    const expiresAt = acceptance.expiresAt ?? Math.min(request.expiresAt, now + this.approvalTtlMs);
    try {
      finiteNumber("approval expiresAt", expiresAt);
      if (expiresAt <= now || expiresAt > request.expiresAt) throw new RangeError("approval expiry is outside the request lifetime");
      const approvalRedactor = request.credential?.token
        ? new SecretRedactor([...this.secrets, request.credential.token])
        : this.redactor;
      const acceptedBy = approvalRedactor.redactText(acceptance.acceptedBy);
      const reason = acceptance.reason === undefined ? undefined : approvalRedactor.redactText(acceptance.reason);
      const decision = this.gate.accept({
        championDigest: request.championDigest,
        artifactDigest: request.artifactDigest,
        acceptedBy,
        ...(acceptance.decisionId === undefined ? {} : { decisionId: acceptance.decisionId }),
        acceptedAt,
        expiresAt,
        ...(reason === undefined ? {} : { reason }),
        requestId,
      });
      const approval = freezeClone({
        requestId,
        decisionId: decision.decisionId,
        championDigest: request.championDigest,
        artifactDigest: request.artifactDigest,
        acceptedBy: decision.acceptedBy,
        acceptedAt: decision.acceptedAt,
        expiresAt: decision.expiresAt!,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
      const existing = this.approvals.get(requestId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(approval)) this.reject("approval-mismatch", "request already has a different human acceptance", requestId);
        return existing;
      }
      const payload = {
        requestId, decisionId: approval.decisionId, championDigest: approval.championDigest,
        artifactDigest: approval.artifactDigest, acceptedBy: approval.acceptedBy, acceptedAt: approval.acceptedAt,
        expiresAt: approval.expiresAt, ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      };
      this.append("HUMAN_ACCEPTED", payload);
      this.append("SUBMISSION_APPROVED", payload);
      this.approvals.set(requestId, approval);
      request.status = "APPROVED";
      return approval;
    } catch (error) {
      if (error instanceof SubmissionRejected) throw error;
      this.reject("invalid-request", error instanceof Error ? error.message : "invalid human acceptance", requestId);
    }
  }

  approveSubmission(requestOrId: string | SubmissionRequest, acceptance: Parameters<SubmissionBroker["approve"]>[1]): SubmissionApproval {
    return this.approve(requestOrId, acceptance);
  }

  private pruneRate(now: number): void {
    const first = now - this.rateWindowMs;
    while (this.submissionTimes.length > 0 && this.submissionTimes[0]! <= first) this.submissionTimes.shift();
  }

  /** Observable submission-quota balance, projected from the ledger plus synchronous reservations (T42). */
  quotaBalance(): SubmissionQuotaBalance {
    const used = externalSubmissionsFromEvents(this.ledger.events?.() ?? []) + this.quotaReserved.size;
    return {
      limit: this.submissionQuota,
      used,
      ...(this.submissionQuota === undefined ? {} : { remaining: Math.max(0, this.submissionQuota - used) }),
    };
  }

  /**
   * T42 budget gates for a real (non-dry-run) submission, enforced in addition
   * to the human-acceptance gate. Refusal writes a reason code to the ledger and
   * performs no external side effect and no quota consumption.
   */
  private validateSubmissionBudget(champion: SubmissionChampion, requestId: string): void {
    if (this.submissionQuota !== undefined) {
      const { used, remaining } = this.quotaBalance();
      if ((remaining ?? Infinity) <= 0) {
        this.reject("submission-quota-exhausted", `submission quota exhausted: ${this.submissionQuota} allowed, ${used} already spent or reserved`, requestId);
      }
    }
    if (this.gainThreshold !== undefined && this.gainThreshold > 0) {
      const score = champion.score;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        this.reject("gain-below-threshold", "champion has no evaluator score; gain threshold cannot be evaluated", requestId);
      }
      const baseline = submissionGainBaselineFromEvents(this.ledger.events?.() ?? []);
      if (baseline !== undefined && score - baseline < this.gainThreshold) {
        this.reject("gain-below-threshold", `champion gain ${score - baseline} is below the required gain threshold ${this.gainThreshold}`, requestId, {
          championScore: score,
          baselineScore: baseline,
          gainThreshold: this.gainThreshold,
        });
      }
    }
  }

  private reserveRate(now: number, requestId: string): void {
    this.pruneRate(now);
    if (this.submissionTimes.length >= this.maxSubmissions) {
      this.reject("rate-limit-exceeded", "submission rate limit has been reached", requestId);
    }
    this.submissionTimes.push(now);
  }

  private validateArtifactPayload(artifact: SubmissionArtifact, requestId?: string, expectedSnapshotDigest?: string): void {
    const payload = artifact.payload;
    if (isRecord(payload) && !isPlainRecord(payload) && ["files", "contract", "provenance"].some((key) => key in payload)) {
      this.reject("artifact-digest-mismatch", "artifact snapshot payload must be an ordinary object", requestId);
    }
    if (isPlainRecord(payload) && ["files", "contract", "provenance"].some((key) => key in payload)) {
      try {
        assertSnapshotIntegrity(payload);
      } catch {
        this.reject("artifact-digest-mismatch", "artifact payload failed snapshot integrity validation", requestId);
      }
      if (expectedSnapshotDigest !== undefined && payload.digest !== expectedSnapshotDigest) {
        this.reject("artifact-digest-mismatch", "artifact payload is not the requested champion snapshot", requestId);
      }
    }
  }

  private assertArtifactCandidate(
    expected: SubmissionArtifact,
    candidate: SubmissionArtifact,
    requestId: string | undefined,
    expectedSnapshotDigest: string,
  ): void {
    if (!sameArtifactIdentity(expected, candidate)) {
      this.reject("artifact-digest-mismatch", "submission artifact identity does not match the trusted artifact", requestId);
    }
    if (candidate.payload === undefined) return;
    if (expected.payload === undefined) {
      this.reject("artifact-digest-mismatch", "submission payload is not backed by a trusted artifact", requestId);
    }
    this.validateArtifactPayload(candidate, requestId, expectedSnapshotDigest);
    if (!isDeepStrictEqual(expected.payload, candidate.payload)) {
      this.reject("artifact-digest-mismatch", "submission payload is not the trusted artifact payload", requestId);
    }
  }

  private currentArtifact(request: StoredRequest, supplied?: SubmissionArtifact, trusted = request.artifact): SubmissionArtifact {
    if (!sameArtifactIdentity(trusted, request.artifact)) {
      this.reject("artifact-digest-mismatch", "trusted artifact identity changed", request.requestId);
    }
    if (this.championProvider && (trusted.payload === undefined) !== (request.artifact.payload === undefined)) {
      this.reject("artifact-digest-mismatch", "trusted artifact payload availability changed", request.requestId);
    }
    if (this.championProvider && trusted.payload !== undefined && request.artifact.payload !== undefined) {
      if (!isDeepStrictEqual(trusted.payload, request.artifact.payload)) {
        this.reject("artifact-digest-mismatch", "trusted artifact payload changed", request.requestId);
      }
    }
    if (supplied !== undefined) {
      const candidate = normalizeArtifact(supplied, request.artifactDigest);
      this.assertArtifactCandidate(trusted, candidate, request.requestId, request.championDigest);
    }
    this.validateArtifactAllowlist(request.competitionId, request.target, trusted.digest, request.requestId);
    this.validateArtifactPayload(trusted, request.requestId, request.championDigest);
    if (trusted.digest !== request.artifactDigest) this.reject("artifact-digest-mismatch", "submission artifact digest changed", request.requestId);
    return trusted;
  }

  private currentCredential(request: StoredRequest, supplied: SubmissionCredential | undefined, now: number): SubmissionCredential {
    const credential = supplied ?? request.credential;
    if (!credential) this.reject("credential-required", "an external submission requires a scoped credential", request.requestId);
    const credentialId = isPlainRecord(credential) ? ownValue(credential, "id") : undefined;
    if (request.credentialId !== undefined && credentialId !== request.credentialId) {
      this.reject("credential-scope-denied", "credential identity does not match the request", request.requestId);
    }
    const input: SubmissionRequestInput = {
      missionId: request.missionId,
      competition: request.competitionId,
      target: request.target,
      credential,
      credentialScopes: request.credentialScopes,
      dryRun: false,
    };
    return this.validateCredential(input, request.competitionId, request.target, request.credentialScopes, now, false, request.requestId)!;
  }

  private ledgerApproval(request: StoredRequest): SubmissionApproval | undefined {
    const events = this.ledger.events?.() ?? [];
    if (!Array.isArray(events)) return undefined;
    for (const event of [...events].reverse()) {
      if (!isPlainRecord(event) || event.type !== "HUMAN_ACCEPTED" || !isPlainRecord(event.payload)) continue;
      const payload = ownRecord(event.payload);
      if (payload.requestId === request.requestId) {
        const approval = this.approvalFromPayload(payload);
        if (approval && approval.championDigest === request.championDigest
          && approval.artifactDigest === request.artifactDigest) return approval;
        const acceptance = this.genericAcceptanceFromPayload(payload);
        if (acceptance && acceptance.championDigest === request.championDigest
          && (acceptance.artifactDigest === undefined || acceptance.artifactDigest === request.artifactDigest)) {
          return freezeClone({
            requestId: request.requestId,
            decisionId: acceptance.decisionId,
            championDigest: acceptance.championDigest,
            artifactDigest: request.artifactDigest,
            acceptedBy: acceptance.acceptedBy,
            acceptedAt: acceptance.acceptedAt,
            expiresAt: acceptance.expiresAt ?? request.expiresAt,
            ...(acceptance.reason === undefined ? {} : { reason: acceptance.reason }),
          });
        }
      }
      if (event.type === "HUMAN_ACCEPTED" && payload.requestId === undefined
        && payload.championDigest === request.championDigest) {
        const acceptance = this.genericAcceptanceFromPayload(payload);
        if (acceptance && acceptance.acceptedAt >= request.requestedAt
          && (acceptance.artifactDigest === undefined || acceptance.artifactDigest === request.artifactDigest)) {
          return freezeClone({
            requestId: request.requestId,
            decisionId: acceptance.decisionId,
            championDigest: acceptance.championDigest,
            artifactDigest: request.artifactDigest,
            acceptedBy: acceptance.acceptedBy,
            acceptedAt: acceptance.acceptedAt,
            expiresAt: acceptance.expiresAt ?? request.expiresAt,
            ...(acceptance.reason === undefined ? {} : { reason: acceptance.reason }),
          });
        }
      }
    }
    return undefined;
  }

  private validateApproval(request: StoredRequest, now: number): SubmissionApproval {
    const recorded = this.approvals.get(request.requestId);
    const approval = recorded ?? this.ledgerApproval(request);
    if (!approval) this.reject("human-acceptance-required", "external submission requires explicit human acceptance", request.requestId);
    if (approval.requestId !== request.requestId || approval.championDigest !== request.championDigest || approval.artifactDigest !== request.artifactDigest) {
      this.reject("approval-mismatch", "human acceptance is not bound to this request and artifact", request.requestId);
    }
    if (approval.expiresAt > request.expiresAt) this.reject("approval-mismatch", "human acceptance outlives the submission request", request.requestId);
    if (approval.acceptedAt < request.requestedAt) this.reject("approval-mismatch", "human acceptance predates the submission request", request.requestId);
    if (approval.acceptedAt > now || approval.expiresAt <= now) this.reject("human-acceptance-expired", "human acceptance is expired or from the future", request.requestId);
    if (!recorded) {
      this.approvals.set(request.requestId, approval);
      request.status = "APPROVED";
      this.append("SUBMISSION_APPROVED", {
        requestId: approval.requestId,
        decisionId: approval.decisionId,
        championDigest: approval.championDigest,
        artifactDigest: approval.artifactDigest,
        acceptedBy: approval.acceptedBy,
        acceptedAt: approval.acceptedAt,
        expiresAt: approval.expiresAt,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      });
    }
    return approval;
  }

  private recordResult(result: SubmissionResult, request: StoredRequest, credential?: SubmissionCredential): SubmissionResult {
    const frozen = freezeClone(result);
    this.results.set(result.requestId, frozen);
    request.status = result.status === "DRY_RUN" ? "DRY_RUN" : result.status;
    this.append("SUBMISSION_RESULT", {
      requestId: result.requestId, mode: result.mode, status: result.status, submittedAt: result.submittedAt,
      // T42: the successfully submitted champion's evaluator score is the gain
      // baseline for the next real submission (FAILED attempts consumed quota
      // but never established a baseline — that champion was not submitted).
      ...(result.mode === "external" && result.status === "SUCCEEDED"
        && typeof request.champion?.score === "number" && Number.isFinite(request.champion.score)
        ? { championScore: request.champion.score } : {}),
      ...(result.submissionId === undefined ? {} : { submissionId: result.submissionId }),
      ...(result.response === undefined ? {} : { response: result.response }),
    }, credential);
    return frozen;
  }

  async submit(
    requestOrId: string | SubmissionRequest,
    options: { readonly dryRun?: boolean; readonly credential?: SubmissionCredential; readonly artifact?: SubmissionArtifact } = {},
  ): Promise<SubmissionResult> {
    const requestId = typeof requestOrId === "string"
      ? requestOrId
      : isPlainRecord(requestOrId) && typeof ownValue(requestOrId, "requestId") === "string" ? ownValue(requestOrId, "requestId") as string : "";
    if (requestId.trim() === "") this.reject("invalid-request", "submission requestId is required");
    if (!isPlainRecord(options)) this.reject("invalid-request", "submission options must be an ordinary object", requestId);
    options = { ...options };
    if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") this.reject("invalid-request", "dryRun must be boolean", requestId);
    const request = this.requests.get(requestId);
    if (!request) this.reject("request-not-found", `unknown submission request: ${requestId}`, requestId);
    if (options.dryRun !== undefined && options.dryRun !== request.dryRun) {
      this.reject("request-id-conflict", "submission mode cannot change after request creation", requestId);
    }
    const dryRun = request.dryRun;
    const now = this.now();
    if (request.expiresAt <= now) this.reject("request-expired", "submission request has expired", requestId);
    const existingResult = this.results.get(requestId);
    if (existingResult) return existingResult;
    try {
      this.validateAllowlist(request.competitionId, request.target, requestId, request.competition);
      const champion = this.currentChampion(request);
      if (champion.competition !== undefined && champion.competition !== request.competition
        && champion.competition !== request.competitionId) {
        this.reject("mission-mismatch", "current champion belongs to another competition", requestId);
      }
      const digest = championDigest(champion);
      const artifactDigest = championArtifactDigest(champion, digest);
      if (digest !== request.championDigest || artifactDigest !== request.artifactDigest) {
        this.reject("artifact-digest-mismatch", "current champion digest does not match the request", requestId);
      }
      let trustedArtifact = request.artifact;
      if (this.championProvider) {
        try { trustedArtifact = championArtifact(champion, artifactDigest); } catch {
          this.reject("artifact-digest-mismatch", "current champion has no valid trusted artifact", requestId);
        }
      }
      const artifact = this.currentArtifact(request, options.artifact, trustedArtifact);
      if (dryRun) {
        return this.recordResult({ requestId, mode: "dry-run", status: "DRY_RUN", submittedAt: now }, request);
      }
      this.validateApproval(request, now);
      this.validateSubmissionBudget(champion, requestId);
      const credential = this.currentCredential(request, options.credential, now);
      if (!this.destination) this.reject("destination-unavailable", "no external submission destination is configured", requestId);
      const destinationSubmit = typeof this.destination === "function"
        ? this.destination
        : this.destination.submit ?? this.destination.send;
      if (!destinationSubmit) this.reject("destination-unavailable", "submission destination has no submit handler", requestId);
      if (this.inFlight.has(requestId)) this.reject("request-already-completed", "submission request is already in flight", requestId);
      this.reserveRate(now, requestId);
      this.inFlight.add(requestId);
      // Synchronous quota reservation, before the first await: concurrent
      // submits see it in quotaBalance(); quota is spent when the external side
      // effect is attempted, not when its result lands (mirrors reserveRate).
      this.quotaReserved.add(requestId);
      try {
        const requestView = publicRequest(request);
        const destinationInput = deepFreeze({
          ...requestView,
          request: requestView,
          submission: requestView,
          artifact,
          credential,
        }) as SubmissionDestinationInput;
        const response = typeof this.destination === "function"
          ? await this.destination(destinationInput, artifact, credential)
          : await destinationSubmit.call(this.destination, destinationInput, artifact, credential);
        const responseRedactor = new SecretRedactor([...this.secrets, ...(credential.token === undefined ? [] : [credential.token])]);
        const safeResponse = isRecord(response)
          ? responseRedactor.redact(safeLedgerValue(response)) as Record<string, unknown>
          : { value: responseRedactor.redact(safeLedgerValue(response)) };
        return this.recordResult({
          requestId,
          mode: "external",
          status: "SUCCEEDED",
          submittedAt: now,
          ...(typeof safeResponse.submissionId === "string" ? { submissionId: safeResponse.submissionId } : {}),
          response: freezeClone(safeResponse),
        }, request, credential);
      } catch (error) {
        const safe = new SecretRedactor([...this.secrets, ...(credential.token === undefined ? [] : [credential.token])]).error(error);
        return this.recordResult({
          requestId,
          mode: "external",
          status: "FAILED",
          submittedAt: now,
          response: { error: safe.message },
        }, request, credential);
      } finally {
        this.inFlight.delete(requestId);
        this.quotaReserved.delete(requestId);
      }
    } catch (error) {
      if (error instanceof SubmissionRejected) throw error;
      this.reject("invalid-request", error instanceof Error ? error.message : "submission failed", requestId);
    }
  }

  async dryRun(input: SubmissionRequestInput | SubmissionRequest): Promise<SubmissionResult> {
    const requestId = isPlainRecord(input) ? ownValue(input, "requestId") : undefined;
    const request = typeof requestId === "string" && this.requests.has(requestId)
      ? input as SubmissionRequest
      : this.createDryRun(input as SubmissionRequestInput);
    return this.submit(request, { dryRun: true });
  }

  events(): readonly SubmissionEvent[] {
    const events = this.ledger.events?.() ?? [];
    if (!Array.isArray(events)) return Object.freeze([]);
    const filtered = events.filter((event) => isPlainRecord(event)
      && typeof event.type === "string" && SUBMISSION_EVENT_TYPES.has(event.type as SubmissionEventType)
      && isPlainRecord(event.payload)) as SubmissionEvent[];
    return freezeClone(this.redactor.redact(filtered));
  }

}
