import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHostFile, writeHostFile, writeRoleJson } from "./artifacts";
import { ensureRealDir } from "./containment";
import { flag } from "./args";
import { Budget } from "./budget";
import { LOCAL_MODEL_ID } from "./fixed-model";
import { HELD_OUT_SCORE_FILE, readEvaluatedHeldOut, readHeldOutScore, writeHandFilledHeldOut } from "./heldout-file";
import { Lineage, Node } from "./lineage";
import { liveRoles, stageWriter } from "./live-round";
import { createExecutor, executorKindFromSaved } from "./modules/executor";
import { LocalJsonTaskSource, PlaygroundTaskSource } from "./modules/probe";
import { GreedySelector } from "./modules/selector";
import { Orchestrator } from "./orchestrator";
import { pinPackageAgentDir } from "./pi/agent-dirs";
import {
  attachSampleBridge,
  createMemoryBus,
  DEFAULT_DELEGATION_TIMEOUT_MS,
  eventBusDelegate,
  type EventBus,
} from "./pi/delegate";
import { listStageReports, reviewRoundE2E, writeStageReport } from "./reports";
import { buildDirectoryGateRequest, runDirectorySubmitGate } from "./submit-gate";
import {
  missingThresholds,
  readThresholds,
  readTokensSpent,
  THRESHOLD_KEYS,
  writeThresholds,
  writeTokensSpent,
  type RunThresholds,
  type ThresholdKey,
} from "./thresholds";
import { traceRelPath } from "./traces";
import type { EvidenceCheck } from "./modules/evidence-gate";
import type { TaskRef } from "./types";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** In-project run directory. A Pi session and the CLI both default here. */
export const DEFAULT_RUN_DIR = ".harness-opt";

export function defaultRunRoot(cwd: string): string {
  return join(cwd, DEFAULT_RUN_DIR);
}

export function bundledTaskDir(): string {
  return join(PACKAGE_ROOT, "fixtures", "tasks");
}

/**
 * Explicit inputs for the one-round sample demo. The gate reads these from
 * `thresholds.json` and `sealed/heldout-score.json`. They are not defaults
 * inside `submitGate`.
 */
export const DEMO_INPUTS = {
  minDelta: 0.1,
  ttsBaseline: 0.5,
  heldOutFloor: 0.4,
  tokenBudget: 100_000,
  maxLocalRuns: 20,
  maxWallS: 3600,
  maxOnlineSubmitsPerDay: 1,
  heldOutScore: 0.55,
} as const;

const FLAG_FOR: Record<ThresholdKey, string> = {
  minDelta: "--min-delta",
  ttsBaseline: "--tts-baseline",
  heldOutFloor: "--held-out-floor",
  tokenBudget: "--token-budget",
  maxLocalRuns: "--max-local-runs",
  maxWallS: "--max-wall-s",
  maxOnlineSubmitsPerDay: "--max-submits",
};

const GATE_ROWS: readonly { readonly id: string; readonly label: string; readonly ids: readonly string[] }[] = [
  { id: "model", label: "model", ids: ["model"] },
  { id: "held-out", label: "held-out", ids: ["held-out"] },
  { id: "trace-pack", label: "trace-pack", ids: ["trace-pack"] },
  { id: "change-note", label: "change-note", ids: ["change-note"] },
  { id: "tts", label: "tts", ids: ["tts"] },
  { id: "budget", label: "budget", ids: ["budget", "quota"] },
  { id: "playground-submit-dry-run", label: "playground-submit-dry-run", ids: ["playground-submit-dry-run"] },
];

export interface CommandResult {
  readonly ok: boolean;
  readonly command: string;
  readonly root: string;
  readonly text: string;
  readonly failed: readonly string[];
  readonly missing: readonly string[];
  readonly panel: readonly string[];
  readonly reports: readonly string[];
  readonly e2eOk?: boolean;
}

export interface DispatchOptions {
  readonly cwd: string;
  /** Pi extension passes `pi.events`. The CLI has no bus and uses a memory bus. */
  readonly events?: EventBus;
  /**
   * Answer delegation with the sample bridge. Default is on only when no
   * external bus was passed. The Pi tool leaves this off so pi-subagents
   * is the listener.
   */
  readonly sampleBridge?: boolean;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
}

