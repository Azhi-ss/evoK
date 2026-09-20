/**
 * ET-DEPLOY-ORCH / #182 — DeployArena thick orchestration (not a commercial OS).
 *
 * Competition-owned serving arm: task/service graph, multi-machine / multi-GPU
 * workers, local metric aggregation, and the Competition I/O (COI) adapter
 * that assembles `submission.json` `{ image, command, env }`.
 *
 * Auto-submit authority stays in evidence (`attemptContestAutoSubmit`).
 * This module does not loosen Admission / Budget / hang / T48 predicates,
 * does not thicken execution Pattern C, and does not open from env alone.
 * AtCoder remains a separate frozen arm. Deploy Arena is orthogonal:
 * callers must pass `competitionId=deploy-arena`.
 */
import { deepFreeze } from "../execution/security-boundary";
import type { ContestSubmitSeam, ContestSubmitSeamResult } from "../evidence/contest-auto-submit";

export const DEPLOY_ARENA_COMPETITION_ID = "deploy-arena" as const;
export const CAPABILITY_GATE_THRESHOLD = 95;
export const DEFAULT_DEPLOY_ARENA_CHALLENGE_ID = "llm-challenge-arena-v1" as const;

export type DeployArenaTaskKind = "capability" | "load" | "aggregate";
export type DeployArenaTaskStatus = "completed" | "failed" | "skipped";

export interface DeployArenaWorker {
  readonly id: string;
  readonly machine: string;
  readonly gpu?: string;
}

export interface DeployArenaTask {
  readonly id: string;
  readonly kind: DeployArenaTaskKind;
  readonly workerId?: string;
  readonly subject?: string;
  readonly service?: string;
  readonly dependsOn?: readonly string[];
}

export interface DeployArenaGraph {
  readonly workers: readonly DeployArenaWorker[];
  readonly tasks: readonly DeployArenaTask[];
}

export interface DeployArenaObservation {
  readonly taskId: string;
  readonly workerId?: string;
  readonly subject: string;
  readonly score: number;
  readonly samples?: number;
}

export interface DeployArenaTaskState {
  readonly id: string;
  readonly status: DeployArenaTaskStatus;
  readonly workerId?: string;
}

export interface DeployArenaSubjectAggregate {
  readonly subject: string;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly workers: number;
  readonly samples: number;
}

export interface DeployArenaCapabilityGate {
  readonly aime26: number;
  readonly gpqaDiamond: number;
  readonly passed: boolean;
  readonly threshold: typeof CAPABILITY_GATE_THRESHOLD;
}

export interface DeployArenaAggregation {
  readonly subjects: readonly DeployArenaSubjectAggregate[];
  readonly capability: DeployArenaCapabilityGate;
}

export interface DeployArenaGraphResult {
  readonly ok: boolean;
  readonly workers: readonly DeployArenaWorker[];
  readonly observations: readonly DeployArenaObservation[];
  readonly tasks: readonly DeployArenaTaskState[];
  readonly aggregation: DeployArenaAggregation;
}

