/**
 * Charter approval and the frozen benchmark protocol on the Mission ledger
 * (#251 / C2; spec #249, `docs/research-charter-prd.md` §5, §8).
 *
 * A charter becomes real only when a human approves it. This module is the
 * ledger seam for that: four events, replayed from the Mission ledger alone into
 * the currently approved charter version and frozen protocol.
 *
 * - The ledger stores versions, digests and artifact references, never the
 *   charter text or the literature evidence (`docs/research-charter-prd.md` §8).
 * - Approval is a human authorization event. The payload records `source:
 *   "user"`, and replay refuses any other source, so a model-authored approval
 *   cannot exist even if another writer appends a raw event.
 * - Approval and freezing pin the C1 content digest (`charterDigest`), so
 *   editing the charter afterwards cannot silently change what was approved.
 * - A primary-protocol change is a new `BENCHMARK_PROTOCOL_FROZEN` with a new
 *   `protocolVersion` and a recorded reason. Every frozen version stays in
 *   `frozenHistory`, so a result keeps the version it ran under and is never
 *   re-scored. Re-freezing an existing version with different content is refused.
 * - `BENCHMARK_EXTENSION_ADDED` only appends a supplementary comparator; it
 *   copies the frozen protocol version and digest and leaves `baselineIds`
 *   untouched, so the frozen set cannot move.
 *
 * `requireApprovedCharter` is the gate a long-running research loop (#248) calls
 * before it starts: no approved charter or no frozen protocol is a refusal, not
 * a default. Wiring it into `runMissionController` belongs to #248.
 */
import { deepFreeze, digestValue } from "../execution/security-boundary";
import {
  BASELINE_CATEGORIES,
  RESEARCH_CHARTER_SCHEMA,
  assertResearchCharter,
  charterDigest,
  type ResearchCharter,
} from "./research-charter";
import type { ResearchEvent, ResearchLedger } from "./research-loop";

/** Event-payload schema; a breaking payload change needs its own id. */
export const CHARTER_EVENT_SCHEMA = "evok.charter-ledger-event/v1";

/** Replayed-state schema (the projection the ledger is rebuilt into). */
export const CHARTER_LEDGER_SCHEMA = "evok.charter-ledger/v1";

export type CharterEventType =
  | "RESEARCH_CHARTER_PROPOSED"
  | "RESEARCH_CHARTER_APPROVED"
  | "BENCHMARK_PROTOCOL_FROZEN"
  | "BENCHMARK_EXTENSION_ADDED";

const CHARTER_EVENT_TYPES: ReadonlySet<string> = new Set<CharterEventType>([
  "RESEARCH_CHARTER_PROPOSED",
  "RESEARCH_CHARTER_APPROVED",
  "BENCHMARK_PROTOCOL_FROZEN",
  "BENCHMARK_EXTENSION_ADDED",
]);

/** Typed defect in the charter ledger or a submission against it. */
export class CharterLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharterLedgerError";
  }
}

/** An approval was attempted with something other than the user's own authorization. */
export class CharterApprovalRejectedError extends CharterLedgerError {
  constructor(message: string) {
    super(message);
    this.name = "CharterApprovalRejectedError";
  }
}

/** A research-loop start was attempted without an approved charter and a frozen protocol. */
export class CharterApprovalRequiredError extends CharterLedgerError {
  constructor(message: string) {
    super(message);
    this.name = "CharterApprovalRequiredError";
  }
}

export interface CharterProposal {
  readonly charterId: string;
  readonly charterVersion: number;
  readonly charterDigest: string;
  /** Artifact holding the full charter text; the ledger stores the reference only. */
  readonly artifactRef: string;
  readonly proposedBy: string;
  /** Ledger sequence of the proposal event; replay orders by it. */
  readonly proposedOrdinal: number;
}

