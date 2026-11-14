/**
 * Auto-Research Arena (`Auto-Research-Arena/auto-research-arena`, arXiv:2610.35866)
 * Competition Adapter / independent BaselineEvaluator for evoK.
 *
 * Bridges AutoArena's v5 context JSON and gated admissibility/objective contract
 * onto evoK's Mission mainline (`BaselineEvaluator` + `project-evaluator.ts`)
 * without altering official task definitions, immutable `prepare.py` instruments,
 * or evoK's Admission / Budget / hang / T48 / External Submission boundaries.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BaselineEvaluationFact, BaselineEvaluator, BaselineMeasurement } from "../mission-start";
import { saveMissionDraft, type MissionDraft } from "../mission/mission-draft";

export const AUTO_RESEARCH_ARENA_ID = "auto-research-arena" as const;
export const DEFAULT_AUTOARENA_CONTEXT_FILE = ".evok/autoarena-context.json" as const;

export class AutoArenaContractError extends Error {
  readonly kind = "auto-research-arena-contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "AutoArenaContractError";
  }
}

export type AutoArenaOperator = "<" | "<=" | ">" | ">=" | "==";
export type AutoArenaDirection = "minimize" | "maximize";

export interface AutoArenaFrozenRegion {
  readonly file: string;
  readonly region: string;
  readonly anchor?: string;
  readonly reason: string;
}

export interface AutoArenaConstraint {
  readonly metric: string;
  readonly operator: AutoArenaOperator;
  readonly value: number;
  readonly basis?: string;
}

export interface AutoArenaRankingMetric {
  readonly metric: string;
  readonly direction: AutoArenaDirection;
}

export interface AutoArenaTask {
  readonly task_id: string;
  readonly version: number;
  readonly title: string;
  readonly substrate: {
    readonly id: string;
    readonly mutable: readonly string[];
    readonly immutable: readonly string[];
    readonly gpu_work_witness: string;
    readonly frozen_regions?: readonly AutoArenaFrozenRegion[];
    readonly known_constraints?: readonly string[];
  };
  readonly launch: {
    readonly train_seconds: number;
    readonly gpus_per_launch: number;
    readonly accelerator: string;
    readonly seed: number;
    readonly timeout_seconds: number;
  };
  readonly budget: {
    readonly max_launches: number;
    readonly includes_failures: boolean;
    readonly includes_reference_launch: boolean;
    readonly charging_rule: string;
  };
  readonly metrics: Readonly<Record<string, {
    readonly type: "integer" | "number" | "boolean";
    readonly unit?: string;
    readonly deterministic?: boolean;
    readonly description?: string;
  }>>;
  readonly objective: {
    readonly comparison_mode: "gated";
    readonly target: AutoArenaRankingMetric;
    readonly quality_gate: {
      readonly metric: string;
      readonly operator: AutoArenaOperator;
      readonly value: number;
    };
    readonly tiebreaks: readonly AutoArenaRankingMetric[];
    readonly constraints: readonly AutoArenaConstraint[];
  };
}

export interface AutoArenaReferenceResult {
  readonly candidate_id?: string;
  readonly launch_uuid?: string;
  readonly status: string;
  readonly metrics: Readonly<Record<string, number | boolean | null>>;
}

export interface AutoArenaContext {
  readonly version: 5;
  readonly api_version: 1;
  readonly run_dir: string;
  readonly workspace: string;
  readonly task_dir: string;
  readonly runner_root: string;
  readonly session_id: string;
  readonly task?: AutoArenaTask;
  readonly reference_result: AutoArenaReferenceResult;
  readonly evaluate: readonly string[];
  readonly experiment_status: readonly string[];
  readonly status: readonly string[];
  readonly finish: readonly string[];
}

export interface AutoArenaEvaluationContract {
  readonly id: typeof AUTO_RESEARCH_ARENA_ID;
  readonly version: string;
  readonly contextFile: string;
}

export interface AutoArenaEvaluationResponse {
  readonly status: string;
  readonly witness?: boolean;
  readonly charged?: boolean;
  readonly charge?: string;
  readonly charge_classification?: string;
  readonly candidate_id?: string;
  readonly launch_seq?: number;
  readonly launch_uuid?: string;
  readonly metrics?: Readonly<Record<string, number | boolean | null>>;
  readonly extraction_errors?: readonly string[];
  readonly logs?: { readonly stdout?: string; readonly stderr?: string };
}

export interface AutoArenaAdmissibilityVerdict {
  readonly admissible: boolean;
  readonly clause: string;
  readonly reason: string;
  readonly gateMargin?: number;
}

export type AutoArenaCommandRunner = (input: {
  readonly command: readonly string[];
  readonly cwd: string;
}) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;

export interface CreateAutoArenaEvaluatorOptions {
  readonly context: AutoArenaContext;
  readonly task: AutoArenaTask;
  readonly referenceCode: Readonly<Record<string, string>>;
  readonly projectRoot?: string;
  readonly commandRunner?: AutoArenaCommandRunner;
}

const OPERATORS = new Set<AutoArenaOperator>(["<", "<=", ">", ">=", "=="]);
const DIRECTIONS = new Set<AutoArenaDirection>(["minimize", "maximize"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AutoArenaContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function relativeFilePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label);
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new AutoArenaContractError(`${label} must be a safe relative path`);
  }
  return path;
}

function commandArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item === "")) {
    throw new AutoArenaContractError(`${label} must be a non-empty string command array`);
  }
  return [...value];
}

export function normalizeAutoArenaEvaluationContract(value: unknown): AutoArenaEvaluationContract {
  if (!isRecord(value)) throw new AutoArenaContractError("evaluation contract must be a JSON object");
  if (value.id !== AUTO_RESEARCH_ARENA_ID) {
    throw new AutoArenaContractError(`evaluation contract id must be "${AUTO_RESEARCH_ARENA_ID}"`);
  }
  const version = nonEmptyString(value.version ?? "1", "evaluation contract version");
  const contextFile = relativeFilePath(value.contextFile ?? DEFAULT_AUTOARENA_CONTEXT_FILE, "evaluation contract contextFile");
  return { id: AUTO_RESEARCH_ARENA_ID, version, contextFile };
}

export function validateAutoArenaTask(value: unknown): AutoArenaTask {
  if (!isRecord(value)) throw new AutoArenaContractError("AutoArena task.json must be a JSON object");
  const task_id = nonEmptyString(value.task_id, "task.task_id");
  const title = nonEmptyString(value.title, "task.title");
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) {
    throw new AutoArenaContractError("task.version must be a positive integer");
  }
  if (!isRecord(value.substrate)) throw new AutoArenaContractError("task.substrate is required");
  const mutable = Array.isArray(value.substrate.mutable)
    ? value.substrate.mutable.map((entry, i) => relativeFilePath(entry, `substrate.mutable[${i}]`))
    : [];
  if (mutable.length === 0) throw new AutoArenaContractError("task.substrate.mutable must be non-empty");
  const immutable = Array.isArray(value.substrate.immutable)
    ? value.substrate.immutable.map((entry, i) => relativeFilePath(entry, `substrate.immutable[${i}]`))
    : [];
  if (!isRecord(value.objective) || value.objective.comparison_mode !== "gated") {
    throw new AutoArenaContractError("task.objective.comparison_mode must be \"gated\"");
  }
  if (!isRecord(value.objective.target) || !DIRECTIONS.has(value.objective.target.direction as AutoArenaDirection)) {
    throw new AutoArenaContractError("task.objective.target requires a valid metric and direction");
  }
  if (!isRecord(value.objective.quality_gate) || !OPERATORS.has(value.objective.quality_gate.operator as AutoArenaOperator)) {
    throw new AutoArenaContractError("task.objective.quality_gate requires a valid operator");
  }
  if (typeof value.objective.quality_gate.value !== "number" || !Number.isFinite(value.objective.quality_gate.value)) {
    throw new AutoArenaContractError("task.objective.quality_gate.value must be finite");
  }
  return value as unknown as AutoArenaTask;
}

export function validateAutoArenaContext(value: unknown): AutoArenaContext {
  if (!isRecord(value) || value.version !== 5 || value.api_version !== 1) {
    throw new AutoArenaContractError("expected AutoArena context version 5 and api_version 1");
  }
  for (const key of ["run_dir", "workspace", "task_dir", "runner_root", "session_id"] as const) {
    nonEmptyString(value[key], `context.${key}`);
  }
  for (const op of ["evaluate", "experiment_status", "status", "finish"] as const) {
    commandArray(value[op], `context.${op}`);
  }
  if (!isRecord(value.reference_result) || typeof value.reference_result.status !== "string" || !isRecord(value.reference_result.metrics)) {
    throw new AutoArenaContractError("context.reference_result requires status and metrics");
  }
  if (value.task !== undefined) validateAutoArenaTask(value.task);
  return value as unknown as AutoArenaContext;
}

function satisfies(value: number, operator: AutoArenaOperator, bound: number): boolean {
  switch (operator) {
    case "<": return value < bound;
    case "<=": return value <= bound;
    case ">": return value > bound;
    case ">=": return value >= bound;
    case "==": return value === bound;
  }
}

function numericMetric(metrics: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const raw = metrics[name];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return raw;
  return undefined;
}

export function autoArenaGateMargin(task: AutoArenaTask, metrics: Readonly<Record<string, unknown>>): number | undefined {
  const gate = task.objective.quality_gate;
  const value = numericMetric(metrics, gate.metric);
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return gate.operator === "<" || gate.operator === "<=" ? gate.value - value : value - gate.value;
}

/**
 * Exact mirror of AutoArena `engine/evaluation/objective.py:admissibility`:
 * 1) resource ceilings, 2) quality gate, 3) universal strictly-positive finite floor
 * on every ranking metric (`target` + `tiebreaks`).
 */