interface SavedSession {
  round: number;
  phase: string;
  stopped: boolean;
  executor: string;
  bridge: string;
  taskSource: "local" | "playground";
  taskDir: string;
  usedRuns: number;
  startedAt: number;
  checks: EvidenceCheck[];
}

export function formatCommandResult(result: CommandResult): string {
  const parts = [result.text];
  if (result.failed.length > 0) parts.push(`failed: ${result.failed.join(", ")}`);
  if (result.missing.length > 0) parts.push(`missing: ${result.missing.join(", ")}`);
  return parts.join("\n");
}

export async function dispatchHarnessCommand(argv: readonly string[], options: DispatchOptions): Promise<CommandResult> {
  const [command, ...rest] = argv;
  const root = flag(rest, "--out") ?? defaultRunRoot(options.cwd);
  if (!command || !["start", "step", "status", "gate", "stop"].includes(command)) {
    return result(false, command ?? "harness-opt", root, "required subcommand: start | step | status | gate | stop", [], ["subcommand"]);
  }
  try {
    if (command === "start") return await startRun(root, rest, options);
    if (command === "step") return await stepRun(root, options);
    if (command === "status") return statusRun(root);
    if (command === "gate") return await gateRun(root);
    return stopRun(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(false, command, root, message, [], []);
  }
}

export async function runClosedLoopDemo(root: string, options?: { readonly cwd?: string }): Promise<CommandResult> {
  const cwd = options?.cwd ?? process.cwd();
  const dispatchOptions: DispatchOptions = { cwd, sampleBridge: true };
  const started = await dispatchHarnessCommand([
    "start",
    "--out", root,
    "--min-delta", String(DEMO_INPUTS.minDelta),
    "--tts-baseline", String(DEMO_INPUTS.ttsBaseline),
    "--held-out-floor", String(DEMO_INPUTS.heldOutFloor),
    "--token-budget", String(DEMO_INPUTS.tokenBudget),
    "--max-local-runs", String(DEMO_INPUTS.maxLocalRuns),
    "--max-wall-s", String(DEMO_INPUTS.maxWallS),
    "--max-submits", String(DEMO_INPUTS.maxOnlineSubmitsPerDay),
    "--heldout-score", String(DEMO_INPUTS.heldOutScore),
    "--dev", bundledTaskDir(),
    "--executor", "sample",
  ], dispatchOptions);
  if (!started.ok) return started;
  const stepped = await dispatchHarnessCommand(["step", "--out", root], dispatchOptions);
  const status = await dispatchHarnessCommand(["status", "--out", root], dispatchOptions);
  return {
    ...stepped,
    text: `${started.text}\n${stepped.text}`,
    panel: status.panel,
  };
}

async function startRun(root: string, argv: readonly string[], options: DispatchOptions): Promise<CommandResult> {
  if (existsSync(sessionPath(root))) {
    return result(false, "start", root, "run directory already has a session; pass a fresh --out", [], []);
  }
  const thresholds = collectThresholds(root, argv);
  if (!thresholds.ok) {
    return result(false, "start", root, "start refused: explicit thresholds are missing", [], thresholds.missing);
  }
  const held = collectHeldOut(root, argv);
  if (!held.ok) return result(false, "start", root, "start refused: held-out score file is missing", [], held.missing);

  const taskSourceName = flag(argv, "--task-source") ?? "local";
  const taskDir = flag(argv, "--dev") ?? bundledTaskDir();
  let tasks: readonly TaskRef[];
  let sourceLabel: string;
  if (taskSourceName === "playground") {
    sourceLabel = "playground";
    tasks = await new PlaygroundTaskSource().list();
  } else if (taskSourceName === "local") {
    const source = new LocalJsonTaskSource(taskDir);
    sourceLabel = source.name;
    tasks = await source.list();
  } else {
    return result(false, "start", root, `unknown task source ${taskSourceName}`, [], ["--task-source"]);
  }
  if (tasks.length === 0) return result(false, "start", root, "task source returned no dev tasks", [], ["dev tasks"]);

  const executorKind = flag(argv, "--executor") ?? "sample";
  if (executorKind !== "sample" && executorKind !== "bohr" && executorKind !== "devii") {
    return result(false, "start", root, `unknown executor ${executorKind}`, [], ["--executor"]);
  }
  const executor = createExecutor(executorKind);
  mkdirSync(root, { recursive: true });
  writeThresholds(root, thresholds.value);
  writeHandFilledHeldOut(root, held.score);

  const configPath = "candidates/base/config.json";
  writeRoleJson(root, "orchestrator", configPath, {
    id: "base",
    modelId: LOCAL_MODEL_ID,
    parts: { "agent-loop": { maxSteps: 8 }, context: {}, memory: {}, toolchain: {}, skills: {} },
    search: { samples: 1, selfChecks: 0, retries: 0 },
  });

  const scores: number[] = [];
  let tokens = 0;
  for (const task of tasks) {
    const trace = await executor.run(task, configPath);
    tokens += trace.tokens;
    writeRoleJson(root, "runner", traceRelPath(configPath, trace.taskId), trace);
    scores.push(trace.reward);
  }
  const lineage = new Lineage(ensureRealDir(root, "state"));
  lineage.put(new Node({
    id: "base",
    parentId: null,
    configPath,
    status: "evaluated",
    devScores: scores,
    devFullScores: scores,
    stage: "full",
    tokensUsed: tokens,
  }));
  writeTokensSpent(root, tokens);
  const bridge = "none";
  const saved: SavedSession = {
    round: 0,
    phase: "ready",
    stopped: false,
    executor: executor.name,
    bridge,
    taskSource: taskSourceName === "playground" ? "playground" : "local",
    taskDir,
    usedRuns: tasks.length,
    startedAt: Date.now() / 1000,
    checks: [],
  };
  writeSession(root, saved);
  const panel = renderPanel(root, saved, lineage.best().id);
  return {
    ...result(
      true,
      "start",
      root,
      `start ready executor ${executor.name} bridge ${bridge} task-source ${sourceLabel} tasks ${tasks.map((task) => task.id).join(",")} held-out file ${HELD_OUT_SCORE_FILE}`,
      [],
      [],
    ),
    panel,
  };
}

async function stepRun(root: string, options: DispatchOptions): Promise<CommandResult> {
  const saved = readSession(root);
  if (!saved) return result(false, "step", root, "step refused: no session; run start first", [], ["session"]);
  if (saved.stopped) return result(false, "step", root, "step refused: session is stopped", [], []);
  const thresholds = readThresholds(root);
  if (!thresholds.ok) return result(false, "step", root, "step refused: explicit thresholds are missing", [], thresholds.missing);
  const usage = readTokensSpent(root);
  if (!usage.ok) return result(false, "step", root, "step refused: token count is missing", [], [usage.missing]);
  const tasks = saved.taskSource === "playground"
    ? await new PlaygroundTaskSource().list()
    : await new LocalJsonTaskSource(saved.taskDir).list();
  if (tasks.length === 0) return result(false, "step", root, "step refused: task source returned no dev tasks", [], ["dev tasks"]);

  const round = saved.round + 1;
  const candidateId = `c${round}`;
  pinPackageAgentDir();
  const useSample = options.sampleBridge ?? !options.events;
  const bus = options.events ?? createMemoryBus();
  if (useSample) attachSampleBridge(bus);
  let answered = false;
  const delegate = eventBusDelegate(bus, {
    cwd: root,
    timeoutMs: options.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    onSettled: (info) => {
      if (info.responded) answered = true;
    },
  });
  const budget = new Budget({
    maxLocalRuns: thresholds.value.maxLocalRuns,
    maxTokens: thresholds.value.tokenBudget,
    maxWallS: thresholds.value.maxWallS,
    maxOnlineSubmitsPerDay: thresholds.value.maxOnlineSubmitsPerDay,
  });
  budget.usedTokens = usage.tokensSpent;
  budget.usedRuns = saved.usedRuns;
  budget.started = saved.startedAt;
  const lineage = new Lineage(ensureRealDir(root, "state"));
  const orchestrator = new Orchestrator(lineage, liveRoles({
    root,
    round,
    delegate,
    executor: createExecutor(executorKindFromSaved(saved.executor)),
    tasks,
    budget,
    candidateId,
  }), new GreedySelector(), budget, {
    ids: () => candidateId,
    onStage: stageWriter(root, round),
    heldOutAtMilestone: (configPath) => readEvaluatedHeldOut(root, configPath),
  });
  const phase = await orchestrator.step();
  writeTokensSpent(root, budget.usedTokens);
  const gate = await orchestrator.submitGate(buildDirectoryGateRequest(root));
  const e2e = reviewRoundE2E(root, round);
  const failed = gate.checks.filter((check) => !check.ok).map((check) => check.id);
  const next: SavedSession = {
    ...saved,
    round,
    phase,
    bridge: answered ? (useSample ? "sample" : "pi-subagents") : "none",
    usedRuns: budget.usedRuns,
    checks: [...gate.checks],
  };
  writeSession(root, next);
  const bestId = lineage.best().id;
  const panel = renderPanel(root, next, bestId);
  const lastError = lineage.events().filter((event) => event.kind === "error").at(-1);
  const errorText = lastError ? ` error ${String(lastError.err)}` : "";
  return {
    ok: e2e.ok,
    command: "step",
    root,
    text: `step round ${round} phase ${phase} best ${bestId} submit ${gate.submit} e2e ${e2e.ok ? "ok" : "fail"} executor ${saved.executor} bridge ${next.bridge}${errorText}`,
    failed,
    missing: gate.checks.find((check) => check.id === "inputs")?.detail.replace("missing explicit input: ", "").split(", ") ?? [],
    panel,
    reports: listStageReports(root, round),
    e2eOk: e2e.ok,
  };
}

function statusRun(root: string): CommandResult {
  const saved = readSession(root);
  if (!saved) {
    const missing = [
      ...(!existsSync(join(root, "thresholds.json")) ? ["thresholds.json"] : []),
      "session",
    ];
    return {
      ...result(false, "status", root, "status: no session", [], missing),
      panel: ["round none", "phase not-started", "budget remaining unknown", "best none", ...GATE_ROWS.map((row) => `${row.label} not-run`)],
    };
  }
  let bestId = "none";
  try {
    bestId = new Lineage(ensureRealDir(root, "state")).best().id;
  } catch {
    bestId = "none";
  }
  const panel = renderPanel(root, saved, bestId);
  return {
    ...result(true, "status", root, `status round ${saved.round} phase ${saved.phase} best ${bestId} executor ${saved.executor} bridge ${saved.bridge}`, [], []),
    panel,
  };
}

async function gateRun(root: string): Promise<CommandResult> {
  const saved = readSession(root);
  if (!saved) return result(false, "gate", root, "gate refused: no session", [], ["session"]);
  const gate = await runDirectorySubmitGate(root);
  const failed = gate.checks.filter((check) => !check.ok).map((check) => check.id);
  const next: SavedSession = { ...saved, phase: "gate", checks: [...gate.checks] };
  writeSession(root, next);
  writeStageReport(root, {
    round: Math.max(saved.round, 1),
    stage: "gate",
    output: { node: gate.node, ok: gate.submit, failed, heldout: gate.heldout },
    explanation: gate.submit ? "submit gate is green; live submit stays off" : `submit gate failed: ${failed.join(", ")}`,
  });
  let bestId = gate.node;
  try {
    bestId = new Lineage(ensureRealDir(root, "state")).best().id;
  } catch {
    bestId = gate.node;
  }
  return {
    ...result(true, "gate", root, `gate node ${gate.node} submit ${gate.submit} held-out file ${HELD_OUT_SCORE_FILE}`, failed, []),
    panel: renderPanel(root, next, bestId),
    reports: listStageReports(root, Math.max(saved.round, 1)),
  };
}

function stopRun(root: string): CommandResult {
  const saved = readSession(root);
  if (!saved) return result(false, "stop", root, "stop refused: no session", [], ["session"]);
  const next: SavedSession = { ...saved, phase: "stop", stopped: true };
  writeSession(root, next);
  let bestId = "none";
  try {
    bestId = new Lineage(ensureRealDir(root, "state")).best().id;
  } catch {
    bestId = "none";
  }
  return {
    ...result(true, "stop", root, "stop recorded; further step calls are refused", [], []),
    panel: renderPanel(root, next, bestId),
  };
}

function collectThresholds(root: string, argv: readonly string[]): { ok: true; value: RunThresholds } | { ok: false; missing: string[] } {
  const fromFile = readThresholds(root);
  const overlay: Partial<RunThresholds> = {};
  const missing: string[] = [];
  for (const key of THRESHOLD_KEYS) {
    const raw = flag(argv, FLAG_FOR[key]);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || (key === "minDelta" && value <= 0)) {
      missing.push(`${key} (${FLAG_FOR[key]})`);
      continue;
    }
    overlay[key] = value;
  }
  const merged: Partial<RunThresholds> = { ...(fromFile.ok ? fromFile.value : {}), ...overlay };
  for (const key of missingThresholds(merged)) {
    if (!missing.includes(`${key} (${FLAG_FOR[key]})`)) missing.push(`${key} (${FLAG_FOR[key]})`);
  }
  if (missing.length > 0 || !isComplete(merged)) return { ok: false, missing };
  return { ok: true, value: merged };
}