export interface CharterApproval {
  readonly charterId: string;
  readonly charterVersion: number;
  readonly charterDigest: string;
  readonly approvedBy: string;
  readonly authorizationToken: string;
  /** Always `"user"`: a charter approval is a human authorization event. */
  readonly source: "user";
  readonly approvedOrdinal: number;
}

export interface FrozenProtocol {
  readonly protocolVersion: string;
  /** C1 `charterDigest` of the approved charter that carries this protocol. */
  readonly protocolDigest: string;
  readonly charterId: string;
  readonly charterVersion: number;
  /** Artifact holding the frozen protocol document; the ledger stores the reference only. */
  readonly artifactRef: string;
  /** The frozen comparator set; a later extension never alters it. */
  readonly baselineIds: readonly string[];
  readonly reason?: string;
  readonly frozenOrdinal: number;
}

export interface BenchmarkExtension {
  readonly extensionId: string;
  readonly baselineId: string;
  readonly comparator: string;
  readonly rationale: string;
  readonly artifactRef: string;
  /** The frozen protocol version this comparator supplements (never a new one). */
  readonly protocolVersion: string;
  readonly protocolDigest: string;
  readonly addedOrdinal: number;
}

export interface CharterLedgerState {
  readonly schema: typeof CHARTER_LEDGER_SCHEMA;
  readonly missionId: string;
  readonly proposals: readonly CharterProposal[];
  readonly approval?: CharterApproval;
  readonly frozenProtocol?: FrozenProtocol;
  /** Every protocol version ever frozen, so earlier results keep theirs. */
  readonly frozenHistory: readonly FrozenProtocol[];
  readonly extensions: readonly BenchmarkExtension[];
  readonly digest: string;
}

/** What a Run records about the charter it executed under (#248 reads this). */
export interface ApprovedCharterReference {
  readonly approval: CharterApproval;
  readonly protocol: FrozenProtocol;
  readonly extensions: readonly BenchmarkExtension[];
}

/** The Mission ledger as this module needs it: append plus read. */
export type CharterLedger = Pick<ResearchLedger, "append" | "events">;

/** The `source: "model"` guard shared with start / resume / continue. */
export interface CharterApprovalAuthorization {
  readonly requested: boolean;
  readonly token: string;
  readonly missionSelector: string;
  readonly source?: "user" | "model";
}

export interface ProposeResearchCharterInput {
  readonly missionId: string;
  /** The full charter; validated with C1 and never written to the ledger. */
  readonly charter: unknown;
  readonly artifactRef: string;
  readonly proposedBy: string;
}

export interface ApproveResearchCharterInput {
  readonly missionId: string;
  readonly charterId: string;
  readonly charterVersion: number;
  readonly charterDigest: string;
  readonly approvedBy: string;
  /** The user's explicit approval; `authorizationToken` is recorded as audit text, not parsed as a grammar. */
  readonly authorization: CharterApprovalAuthorization;
}

export interface FreezeBenchmarkProtocolInput {
  readonly missionId: string;
  /** The approved charter artifact; its protocol version and baseline set are frozen from it. */
  readonly charter: unknown;
  readonly artifactRef: string;
  /** Required by a later primary-protocol version; the reason is recorded, never inferred. */
  readonly reason?: string;
}

export interface AddBenchmarkExtensionInput {
  readonly missionId: string;
  readonly extensionId: string;
  readonly baselineId: string;
  readonly comparator: string;
  readonly rationale: string;
  readonly artifactRef: string;
}

const PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  "schema", "missionId", "operationId", "charterId", "charterVersion", "charterDigest",
  "charterSchema", "artifactRef", "proposedBy",
]);
const APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "schema", "missionId", "operationId", "charterId", "charterVersion", "charterDigest",
  "approvedBy", "authorizationToken", "source",
]);
const FROZEN_KEYS: ReadonlySet<string> = new Set([
  "schema", "missionId", "operationId", "protocolVersion", "protocolDigest",
  "charterId", "charterVersion", "artifactRef", "baselineIds", "reason",
]);
const EXTENSION_KEYS: ReadonlySet<string> = new Set([
  "schema", "missionId", "operationId", "extensionId", "baselineId", "comparator",
  "rationale", "artifactRef",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new CharterLedgerError(`${name} must be a non-empty string`);
  return value;
}

function optionalText(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(name, value);
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new CharterLedgerError(`${name} must be a positive integer`);
  return value;
}

function requiredStrings(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CharterLedgerError(`${name} must be a non-empty array`);
  const entries = value.map((entry) => requiredString(name, entry));
  if (new Set(entries).size !== entries.length) throw new CharterLedgerError(`${name} must not repeat an entry`);
  return entries;
}

/** Closed payload: a charter event can never smuggle charter text or evidence into the ledger. */
function assertClosed(name: string, keys: ReadonlySet<string>, payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!keys.has(key)) throw new CharterLedgerError(`${name} carries an undeclared field: ${key} (the ledger stores versions, approvals and references only)`);
  }
}

/** Refuses charter events on a ledger that does not already declare the same Mission. */
function assertLedgerMission(ledger: CharterLedger, missionId: string): void {
  const declared = ledger.events()[0]?.payload.missionId;
  if (typeof declared !== "string") {
    throw new CharterLedgerError(`charter events belong to an existing Mission ledger; start the Mission before proposing a charter (${missionId})`);
  }
  if (declared !== missionId) throw new CharterLedgerError(`charter events belong to another mission: ${missionId} (ledger holds ${declared})`);
}

/**
 * Appends one charter event after validating it against the projected ledger, so
 * a rejected event never reaches the ledger. An identical retry (same operation)
 * is a no-op; re-using the operation for different content is refused.
 */
function commit<T>(
  ledger: CharterLedger,
  missionId: string,
  type: CharterEventType,
  payload: Record<string, unknown>,
  read: (state: CharterLedgerState) => T,
): T {
  assertLedgerMission(ledger, missionId);
  const events = ledger.events();
  const candidate: ResearchEvent = {
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    eventId: `${type.toLowerCase()}-${events.length + 1}`,
    type,
    payload,
  };
  // Validate against the projected ledger before the first write: a refused event
  // never lands, and an identical retry (same projected state) appends nothing.
  const current = projectCharterLedger(events, { missionId });
  const next = projectCharterLedger([...events, candidate], { missionId });
  if (next.digest === current.digest) return read(current);
  ledger.append({ type, payload });
  return read(projectCharterLedger(ledger.events(), { missionId }));
}

function charterBaselineIds(charter: ResearchCharter): string[] {
  return BASELINE_CATEGORIES.flatMap((category) => charter.baselinePortfolio.categories[category].entries.map((entry) => entry.baselineId));
}

/** Proposes a charter version; the ledger keeps its version, digest and artifact reference. */
export function proposeResearchCharter(ledger: CharterLedger, input: ProposeResearchCharterInput): CharterProposal {
  const missionId = requiredString("missionId", input.missionId);
  const charter = assertResearchCharter(input.charter);
  const artifactRef = requiredString("artifactRef", input.artifactRef);
  const proposedBy = requiredString("proposedBy", input.proposedBy);
  const payload: Record<string, unknown> = {
    schema: CHARTER_EVENT_SCHEMA,
    missionId,
    operationId: `charter-proposed:${charter.charterId}@${charter.version}`,
    charterId: charter.charterId,
    charterVersion: charter.version,
    charterDigest: charterDigest(charter),
    charterSchema: charter.schema,
    artifactRef,
    proposedBy,
  };
  return commit(ledger, missionId, "RESEARCH_CHARTER_PROPOSED", payload, (state) => {
    const proposal = state.proposals.find((entry) => entry.charterId === charter.charterId && entry.charterVersion === charter.version);
    if (!proposal) throw new CharterLedgerError(`charter ${charter.charterId} v${charter.version} was not projected after append`);
    return proposal;
  });
}