export function evaluateAutoArenaAdmissibility(
  task: AutoArenaTask,
  metrics: Readonly<Record<string, unknown>>,
): AutoArenaAdmissibilityVerdict {
  for (let index = 0; index < task.objective.constraints.length; index += 1) {
    const ceiling = task.objective.constraints[index]!;
    const value = numericMetric(metrics, ceiling.metric);
    if (value === undefined || !Number.isFinite(value)) {
      return {
        admissible: false,
        clause: `ceiling[${index}]:${ceiling.metric}:unmeasured`,
        reason: `${ceiling.metric} was not measured for constraint ${ceiling.metric} ${ceiling.operator} ${ceiling.value}`,
      };
    }
    if (!satisfies(value, ceiling.operator, ceiling.value)) {
      return {
        admissible: false,
        clause: `ceiling[${index}]:${ceiling.metric}`,
        reason: `inadmissible: ${ceiling.metric} = ${value} breaches ${ceiling.operator} ${ceiling.value}`,
      };
    }
  }

  const gate = task.objective.quality_gate;
  const gateValue = numericMetric(metrics, gate.metric);
  if (gateValue === undefined || !Number.isFinite(gateValue)) {
    return {
      admissible: false,
      clause: `gate:${gate.metric}:unmeasured`,
      reason: `${gate.metric} was not measured, so quality gate ${gate.operator} ${gate.value} failed`,
    };
  }
  if (!satisfies(gateValue, gate.operator, gate.value)) {
    return {
      admissible: false,
      clause: `gate:${gate.metric}`,
      reason: `inadmissible: ${gate.metric} = ${gateValue} fails quality gate ${gate.operator} ${gate.value}`,
    };
  }

  const rankingMetrics: readonly AutoArenaRankingMetric[] = [task.objective.target, ...task.objective.tiebreaks];
  for (const entry of rankingMetrics) {
    const value = numericMetric(metrics, entry.metric);
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      return {
        admissible: false,
        clause: `validity_floor:${entry.metric}:non_finite`,
        reason: `inadmissible: ${entry.metric} = ${String(value)} is not finite`,
      };
    }
    if (value <= 0) {
      return {
        admissible: false,
        clause: `validity_floor:${entry.metric}:non_positive`,
        reason: `inadmissible: ${entry.metric} = ${value} must be strictly positive`,
      };
    }
  }

  const targetMetric = task.objective.target.metric;
  const targetValue = numericMetric(metrics, targetMetric);
  if (targetValue === undefined) {
    return {
      admissible: false,
      clause: `unmeasurable:${targetMetric}`,
      reason: `ranking target ${targetMetric} was not measured`,
    };
  }

  const gateMargin = autoArenaGateMargin(task, metrics);
  return {
    admissible: true,
    clause: "admissible",
    reason: "every ceiling and the quality gate are satisfied",
    ...(gateMargin === undefined ? {} : { gateMargin }),
  };
}

