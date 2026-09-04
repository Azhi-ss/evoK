import { DAGScheduler, MissionQueue, type DagRunResult, type DagSchedulerOptions, type DagTaskExecutor } from "./dag-scheduler";

export interface ExecutionPlan {
  readonly version: number;
  readonly branchWidth: number;
  readonly maxAttempts: number;
  readonly branchBudget: number;
  readonly permissions: readonly string[];
  readonly resources: readonly string[];
  readonly verificationGates: readonly string[];
}

export interface CoordinatorInput {
  readonly requestedBranches: number;
  readonly competition?: string;
  readonly maxAttempts?: number;
  readonly branchBudget?: number;
  readonly permissions?: readonly string[];
  readonly resources?: readonly string[];
  readonly verificationGates?: readonly string[];
}

export class Coordinator {
  constructor(private readonly defaults: Partial<ExecutionPlan> = {}) {}

  propose(input: CoordinatorInput): ExecutionPlan {
    if (!Number.isInteger(input.requestedBranches) || input.requestedBranches < 1) {
      throw new RangeError("requestedBranches must be an integer >= 1");
    }
    return {
      version: this.defaults.version ?? 1,
      branchWidth: input.requestedBranches,
      maxAttempts: input.maxAttempts ?? this.defaults.maxAttempts ?? 1,
      branchBudget: input.branchBudget ?? this.defaults.branchBudget ?? 1,
      permissions: [...(input.permissions ?? this.defaults.permissions ?? [])],
      resources: [...(input.resources ?? this.defaults.resources ?? [])],
      verificationGates: [...(input.verificationGates ?? this.defaults.verificationGates ?? [])],
    };
  }
}

export interface PolicyLimits {
  readonly maxBranchWidth: number;
  readonly maxAttempts: number;
  readonly maxBranchBudget: number;
  readonly permissions: readonly string[];
  readonly resources: readonly string[];
  readonly mandatoryVerificationGates: readonly string[];
}

function validPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer >= 1`);
}

function includesAll(allowed: readonly string[], requested: readonly string[]): boolean {
  const set = new Set(allowed);
  return requested.every((value) => set.has(value));
}

export class PolicyGuard {
  constructor(private readonly limits: PolicyLimits) {
    validPositiveInteger("maxBranchWidth", limits.maxBranchWidth);
    validPositiveInteger("maxAttempts", limits.maxAttempts);
    validPositiveInteger("maxBranchBudget", limits.maxBranchBudget);
  }

  validate(plan: ExecutionPlan): ExecutionPlan {
    validPositiveInteger("plan.version", plan.version);
    validPositiveInteger("plan.branchWidth", plan.branchWidth);
    validPositiveInteger("plan.maxAttempts", plan.maxAttempts);
    validPositiveInteger("plan.branchBudget", plan.branchBudget);
    if (plan.branchWidth > this.limits.maxBranchWidth) throw new RangeError("execution plan exceeds branch width");
    if (plan.maxAttempts > this.limits.maxAttempts) throw new RangeError("execution plan exceeds attempt budget");
    if (plan.branchBudget > this.limits.maxBranchBudget) throw new RangeError("execution plan exceeds branch budget");
    if (!includesAll(this.limits.permissions, plan.permissions)) throw new Error("execution plan requests unavailable permissions");
    if (!includesAll(this.limits.resources, plan.resources)) throw new Error("execution plan requests unavailable resources");
    if (!includesAll(plan.verificationGates, this.limits.mandatoryVerificationGates)) {
      throw new Error("execution plan omits a mandatory verification gate");
    }
    return plan;
  }
}

export interface BranchBudget {
  readonly maxAttempts: number;
  readonly remainingAttempts: number;
  readonly maxUnits: number;
  readonly remainingUnits: number;
}

export interface Branch {
  readonly branchId: string;
  readonly sessionId: string;
  readonly workspace: Record<string, string>;
  readonly context: Record<string, unknown>;
  readonly budget: BranchBudget;
  falsifier: Falsifier;
  objections: string[];
  consumeAttempt(): boolean;
}

export interface ArtifactReference {
  readonly artifactId: string;
  readonly branchId: string;
  readonly address: string;
  readonly digest: string;
}

export interface FalsifierResult {
  readonly ok: boolean;
  readonly objections: readonly string[];
}

export interface Falsifier {
  readonly branchId: string;
  falsify(artifact: Readonly<ArtifactReference>): FalsifierResult | Promise<FalsifierResult>;
}

export interface ScheduledBranchResult {
  readonly branch: Branch;
  readonly artifact?: Readonly<ArtifactReference>;
  readonly objections: readonly string[];
  readonly status: "COMPLETED" | "REJECTED";
}

export interface ScheduleOptions {
  readonly branchIds: readonly string[];
  readonly execute: (branch: Branch) => ArtifactReference | Promise<ArtifactReference>;
  readonly falsifier: (branch: Branch) => FalsifierResult | Promise<FalsifierResult>;
}

function assertBranchIds(branchIds: readonly string[]): void {
  if (branchIds.length === 0 || branchIds.some((id) => typeof id !== "string" || id.trim() === "") || new Set(branchIds).size !== branchIds.length) {
    throw new RangeError("branchIds must contain unique, non-empty strings");
  }
}

const ARTIFACT_KEYS = ["artifactId", "branchId", "address", "digest"] as const;

function assertArtifactReference(value: unknown): asserts value is ArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)) {
    throw new TypeError("artifact reference must be an immutable object");
  }
  const candidate = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("artifact reference must use the ordinary object or null prototype");
  }
  const ownKeys = Reflect.ownKeys(candidate);
  if (ownKeys.length !== ARTIFACT_KEYS.length || ownKeys.some((key) => typeof key !== "string" || !ARTIFACT_KEYS.includes(key as typeof ARTIFACT_KEYS[number]))) {
    throw new TypeError("artifact reference must contain exactly artifactId, branchId, address, and digest");
  }
  for (const key of ARTIFACT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value === "") {
      throw new TypeError(`artifact reference requires an own data property ${key}`);
    }
  }
}

function immutableArtifact(value: unknown): Readonly<ArtifactReference> {
  assertArtifactReference(value);
  const candidate = value as ArtifactReference;
  return Object.freeze({
    artifactId: candidate.artifactId,
    branchId: candidate.branchId,
    address: candidate.address,
    digest: candidate.digest,
  });
}

function assertArtifactOwnership(artifact: Readonly<ArtifactReference>, branchId: string): void {
  if (artifact.branchId !== branchId) throw new TypeError("artifact reference belongs to another branch");
}

interface MutableBranchBudget {
  maxAttempts: number;
  remainingAttempts: number;
  maxUnits: number;
  remainingUnits: number;
}

function budgetView(state: MutableBranchBudget): BranchBudget {
  return Object.freeze({
    get maxAttempts() { return state.maxAttempts; },
    get remainingAttempts() { return state.remainingAttempts; },
    get maxUnits() { return state.maxUnits; },
    get remainingUnits() { return state.remainingUnits; },
  });
}

export class DeterministicScheduler {
  constructor(
    private readonly guard: PolicyGuard,
    private readonly missionQueue = new MissionQueue<DagRunResult>(),
  ) {}

  createBranches(plan: ExecutionPlan, branchIds: readonly string[]): Branch[] {
    const approved = this.guard.validate(plan);
    assertBranchIds(branchIds);
    if (branchIds.length > approved.branchWidth) throw new RangeError("branch count exceeds execution plan width");
    return branchIds.map((branchId) => {
      const budgetState: MutableBranchBudget = {
        maxAttempts: approved.maxAttempts,
        remainingAttempts: approved.maxAttempts,
        maxUnits: approved.branchBudget,
        remainingUnits: approved.branchBudget,
      };
      const budget = budgetView(budgetState);
      const branch: Branch = {
        branchId,
        sessionId: `${branchId}:session`,
        workspace: {},
        context: {},
        budget,
        falsifier: {
          branchId,
          falsify: () => ({ ok: true, objections: [] }),
        },
        objections: [],
        consumeAttempt: () => {
          if (budgetState.remainingAttempts < 1 || budgetState.remainingUnits < 1) return false;
          budgetState.remainingAttempts -= 1;
          budgetState.remainingUnits -= 1;
          return true;
        },
      };
      Object.defineProperty(branch, "budget", { value: budget, writable: false, configurable: false, enumerable: true });
      return branch;
    });
  }

  runDag(options: DagSchedulerOptions, fallback?: DagTaskExecutor): Promise<DagRunResult> {
    const result = this.missionQueue.enqueue(options.missionId, () => new DAGScheduler(options).run(fallback));
    void this.missionQueue.drain().catch(() => undefined);
    return result;
  }

  async run(plan: ExecutionPlan, options: ScheduleOptions): Promise<ScheduledBranchResult[]> {
    const branches = this.createBranches(plan, options.branchIds);
    // The branch list is created in input order; Promise.all preserves that order while allowing fan-out.
    return Promise.all(branches.map(async (branch): Promise<ScheduledBranchResult> => {
      if (!branch.consumeAttempt()) return { branch, objections: ["branch budget exhausted"], status: "REJECTED" };
      try {
        const artifact = immutableArtifact(await options.execute(branch));
        assertArtifactOwnership(artifact, branch.branchId);
        branch.falsifier = { branchId: branch.branchId, falsify: () => options.falsifier(branch) };
        const falsification = await branch.falsifier.falsify(artifact);
        branch.objections = [...falsification.objections];
        return {
          branch,
          artifact,
          objections: branch.objections,
          status: falsification.ok ? "COMPLETED" : "REJECTED",
        };
      } catch (error) {
        branch.objections = [error instanceof Error ? error.message : "branch execution failed"];
        return { branch, objections: branch.objections, status: "REJECTED" };
      }
    }));
  }
}

export interface Evaluation {
  readonly score: number;
  readonly [key: string]: unknown;
}

export type IndependentEvaluator = (artifact: Readonly<ArtifactReference>) => Evaluation | Promise<Evaluation>;
export type PromotionPolicy = (artifact: Readonly<ArtifactReference>, evaluation: Readonly<Evaluation>) => boolean | Promise<boolean>;

export interface FanInResult {
  readonly evaluations: ReadonlyMap<string, Evaluation>;
  readonly promoted?: Readonly<ArtifactReference>;
}

export class ArtifactFanIn {
  private readonly approvedBranchIds: ReadonlySet<string>;

  constructor(
    private readonly evaluator: IndependentEvaluator,
    private readonly promotionPolicy: PromotionPolicy,
    approvedBranchIds: readonly string[],
  ) {
    assertBranchIds(approvedBranchIds);
    this.approvedBranchIds = new Set(approvedBranchIds);
  }

  async reconcile(artifacts: readonly ArtifactReference[]): Promise<FanInResult> {
    const unique = new Set<string>();
    const ownedArtifacts: Readonly<ArtifactReference>[] = [];
    for (const supplied of artifacts) {
      const artifact = immutableArtifact(supplied);
      if (!this.approvedBranchIds.has(artifact.branchId)) throw new TypeError("artifact reference belongs to an unapproved branch");
      if (unique.has(artifact.artifactId)) throw new TypeError("duplicate artifact reference");
      unique.add(artifact.artifactId);
      ownedArtifacts.push(artifact);
    }
    const evaluations = new Map<string, Evaluation>();
    let promoted: Readonly<ArtifactReference> | undefined;
    let promotedScore = Number.NEGATIVE_INFINITY;
    for (const artifact of ownedArtifacts) {
      const evaluation = await this.evaluator(artifact);
      if (!Number.isFinite(evaluation.score)) throw new Error("evaluator returned a non-finite score");
      evaluations.set(artifact.artifactId, evaluation);
      if (await this.promotionPolicy(artifact, evaluation) && evaluation.score > promotedScore) {
        promoted = artifact;
        promotedScore = evaluation.score;
      }
    }
    return { evaluations, promoted };
  }
}

export { Coordinator as TeamCoordinator };
export * from "./dag-scheduler";
