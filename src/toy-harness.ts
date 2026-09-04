import {
  HumanAcceptanceGate,
  SandboxBoundary,
  SandboxViolation,
  SecretRedactor,
  TrustViolation,
  assertSnapshotIntegrity,
  createTrustedSnapshot,
  deepFreeze,
  digestValue,
  evaluateTrustedSnapshot,
  type SandboxPolicy,
} from "./security-boundary";
import {
  normalizeVerificationResult,
  verificationRoleContract,
  type VerificationContext,
  type VerificationHooks,
  type VerificationRole,
} from "./verification-gates";
import type { HumanAcceptanceDecision } from "./security-boundary";

export type MissionPhase = "CREATED" | "RUNNING" | "COMPLETED" | "STOPPED";

export type BranchStatus =
  | "QUEUED"
  | "TASK_SELECTED"
  | "PREPARED"
  | "CANDIDATE_PROPOSED"
  | "MATERIALIZED"
  | "PREFLIGHT_SELF_CHECK"
  | "RUNNING"
  | "VERIFYING"
  | "SCORED"
  | "REJECTED"
  | "QUARANTINED"
  | "PROMOTED_LOCAL";

export interface TaskContract {
  objective: string;
  constraints?: Record<string, unknown>;
  budget?: MissionBudget;
  expectedOutputs?: string[];
}

export interface MissionBudget {
  maxCandidates?: number;
  maxAttempts?: number;
  [key: string]: number | undefined;
}

export interface CandidateSnapshot {
  missionId: string;
  branchId: string;
  attempt: number;
  files: Record<string, string>;
  contract: TaskContract;
  /** Integrity fields are present on snapshots created by the harness. */
  digest?: string;
  filesDigest?: string;
  contractDigest?: string;
  provenance: {
    runId: string;
    candidateId: string;
    fencingToken: number;
  };
}

export interface ScoreFact {
  name: string;
  value: string | number | boolean;
  source?: string;
}

export interface EvaluationResult {
  score: number;
  facts?: ScoreFact[];
  evaluatorId?: string;
  evaluatorVersion?: string;
  snapshotDigest?: string;
  contractDigest?: string;
}

export interface CandidateVerificationInput {
  missionId: string;
  branchId: string;
  snapshot: Readonly<CandidateSnapshot>;
}

export interface EvidenceVerificationInput extends CandidateVerificationInput {
  evaluation: Readonly<EvaluationResult>;
}