/**
 * Lexicographic sort key matching `engine/evaluation/objective.py:rank_key`.
 * Smaller tuple wins; `undefined` when inadmissible or unmeasurable.
 */
export function autoArenaRankKey(
  task: AutoArenaTask,
  metrics: Readonly<Record<string, unknown>>,
): readonly number[] | undefined {
  const verdict = evaluateAutoArenaAdmissibility(task, metrics);
  if (!verdict.admissible) return undefined;
  const key: number[] = [];
  for (const entry of [task.objective.target, ...task.objective.tiebreaks]) {
    const value = numericMetric(metrics, entry.metric);
    if (value === undefined || !Number.isFinite(value)) return undefined;
    key.push(entry.direction === "minimize" ? value : -value);
  }
  if (verdict.gateMargin !== undefined) key.push(-verdict.gateMargin);
  return key;
}

export function compareAutoArenaRankKeys(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return left.length - right.length;
}

/**
 * Direction-aligned scalar score for evoK's `missionScoreboard` (which maximizes `score`).
 * Matches AutoArena `submission.json`'s `relative_improvement`:
 *   - reference = 0
 *   - strictly better admissible candidate > 0 (e.g., +0.6990 for 69.9% param reduction)
 *   - worse admissible candidate < 0
 */
export function computeAutoArenaRelativeImprovement(
  task: AutoArenaTask,
  candidateMetrics: Readonly<Record<string, unknown>>,
  referenceMetrics: Readonly<Record<string, unknown>>,
): number | undefined {
  const { metric, direction } = task.objective.target;
  const candidate = numericMetric(candidateMetrics, metric);
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) return undefined;
  const reference = numericMetric(referenceMetrics, metric);
  if (reference !== undefined && Number.isFinite(reference) && reference > 0) {
    return direction === "minimize"
      ? (reference - candidate) / reference
      : (candidate - reference) / reference;
  }
  return direction === "minimize" ? -candidate : candidate;
}