export interface DeployArenaSubmission {
  readonly image: string;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface DeployArenaServingKnobs {
  readonly image: string;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DeployArenaCredentials {
  readonly playground?: boolean;
  readonly bohr?: boolean;
}

export type DeployArenaExec = (argv: readonly string[]) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export interface PlaygroundContestSubmitOptions {
  readonly challengeId?: string;
  readonly outputsDir?: string;
  readonly trace?: string;
  readonly credentials?: DeployArenaCredentials;
  readonly exec?: DeployArenaExec;
  readonly submission?: DeployArenaSubmission;
}

export interface RunDeployArenaGraphInput {
  readonly graph: DeployArenaGraph;
  readonly scores?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export const DEPLOY_ARENA_SMOKE_WORKERS: readonly DeployArenaWorker[] = Object.freeze([
  Object.freeze({ id: "w0", machine: "host-a", gpu: "cuda:0" }),
  Object.freeze({ id: "w1", machine: "host-b", gpu: "cuda:1" }),
]);

export const DEPLOY_ARENA_SMOKE_GRAPH: DeployArenaGraph = deepFreeze({
  workers: DEPLOY_ARENA_SMOKE_WORKERS,
  tasks: [
    { id: "aime-w0", kind: "capability", workerId: "w0", subject: "aime26", service: "capability" },
    { id: "gpqa-w0", kind: "capability", workerId: "w0", subject: "gpqa-diamond", service: "capability" },
    { id: "aime-w1", kind: "capability", workerId: "w1", subject: "aime26", service: "capability" },
    { id: "gpqa-w1", kind: "capability", workerId: "w1", subject: "gpqa-diamond", service: "capability" },
    {
      id: "agg-capability",
      kind: "aggregate",
      service: "capability-aggregate",
      dependsOn: ["aime-w0", "gpqa-w0", "aime-w1", "gpqa-w1"],
    },
    { id: "load-w0", kind: "load", workerId: "w0", subject: "n-at-slo", service: "load", dependsOn: ["agg-capability"] },
    { id: "load-w1", kind: "load", workerId: "w1", subject: "n-at-slo", service: "load", dependsOn: ["agg-capability"] },
    { id: "agg-load", kind: "aggregate", service: "load-aggregate", dependsOn: ["load-w0", "load-w1"] },
  ],
});

const SMOKE_SCORES: Readonly<Record<string, Readonly<Record<string, number>>>> = deepFreeze({
  w0: { aime26: 96, "gpqa-diamond": 97, "n-at-slo": 80 },
  w1: { aime26: 98, "gpqa-diamond": 97, "n-at-slo": 82 },
});

export class DeployArenaContractError extends Error {
  readonly kind = "deploy-arena-contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "DeployArenaContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeployArenaContractError(`${label} is required`);
  }
  return value.trim();
}

function workerById(workers: readonly DeployArenaWorker[]): Map<string, DeployArenaWorker> {
  const map = new Map<string, DeployArenaWorker>();
  for (const worker of workers) {
    const id = requireNonEmpty("worker id", worker.id);
    if (map.has(id)) throw new DeployArenaContractError(`duplicate worker: ${id}`);
    requireNonEmpty("worker machine", worker.machine);
    map.set(id, worker);
  }
  return map;
}

function topoLayers(tasks: readonly DeployArenaTask[]): DeployArenaTask[][] {
  const byId = new Map<string, DeployArenaTask>();
  for (const task of tasks) {
    const id = requireNonEmpty("task id", task.id);
    if (byId.has(id)) throw new DeployArenaContractError(`duplicate task: ${id}`);
    byId.set(id, task);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!byId.has(dep)) throw new DeployArenaContractError(`unknown dependency: ${dep}`);
    }
  }
  const remaining = new Map(byId);
  const layers: DeployArenaTask[][] = [];
  while (remaining.size > 0) {
    const ready: DeployArenaTask[] = [];
    for (const task of remaining.values()) {
      const blocked = (task.dependsOn ?? []).some((dep) => remaining.has(dep));
      if (!blocked) ready.push(task);
    }
    if (ready.length === 0) {
      throw new DeployArenaContractError(`cycle in DeployArena task graph: ${[...remaining.keys()].join(",")}`);
    }
    for (const task of ready) remaining.delete(task.id);
    layers.push(ready);
  }
  return layers;
}

function scoreFor(
  scores: Readonly<Record<string, Readonly<Record<string, number>>>>,
  workerId: string,
  subject: string,
): number {
  const row = scores[workerId]?.[subject];
  if (typeof row !== "number" || !Number.isFinite(row)) {
    throw new DeployArenaContractError(`missing score for worker ${workerId} subject ${subject}`);
  }
  return row;
}

export function aggregateDeployArenaMetrics(
  observations: readonly DeployArenaObservation[],
): DeployArenaAggregation {
  if (!Array.isArray(observations)) {
    throw new DeployArenaContractError("observations must be an array");
  }
  const groups = new Map<string, DeployArenaObservation[]>();
  for (const row of observations) {
    if (row === null || typeof row !== "object") {
      throw new DeployArenaContractError("observation must be an object");
    }
    const subject = requireNonEmpty("subject", row.subject);
    if (typeof row.score !== "number" || !Number.isFinite(row.score)) {
      throw new DeployArenaContractError(`score is required for ${subject}`);
    }
    const bucket = groups.get(subject) ?? [];
    bucket.push(row);
    groups.set(subject, bucket);
  }
  const subjects = [...groups.entries()].map(([subject, rows]) => {
    const scores = rows.map((row) => row.score);
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const samples = rows.reduce((sum, row) => sum + (row.samples ?? 0), 0);
    const workers = new Set(rows.map((row) => row.workerId).filter((id): id is string => typeof id === "string")).size;
    return deepFreeze({
      subject,
      mean,
      min: Math.min(...scores),
      max: Math.max(...scores),
      workers,
      samples,
    }) as DeployArenaSubjectAggregate;
  });
  const aime26 = subjects.find((row) => row.subject === "aime26")?.mean ?? 0;
  const gpqaDiamond = subjects.find((row) => row.subject === "gpqa-diamond")?.mean ?? 0;
  return deepFreeze({
    subjects,
    capability: {
      aime26,
      gpqaDiamond,
      passed: aime26 > CAPABILITY_GATE_THRESHOLD && gpqaDiamond > CAPABILITY_GATE_THRESHOLD,
      threshold: CAPABILITY_GATE_THRESHOLD,
    },
  }) as DeployArenaAggregation;
}

