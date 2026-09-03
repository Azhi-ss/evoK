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
  | "PROMOTED_LOCAL"
  | "BRANCH_REJECTED"
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
}

export interface MissionState {
  missionId: string;
  phase: MissionPhase;
  objective: string;
  constraints: Record<string, unknown>;
  budget: MissionBudget;
  adapterName: string;
  branches: Record<string, BranchState>;
  champion?: { branchId: string; score: number; facts: ScoreFact[]; snapshot: Readonly<CandidateSnapshot> };
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

function initialState(event: MissionEvent): MissionState {
  const p = event.payload;
  const branchIds = p.branchIds as string[];
  return {
    missionId: String(p.missionId),
    phase: "CREATED",
    objective: String(p.objective),
    constraints: clone((p.constraints as Record<string, unknown>) ?? {}),
    budget: clone((p.budget as MissionBudget) ?? {}),
    adapterName: String(p.adapterName ?? "toy"),
    branches: Object.fromEntries(branchIds.map((branchId) => [branchId, {
      branchId, status: "QUEUED", attempt: 0, candidateGenerated: false,
      agentCompleted: false, evaluatorSucceeded: false,
    } satisfies BranchState])),
  };
}

function isValidSnapshot(snapshot: unknown, state: MissionState, branch: BranchState, eventFence: number): snapshot is CandidateSnapshot {
  if (!snapshot || typeof snapshot !== "object") return false;
  const candidate = snapshot as Partial<CandidateSnapshot>;
  const provenance = candidate.provenance;
  return typeof candidate.missionId === "string"
    && candidate.missionId === state.missionId
    && typeof candidate.branchId === "string"
    && candidate.branchId === branch.branchId
    && typeof candidate.attempt === "number"
    && Number.isInteger(candidate.attempt)
    && candidate.attempt === branch.attempt
    && isRecord(candidate.files)
    && isRecord(candidate.contract)
    && typeof candidate.contract.objective === "string"
    && isRecord(provenance)
    && provenance.runId === `${state.missionId}:${branch.branchId}:${branch.attempt}`
    && provenance.candidateId === `${branch.branchId}:${branch.attempt}`
    && isFiniteNumber(provenance.fencingToken)
    && provenance.fencingToken === branch.fencingToken
    && provenance.fencingToken === eventFence;
}

function project(events: readonly MissionEvent[]): MissionState {
  const created = events.find((event) => event.type === "MISSION_CREATED");
  if (!created) throw new Error("ledger has no MISSION_CREATED event");
  const state = initialState(created);
  for (const event of events.slice(1)) {
    const p = event.payload;
    const branchScoped = Object.prototype.hasOwnProperty.call(p, "branchId");
    const branch = branchScoped ? state.branches[String(p.branchId)] : undefined;
    const eventFence = p.fencingToken;
    if (branchScoped && event.type !== "BRANCH_RESERVED" && !isFiniteNumber(eventFence)) continue;
    if (branch && event.type !== "BRANCH_RESERVED" && eventFence !== branch.fencingToken) continue;
    if ((event.type === "SNAPSHOT_COMMITTED" || event.type === "PROMOTED_LOCAL")
      && (!branch || !isFiniteNumber(eventFence) || !isValidSnapshot(p.snapshot, state, branch, eventFence))) continue;
    switch (event.type) {
      case "MISSION_STARTED": state.phase = "RUNNING"; break;
      case "BRANCH_RESERVED": {
        const attempt = p.attempt;
        if (branch && isFiniteNumber(eventFence) && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1
          && (branch.fencingToken === undefined || eventFence > branch.fencingToken)) {
          branch.attempt = attempt;
          branch.fencingToken = eventFence;
          branch.status = "TASK_SELECTED";
        }
        break;
      }
      case "PREFLIGHT_SELF_CHECK_PASSED": if (branch) branch.status = "PREFLIGHT_SELF_CHECK"; break;
      case "PREFLIGHT_SELF_CHECK_FAILED":
        if (branch) { branch.status = "REJECTED"; branch.rejectionReason = String(p.reason ?? "self-check failed"); }
        break;
      case "AGENT_COMPLETED": if (branch) branch.agentCompleted = true; break;
      case "CANDIDATE_GENERATED": if (branch) { branch.candidateGenerated = true; branch.status = "CANDIDATE_PROPOSED"; } break;
      case "CANDIDATE_MATERIALIZED": if (branch) branch.status = "MATERIALIZED"; break;
      case "SNAPSHOT_COMMITTED": if (branch) { branch.snapshot = freeze(clone(p.snapshot as CandidateSnapshot)); branch.status = "RUNNING"; } break;
      case "EVALUATION_STARTED": if (branch) branch.status = "VERIFYING"; break;
      case "EVALUATOR_SUCCEEDED":
        if (branch) { branch.evaluatorSucceeded = true; branch.score = Number(p.score); branch.facts = clone((p.facts as ScoreFact[]) ?? []); branch.status = "SCORED"; }
        break;
      case "EVALUATOR_FAILED": break;
      case "FALSIFIER_COMPLETED":
        if (branch && p.ok === false) { branch.objections = clone((p.objections as string[]) ?? []); branch.status = "REJECTED"; branch.rejectionReason = "falsifier objection"; }
        break;
      case "BRANCH_REJECTED":
        if (branch) { branch.status = "REJECTED"; branch.rejectionReason = String(p.reason ?? "rejected"); }
        break;
      case "PROMOTED_LOCAL":
        if (branch) branch.status = "PROMOTED_LOCAL";
        state.champion = {
          branchId: String(p.branchId), score: Number(p.score), facts: clone((p.facts as ScoreFact[]) ?? []),
          snapshot: freeze(clone(p.snapshot as CandidateSnapshot)),
        };
        break;
      case "MISSION_COMPLETED": state.phase = "COMPLETED"; break;
      case "MISSION_STOPPED": state.phase = "STOPPED"; state.stopReason = String(p.reason); break;
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

  constructor(options: ToyMissionOptions) {
    this.options = options;
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
        budget: clone(this.effectiveBudget), branchIds, adapterName: this.adapter.name ?? "toy",
      },
    }];
  }