/**
 * Pre-flight check on candidate snapshot before consuming a GPU launch:
 * - all mutable files exist in snapshot;
 * - any immutable file present in snapshot is byte-identical to `task_dir/code/`;
 * - declared `frozen_regions` anchors still appear in the mutable file.
 */
export function checkAutoArenaCandidateSource(
  task: AutoArenaTask,
  snapshot: Readonly<Record<string, string>>,
  referenceCode: Readonly<Record<string, string>>,
): readonly string[] {
  const violations: string[] = [];
  for (const mutableFile of task.substrate.mutable) {
    const content = snapshot[mutableFile];
    if (content === undefined || content.trim() === "") {
      violations.push(`required mutable file ${mutableFile} is missing or empty in candidate snapshot`);
    }
  }
  for (const immutableFile of task.substrate.immutable) {
    if (snapshot[immutableFile] !== undefined && snapshot[immutableFile] !== referenceCode[immutableFile]) {
      violations.push(`immutable substrate file ${immutableFile} was modified by candidate`);
    }
  }
  for (const region of task.substrate.frozen_regions ?? []) {
    if (!region.anchor) continue;
    const content = snapshot[region.file];
    if (content !== undefined && !content.includes(region.anchor)) {
      violations.push(`frozen region "${region.region}" anchor ${JSON.stringify(region.anchor)} missing in ${region.file}`);
    }
  }
  return violations;
}

function digestProgram(
  task: AutoArenaTask,
  snapshot: Readonly<Record<string, string>>,
  referenceCode: Readonly<Record<string, string>>,
): string {
  const hash = createHash("sha256");
  const files = [...task.substrate.mutable, ...task.substrate.immutable].sort();
  for (const file of files) {
    const body = task.substrate.mutable.includes(file) ? (snapshot[file] ?? "") : (referenceCode[file] ?? "");
    hash.update(`${file}\0${body}\0`, "utf8");
  }
  return hash.digest("hex");
}

function factsFromMetrics(
  task: AutoArenaTask,
  metrics: Readonly<Record<string, unknown>>,
  source: string,
  extras: readonly BaselineEvaluationFact[] = [],
): BaselineEvaluationFact[] {
  const facts: BaselineEvaluationFact[] = [...extras];
  for (const key of Object.keys(task.metrics).sort()) {
    const val = metrics[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      facts.push({ name: key, value: val, source });
    } else if (typeof val === "boolean") {
      facts.push({ name: key, value: val, source });
    }
  }
  const margin = autoArenaGateMargin(task, metrics);
  if (margin !== undefined && Number.isFinite(margin)) {
    facts.push({ name: "quality_gate_margin", value: margin, source });
  }
  return facts;
}

export const defaultAutoArenaCommandRunner: AutoArenaCommandRunner = ({ command, cwd }) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
}

export async function loadAutoArenaBundle(
  contextPath: string,
): Promise<{
  readonly context: AutoArenaContext;
  readonly task: AutoArenaTask;
  readonly referenceCode: Readonly<Record<string, string>>;
}> {
  const context = validateAutoArenaContext(JSON.parse(await readFile(contextPath, "utf8")));
  const task = context.task
    ? validateAutoArenaTask(context.task)
    : validateAutoArenaTask(JSON.parse(await readFile(join(context.task_dir, "task.json"), "utf8")));
  const referenceCode: Record<string, string> = {};
  for (const file of [...task.substrate.mutable, ...task.substrate.immutable]) {
    referenceCode[file] = await readFile(join(context.task_dir, "code", file), "utf8");
  }
  return { context, task, referenceCode };
}