export async function runDeployArenaGraph(input: RunDeployArenaGraphInput): Promise<DeployArenaGraphResult> {
  if (!isRecord(input) || !isRecord(input.graph)) {
    throw new DeployArenaContractError("runDeployArenaGraph requires a graph");
  }
  const workers = workerById(input.graph.workers ?? []);
  for (const task of input.graph.tasks ?? []) {
    if (task.workerId !== undefined && !workers.has(task.workerId)) {
      throw new DeployArenaContractError(`unknown worker: ${task.workerId}`);
    }
  }
  const layers = topoLayers(input.graph.tasks ?? []);
  const scores = input.scores ?? SMOKE_SCORES;
  const observations: DeployArenaObservation[] = [];
  const states: DeployArenaTaskState[] = [];

  for (const layer of layers) {
    const executed = await Promise.all(layer.map(async (task) => {
      if (task.kind === "load" && !aggregateDeployArenaMetrics(observations).capability.passed) {
        return {
          observation: undefined,
          state: deepFreeze({
            id: task.id,
            status: "skipped",
            ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
          }) as DeployArenaTaskState,
        };
      }
      if (task.kind === "capability" || task.kind === "load") {
        const workerId = requireNonEmpty("workerId", task.workerId);
        const subject = requireNonEmpty("subject", task.subject);
        const observation = deepFreeze({
          taskId: task.id,
          workerId,
          subject,
          score: scoreFor(scores, workerId, subject),
          samples: task.kind === "load" ? 1 : 10,
        }) as DeployArenaObservation;
        return { observation, state: deepFreeze({ id: task.id, status: "completed", workerId }) as DeployArenaTaskState };
      }
      return {
        observation: undefined,
        state: deepFreeze({
          id: task.id,
          status: "completed",
          ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
        }) as DeployArenaTaskState,
      };
    }));
    for (const item of executed) {
      if (item.observation !== undefined) observations.push(item.observation);
      states.push(item.state);
    }
  }

  return deepFreeze({
    ok: states.every((task) => task.status === "completed" || task.status === "skipped"),
    workers: [...workers.values()],
    observations,
    tasks: states,
    aggregation: aggregateDeployArenaMetrics(observations),
  }) as DeployArenaGraphResult;
}

export function assembleDeployArenaSubmission(knobs: DeployArenaServingKnobs): DeployArenaSubmission {
  if (!isRecord(knobs)) throw new DeployArenaContractError("serving knobs are required");
  const image = requireNonEmpty("image", knobs.image);
  const command = requireNonEmpty("command", knobs.command);
  const envEntries = Object.entries(knobs.env ?? {}).map(([key, value]) => {
    if (typeof value !== "string") throw new DeployArenaContractError(`env.${key} must be a string`);
    return [requireNonEmpty("env key", key), value] as const;
  });
  return deepFreeze({
    image,
    command,
    env: Object.fromEntries(envEntries),
  }) as DeployArenaSubmission;
}

function credentialsPresent(credentials: DeployArenaCredentials | undefined): boolean {
  return credentials?.playground === true || credentials?.bohr === true;
}

export function playgroundTaskDownloadArgv(input: {
  readonly challengeId?: string;
  readonly outDir: string;
}): readonly string[] {
  const challengeId = input.challengeId ?? DEFAULT_DEPLOY_ARENA_CHALLENGE_ID;
  return Object.freeze([
    "playground",
    "task",
    "download",
    "--challenge-id",
    requireNonEmpty("challengeId", challengeId),
    "--out",
    requireNonEmpty("outDir", input.outDir),
  ]);
}

export function playgroundSubmitArgv(input: {
  readonly challengeId?: string;
  readonly outputsDir: string;
  readonly trace: string;
}): readonly string[] {
  const challengeId = input.challengeId ?? DEFAULT_DEPLOY_ARENA_CHALLENGE_ID;
  return Object.freeze([
    "playground",
    "submit",
    "--challenge-id",
    requireNonEmpty("challengeId", challengeId),
    "--outputs",
    requireNonEmpty("outputsDir", input.outputsDir),
    "--trace",
    requireNonEmpty("trace", input.trace),
  ]);
}

export function createPlaygroundContestSubmitSeam(
  options: PlaygroundContestSubmitOptions = {},
): ContestSubmitSeam {
  const challengeId = options.challengeId ?? DEFAULT_DEPLOY_ARENA_CHALLENGE_ID;
  const outputsDir = options.outputsDir ?? ".";
  const trace = options.trace ?? "deploy-arena.trace";
  return async ({ live, decision }): Promise<ContestSubmitSeamResult> => {
    if (decision.reason === "gates-not-green" || decision.refusedGates.length > 0) {
      throw new DeployArenaContractError("playground seam refused: gates are not green");
    }
    const argv = playgroundSubmitArgv({ challengeId, outputsDir, trace });
    if (live !== true) {
      return deepFreeze({
        status: "DRY_RUN",
        response: {
          challengeId,
          argv,
          ...(options.submission === undefined ? {} : { submission: options.submission }),
        },
      }) as ContestSubmitSeamResult;
    }
    if (!credentialsPresent(options.credentials)) {
      return deepFreeze({
        status: "FAILED",
        response: { reason: "credentials-missing", challengeId },
      }) as ContestSubmitSeamResult;
    }
    const exec = options.exec ?? (async () => {
      throw new DeployArenaContractError("playground exec is not bound in this environment");
    });
    const ran = await exec(argv);
    return deepFreeze({
      status: ran.code === 0 ? "SUCCEEDED" : "FAILED",
      response: { challengeId, argv, stdout: ran.stdout, stderr: ran.stderr, code: ran.code },
    }) as ContestSubmitSeamResult;
  };
}