export interface ToyAgentRuntime {
  selfVerify(input: {
    missionId: string;
    branchId: string;
    taskContract: TaskContract;
    context: Record<string, unknown>;
    workspace: Record<string, string>;
  }): { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  propose(input: {
    missionId: string;
    branchId: string;
    taskContract: TaskContract;
    workspace: Record<string, string>;
  }): { files: Record<string, string> } | Promise<{ files: Record<string, string> }>;
  falsify(input: {
    missionId: string;
    branchId: string;
    snapshot: Readonly<CandidateSnapshot>;
  }): { ok: boolean; objections: string[] } | Promise<{ ok: boolean; objections: string[] }>;
  critic?: (input: CandidateVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  challenger?: (input: CandidateVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  auditor?: (input: EvidenceVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
  successAuditor?: (input: EvidenceVerificationInput) => { ok: boolean; objections?: string[] } | Promise<{ ok: boolean; objections?: string[] }>;
}

export interface ToyCompetitionAdapter {
  readonly name?: string;
  evaluate(snapshot: Readonly<CandidateSnapshot>): EvaluationResult | Promise<EvaluationResult>;
}

/** A deliberately small reference adapter: the candidate's `score` file is the score. */
export class ScoreFileToyCompetitionAdapter implements ToyCompetitionAdapter {
  constructor(readonly scoreFile = "score") {}

  evaluate(snapshot: Readonly<CandidateSnapshot>): EvaluationResult {
    const score = Number(snapshot.files[this.scoreFile]);
    return {
      score,
      facts: [{ name: "score-file", value: score, source: this.scoreFile }],
    };
  }
}

export class InfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfrastructureError";
  }
}

export type MissionEventType =
  | "MISSION_CREATED"
  | "MISSION_STARTED"
  | "BRANCH_RESERVED"
  | "TASK_SELECTED"
  | "PREFLIGHT_SELF_CHECK_PASSED"
  | "PREFLIGHT_SELF_CHECK_FAILED"
  | "AGENT_COMPLETED"
  | "CANDIDATE_GENERATED"
  | "CANDIDATE_MATERIALIZED"
  | "SNAPSHOT_COMMITTED"
  | "EVALUATION_STARTED"
  | "EVALUATOR_SUCCEEDED"
  | "EVALUATOR_FAILED"
  | "FALSIFIER_COMPLETED"
  | "CRITIC_COMPLETED"
  | "CHALLENGER_COMPLETED"
  | "AUDITOR_COMPLETED"
  | "SUCCESS_AUDITOR_COMPLETED"
  | "PROMOTED_LOCAL"
  | "BRANCH_REJECTED"
  | "BRANCH_QUARANTINED"
  | "HUMAN_ACCEPTED"
  | "RETRY_SCHEDULED"
  | "MISSION_COMPLETED"
  | "MISSION_STOPPED"
  | "LATE_EVENT_REJECTED";

export interface MissionEvent {
  sequence: number;
  type: MissionEventType;
  payload: Record<string, unknown>;
}

export interface BranchState {
  branchId: string;
  status: BranchStatus;
  attempt: number;
  fencingToken?: number;
  candidateGenerated: boolean;
  agentCompleted: boolean;
  evaluatorSucceeded: boolean;
  score?: number;
  facts?: ScoreFact[];
  snapshot?: Readonly<CandidateSnapshot>;
  objections?: string[];
  rejectionReason?: string;
  verification: Partial<Record<VerificationRole, boolean>>;
  candidateFilesDigest?: string;
  snapshotDigest?: string;
  contractDigest?: string;
}

export interface MissionState {
  missionId: string;
  phase: MissionPhase;
  objective: string;
  constraints: Record<string, unknown>;
  budget: MissionBudget;
  adapterName: string;
  quorum: number;
  verificationRoles: readonly VerificationRole[];
  contractDigest: string;
  branches: Record<string, BranchState>;
  champion?: { branchId: string; score: number; facts: ScoreFact[]; snapshot: Readonly<CandidateSnapshot> };
  humanAcceptance?: HumanAcceptanceDecision;
  stopReason?: string;
}

export type PromotionPolicy = (input: {
  candidate: { branchId: string; score: number; facts: ScoreFact[]; snapshot: Readonly<CandidateSnapshot> };
  champion?: MissionState["champion"];
}) => boolean;

export interface ToyMissionOptions {
  missionId: string;
  objective?: string;
  constraints?: Record<string, unknown>;
  budget?: MissionBudget;
  adapter?: ToyCompetitionAdapter;
  competitionAdapter?: ToyCompetitionAdapter;
  taskContract?: TaskContract;
  branchIds?: string[];
  runtime: ToyAgentRuntime;
  evaluate?: (snapshot: Readonly<CandidateSnapshot>) => EvaluationResult;
  promotionPolicy?: PromotionPolicy;
  policy?: {
    maxBranches: number;
    maxParallelBranches: number;
    maxAttempts?: number;
    quorum: number;
  };
  crashBeforeBranch?: string;
  /** Optional process/path policy used by the candidate boundary. */
  sandbox?: SandboxPolicy;
  /** Optional layer-internal verification roles; none of these can promote. */
  verification?: VerificationHooks;
  secrets?: readonly string[];
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateInteger(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidFence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isValidAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validObjections(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validVerificationRoles(value: unknown): value is VerificationRole[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.includes("SelfVerifier") && value.includes("Falsifier")
    && value.every((role) => typeof role === "string" && VERIFICATION_ROLE_SET.has(role as VerificationRole));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function minimumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function validateBudget(budget: MissionBudget, source: string): void {
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined) validateInteger(`${source}.${name}`, value, name === "maxAttempts" ? 1 : 0);
  }
}

function validateOptions(options: ToyMissionOptions, branchIds: string[], budget: MissionBudget): void {
  if (branchIds.some((branchId) => typeof branchId !== "string" || branchId.trim() === "") || new Set(branchIds).size !== branchIds.length) {
    throw new RangeError("branchIds must contain unique, non-empty strings");
  }
  validateBudget(budget, "budget");
  const policy = options.policy;
  if (!policy) return;
  validateInteger("policy.maxBranches", policy.maxBranches, 1);
  validateInteger("policy.maxParallelBranches", policy.maxParallelBranches, 1);
  if (policy.maxAttempts !== undefined) validateInteger("policy.maxAttempts", policy.maxAttempts, 1);
  validateInteger("policy.quorum", policy.quorum, 1);
  if (policy.maxParallelBranches > policy.maxBranches) throw new RangeError("maxParallelBranches cannot exceed maxBranches");
  if (policy.quorum > Math.min(policy.maxBranches, branchIds.length)) throw new RangeError("quorum cannot exceed available branches");
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

const DEFAULT_VERIFICATION_ROLES: readonly VerificationRole[] = Object.freeze(["SelfVerifier", "Falsifier"]);
const VERIFICATION_ROLE_SET = new Set<VerificationRole>([
  "SelfVerifier", "Falsifier", "Critic", "Challenger", "Auditor", "SuccessAuditor",
]);

function configuredVerificationRoles(options: ToyMissionOptions): VerificationRole[] {
  const roles: VerificationRole[] = [...DEFAULT_VERIFICATION_ROLES];
  if (typeof options.verification?.critic === "function" || typeof options.runtime.critic === "function") roles.push("Critic");
  if (typeof options.verification?.challenger === "function" || typeof options.runtime.challenger === "function") roles.push("Challenger");
  if (typeof options.verification?.auditor === "function" || typeof options.runtime.auditor === "function") roles.push("Auditor");
  if (typeof options.verification?.successAuditor === "function" || typeof options.runtime.successAuditor === "function") roles.push("SuccessAuditor");
  return roles;
}

function initialState(event: MissionEvent): MissionState {
  const p = event.payload;
  const branchIds = Array.isArray(p.branchIds) ? p.branchIds.filter((branchId): branchId is string => typeof branchId === "string") : [];
  const roles = validVerificationRoles(p.verificationRoles) ? [...p.verificationRoles] : [...DEFAULT_VERIFICATION_ROLES];
  const quorum = isValidFence(p.quorum) ? p.quorum : 1;
  if (typeof p.contractDigest !== "string" || p.contractDigest.trim() === "") {
    throw new TrustViolation("mission contract digest is required");
  }
  if (!isPlainRecord(p.contract) || typeof p.contract.objective !== "string" || p.contract.objective.trim() === "") {
    throw new TrustViolation("mission contract is required");
  }
  try {
    if (digestValue(p.contract) !== p.contractDigest) {
      throw new TrustViolation("mission contract digest does not match its contents");
    }
  } catch (error) {
    if (error instanceof TrustViolation) throw error;
    throw new TrustViolation("mission contract is not digestable");
  }
  return {
    missionId: String(p.missionId),
    phase: "CREATED",
    objective: String(p.objective),
    constraints: clone((p.constraints as Record<string, unknown>) ?? {}),
    budget: clone((p.budget as MissionBudget) ?? {}),
    adapterName: String(p.adapterName ?? "toy"),
    quorum,
    verificationRoles: Object.freeze(roles),
    contractDigest: p.contractDigest,
    branches: Object.fromEntries(branchIds.map((branchId) => [branchId, {
      branchId, status: "QUEUED", attempt: 0, candidateGenerated: false,
      agentCompleted: false, evaluatorSucceeded: false, verification: {},
    } satisfies BranchState])),
  };
}

function isValidSnapshot(snapshot: unknown, state: MissionState, branch: BranchState, eventFence: number): snapshot is CandidateSnapshot {
  if (!isPlainRecord(snapshot)) return false;
  const candidate = snapshot as Partial<CandidateSnapshot>;
  const provenance = candidate.provenance;
  if (!(typeof candidate.missionId === "string"
    && candidate.missionId === state.missionId
    && typeof candidate.branchId === "string"
    && candidate.branchId === branch.branchId
    && isValidAttempt(candidate.attempt)
    && candidate.attempt === branch.attempt
    && isPlainRecord(candidate.files)
    && Object.values(candidate.files).every((value) => typeof value === "string")
    && isPlainRecord(candidate.contract)
    && typeof candidate.contract.objective === "string"
    && isPlainRecord(provenance)
    && provenance.runId === `${state.missionId}:${branch.branchId}:${branch.attempt}`
    && provenance.candidateId === `${branch.branchId}:${branch.attempt}`
    && isValidFence(provenance.fencingToken)
    && provenance.fencingToken === branch.fencingToken
    && provenance.fencingToken === eventFence
    && typeof candidate.digest === "string"
    && typeof candidate.filesDigest === "string"
    && typeof candidate.contractDigest === "string"
    && candidate.contractDigest === state.contractDigest
    && branch.candidateFilesDigest === candidate.filesDigest)) return false;
  try {
    assertSnapshotIntegrity(candidate);
    return true;
  } catch {
    return false;
  }
}

const verificationEventRoles: Readonly<Record<string, VerificationRole>> = Object.freeze({
  FALSIFIER_COMPLETED: "Falsifier",
  CRITIC_COMPLETED: "Critic",
  CHALLENGER_COMPLETED: "Challenger",
  AUDITOR_COMPLETED: "Auditor",
  SUCCESS_AUDITOR_COMPLETED: "SuccessAuditor",
});

function validFacts(value: unknown): value is ScoreFact[] {
  return Array.isArray(value) && value.every((fact) => isPlainRecord(fact)
    && typeof fact.name === "string"
    && (typeof fact.value === "string" || typeof fact.value === "boolean" || typeof fact.value === "number" && Number.isFinite(fact.value))
    && (fact.source === undefined || typeof fact.source === "string"));
}

function sameFacts(left: unknown, right: unknown): boolean {
  try { return digestValue(left) === digestValue(right); } catch { return false; }
}

function verificationComplete(state: MissionState, branch: BranchState): boolean {
  return state.verificationRoles.every((role) => branch.verification[role] === true);
}

function project(events: readonly MissionEvent[]): MissionState {
  const created = events[0];
  if (!created || created.type !== "MISSION_CREATED" || created.sequence !== 1 || !isPlainRecord(created.payload)) {
    throw new Error("ledger must start with MISSION_CREATED at sequence 1");
  }
  const state = initialState(created);
  let expectedSequence = 2;
  let retryableFence: number | undefined;
  for (const event of events.slice(1)) {
    if (!isPlainRecord(event) || event.sequence !== expectedSequence || typeof event.type !== "string" || !isPlainRecord(event.payload)) break;
    expectedSequence += 1;
    const p = event.payload;
    if ((state.phase === "COMPLETED" || state.phase === "STOPPED") && event.type !== "HUMAN_ACCEPTED") continue;
    const branchScoped = Object.prototype.hasOwnProperty.call(p, "branchId");
    if (branchScoped && typeof p.branchId !== "string") continue;
    const branch = branchScoped ? state.branches[p.branchId as string] : undefined;
    const eventFence = p.fencingToken;
    if (branchScoped && event.type !== "BRANCH_RESERVED" && !isValidFence(eventFence)) continue;
    if (branch && event.type !== "BRANCH_RESERVED" && eventFence !== branch.fencingToken) continue;
    if ((event.type === "SNAPSHOT_COMMITTED" || event.type === "PROMOTED_LOCAL")
      && (!branch || !isValidFence(eventFence) || !isValidSnapshot(p.snapshot, state, branch, eventFence))) continue;
    switch (event.type) {
      case "MISSION_STARTED":
        if (state.phase === "CREATED") state.phase = "RUNNING";
        break;
      case "BRANCH_RESERVED": {
        const attempt = p.attempt;
        const carriesSnapshot = !!branch && retryableFence === branch.fencingToken && branch.snapshot !== undefined;
        const carriedVerification = carriesSnapshot && branch ? { ...branch.verification } : {};
        const carriedFilesDigest = carriesSnapshot && branch ? branch.candidateFilesDigest ?? branch.snapshot?.filesDigest : undefined;
        if (state.phase === "RUNNING" && branch && isValidFence(eventFence) && isValidAttempt(attempt)
          && attempt === branch.attempt + 1
          && (branch.fencingToken === undefined || eventFence > branch.fencingToken)
          && !["PROMOTED_LOCAL", "REJECTED", "QUARANTINED"].includes(branch.status)
          && (branch.status !== "SCORED" || retryableFence === branch.fencingToken)) {
          branch.attempt = attempt;
          branch.fencingToken = eventFence;
          branch.status = "TASK_SELECTED";
          branch.candidateGenerated = false;
          branch.agentCompleted = false;
          branch.evaluatorSucceeded = false;
          branch.score = undefined;
          branch.facts = undefined;
          branch.snapshot = undefined;
          branch.candidateFilesDigest = carriedFilesDigest;
          branch.snapshotDigest = undefined;
          branch.contractDigest = undefined;
          branch.objections = undefined;
          branch.rejectionReason = undefined;
          branch.verification = carriedVerification;
          retryableFence = undefined;
        }
        break;
      }
      case "PREFLIGHT_SELF_CHECK_PASSED":
        if (branch && branch.status === "TASK_SELECTED" && p.ok === true && validObjections(p.objections ?? [])) {
          branch.status = "PREFLIGHT_SELF_CHECK";
          branch.verification.SelfVerifier = true;
        }
        break;
      case "PREFLIGHT_SELF_CHECK_FAILED":
        if (branch && branch.status === "TASK_SELECTED" && p.ok !== true && validObjections(p.objections ?? [])) {
          branch.verification.SelfVerifier = false;
          branch.status = "REJECTED";
          branch.objections = clone(p.objections as string[]);
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "self-check failed";
        }
        break;
      case "AGENT_COMPLETED":
        if (branch && branch.status === "PREFLIGHT_SELF_CHECK" && p.ok === true) branch.agentCompleted = true;
        break;
      case "CANDIDATE_GENERATED": {
        let filesDigest: string | undefined;
        try {
          if (isPlainRecord(p.files)) filesDigest = digestValue(p.files);
        } catch {
          filesDigest = undefined;
        }
        if (branch && branch.status === "PREFLIGHT_SELF_CHECK" && branch.agentCompleted
          && filesDigest !== undefined && p.filesDigest === filesDigest
          && Object.values(p.files as Record<string, unknown>).every((value) => typeof value === "string")) {
          branch.candidateGenerated = true;
          branch.candidateFilesDigest = filesDigest;
          branch.status = "CANDIDATE_PROPOSED";
        }
        break;
      }
      case "CANDIDATE_MATERIALIZED":
        if (branch && branch.status === "CANDIDATE_PROPOSED" && branch.candidateGenerated) branch.status = "MATERIALIZED";
        break;
      case "SNAPSHOT_COMMITTED": {
        if (!branch) break;
        const snapshot = p.snapshot as CandidateSnapshot;
        const duplicate = branch.snapshot?.digest === snapshot.digest;
        const recoverable = branch.status === "TASK_SELECTED" && p.recovered === true;
        if (duplicate && branch.status === "RUNNING") break;
        if (!(branch.status === "MATERIALIZED" || recoverable)) break;
        branch.snapshot = freeze(clone(snapshot));
        branch.snapshotDigest = branch.snapshot.digest;
        branch.contractDigest = branch.snapshot.contractDigest;
        branch.status = "RUNNING";
        break;
      }
      case "EVALUATION_STARTED":
        if (branch && branch.snapshot && branch.status === "RUNNING") branch.status = "VERIFYING";
        break;
      case "EVALUATOR_SUCCEEDED":
        if (branch && branch.snapshot && branch.status === "VERIFYING" && isFiniteNumber(p.score) && validFacts(p.facts)
          && typeof p.evaluatorId === "string" && p.evaluatorId.trim() !== ""
          && typeof p.evaluatorVersion === "string" && p.evaluatorVersion.trim() !== ""
          && p.snapshotDigest === branch.snapshot.digest && p.contractDigest === branch.snapshot.contractDigest) {
          branch.evaluatorSucceeded = true;
          branch.score = p.score;
          branch.facts = clone(p.facts);
          branch.status = "SCORED";
        }
        break;
      case "EVALUATOR_FAILED":
        if (branch && (branch.status === "VERIFYING" || branch.status === "SCORED")
          && typeof p.reason === "string" && p.reason.trim() !== "") {
          branch.objections = [p.reason];
        }
        break;
      case "RETRY_SCHEDULED":
        if (branch && (branch.status === "VERIFYING" || branch.status === "SCORED")
          && isValidFence(eventFence) && eventFence === branch.fencingToken
          && isValidAttempt(p.nextAttempt) && p.nextAttempt === branch.attempt + 1
          && typeof p.reason === "string" && p.reason.trim() !== "") retryableFence = eventFence;
        break;
      case "FALSIFIER_COMPLETED":
      case "CRITIC_COMPLETED":
      case "CHALLENGER_COMPLETED":
      case "AUDITOR_COMPLETED":
      case "SUCCESS_AUDITOR_COMPLETED": {
        const role = verificationEventRoles[event.type];
        if (!branch || !role || !state.verificationRoles.includes(role) || p.role !== role
          || typeof p.ok !== "boolean" || !validObjections(p.objections) || !branch.snapshot
          || p.snapshotDigest !== branch.snapshot.digest
          || p.contractDigest !== branch.snapshot.contractDigest
          || branch.verification[role] !== undefined) break;
        const early = role === "Falsifier" || role === "Critic" || role === "Challenger";
        if (early ? !["VERIFYING", "SCORED"].includes(branch.status) : branch.status !== "SCORED") break;
        branch.verification[role] = p.ok;
        branch.objections = clone(p.objections);
        if (!p.ok) {
          branch.status = "REJECTED";
          branch.rejectionReason = `${role} objection`;
        }
        break;
      }
      case "BRANCH_REJECTED":
        if (branch && branch.status !== "PROMOTED_LOCAL" && branch.status !== "QUARANTINED") {
          branch.status = "REJECTED";
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "rejected";
        }
        break;
      case "BRANCH_QUARANTINED":
        if (branch && branch.status !== "PROMOTED_LOCAL" && branch.status !== "REJECTED") {
          branch.status = "QUARANTINED";
          branch.rejectionReason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason : "sandbox or trust violation";
          branch.objections = validObjections(p.objections) ? clone(p.objections) : [branch.rejectionReason];
        }
        break;
      case "PROMOTED_LOCAL": {
        const promotedSnapshot = p.snapshot as CandidateSnapshot;
        if (!branch || branch.status !== "SCORED" || !branch.evaluatorSucceeded || !verificationComplete(state, branch)
          || p.branchId !== branch.branchId || !branch.snapshot
          || promotedSnapshot.digest !== branch.snapshot.digest
          || p.snapshotDigest !== branch.snapshot.digest || p.contractDigest !== branch.snapshot.contractDigest
          || !isFiniteNumber(p.score) || p.score !== branch.score || !validFacts(p.facts)
          || !sameFacts(p.facts, branch.facts)) break;
        branch.status = "PROMOTED_LOCAL";
        if (state.champion?.snapshot.digest !== promotedSnapshot.digest) state.humanAcceptance = undefined;
        state.champion = {
          branchId: branch.branchId, score: p.score, facts: clone(p.facts),
          snapshot: freeze(clone(promotedSnapshot)),
        };
        break;
      }
      case "HUMAN_ACCEPTED":
        if (state.champion && typeof p.championDigest === "string" && p.championDigest === state.champion.snapshot.digest
          && typeof p.acceptedBy === "string" && p.acceptedBy.trim() !== ""
          && typeof p.decisionId === "string" && p.decisionId.trim() !== ""
          && isFiniteNumber(p.acceptedAt)) {
          state.humanAcceptance = freeze({
            championDigest: p.championDigest,
            acceptedBy: p.acceptedBy,
            decisionId: p.decisionId,
            acceptedAt: p.acceptedAt,
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          });
        }
        break;
      case "MISSION_COMPLETED":
        if (state.phase === "RUNNING" && Object.values(state.branches).filter((value) => value.status === "PROMOTED_LOCAL").length >= state.quorum) {
          state.phase = "COMPLETED";
        }
        break;
      case "MISSION_STOPPED":
        if (state.phase === "RUNNING" && typeof p.reason === "string" && p.reason.trim() !== "") {
          state.phase = "STOPPED";
          state.stopReason = p.reason;
        }
        break;
    }
  }
  return state;
}

export class ToyCompetitionHarness {
  private readonly ledger: MissionEvent[];
  private crashed = false;
  private readonly options: ToyMissionOptions;
  private readonly adapter: ToyCompetitionAdapter;
  private readonly effectiveBudget: MissionBudget;
  private readonly sandbox: SandboxBoundary;
  private readonly redactor: SecretRedactor;
  private contractValue?: Readonly<TaskContract>;
  private readonly humanAcceptance = new HumanAcceptanceGate();

  constructor(options: ToyMissionOptions) {
    if (typeof options.missionId !== "string" || options.missionId.trim() === "") throw new TypeError("missionId is required");
    this.options = options;
    this.sandbox = new SandboxBoundary({ ...options.sandbox, root: options.sandbox?.root ?? `/tmp/evok-${encodeURIComponent(options.missionId)}` });
    this.redactor = new SecretRedactor(options.secrets ?? []);
    this.adapter = options.adapter ?? options.competitionAdapter ?? { name: "toy", evaluate: options.evaluate ?? new ScoreFileToyCompetitionAdapter().evaluate.bind(new ScoreFileToyCompetitionAdapter()) };
    const contract = this.contract;
    const branchIds = this.branchIds;
    const contractBudget = contract.budget ?? {};
    const topLevelBudget = options.budget ?? {};
    validateBudget(contractBudget, "taskContract.budget");
    validateBudget(topLevelBudget, "budget");
    const effectiveBudget: MissionBudget = {};
    for (const name of new Set([...Object.keys(contractBudget), ...Object.keys(topLevelBudget)])) {
      const value = minimumDefined(contractBudget[name], topLevelBudget[name]);
      if (value !== undefined) effectiveBudget[name] = value;
    }
    const maxCandidates = minimumDefined(effectiveBudget.maxCandidates, options.policy?.maxBranches);
    const maxAttempts = minimumDefined(effectiveBudget.maxAttempts, options.policy?.maxAttempts);
    if (maxCandidates !== undefined) effectiveBudget.maxCandidates = maxCandidates;
    if (maxAttempts !== undefined) effectiveBudget.maxAttempts = maxAttempts;
    this.effectiveBudget = effectiveBudget;
    validateOptions(options, branchIds, this.effectiveBudget);
    const maxBranches = this.effectiveBudget.maxCandidates ?? branchIds.length;
    const quorum = options.policy?.quorum ?? 1;
    if (quorum > Math.min(maxBranches, branchIds.length)) throw new RangeError("quorum cannot exceed available branches");
    this.ledger = [{
      sequence: 1,
      type: "MISSION_CREATED",
      payload: {
        missionId: options.missionId, objective: contract.objective, constraints: clone(contract.constraints ?? options.constraints ?? {}),
        budget: clone(this.effectiveBudget), branchIds, adapterName: this.adapter.name ?? "toy", quorum,
        contract: clone(contract), contractDigest: digestValue(contract),
        verificationRoles: configuredVerificationRoles(options),
      },
    }];
  }

  private get contract(): TaskContract {
    if (!this.contractValue) {
      const contract = this.options.taskContract ?? {
        objective: this.options.objective ?? "",
        constraints: clone(this.options.constraints ?? {}),
        budget: clone(this.options.budget ?? {}),
      };
      this.contractValue = deepFreeze(this.redactor.redact(clone(contract))) as Readonly<TaskContract>;
    }
    return this.contractValue as TaskContract;
  }

  private get branchIds(): string[] {
    return this.options.branchIds?.slice() ?? ["candidate-1"];
  }

  static fromEvents(options: ToyMissionOptions, events: readonly MissionEvent[]): ToyCompetitionHarness {
    const harness = new ToyCompetitionHarness(options);
    harness.ledger.splice(0, harness.ledger.length, ...clone(events));
    return harness;
  }

  static replay(events: readonly MissionEvent[]): MissionState { return project(events); }
  replay(): MissionState { return project(this.ledger); }
  state(): MissionState { return this.replay(); }
  events(): readonly MissionEvent[] { return freeze(clone(this.ledger)); }
  ledgerEvents(): readonly MissionEvent[] { return this.events(); }

  private append(type: MissionEventType, payload: Record<string, unknown> = {}): void {
    const safe = this.redactor.redact(payload);
    if (["CANDIDATE_GENERATED", "SNAPSHOT_COMMITTED", "EVALUATOR_SUCCEEDED", "PROMOTED_LOCAL"].includes(type)) {
      let unchanged = false;
      try { unchanged = JSON.stringify(safe) === JSON.stringify(payload); } catch { unchanged = false; }
      if (!unchanged) throw new SandboxViolation("credential", "integrity-bearing event contains a secret");
    }
    this.ledger.push({ sequence: this.ledger.length + 1, type, payload: clone(safe) });
  }

  private promotionApproved(candidate: NonNullable<MissionState["champion"]>, state: MissionState): boolean {
    const policy = this.options.promotionPolicy;
    return policy ? policy({ candidate, champion: state.champion }) : !state.champion || candidate.score > state.champion.score;
  }

  private verificationContext(role: VerificationRole, branchId: string, snapshot?: Readonly<CandidateSnapshot>, evaluation?: Readonly<EvaluationResult>): VerificationContext {
    return deepFreeze({
      role,
      contract: Object.freeze({ ...verificationRoleContract(role) }),
      missionId: this.options.missionId,
      branchId,
      taskContract: deepFreeze(clone(this.contract)),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(evaluation === undefined ? {} : { evaluation }),
    });
  }

  private async runVerificationRole(
    role: VerificationRole,
    branchId: string,
    snapshot: Readonly<CandidateSnapshot>,
    evaluation?: Readonly<EvaluationResult>,
  ): Promise<{ ok: boolean; objections: string[] }> {
    const hooks = this.options.verification;
    const runtime = this.options.runtime;
    const context = this.verificationContext(role, branchId, snapshot, evaluation);
    let result: unknown;
    if (role === "Falsifier") {
      if (hooks?.falsifier) result = await hooks.falsifier(context);
      else result = await runtime.falsify({ missionId: this.options.missionId, branchId, snapshot });
    } else if (role === "Critic") {
      if (hooks?.critic) result = await hooks.critic(context);
      else if (runtime.critic) result = await runtime.critic({ missionId: this.options.missionId, branchId, snapshot });
      else return { ok: true, objections: [] };
    } else if (role === "Challenger") {
      if (hooks?.challenger) result = await hooks.challenger(context);
      else if (runtime.challenger) result = await runtime.challenger({ missionId: this.options.missionId, branchId, snapshot });
      else return { ok: true, objections: [] };
    } else if (role === "Auditor") {
      if (hooks?.auditor) result = await hooks.auditor(context);
      else if (runtime.auditor) result = await runtime.auditor({ missionId: this.options.missionId, branchId, snapshot, evaluation: evaluation! });
      else return { ok: true, objections: [] };
    } else if (role === "SuccessAuditor") {
      if (hooks?.successAuditor) result = await hooks.successAuditor(context);
      else if (runtime.successAuditor) result = await runtime.successAuditor({ missionId: this.options.missionId, branchId, snapshot, evaluation: evaluation! });
      else return { ok: true, objections: [] };
    } else {
      const callback = hooks?.selfVerifier;
      if (!callback) return { ok: true, objections: [] };
      result = await callback(context);
    }
    const normalized = normalizeVerificationResult(result, role);
    return { ok: normalized.ok, objections: [...normalized.objections] };
  }

  private appendVerification(
    role: VerificationRole,
    branchId: string,
    fencingToken: number,
    snapshot: Readonly<CandidateSnapshot>,
    result: { ok: boolean; objections: string[] },
  ): void {
    const type: MissionEventType = role === "Falsifier" ? "FALSIFIER_COMPLETED"
      : role === "Critic" ? "CRITIC_COMPLETED"
        : role === "Challenger" ? "CHALLENGER_COMPLETED"
          : role === "Auditor" ? "AUDITOR_COMPLETED" : "SUCCESS_AUDITOR_COMPLETED";
    this.append(type, {
      branchId, fencingToken, role, ok: result.ok, objections: result.objections,
      snapshotDigest: snapshot.digest, contractDigest: snapshot.contractDigest,
    });
  }

  private quarantine(branchId: string, fencingToken: number, error: unknown): void {
    const safe = this.redactor.error(error);
    this.append("BRANCH_QUARANTINED", { branchId, fencingToken, reason: safe.message, objections: [safe.message] });
  }

  acceptChampion(request: Omit<Parameters<HumanAcceptanceGate["accept"]>[0], "championDigest"> & { championDigest?: string }): Readonly<HumanAcceptanceDecision> {
    const state = this.state();
    if (!state.champion) throw new Error("cannot accept a mission without a local champion");
    const digest = request.championDigest ?? state.champion.snapshot.digest;
    if (!digest || digest !== state.champion.snapshot.digest) throw new TrustViolation("human acceptance must name the current champion digest");
    const decision = this.humanAcceptance.accept({ ...request, championDigest: digest });
    this.append("HUMAN_ACCEPTED", decision as Record<string, unknown>);
    return decision;
  }

  private async processBranch(branchId: string): Promise<void> {
    const state = this.state();
    const branch = state.branches[branchId];
    if (!branch || ["PROMOTED_LOCAL", "REJECTED", "QUARANTINED"].includes(branch.status)) return;
    const maxAttempts = this.effectiveBudget.maxAttempts ?? 1;
    let snapshot = branch.snapshot;
    let attempt = branch.attempt;
    let recoveredStage: BranchStatus | undefined = snapshot ? branch.status : undefined;
    let reservation = branch.status === "TASK_SELECTED" && !snapshot && branch.attempt > 0 && branch.fencingToken !== undefined
      ? { attempt: branch.attempt, fencingToken: branch.fencingToken }
      : undefined;
    let verifiedRoles = new Set<VerificationRole>(Object.entries(branch.verification)
      .filter(([, passed]) => passed === true)
      .map(([role]) => role as VerificationRole));

    // A reservation is a resumable attempt, not a new attempt after a crash.
    while (attempt < maxAttempts || reservation || recoveredStage) {
      let fencingToken: number;
      let evaluationAlreadyStarted = recoveredStage === "VERIFYING" || recoveredStage === "SCORED";
      let evaluationAlreadySucceeded = recoveredStage === "SCORED";
      if (recoveredStage) {
        attempt = branch.attempt;
        fencingToken = branch.fencingToken!;
      } else if (reservation) {
        attempt = reservation.attempt;
        fencingToken = reservation.fencingToken;
        reservation = undefined;
      } else {
        attempt += 1;
        const carriesSnapshot = snapshot !== undefined;
        const carriedRoles = carriesSnapshot ? new Set(verifiedRoles) : new Set<VerificationRole>();
        const fences = this.ledger
          .filter((event) => event.type === "BRANCH_RESERVED" && isValidFence(event.payload.fencingToken))
          .map((event) => event.payload.fencingToken as number);
        fencingToken = (fences.length > 0 ? Math.max(...fences) : 0) + 1;
        this.append("BRANCH_RESERVED", { branchId, attempt, fencingToken });
        if (snapshot) {
          snapshot = createTrustedSnapshot({
            ...clone(snapshot),
            attempt,
            provenance: {
              ...clone(snapshot.provenance),
              runId: `${this.options.missionId}:${branchId}:${attempt}`,
              candidateId: `${branchId}:${attempt}`,
              fencingToken,
            },
          }) as Readonly<CandidateSnapshot>;
          this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot, recovered: true });
        }
        verifiedRoles = carriedRoles;
        recoveredStage = undefined;
        evaluationAlreadyStarted = false;
        evaluationAlreadySucceeded = false;
      }
      if (this.options.crashBeforeBranch === branchId && !this.crashed && !snapshot) {
        this.crashed = true;
        throw new Error("simulated crash");
      }
      if (!snapshot) {
        try {
          const workspace = this.sandbox.createWorkspace();
          const context: Record<string, unknown> = {};
          const taskContract = deepFreeze(clone(this.contract)) as TaskContract;
          const rawCheck = typeof this.options.verification?.selfVerifier === "function"
            ? await this.options.verification.selfVerifier(this.verificationContext("SelfVerifier", branchId))
            : await this.options.runtime.selfVerify({ missionId: this.options.missionId, branchId, taskContract, context, workspace });
          const check = normalizeVerificationResult(rawCheck, "SelfVerifier");
          if (!check.ok) {
            this.append("PREFLIGHT_SELF_CHECK_FAILED", { branchId, fencingToken, objections: check.objections, reason: "self-check failed" });
            return;
          }
          this.append("PREFLIGHT_SELF_CHECK_PASSED", { branchId, fencingToken, ok: true, objections: check.objections });
          const proposal = await this.options.runtime.propose({ missionId: this.options.missionId, branchId, taskContract, workspace });
          const files = this.sandbox.validateCandidateFiles(proposal?.files);
          if (JSON.stringify(this.redactor.redact(files)) !== JSON.stringify(files)) {
            throw new SandboxViolation("credential", "candidate output contains a configured secret");
          }
          this.append("AGENT_COMPLETED", { branchId, fencingToken, ok: true });
          this.append("CANDIDATE_GENERATED", { branchId, fencingToken, files, filesDigest: digestValue(files) });
          this.append("CANDIDATE_MATERIALIZED", { branchId, fencingToken });
          snapshot = createTrustedSnapshot({
            missionId: this.options.missionId,
            branchId,
            attempt,
            files,
            contract: clone(taskContract),
            provenance: { runId: `${this.options.missionId}:${branchId}:${attempt}`, candidateId: `${branchId}:${attempt}`, fencingToken },
          }) as Readonly<CandidateSnapshot>;
          this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot });
        } catch (error) {
          if (error instanceof SandboxViolation || error instanceof TypeError && /read only|readonly|frozen|extensible|property/i.test(error.message)) {
            this.quarantine(branchId, fencingToken, error instanceof SandboxViolation ? error : new TrustViolation("candidate attempted to mutate trusted input"));
            return;
          }
          const reason = this.redactor.error(error).message;
          if (!(error instanceof InfrastructureError) || attempt >= maxAttempts) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
            return;
          }
          this.append("RETRY_SCHEDULED", { branchId, fencingToken, nextAttempt: attempt + 1, reason });
          recoveredStage = undefined;
          continue;
        }
      }
      if (!snapshot) return;
      try {
        assertSnapshotIntegrity(snapshot as unknown as Record<string, unknown>);
      } catch (error) {
        this.quarantine(branchId, fencingToken, error instanceof TrustViolation ? error : new TrustViolation("untrusted snapshot failed integrity validation"));
        return;
      }

      try {
        if (!evaluationAlreadyStarted) this.append("EVALUATION_STARTED", { branchId, fencingToken });

        let evaluation: EvaluationResult;
        if (evaluationAlreadySucceeded) {
          evaluation = {
            score: branch.score!,
            facts: branch.facts ?? [],
            snapshotDigest: snapshot.digest,
            contractDigest: snapshot.contractDigest,
          };
        } else {
          const trusted = await evaluateTrustedSnapshot(
            snapshot as unknown as Record<string, unknown>,
            this.contract,
            async (candidate) => this.adapter.evaluate(candidate as unknown as CandidateSnapshot),
          );
          const raw = trusted.result;
          if (!isRecord(raw) || !isFiniteNumber(raw.score) || (raw.facts !== undefined && !validFacts(raw.facts))
            || raw.evaluatorId !== undefined && (typeof raw.evaluatorId !== "string" || raw.evaluatorId.trim() === "")
            || raw.evaluatorVersion !== undefined && (typeof raw.evaluatorVersion !== "string" || raw.evaluatorVersion.trim() === "")) {
            throw new TrustViolation("evaluator returned a malformed result");
          }
          if (raw.snapshotDigest !== undefined && raw.snapshotDigest !== trusted.manifest.snapshotDigest) {
            throw new TrustViolation("evaluator result is bound to another snapshot");
          }
          if (raw.contractDigest !== undefined && raw.contractDigest !== trusted.manifest.contractDigest) {
            throw new TrustViolation("evaluator result is bound to another contract");
          }
          evaluation = {
            score: raw.score,
            facts: clone((raw.facts as ScoreFact[] | undefined) ?? [{ name: "score", value: raw.score, source: this.adapter.name ?? "toy-evaluator" }]),
            evaluatorId: typeof raw.evaluatorId === "string" ? raw.evaluatorId : this.adapter.name ?? "toy-evaluator",
            evaluatorVersion: typeof raw.evaluatorVersion === "string" ? raw.evaluatorVersion : "1",
            snapshotDigest: trusted.manifest.snapshotDigest,
            contractDigest: trusted.manifest.contractDigest,
          };
          this.append("EVALUATOR_SUCCEEDED", { branchId, fencingToken, ...evaluation });
        }

        const earlyRoles: VerificationRole[] = ["Falsifier", "Critic", "Challenger"];
        for (const role of earlyRoles) {
          const callbackExists = role === "Falsifier"
            || role === "Critic" && (typeof this.options.verification?.critic === "function" || typeof this.options.runtime.critic === "function")
            || role === "Challenger" && (typeof this.options.verification?.challenger === "function" || typeof this.options.runtime.challenger === "function");
          if (!callbackExists || verifiedRoles.has(role)) continue;
          const result = await this.runVerificationRole(role, branchId, snapshot);
          this.appendVerification(role, branchId, fencingToken, snapshot, result);
          verifiedRoles.add(role);
          if (!result.ok) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `${role} objection` });
            return;
          }
        }