export async function loadProjectAutoArenaEvaluator(
  projectRoot: string,
  contract: AutoArenaEvaluationContract,
  commandRunner?: AutoArenaCommandRunner,
): Promise<BaselineEvaluator> {
  const resolvedContext = resolve(projectRoot, contract.contextFile);
  const bundle = await loadAutoArenaBundle(resolvedContext);
  return createAutoArenaEvaluator({
    ...bundle,
    projectRoot,
    ...(commandRunner ? { commandRunner } : {}),
  });
}

function measurementFromResult(
  task: AutoArenaTask,
  response: AutoArenaEvaluationResponse,
  referenceMetrics: Readonly<Record<string, unknown>>,
  sourceLabel: string,
): { readonly measurement: BaselineMeasurement; readonly rankKey?: readonly number[] } {
  const statusExtras: BaselineEvaluationFact[] = [
    { name: "autoarena_status", value: response.status, source: sourceLabel },
    ...(typeof response.charged === "boolean" ? [{ name: "charged", value: response.charged, source: sourceLabel }] : []),
    ...(typeof response.launch_seq === "number" && Number.isFinite(response.launch_seq)
      ? [{ name: "launch_seq", value: response.launch_seq, source: sourceLabel }]
      : []),
  ];

  // Operational crash/OOM/timeout: omit both `score` and `ruleViolations` so
  // `classifyRunOutcome` records an operational failure (`scientificNegativeEvidence: false`)
  // rather than misclassifying a non-measurement as hypothesis refutation.
  if (response.status !== "ok" || !response.metrics) {
    return {
      measurement: {
        ok: false,
        facts: statusExtras,
      },
    };
  }

  const verdict = evaluateAutoArenaAdmissibility(task, response.metrics);
  const facts = factsFromMetrics(task, response.metrics, sourceLabel, [
    ...statusExtras,
    { name: "admissibility_clause", value: verdict.clause, source: sourceLabel },
  ]);

  if (!verdict.admissible) {
    return {
      measurement: {
        ok: false,
        ruleViolations: [verdict.reason],
        facts,
      },
    };
  }

  const score = computeAutoArenaRelativeImprovement(task, response.metrics, referenceMetrics);
  if (score === undefined || !Number.isFinite(score)) {
    return {
      measurement: {
        ok: false,
        facts,
      },
    };
  }

  const rankKey = autoArenaRankKey(task, response.metrics);
  return {
    measurement: {
      ok: true,
      score,
      facts: [
        ...facts,
        { name: "relative_improvement", value: score, source: sourceLabel },
      ],
    },
    ...(rankKey ? { rankKey } : {}),
  };
}

/**
 * Creates the independent AutoArena `BaselineEvaluator`:
 * - Reuses `context.reference_result` when candidate code matches the seed `code/`
 *   (AutoArena forbids duplicate charged submissions of identical source bytes).
 * - Rejects tampered immutable files or missing frozen-region anchors before launch.
 * - Persists request payloads before `evaluate` and checks `experiment-status`
 *   first so interrupted evaluations recover deterministically on resume.
 * - Updates `<projectRoot>/BEST_CANDIDATE_<mutable>` only on strictly better
 *   admissible results so subsequent isolated Runs can compound improvements.
 */