function isComplete(value: Partial<RunThresholds>): value is RunThresholds {
  return missingThresholds(value).length === 0;
}

function collectHeldOut(root: string, argv: readonly string[]): { ok: true; score: number } | { ok: false; missing: string[] } {
  const raw = flag(argv, "--heldout-score");
  if (raw !== undefined) {
    const score = Number(raw);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      return { ok: false, missing: ["heldout-score (--heldout-score)"] };
    }
    return { ok: true, score };
  }
  try {
    return { ok: true, score: readHeldOutScore(root).score };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, missing: [`heldout-score (--heldout-score) ${detail}`] };
  }
}

function renderPanel(root: string, saved: SavedSession, bestId: string): string[] {
  const thresholds = readThresholds(root);
  const usage = readTokensSpent(root);
  const tokenBudget = thresholds.ok ? thresholds.value.tokenBudget : Number.NaN;
  const maxRuns = thresholds.ok ? thresholds.value.maxLocalRuns : Number.NaN;
  const spent = usage.ok ? usage.tokensSpent : Number.NaN;
  const tokenLine = Number.isFinite(spent) && Number.isFinite(tokenBudget)
    ? `budget remaining tokens ${tokenBudget - spent} / ${tokenBudget}; runs ${maxRuns - saved.usedRuns} / ${maxRuns}`
    : "budget remaining unknown (thresholds or tokensSpent missing)";
  const lines = [
    `round ${saved.round}`,
    `phase ${saved.phase}`,
    tokenLine,
    `best ${bestId}`,
  ];
  for (const row of GATE_ROWS) {
    const parts = row.ids.map((id) => saved.checks.find((check) => check.id === id));
    if (parts.some((part) => part === undefined)) {
      lines.push(`${row.label} not-run`);
      continue;
    }
    const ok = parts.every((part) => part?.ok);
    const detail = parts.map((part) => part?.detail ?? "").join("; ");
    lines.push(`${row.label} ${ok ? "OK" : "FAIL"} ${detail}`);
  }
  const inputs = saved.checks.find((check) => check.id === "inputs");
  if (inputs) lines.push(`inputs FAIL ${inputs.detail}`);
  return lines;
}

function result(
  ok: boolean,
  command: string,
  root: string,
  text: string,
  failed: readonly string[],
  missing: readonly string[],
): CommandResult {
  return { ok, command, root, text, failed, missing, panel: [], reports: [] };
}

function sessionPath(root: string): string {
  return join(root, "state", "session.json");
}

function readSession(root: string): SavedSession | undefined {
  try {
    return JSON.parse(readHostFile(root, "state/session.json")) as SavedSession;
  } catch {
    return undefined;
  }
}

function writeSession(root: string, saved: SavedSession): void {
  writeHostFile(root, "state/session.json", `${JSON.stringify(saved, null, 2)}\n`);
}