/**
 * Records the human approval of one proposed charter version and digest. The
 * version and digest are the pin: a later charter edit is a new version and
 * cannot change what this event approved.
 */
export function approveResearchCharter(ledger: CharterLedger, input: ApproveResearchCharterInput): CharterApproval {
  const missionId = requiredString("missionId", input.missionId);
  const authorization = input.authorization;
  if (!authorization?.requested) {
    throw new CharterApprovalRejectedError("charter approval intent is absent; reviewing a proposal does not approve it");
  }
  if (authorization.source === "model") {
    throw new CharterApprovalRejectedError("charter approval must come from the user; a model-authored approval cannot authorize a charter");
  }
  if (authorization.missionSelector !== "displayed" && authorization.missionSelector !== missionId) {
    throw new CharterApprovalRejectedError(`charter approval targets mission ${authorization.missionSelector} but the selected mission is ${missionId}; refusing to guess which charter was approved`);
  }
  const charterVersion = positiveInteger("charterVersion", input.charterVersion);
  const payload: Record<string, unknown> = {
    schema: CHARTER_EVENT_SCHEMA,
    missionId,
    operationId: `charter-approved:${requiredString("charterId", input.charterId)}@${charterVersion}`,
    charterId: input.charterId,
    charterVersion,
    charterDigest: requiredString("charterDigest", input.charterDigest),
    approvedBy: requiredString("approvedBy", input.approvedBy),
    authorizationToken: requiredString("approval token", authorization.token),
    source: "user",
  };
  return commit(ledger, missionId, "RESEARCH_CHARTER_APPROVED", payload, (state) => {
    if (!state.approval) throw new CharterLedgerError("charter approval was not projected after append");
    return state.approval;
  });
}

/**
 * Freezes the evaluation protocol of the currently approved charter. The frozen
 * baseline set is derived from the charter, so it cannot be asserted by a caller.
 */
export function freezeBenchmarkProtocol(ledger: CharterLedger, input: FreezeBenchmarkProtocolInput): FrozenProtocol {
  const missionId = requiredString("missionId", input.missionId);
  const charter = assertResearchCharter(input.charter);
  const protocolVersion = requiredString("evaluation.protocolVersion", charter.evaluation.protocolVersion);
  const payload: Record<string, unknown> = {
    schema: CHARTER_EVENT_SCHEMA,
    missionId,
    operationId: `benchmark-frozen:${protocolVersion}`,
    protocolVersion,
    protocolDigest: charterDigest(charter),
    charterId: charter.charterId,
    charterVersion: charter.version,
    artifactRef: requiredString("artifactRef", input.artifactRef),
    baselineIds: charterBaselineIds(charter),
    ...(input.reason === undefined ? {} : { reason: requiredString("freeze reason", input.reason) }),
  };
  return commit(ledger, missionId, "BENCHMARK_PROTOCOL_FROZEN", payload, (state) => {
    if (!state.frozenProtocol) throw new CharterLedgerError("frozen protocol was not projected after append");
    return state.frozenProtocol;
  });
}

/** Adds a supplementary comparator to the currently frozen protocol. */
export function addBenchmarkExtension(ledger: CharterLedger, input: AddBenchmarkExtensionInput): BenchmarkExtension {
  const missionId = requiredString("missionId", input.missionId);
  const extensionId = requiredString("extensionId", input.extensionId);
  const payload: Record<string, unknown> = {
    schema: CHARTER_EVENT_SCHEMA,
    missionId,
    operationId: `benchmark-extension:${extensionId}`,
    extensionId,
    baselineId: requiredString("baselineId", input.baselineId),
    comparator: requiredString("comparator", input.comparator),
    rationale: requiredString("rationale", input.rationale),
    artifactRef: requiredString("artifactRef", input.artifactRef),
  };
  return commit(ledger, missionId, "BENCHMARK_EXTENSION_ADDED", payload, (state) => {
    const extension = state.extensions.find((entry) => entry.extensionId === extensionId);
    if (!extension) throw new CharterLedgerError(`extension ${extensionId} was not projected after append`);
    return extension;
  });
}