export function createAutoArenaEvaluator(options: CreateAutoArenaEvaluatorOptions): BaselineEvaluator {
  const { context, task, referenceCode, projectRoot } = options;
  const runCommand = options.commandRunner ?? defaultAutoArenaCommandRunner;
  const referenceDigest = digestProgram(task, referenceCode, referenceCode);
  const referenceMetrics = context.reference_result.metrics ?? {};
  let bestRankKey = autoArenaRankKey(task, referenceMetrics);
  const evaluatedDigests = new Map<string, { readonly candidateId: string; readonly charged: boolean }>();
  evaluatedDigests.set(referenceDigest, { candidateId: "reference", charged: true });

  return {
    id: AUTO_RESEARCH_ARENA_ID,
    version: String(task.version),
    async evaluate(snapshot, evalContext): Promise<BaselineMeasurement> {
      const violations = checkAutoArenaCandidateSource(task, snapshot, referenceCode);
      if (violations.length > 0) {
        return { ok: false, ruleViolations: violations };
      }

      const programDigest = digestProgram(task, snapshot, referenceCode);
      if (programDigest === referenceDigest) {
        return measurementFromResult(
          task,
          { status: context.reference_result.status, charged: true, metrics: context.reference_result.metrics },
          referenceMetrics,
          "autoarena:reference",
        ).measurement;
      }

      const requestId = `evok-${sanitizeId(evalContext.runId)}`;
      const candidateId = `cand-${programDigest.slice(0, 12)}`;
      const dispatchDir = join(context.workspace, "evok-dispatch");
      const requestRecordPath = join(dispatchDir, `${requestId}.json`);
      const candidateDir = join(context.workspace, "candidates", requestId);

      const existingSameCode = evaluatedDigests.get(programDigest);
      if (existingSameCode?.charged) {
        return {
          ok: false,
          ruleViolations: [
            `candidate program bytes match already-charged ${existingSameCode.candidateId}; AutoArena forbids duplicate submissions of identical source`,
          ],
        };
      }

      const researchLog = {
        ideas: [`evoK run ${evalContext.runId} for objective: ${evalContext.contract.objective}`],
        status: "evoK independent BaselineEvaluator dispatch",
        evok_mission_id: evalContext.missionId,
        evok_run_id: evalContext.runId,
        snapshot_digest: evalContext.snapshotDigest,
      };

      await mkdir(candidateDir, { recursive: true });
      for (const immutableFile of task.substrate.immutable) {
        await atomicWriteText(join(candidateDir, immutableFile), referenceCode[immutableFile]!);
      }
      for (const mutableFile of task.substrate.mutable) {
        await atomicWriteText(join(candidateDir, mutableFile), snapshot[mutableFile]!);
      }

      let persistedResearchLog: unknown = researchLog;
      try {
        const prior = JSON.parse(await readFile(requestRecordPath, "utf8")) as { research_log?: unknown };
        if (prior.research_log !== undefined) persistedResearchLog = prior.research_log;
      } catch {
        await atomicWriteText(
          requestRecordPath,
          `${JSON.stringify({ request_id: requestId, candidate_id: candidateId, source: candidateDir, research_log: researchLog }, null, 2)}\n`,
        );
      }

      let evalResponse: AutoArenaEvaluationResponse | undefined;
      const statusCheck = await runCommand({
        command: [...context.experiment_status, "--request-id", requestId],
        cwd: context.runner_root,
      });
      if (statusCheck.exitCode === 0 && statusCheck.stdout.trim() !== "") {
        try {
          const parsedStatus = JSON.parse(statusCheck.stdout) as {
            status?: string;
            results?: readonly AutoArenaEvaluationResponse[];
            result?: AutoArenaEvaluationResponse;
          };
          if (parsedStatus.result && typeof parsedStatus.result.status === "string") {
            evalResponse = parsedStatus.result;
          } else if (Array.isArray(parsedStatus.results) && parsedStatus.results[0]) {
            evalResponse = parsedStatus.results[0];
          }
        } catch {
          // Proceed to evaluate below if status output was not a completed response.
        }
      }

      if (!evalResponse) {
        const evalCall = await runCommand({
          command: [
            ...context.evaluate,
            "--request-id", requestId,
            "--source", candidateDir,
            "--candidate-id", candidateId,
            "--research-log", JSON.stringify(persistedResearchLog),
          ],
          cwd: context.runner_root,
        });
        if (evalCall.exitCode !== 0) {
          throw new Error(`AutoArena evaluate rejected ${requestId}: ${evalCall.stderr.trim() || `exit ${evalCall.exitCode}`}`);
        }
        evalResponse = JSON.parse(evalCall.stdout) as AutoArenaEvaluationResponse;
      }

      evaluatedDigests.set(programDigest, {
        candidateId,
        charged: evalResponse.charged !== false,
      });

      const outcome = measurementFromResult(task, evalResponse, referenceMetrics, `autoarena:${requestId}`);
      if (outcome.measurement.ok && outcome.rankKey && projectRoot) {
        if (!bestRankKey || compareAutoArenaRankKeys(outcome.rankKey, bestRankKey) < 0) {
          bestRankKey = outcome.rankKey;
          for (const mutableFile of task.substrate.mutable) {
            await atomicWriteText(
              join(projectRoot, `BEST_CANDIDATE_${mutableFile.replace(/[\\/]/g, "_")}`),
              snapshot[mutableFile]!,
            );
          }
        }
      }
      return outcome.measurement;
    },
  };
}