  private get contract(): TaskContract {
    return this.options.taskContract ?? {
      objective: this.options.objective ?? "",
      constraints: clone(this.options.constraints ?? {}),
      budget: clone(this.options.budget ?? {}),
    };
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
    this.ledger.push({ sequence: this.ledger.length + 1, type, payload: clone(payload) });
  }

  private promotionApproved(candidate: NonNullable<MissionState["champion"]>, state: MissionState): boolean {
    const policy = this.options.promotionPolicy;
    return policy ? policy({ candidate, champion: state.champion }) : !state.champion || candidate.score > state.champion.score;
  }

  private async processBranch(branchId: string): Promise<void> {
    const state = this.state();
    const branch = state.branches[branchId];
    if (!branch || branch.status === "PROMOTED_LOCAL" || branch.status === "REJECTED") return;
    const maxAttempts = this.effectiveBudget.maxAttempts ?? 1;
    let snapshot = branch.snapshot;
    let attempt = branch.attempt;
    let recoveredStage: BranchStatus | undefined = snapshot ? branch.status : undefined;
    let reservation = branch.status === "TASK_SELECTED" && !snapshot && branch.attempt > 0 && branch.fencingToken !== undefined
      ? { attempt: branch.attempt, fencingToken: branch.fencingToken }
      : undefined;
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
        fencingToken = this.ledger.filter((event) => event.type === "BRANCH_RESERVED").length + 1;
        this.append("BRANCH_RESERVED", { branchId, attempt, fencingToken });
        if (snapshot) {
          snapshot = freeze({
            ...clone(snapshot),
            attempt,
            provenance: {
              ...clone(snapshot.provenance),
              runId: `${this.options.missionId}:${branchId}:${attempt}`,
              candidateId: `${branchId}:${attempt}`,
              fencingToken,
            },
          });
          this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot });
        }
        recoveredStage = undefined;
        evaluationAlreadyStarted = false;
        evaluationAlreadySucceeded = false;
      }
      if (this.options.crashBeforeBranch === branchId && !this.crashed && !snapshot) {
        this.crashed = true;
        throw new Error("simulated crash");
      }
      if (!snapshot) {
        const workspace: Record<string, string> = {};
        const context: Record<string, unknown> = {};
        const check = await this.options.runtime.selfVerify({ missionId: this.options.missionId, branchId, taskContract: this.contract, context, workspace });
        if (!check.ok) {
          this.append("PREFLIGHT_SELF_CHECK_FAILED", { branchId, fencingToken, objections: check.objections ?? [], reason: "self-check failed" });
          return;
        }
        this.append("PREFLIGHT_SELF_CHECK_PASSED", { branchId, fencingToken });
        const proposal = await this.options.runtime.propose({ missionId: this.options.missionId, branchId, taskContract: this.contract, workspace });
        this.append("AGENT_COMPLETED", { branchId, fencingToken, ok: true });
        this.append("CANDIDATE_GENERATED", { branchId, fencingToken, files: proposal.files });
        this.append("CANDIDATE_MATERIALIZED", { branchId, fencingToken });
        snapshot = freeze({
          missionId: this.options.missionId, branchId, attempt, files: clone(proposal.files), contract: clone(this.contract),
          provenance: { runId: `${this.options.missionId}:${branchId}:${attempt}`, candidateId: `${branchId}:${attempt}`, fencingToken },
        });
        this.append("SNAPSHOT_COMMITTED", { branchId, fencingToken, snapshot });
      }
      if (!evaluationAlreadyStarted) this.append("EVALUATION_STARTED", { branchId, fencingToken });
      try {
        let score: number;
        let facts: ScoreFact[];
        if (evaluationAlreadySucceeded) {
          score = branch.score!;
          facts = branch.facts ?? [];
        } else {
          const evaluation = await this.adapter.evaluate(snapshot);
          if (!Number.isFinite(evaluation.score)) throw new Error("evaluator returned a non-finite score");
          score = evaluation.score;
          facts = evaluation.facts ?? [{ name: "score", value: evaluation.score, source: this.adapter.name ?? "toy-evaluator" }];
          this.append("EVALUATOR_SUCCEEDED", { branchId, fencingToken, score, facts });
        }
        const falsification = await this.options.runtime.falsify({ missionId: this.options.missionId, branchId, snapshot });
        this.append("FALSIFIER_COMPLETED", { branchId, fencingToken, ok: falsification.ok, objections: falsification.objections });
        if (!falsification.ok) { this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: "falsifier objection" }); return; }
        const candidate = { branchId, score, facts, snapshot };
        if (this.promotionApproved(candidate, this.state())) this.append("PROMOTED_LOCAL", { ...candidate, fencingToken });
        return;
      } catch (error) {
        if (!(error instanceof InfrastructureError) || attempt >= maxAttempts) {
          this.append("BRANCH_REJECTED", { branchId, fencingToken, reason: error instanceof Error ? error.message : "evaluation failed" });
          return;
        }
        this.append("EVALUATOR_FAILED", { branchId, fencingToken, reason: error.message });
        this.append("RETRY_SCHEDULED", { branchId, fencingToken, nextAttempt: attempt + 1, reason: error.message });
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