/**
 * Rebuilds the charter state from Mission ledger events alone: the latest human
 * approval and the latest frozen protocol, plus every proposal, frozen version
 * and extension. Earlier charter events are never overwritten — a proposal or a
 * frozen protocol is immutable once recorded.
 */
export function projectCharterLedger(events: readonly ResearchEvent[], options: { readonly missionId: string }): CharterLedgerState {
  const missionId = requiredString("missionId", options.missionId);
  const proposals: CharterProposal[] = [];
  const proposalByKey = new Map<string, CharterProposal>();
  let approval: CharterApproval | undefined;
  const frozenHistory: FrozenProtocol[] = [];
  const extensions: BenchmarkExtension[] = [];
  let previousSequence = 0;

  for (const event of events) {
    if (!CHARTER_EVENT_TYPES.has(event.type)) continue;
    positiveInteger("charter event sequence", event.sequence);
    if (event.sequence <= previousSequence) throw new CharterLedgerError(`charter events are not in ledger order (sequence ${event.sequence})`);
    previousSequence = event.sequence;
    if (!isRecord(event.payload)) throw new CharterLedgerError(`charter event ${event.sequence} has an invalid payload`);
    const payload = event.payload;
    if (payload.missionId !== missionId) throw new CharterLedgerError(`charter event ${event.sequence} belongs to another mission`);
    if (payload.schema !== CHARTER_EVENT_SCHEMA) throw new CharterLedgerError(`charter event ${event.sequence} has an unknown schema: ${String(payload.schema)}`);

    if (event.type === "RESEARCH_CHARTER_PROPOSED") {
      assertClosed("charter proposal event", PROPOSAL_KEYS, payload);
      if (payload.charterSchema !== RESEARCH_CHARTER_SCHEMA) {
        throw new CharterLedgerError(`charter proposal ${event.sequence} names schema ${String(payload.charterSchema)}; this ledger reads ${RESEARCH_CHARTER_SCHEMA}`);
      }
      const charterId = requiredString("charterId", payload.charterId);
      const charterVersion = positiveInteger("charterVersion", payload.charterVersion);
      const charterDigestValue = requiredString("charterDigest", payload.charterDigest);
      const key = `${charterId}@${charterVersion}`;
      const existingProposal = proposalByKey.get(key);
      if (existingProposal) {
        // A retry collapses; a changed digest for the same version is the silent edit this pin exists to reject.
        if (existingProposal.charterDigest !== charterDigestValue) {
          throw new CharterLedgerError(`charter ${charterId} v${charterVersion} was already proposed with a different digest; a changed charter needs a new version, not an edited one`);
        }
        continue;
      }
      const latest = proposals.filter((entry) => entry.charterId === charterId).at(-1);
      if (latest && charterVersion < latest.charterVersion) {
        throw new CharterLedgerError(`charter ${charterId} v${charterVersion} is behind the latest proposed version ${latest.charterVersion}; a charter version only moves forward`);
      }
      const proposal = deepFreeze({
        charterId,
        charterVersion,
        charterDigest: charterDigestValue,
        artifactRef: requiredString("artifactRef", payload.artifactRef),
        proposedBy: requiredString("proposedBy", payload.proposedBy),
        proposedOrdinal: event.sequence,
      }) as CharterProposal;
      proposalByKey.set(key, proposal);
      proposals.push(proposal);
      continue;
    }

    if (event.type === "RESEARCH_CHARTER_APPROVED") {
      assertClosed("charter approval event", APPROVAL_KEYS, payload);
      if (payload.source !== "user") {
        throw new CharterLedgerError(`charter approval ${event.sequence} is not a human authorization event (source ${JSON.stringify(payload.source)}); only the user can approve a charter`);
      }
      const charterId = requiredString("charterId", payload.charterId);
      const charterVersion = positiveInteger("charterVersion", payload.charterVersion);
      const charterDigestValue = requiredString("charterDigest", payload.charterDigest);
      const proposal = proposalByKey.get(`${charterId}@${charterVersion}`);
      if (!proposal || proposal.charterDigest !== charterDigestValue) {
        throw new CharterLedgerError(`charter approval ${event.sequence} references ${charterId} v${charterVersion} digest ${charterDigestValue}, which was never proposed; an approval pins a proposed version and digest`);
      }
      const record = deepFreeze({
        charterId,
        charterVersion,
        charterDigest: charterDigestValue,
        approvedBy: requiredString("approvedBy", payload.approvedBy),
        authorizationToken: requiredString("approval token", payload.authorizationToken),
        source: "user" as const,
        approvedOrdinal: event.sequence,
      }) as CharterApproval;
      if (approval) {
        if (approval.charterId === record.charterId && approval.charterVersion === record.charterVersion) {
          if (approval.charterDigest !== record.charterDigest || approval.approvedBy !== record.approvedBy || approval.authorizationToken !== record.authorizationToken) {
            throw new CharterLedgerError(`charter ${charterId} v${charterVersion} is already approved with different content`);
          }
          continue;
        }
        if (approval.charterId === record.charterId && record.charterVersion < approval.charterVersion) {
          throw new CharterLedgerError(`approval of ${charterId} v${record.charterVersion} would move backwards from the approved v${approval.charterVersion}; what was approved does not silently change`);
        }
      }
      approval = record;
      continue;
    }

    if (event.type === "BENCHMARK_PROTOCOL_FROZEN") {
      assertClosed("benchmark protocol event", FROZEN_KEYS, payload);
      const protocolVersion = requiredString("protocolVersion", payload.protocolVersion);
      const protocolDigest = requiredString("protocolDigest", payload.protocolDigest);
      const charterId = requiredString("charterId", payload.charterId);
      const charterVersion = positiveInteger("charterVersion", payload.charterVersion);
      const artifactRef = requiredString("artifactRef", payload.artifactRef);
      const baselineIds = requiredStrings("frozen baselineIds", payload.baselineIds);
      const reason = optionalText("freeze reason", payload.reason);
      if (!approval) {
        throw new CharterApprovalRequiredError(`protocol ${protocolVersion} cannot be frozen before a charter is approved; freezing an unapproved protocol would authorize an unapproved study`);
      }
      if (approval.charterId !== charterId || approval.charterVersion !== charterVersion || approval.charterDigest !== protocolDigest) {
        throw new CharterLedgerError(`protocol ${protocolVersion} does not belong to the currently approved charter (${approval.charterId} v${approval.charterVersion}); approve that charter version before freezing its protocol`);
      }
      const existing = frozenHistory.find((entry) => entry.protocolVersion === protocolVersion);
      if (existing) {
        if (existing.protocolDigest !== protocolDigest || existing.charterId !== charterId || existing.charterVersion !== charterVersion
          || existing.artifactRef !== artifactRef
          || digestValue(existing.baselineIds) !== digestValue(baselineIds) || existing.reason !== reason) {
          throw new CharterLedgerError(`protocol ${protocolVersion} is already frozen with different content; a primary-protocol change needs a new protocolVersion — previous results keep the version they ran under`);
        }
        continue;
      }
      if (frozenHistory.length > 0 && reason === undefined) {
        throw new CharterLedgerError(`freezing protocol ${protocolVersion} over the existing ${frozenHistory.at(-1)!.protocolVersion} needs a recorded reason; a primary-protocol change is never silent`);
      }
      const frozen = deepFreeze({
        protocolVersion,
        protocolDigest,
        charterId,
        charterVersion,
        artifactRef,
        baselineIds: Object.freeze(baselineIds),
        ...(reason === undefined ? {} : { reason }),
        frozenOrdinal: event.sequence,
      }) as FrozenProtocol;
      frozenHistory.push(frozen);
      continue;
    }

    // BENCHMARK_EXTENSION_ADDED
    assertClosed("benchmark extension event", EXTENSION_KEYS, payload);
    const frozen = frozenHistory.at(-1);
    const extensionId = requiredString("extensionId", payload.extensionId);
    const baselineId = requiredString("baselineId", payload.baselineId);
    if (!frozen) {
      throw new CharterLedgerError(`benchmark extension ${extensionId} supplements a frozen protocol; freeze the primary protocol first`);
    }
    if (frozen.baselineIds.includes(baselineId)) {
      throw new CharterLedgerError(`comparator ${baselineId} is already in the frozen set of protocol ${frozen.protocolVersion}; an extension adds a supplementary comparator and never replaces the frozen one`);
    }
    const comparator = requiredString("comparator", payload.comparator);
    const existingExtension = extensions.find((entry) => entry.extensionId === extensionId);
    if (existingExtension) {
      if (existingExtension.baselineId !== baselineId || existingExtension.comparator !== comparator
        || existingExtension.rationale !== requiredString("rationale", payload.rationale)
        || existingExtension.artifactRef !== requiredString("artifactRef", payload.artifactRef)) {
        throw new CharterLedgerError(`extension ${extensionId} is already added with different content`);
      }
      continue;
    }
    if (extensions.some((entry) => entry.baselineId === baselineId)) {
      throw new CharterLedgerError(`comparator ${baselineId} is already added as a supplementary comparator`);
    }
    extensions.push(deepFreeze({
      extensionId,
      baselineId,
      comparator,
      rationale: requiredString("rationale", payload.rationale),
      artifactRef: requiredString("artifactRef", payload.artifactRef),
      // Copied from the frozen protocol: an extension cannot move the digest it supplements.
      protocolVersion: frozen.protocolVersion,
      protocolDigest: frozen.protocolDigest,
      addedOrdinal: event.sequence,
    }) as BenchmarkExtension);
  }

  const frozenProtocol = frozenHistory.at(-1);
  const body: Omit<CharterLedgerState, "digest"> = {
    schema: CHARTER_LEDGER_SCHEMA,
    missionId,
    proposals: Object.freeze(proposals),
    ...(approval === undefined ? {} : { approval }),
    ...(frozenProtocol === undefined ? {} : { frozenProtocol }),
    frozenHistory: Object.freeze(frozenHistory),
    extensions: Object.freeze(extensions),
  };
  return deepFreeze({ ...body, digest: digestValue(body) }) as CharterLedgerState;
}