export function renderAutoArenaTaskBrief(task: AutoArenaTask, reference: AutoArenaReferenceResult): string {
  const lines: string[] = [
    `# Auto-Research Arena Task: ${task.task_id} — ${task.title}`,
    "",
    `- Optimization target: **${task.objective.target.direction} \`${task.objective.target.metric}\`**`,
    `- Quality gate (admissibility): \`${task.objective.quality_gate.metric} ${task.objective.quality_gate.operator} ${task.objective.quality_gate.value}\``,
    `- Tiebreaks: ${task.objective.tiebreaks.map((t) => `${t.direction} \`${t.metric}\``).join(", ") || "none"}`,
    `- Editable file(s): ${task.substrate.mutable.map((f) => `\`${f}\``).join(", ")}`,
    `- Immutable file(s) (do NOT edit): ${task.substrate.immutable.map((f) => `\`${f}\``).join(", ")}`,
    `- Per-launch training clock: ${task.launch.train_seconds}s (worker timeout ${task.launch.timeout_seconds}s, seed ${task.launch.seed}, accelerator ${task.launch.accelerator})`,
    `- Campaign launch budget: ${task.budget.max_launches} total charged launches (reference uses launch #1)`,
    "",
    "## Resource Constraints (Ceilings / Pins)",
    ...task.objective.constraints.map(
      (c) => `- \`${c.metric} ${c.operator} ${c.value}\`${c.basis ? ` — ${c.basis}` : ""}`,
    ),
    "",
    "## Measured Reference Baseline (`launch #1`)",
    "```json",
    JSON.stringify(reference.metrics, null, 2),
    "```",
    "",
    "## Score Convention in evoK",
    `- evoK scoreboard reports \`score = relative_improvement\` on \`${task.objective.target.metric}\` (higher is better; reference = \`0\`).`,
    "- Read `BEST_CANDIDATE_train.py` in the project root to build on the strongest admissible program discovered so far, or `train.py` for the original seed reference.",
    "- Write your complete candidate `train.py` into `./train.py` in your isolated run workspace. Do NOT run full GPU training inside your workspace; the external AutoArena engine runs and measures your snapshot on GPU.",
  ];
  if (task.substrate.frozen_regions?.length) {
    lines.push("", "## Frozen Regions Inside Editable Files (MUST preserve)");
    for (const region of task.substrate.frozen_regions) {
      lines.push(
        `- **${region.region}** (\`${region.file}\`${region.anchor ? `, anchor: \`${region.anchor}\`` : ""}): ${region.reason}`,
      );
    }
  }
  if (task.substrate.known_constraints?.length) {
    lines.push("", "## Known Semantic Constraints");
    for (const rule of task.substrate.known_constraints) {
      lines.push(`- ${rule}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface StageAutoArenaProjectOptions {
  readonly contextPath: string;
  readonly projectRoot?: string;
  readonly missionId?: string;
  readonly modelBudgetUsd?: number;
}

export interface StagedAutoArenaProject {
  readonly projectRoot: string;
  readonly missionId: string;
  readonly context: AutoArenaContext;
  readonly task: AutoArenaTask;
  readonly draft?: MissionDraft;
}

/**
 * Materializes or reopens `<workspace>/evok-project` for an AutoArena run:
 * - Copies seed `code/` (`train.py`, `prepare.py`, `pyproject.toml`, `uv.lock`)
 *   and `TASK_BRIEF.md` into `<projectRoot>` (read-only to candidate Runs);
 * - Initializes `BEST_CANDIDATE_train.py` if not yet present;
 * - Stores `autoarena-context.json` and `evaluation.json` inside `.evok/`
 *   (protected from candidate Runs by `run-dispatch.ts`);
 * - Writes a reviewed `draft.json` when no Mission exists yet (leaves existing
 *   draft/mission records untouched for `--resume`).
 */
export async function stageAutoArenaMissionProject(
  options: StageAutoArenaProjectOptions,
): Promise<StagedAutoArenaProject> {
  const { context, task, referenceCode } = await loadAutoArenaBundle(options.contextPath);
  const projectRoot = resolve(options.projectRoot ?? join(context.workspace, "evok-project"));
  const missionId = options.missionId ?? `autoarena-${sanitizeId(task.task_id)}`;

  await mkdir(join(projectRoot, ".evok"), { recursive: true });
  for (const [relPath, content] of Object.entries(referenceCode)) {
    await atomicWriteText(join(projectRoot, relPath), content);
  }
  for (const mutableFile of task.substrate.mutable) {
    const bestPath = join(projectRoot, `BEST_CANDIDATE_${mutableFile.replace(/[\\/]/g, "_")}`);
    try {
      await readFile(bestPath, "utf8");
    } catch {
      await atomicWriteText(bestPath, referenceCode[mutableFile]!);
    }
  }
  await atomicWriteText(join(projectRoot, "TASK_BRIEF.md"), renderAutoArenaTaskBrief(task, context.reference_result));
  await atomicWriteText(
    join(projectRoot, DEFAULT_AUTOARENA_CONTEXT_FILE),
    `${JSON.stringify({ ...context, task }, null, 2)}\n`,
  );
  await atomicWriteText(
    join(projectRoot, ".evok", "evaluation.json"),
    `${JSON.stringify({
      id: AUTO_RESEARCH_ARENA_ID,
      version: String(task.version),
      contextFile: DEFAULT_AUTOARENA_CONTEXT_FILE,
    } satisfies AutoArenaEvaluationContract, null, 2)}\n`,
  );

  const missionJsonPath = join(projectRoot, ".evok", "missions", missionId, "mission.json");
  const draftJsonPath = join(projectRoot, ".evok", "missions", missionId, "draft.json");
  const hasMission = await readFile(missionJsonPath, "utf8").then(() => true, () => false);
  const hasDraft = await readFile(draftJsonPath, "utf8").then(() => true, () => false);

  let draft: MissionDraft | undefined;
  if (!hasMission && !hasDraft) {
    const gate = task.objective.quality_gate;
    draft = await saveMissionDraft(projectRoot, {
      id: missionId,
      objective: `Auto-Research Arena (${task.task_id}): ${task.objective.target.direction} ${task.objective.target.metric} while keeping ${gate.metric} ${gate.operator} ${gate.value} and satisfying all task resource constraints.`,
      successCriteria: [
        `Admissible candidate satisfies ${gate.metric} ${gate.operator} ${gate.value} and all declared resource constraints`,
        `Strictly improves ${task.objective.target.metric} (${task.objective.target.direction}) over the measured reference (${String(context.reference_result.metrics[task.objective.target.metric])})`,
      ],
      data: {
        description: `Auto-Research Arena substrate ${task.substrate.id}; read TASK_BRIEF.md, train.py, BEST_CANDIDATE_train.py, and prepare.py in the project root.`,
        sources: ["https://github.com/Auto-Research-Arena/auto-research-arena", "https://arxiv.org/abs/2610.35866"],
      },
      evaluation: {
        method: AUTO_RESEARCH_ARENA_ID,
        metric: `relative_improvement(${task.objective.target.metric})`,
      },
      constraints: {
        permissions: ["read-project", "isolated-workspace-write", "local-shell-in-workspace"],
        hardRules: [
          `edit only ${task.substrate.mutable.join(", ")}`,
          `never modify ${task.substrate.immutable.join(", ")} or frozen regions in TASK_BRIEF.md`,
          "never self-report a score or print custom METRICS_JSON",
          "no external submission",
        ],
      },
      budget: {
        total: options.modelBudgetUsd ?? 50,
        units: "model-USD",
        note: `LLM metering envelope; AutoArena enforces ${task.budget.max_launches} GPU launches externally`,
      },
      outputs: [...task.substrate.mutable],
      stopConditions: [
        "AutoArena launch budget exhausted",
        "model-USD budget exhausted",
        "no remaining falsifiable improvement direction within constraints",
      ],
      unresolvedPrerequisites: [],
      decisions: [],
      sources: [
        {
          url: "https://arxiv.org/abs/2610.35866",
          title: "Auto-Research Arena: Benchmarking and Advancing Auto-Research in Language Modeling",
          claim: `Task ${task.task_id} gated objective and admissibility specification`,
          retrievedAt: "2026-11-14T00:00:00.000Z",
        },
      ],
      plan: {
        baselineHypothesis: `Copying the unmodified seed ${task.substrate.mutable.join(", ")} reproduces the engine's reference baseline (${scoreSummary(task, context.reference_result)}) as score=0.`,
        tasks: [
          {
            taskId: "baseline",
            objective: `Read TASK_BRIEF.md and copy the unmodified seed ${task.substrate.mutable.join(", ")} from the project root into your isolated workspace to anchor the reference baseline.`,
            expectedOutputs: [...task.substrate.mutable],
          },
        ],
      },
    });
  }

  return { projectRoot, missionId, context, task, ...(draft ? { draft } : {}) };
}

function scoreSummary(task: AutoArenaTask, reference: AutoArenaReferenceResult): string {
  const target = task.objective.target.metric;
  const gate = task.objective.quality_gate.metric;
  return `${target}=${String(reference.metrics[target])}, ${gate}=${String(reference.metrics[gate])}`;
}