        for (const role of ["Auditor", "SuccessAuditor"] as const) {
          const callbackExists = role === "Auditor"
            ? typeof this.options.verification?.auditor === "function" || typeof this.options.runtime.auditor === "function"
            : typeof this.options.verification?.successAuditor === "function" || typeof this.options.runtime.successAuditor === "function";
          if (!callbackExists || verifiedRoles.has(role)) continue;
          const result = await this.runVerificationRole(role, branchId, snapshot, evaluation);
          this.appendVerification(role, branchId, fencingToken, snapshot, result);
          verifiedRoles.add(role);
          if (!result.ok) {
            this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: `${role} objection` });
            return;
          }
        }

        const candidate = { branchId, score: evaluation.score, facts: evaluation.facts ?? [], snapshot };
        if (this.promotionApproved(candidate, this.state())) {
          this.append("PROMOTED_LOCAL", { ...candidate, fencingToken, snapshotDigest: evaluation.snapshotDigest, contractDigest: evaluation.contractDigest });
        } else {
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "promotion policy rejected" });
        }
        return;
      } catch (error) {
        if (error instanceof SandboxViolation) {
          this.quarantine(branchId, fencingToken, error);
          return;
        }
        const reason = this.redactor.error(error).message;
        if (!(error instanceof InfrastructureError) || attempt >= maxAttempts) {
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason });
          return;
        }
        this.append("EVALUATOR_FAILED", { branchId, fencingToken, reason });
        this.append("RETRY_SCHEDULED", { branchId, fencingToken, nextAttempt: attempt + 1, reason });
        recoveredStage = undefined;
      }
    }
  }

  async run(): Promise<MissionState> {
    const current = this.state();
    if (current.phase === "COMPLETED" || current.phase === "STOPPED") return current;
    if (current.phase === "CREATED") { this.append("MISSION_STARTED"); }
    const maxBranches = this.effectiveBudget.maxCandidates ?? this.branchIds.length;
    const ids = this.branchIds.slice(0, maxBranches);
    const concurrency = Math.max(1, this.options.policy?.maxParallelBranches ?? 1);
    let cursor = 0;
    const worker = async () => { while (cursor < ids.length) { const id = ids[cursor++]; await this.processBranch(id); } };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure) throw failure.reason;
    const final = this.state();
    const quorum = this.options.policy?.quorum ?? 1;
    const promoted = Object.values(final.branches).filter((branch) => branch.status === "PROMOTED_LOCAL").length;
    if (promoted >= quorum) this.append("MISSION_COMPLETED", { champion: final.champion });
    else this.append("MISSION_STOPPED", { reason: "join quorum not met" });
    return this.state();
  }

  async resume(): Promise<MissionState> { return this.run(); }

  injectLateCompletion(branchId: string, fencingToken: number, score: number): boolean {
    const branch = this.state().branches[branchId];
    if (!branch || branch.fencingToken !== fencingToken) {
      this.append("LATE_EVENT_REJECTED", { branchId, fencingToken, score, reason: "stale fencing token" });
      return false;
    }
    this.append("LATE_EVENT_REJECTED", { branchId, fencingToken, score, reason: "completion injection unsupported" });
    return false;
  }
}

export function createToyMission(options: ToyMissionOptions): ToyCompetitionHarness {
  return new ToyCompetitionHarness(options);
}

export function replayToyMission(events: readonly MissionEvent[]): MissionState {
  return ToyCompetitionHarness.replay(events);
}

export * from "./team-execution";
export * from "./pi-agent-runtime";
export * from "./branch-recovery";
export * from "./dag-scheduler";
export * from "./security-boundary";
export * from "./verification-gates";
export * from "./research-loop";