/**
 * The start gate for a long-running research loop (#248 calls it): a Mission may
 * only run under a human-approved charter whose protocol is frozen.
 */
export function requireApprovedCharter(events: readonly ResearchEvent[], options: { readonly missionId: string }): ApprovedCharterReference {
  const state = projectCharterLedger(events, options);
  if (!state.approval) {
    throw new CharterApprovalRequiredError(`mission ${state.missionId} has no human-approved research charter; a long-running research loop cannot start on an unapproved charter`);
  }
  if (!state.frozenProtocol) {
    throw new CharterApprovalRequiredError(`charter ${state.approval.charterId} v${state.approval.charterVersion} is approved but has no frozen benchmark protocol; freeze the protocol before starting the research loop`);
  }
  if (state.frozenProtocol.charterVersion !== state.approval.charterVersion || state.frozenProtocol.protocolDigest !== state.approval.charterDigest) {
    throw new CharterApprovalRequiredError(`the frozen protocol ${state.frozenProtocol.protocolVersion} belongs to charter v${state.frozenProtocol.charterVersion}, but v${state.approval.charterVersion} is approved; freeze the new protocol before starting the research loop`);
  }
  return deepFreeze({
    approval: state.approval,
    protocol: state.frozenProtocol,
    extensions: state.extensions,
  }) as ApprovedCharterReference;
}
