import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoHeldOutLeak } from "./proposer";
import { DEFAULT_EWI_THRESHOLD_SEC, measureRunEwi, type EwiMetrics } from "./ewi";
import {
  CommandOptExecutor,
  createDryRunExecutor,
  tokenCap,
  type OptExecutor,
  type OptRunRequest,
  type OptTask,
} from "./opt-executor";

/** Pinned test id. Calls go out through BASE_URL; this package does not pick a host. */
export const OPT_MODEL = "deepseek-v4-1-flash-261017";

export const DEV_TASK: OptTask = {
  id: "i014",
  path: "tasks2/i014",
  split: "dev",
  network: "shared",
  tokenW: 1_625_811,
};

export const HELD_OUT_TASKS: readonly OptTask[] = [
  {
    id: "002",
    path: "tasks1/002-bigwig-h3k27ac-igg-peak-audit",
    split: "held-out",
    network: "gateway-only",
    tokenW: 2_383_647,
  },
  { id: "i030", path: "tasks2/i030", split: "held-out", network: "shared", tokenW: 4_876_782 },
  { id: "hb003", path: "tasks3/hb003", split: "held-out", network: "shared", tokenW: 9_024_166 },
];

/** control.json shape from the preregistration. maxSteps 25. */
export const CONTROL_CONFIG = {
  parts: {
    "agent-loop": { maxSteps: 25 },
  },
} as const;

export interface RoleSession {
  readonly jsonl: string;
}

export interface TraceHint {
  readonly file: string;
  readonly line: number;
}

export interface ReviewNote {
  readonly accept: boolean;
  readonly reason: string;
}

export interface GapCall {
  readonly round: number;
  readonly traces: readonly TraceHint[];
  readonly previousReview: ReviewNote | null;
}

export interface GapTurn {
  readonly session: RoleSession;
  readonly citations: readonly string[];
  readonly knob: string;
  readonly failureClass: string;
  readonly summary: string;
}

export interface InnovateCall {
  readonly round: number;
  readonly knob: string;
  readonly gapSummary: string;
  readonly triedSummaries: readonly string[];
  readonly control: unknown;
}

export interface InnovatorTurn {
  readonly session: RoleSession;
  readonly summary: string;
  readonly parts: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface RunView {
  readonly seed: number;
  readonly reward: number | null;
  readonly scoreStatus: "scored" | "unscored";
  readonly unscoredReason?: string;
  readonly timedOut: boolean;
  readonly tokens: number;
  readonly wallS: number;
  readonly postWriteS: number;
  readonly idleS: number;
  readonly gapMaxS: number;
  readonly ewi: boolean;
}

export interface ReviewCall {
  readonly round: number;
  readonly patchHash: string;
  readonly summary: string;
  readonly knob: string;
  readonly runs: readonly RunView[];
  readonly ewiSeeds: readonly number[];
}

export interface ReviewerTurn {
  readonly session: RoleSession;
  readonly accept: boolean;
  readonly reason: string;
}

export interface OptRoles {
  gap(input: GapCall): Promise<GapTurn>;
  innovate(input: InnovateCall): Promise<InnovatorTurn>;
  review(input: ReviewCall): Promise<ReviewerTurn>;
}

export interface OptLoopOptions {
  readonly out: string;
  readonly rounds?: number;
  readonly seeds?: readonly number[];
  readonly ewiThresholdSec?: number;
  readonly model?: string;
  readonly mode: "dry-run" | "execute";
  readonly roles?: OptRoles;
  readonly executor?: OptExecutor;
  readonly executorCommand?: readonly string[];
  readonly driver?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export interface AcceptedCandidate {
  readonly round: number;
  readonly patchHash: string;
  readonly marker: string;
  readonly configPath: string;
  readonly knob: string;
  readonly knobValue: unknown;
}

export interface OptLoopResult {
  readonly model: string;
  readonly ewiThresholdSec: number;
  readonly rounds: readonly {
    readonly round: number;
    readonly accepted: boolean;
    readonly duplicate: boolean;
    readonly patchHash: string | null;
    readonly ewiSeeds: readonly number[];
  }[];
  readonly accepted: AcceptedCandidate | null;
  readonly finalBlock: { readonly order: readonly string[] } | null;
  readonly heldOut: { readonly calls: number; readonly gatewayOnly: readonly string[] } | null;
  readonly skippedFinal: boolean;
}

interface ConfigFile {
  parts: Record<string, Record<string, unknown>>;
}

interface ScoredRun {
  readonly task: string;
  readonly seed: number;
  readonly arm: "control" | "candidate";
  readonly reward: number | null;
  readonly scoreStatus: "scored" | "unscored";
  readonly unscoredReason?: string;
  readonly tokens: number;
  readonly wallS: number;
  readonly timedOut: boolean;
  readonly ewi: EwiMetrics;
  readonly tracePath: string;
}

interface ClosureRecord {
  round: number;
  closed: boolean;
  gapCitedTrace: boolean;
  knobMatched: boolean;
  patchActive: boolean;
  reviewFedForward: boolean | null;
}

/** One dev round: gap, one candidate, k seeds, reviewer. No model call lives in this function. */
export async function runOptLoop(options: OptLoopOptions): Promise<OptLoopResult> {
  const rounds = options.rounds ?? 3;
  const seeds = options.seeds ?? [0, 1, 2];
  const threshold = options.ewiThresholdSec ?? DEFAULT_EWI_THRESHOLD_SEC;
  const model = options.model ?? OPT_MODEL;
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
  if (seeds.length === 0) throw new Error("seeds are empty");
  const env = options.env ?? process.env;
  if (options.mode === "execute" && !env.BASE_URL) throw new Error("execute mode needs BASE_URL");
  const roles = options.roles ?? (options.mode === "dry-run" ? stubOptRoles() : undefined);
  if (!roles) throw new Error("execute mode needs roles");
  const executor = options.executor ?? executorFor(options, env);
  const now = options.now ?? (() => new Date());
  mkdirSync(options.out, { recursive: true });

  const control = controlConfig();
  const controlPath = join(options.out, "control", "config.json");
  writeJson(controlPath, control);
  const controlSha = sha256(readFileSync(controlPath));
  const baseline = "baseline/i014/seed0/trace.jsonl";
  writeText(join(options.out, baseline), `${JSON.stringify({ type: "run_start", source: "protocol-baseline" })}\n`);

  const tried: string[] = [];
  let accepted: AcceptedCandidate | null = null;
  let traces: TraceHint[] = [{ file: baseline, line: 1 }];
  let previousReview: ReviewNote | null = null;
  const roundSummaries: OptLoopResult["rounds"][number][] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const started = now();
    const gapInput: GapCall = { round, traces, previousReview };
    assertNoHeldOutLeak(gapInput, "gap input");
    writeJson(join(options.out, `round${round}`, "gap-input.json"), gapInput);
    if (previousReview && round > 1) {
      updateFedForward(options.out, round - 1, previousReview.reason);
    }
    const gap = await roles.gap(gapInput);
    writeSession(options.out, round, "gap-finder", gap.session.jsonl);
    const gapCitedTrace = traces.some((hint) => gap.session.jsonl.includes(`${hint.file}:${hint.line}`));

    const innovateInput: InnovateCall = {
      round,
      knob: gap.knob,
      gapSummary: gap.summary,
      triedSummaries: [...tried],
      control,
    };
    assertNoHeldOutLeak(innovateInput, "innovator input");
    writeJson(join(options.out, `round${round}`, "innovator-input.json"), innovateInput);
    const proposed = await roles.innovate(innovateInput);
    writeSession(options.out, round, "innovator", proposed.session.jsonl);

    if (tried.includes(proposed.summary)) {
      const note = "duplicate summary";
      writeSession(options.out, round, "reviewer-gate", sessionLines("reviewer-gate", note));
      writeClosure(options.out, round, {
        round,
        closed: false,
        gapCitedTrace,
        knobMatched: false,
        patchActive: false,
        reviewFedForward: null,
      });
      writeNotes(options.out, round, started, now(), threshold, null, controlSha);
      roundSummaries.push({ round, accepted: false, duplicate: true, patchHash: null, ewiSeeds: [] });
      previousReview = { accept: false, reason: note };
      continue;
    }

    const candidate = mergeConfig(control, proposed.parts);
    const configPath = join(options.out, `round${round}`, "candidate", "config.json");
    writeJson(configPath, candidate);
    const diff = unifiedDiff("control/config.json", readFileSync(controlPath, "utf8"), `round${round}/candidate/config.json`, readFileSync(configPath, "utf8"));
    const diffPath = join(options.out, `round${round}`, "patch.diff");
    writeText(diffPath, diff);
    const patchHash = sha256(readFileSync(diffPath));
    const marker = `harness-opt-patch:${patchHash}`;
    const knobValue = valueAt(candidate, gap.knob);
    const knobMatched = knobValue !== undefined && knobValue !== valueAt(control, gap.knob);
    tried.push(proposed.summary);

    const runs: ScoredRun[] = [];
    for (const seed of seeds) {
      runs.push(await executeScored(executor, {
        task: DEV_TASK,
        seed,
        arm: "candidate",
        configPath,
        runDir: join(options.out, `round${round}`, "runs", DEV_TASK.id, `seed${seed}`, "candidate"),
        model,
        patchHash,
        marker,
        tokenCap: tokenCap(DEV_TASK),
      }, threshold));
    }
    const activation = activationRecord({
      runs,
      marker,
      patchHash,
      controlSha,
      candidateSha: sha256(readFileSync(configPath)),
      knob: gap.knob,
      knobValue,
    });
    writeJson(join(options.out, `round${round}`, "activation.json"), activation);
    const metrics = summarize(runs, threshold);
    writeJson(join(options.out, `round${round}`, "metrics.json"), metrics);

    const reviewInput: ReviewCall = {
      round,
      patchHash,
      summary: proposed.summary,
      knob: gap.knob,
      runs: metrics.runs,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
    };
    assertNoHeldOutLeak(reviewInput, "reviewer input");
    writeJson(join(options.out, `round${round}`, "review-input.json"), reviewInput);
    const verdict = await roles.review(reviewInput);
    writeSession(options.out, round, "reviewer-gate", verdict.session.jsonl);
    writeClosure(options.out, round, {
      round,
      closed: false,
      gapCitedTrace,
      knobMatched,
      patchActive: activation.patchActive,
      reviewFedForward: null,
    });
    writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha);
    if (verdict.accept) {
      accepted = { round, patchHash, marker, configPath, knob: gap.knob, knobValue };
    }
    previousReview = { accept: verdict.accept, reason: verdict.reason };
    traces = runs.map((run) => ({ file: relativeTo(options.out, run.tracePath), line: 1 }));
    roundSummaries.push({
      round,
      accepted: verdict.accept,
      duplicate: false,
      patchHash,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
    });
  }

  if (!accepted) {
    const result: OptLoopResult = {
      model,
      ewiThresholdSec: threshold,
      rounds: roundSummaries,
      accepted: null,
      finalBlock: null,
      heldOut: null,
      skippedFinal: true,
    };
    writeJson(join(options.out, "loop-result.json"), result);
    return result;
  }

  const order: string[] = [];
  const finalRuns: ScoredRun[] = [];
  for (const seed of seeds) {
    order.push(`C${seed}`);
    finalRuns.push(await executeScored(executor, {
      task: DEV_TASK,
      seed,
      arm: "control",
      configPath: controlPath,
      runDir: join(options.out, "final", "runs", DEV_TASK.id, `seed${seed}`, "control"),
      model,
      patchHash: "",
      marker: "",
      tokenCap: tokenCap(DEV_TASK),
    }, threshold));
    order.push(`X${seed}`);
    finalRuns.push(await executeScored(executor, {
      task: DEV_TASK,
      seed,
      arm: "candidate",
      configPath: accepted.configPath,
      runDir: join(options.out, "final", "runs", DEV_TASK.id, `seed${seed}`, "candidate"),
      model,
      patchHash: accepted.patchHash,
      marker: accepted.marker,
      tokenCap: tokenCap(DEV_TASK),
    }, threshold));
  }
  const finalBlock = { order, control: summarize(finalRuns.filter((run) => run.arm === "control"), threshold), candidate: summarize(finalRuns.filter((run) => run.arm === "candidate"), threshold) };
  writeJson(join(options.out, "final", "order.json"), { order });
  writeJson(join(options.out, "final", "metrics.json"), finalBlock);

  const heldRuns: ScoredRun[] = [];
  for (const task of HELD_OUT_TASKS) {
    for (const seed of seeds) {
      heldRuns.push(await executeScored(executor, {
        task,
        seed,
        arm: "candidate",
        configPath: accepted.configPath,
        runDir: join(options.out, "heldout", "runs", task.id, `seed${seed}`, "candidate"),
        model,
        patchHash: accepted.patchHash,
        marker: accepted.marker,
        tokenCap: tokenCap(task),
      }, threshold));
    }
  }
  const heldOut = {
    calls: heldRuns.length,
    gatewayOnly: HELD_OUT_TASKS.filter((task) => task.network === "gateway-only").map((task) => task.id),
    comparison: "control-not-run",
    byTask: HELD_OUT_TASKS.map((task) => ({
      task: task.id,
      network: task.network,
      ...summarize(heldRuns.filter((run) => run.task === task.id), threshold),
    })),
  };
  writeJson(join(options.out, "heldout", "metrics.json"), heldOut);
  const result: OptLoopResult = {
    model,
    ewiThresholdSec: threshold,
    rounds: roundSummaries,
    accepted,
    finalBlock: { order },
    heldOut: { calls: heldOut.calls, gatewayOnly: heldOut.gatewayOnly },
    skippedFinal: false,
  };
  writeJson(join(options.out, "loop-result.json"), result);
  return result;
}

export function stubOptRoles(): OptRoles {
  return {
    async gap(input) {
      const hint = input.traces[0];
      const cite = hint ? `${hint.file}:${hint.line}` : "baseline/i014/seed0/trace.jsonl:1";
      const prior = input.previousReview ? ` previous ${input.previousReview.reason}` : "";
      return {
        session: { jsonl: sessionLines("gap-finder", `cited ${cite} knob agent-loop.maxSteps${prior}`) },
        citations: [cite],
        knob: "agent-loop.maxSteps",
        failureClass: "idle-loop",
        summary: "early write then idle",
      };
    },
    async innovate(input) {
      const maxSteps = 25 - input.round;
      const summary = `agent-loop.maxSteps=${maxSteps}`;
      return {
        session: { jsonl: sessionLines("innovator", summary) },
        summary,
        parts: { "agent-loop": { maxSteps } },
      };
    },
    async review(input) {
      const accept = input.round === 1;
      const reason = accept ? "accept the idle cap" : "reject this candidate";
      return { session: { jsonl: sessionLines("reviewer-gate", reason) }, accept, reason };
    },
  };
}

function executorFor(options: OptLoopOptions, env: NodeJS.ProcessEnv): OptExecutor {
  if (options.mode === "dry-run") return createDryRunExecutor();
  if (!options.executorCommand || options.executorCommand.length === 0) {
    throw new Error("execute mode needs an executor command");
  }
  return new CommandOptExecutor({
    command: options.executorCommand,
    ...(options.driver ? { driver: options.driver } : {}),
    env,
  });
}

async function executeScored(executor: OptExecutor, request: OptRunRequest, threshold: number): Promise<ScoredRun> {
  mkdirSync(request.runDir, { recursive: true });
  const observation = await executor.run(request);
  const rewardFile = readReward(request.runDir);
  let scoreStatus = observation.scoreStatus;
  let reward = scoreStatus === "unscored" ? null : rewardFile.reward;
  let unscoredReason = observation.unscoredReason ?? rewardFile.reason;
  if (observation.tokens > request.tokenCap) {
    scoreStatus = "unscored";
    reward = null;
    unscoredReason = "token_cap_exceeded";
  } else if (reward === null) {
    scoreStatus = "unscored";
  }
  const ewi = measureRunEwi({
    task: request.task.id,
    seed: String(request.seed),
    timedOut: observation.timedOut,
    tracePath: observation.tracePath,
    outputsDir: observation.outputsDir,
    batchLogPath: observation.batchLogPath,
    runNumber: 1,
  }, threshold);
  return {
    task: request.task.id,
    seed: request.seed,
    arm: request.arm,
    reward,
    scoreStatus,
    ...(unscoredReason ? { unscoredReason } : {}),
    tokens: observation.tokens,
    wallS: observation.wallS,
    timedOut: observation.timedOut,
    ewi,
    tracePath: observation.tracePath,
  };
}

function readReward(runDir: string): { readonly reward: number | null; readonly reason?: string } {
  const file = join(runDir, "verifier", "reward.txt");
  if (!existsSync(file)) return { reward: null, reason: "reward-missing" };
  const raw = readFileSync(file, "utf8").trim();
  const reward = Number(raw);
  if (raw === "" || !Number.isFinite(reward) || reward < 0 || reward > 1) {
    return { reward: null, reason: "reward-unreadable" };
  }
  return { reward };
}

function activationRecord(input: {
  readonly runs: readonly ScoredRun[];
  readonly marker: string;
  readonly patchHash: string;
  readonly controlSha: string;
  readonly candidateSha: string;
  readonly knob: string;
  readonly knobValue: unknown;
}): {
  readonly patchHash: string;
  readonly marker: string;
  readonly controlConfigSha: string;
  readonly candidateConfigSha: string;
  readonly differsFromControl: boolean;
  readonly patchActive: boolean;
  readonly runs: readonly {
    readonly seed: number;
    readonly tracePath: string;
    readonly candidateConfigHash: string | null;
    readonly markerInSystemPrompt: boolean;
    readonly effectiveKnob: unknown;
    readonly active: boolean;
  }[];
} {
  const runs = input.runs.map((run) => {
    const start = readRunStart(run.tracePath);
    const prompt = typeof start?.systemPrompt === "string" ? start.systemPrompt : "";
    const hash = typeof start?.candidateConfigHash === "string" ? start.candidateConfigHash : null;
    const effective = start?.effective;
    const effectiveKnob = effective && typeof effective === "object" ? (effective as Record<string, unknown>)[input.knob] : undefined;
    const markerInSystemPrompt = input.marker !== "" && prompt.includes(input.marker);
    const active = markerInSystemPrompt
      && hash === input.candidateSha
      && input.candidateSha !== input.controlSha
      && sameValue(effectiveKnob, input.knobValue);
    return {
      seed: run.seed,
      tracePath: run.tracePath,
      candidateConfigHash: hash,
      markerInSystemPrompt,
      effectiveKnob,
      active,
    };
  });
  return {
    patchHash: input.patchHash,
    marker: input.marker,
    controlConfigSha: input.controlSha,
    candidateConfigSha: input.candidateSha,
    differsFromControl: input.candidateSha !== input.controlSha,
    patchActive: runs.every((run) => run.active),
    runs,
  };
}

function readRunStart(tracePath: string): { readonly candidateConfigHash?: unknown; readonly systemPrompt?: unknown; readonly effective?: unknown } | null {
  if (!existsSync(tracePath)) throw new Error(`patch activation is unreadable: ${tracePath}`);
  const line = readFileSync(tracePath, "utf8").split("\n").find((item) => item.trim() !== "");
  if (!line) throw new Error(`patch activation is unreadable: ${tracePath}`);
  const parsed = JSON.parse(line) as { type?: unknown; candidateConfigHash?: unknown; systemPrompt?: unknown; effective?: unknown };
  if (parsed.type !== "run_start") throw new Error(`patch activation is unreadable: ${tracePath}`);
  return parsed;
}

function summarize(runs: readonly ScoredRun[], threshold: number): {
  readonly ewiThresholdSec: number;
  readonly runs: readonly RunView[];
  readonly ewiRuns: readonly RunView[];
  readonly rewardMean: number | null;
  readonly withoutEwi: { readonly count: number; readonly rewardMean: number | null; readonly timedOut: number };
} {
  const views = runs.map(toView);
  const scored = views.filter((run) => run.scoreStatus === "scored" && run.reward !== null);
  const kept = scored.filter((run) => !run.ewi);
  return {
    ewiThresholdSec: threshold,
    runs: views,
    ewiRuns: views.filter((run) => run.ewi),
    rewardMean: mean(scored.map((run) => run.reward ?? 0)),
    withoutEwi: {
      count: kept.length,
      rewardMean: mean(kept.map((run) => run.reward ?? 0)),
      timedOut: kept.filter((run) => run.timedOut).length,
    },
  };
}

function toView(run: ScoredRun): RunView {
  return {
    seed: run.seed,
    reward: run.reward,
    scoreStatus: run.scoreStatus,
    ...(run.unscoredReason ? { unscoredReason: run.unscoredReason } : {}),
    timedOut: run.timedOut,
    tokens: run.tokens,
    wallS: run.wallS,
    postWriteS: run.ewi.postWriteS,
    idleS: run.ewi.idleS,
    gapMaxS: run.ewi.gapMaxS,
    ewi: run.ewi.ewi,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function controlConfig(): ConfigFile {
  return { parts: { "agent-loop": { maxSteps: CONTROL_CONFIG.parts["agent-loop"].maxSteps } } };
}

function mergeConfig(control: ConfigFile, parts: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ConfigFile {
  const next = structuredClone(control);
  for (const [part, values] of Object.entries(parts)) {
    next.parts[part] = { ...(next.parts[part] ?? {}), ...values };
  }
  return next;
}

function valueAt(config: ConfigFile, knob: string): unknown {
  const [part, ...rest] = knob.split(".");
  if (!part) return undefined;
  let current: unknown = config.parts[part];
  for (const key of rest) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function unifiedDiff(fromName: string, fromText: string, toName: string, toText: string): string {
  const from = linesOf(fromText);
  const to = linesOf(toText);
  const body: string[] = [];
  const max = Math.max(from.length, to.length);
  for (let index = 0; index < max; index += 1) {
    if (from[index] === to[index]) body.push(` ${from[index] ?? ""}`);
    else {
      if (index < from.length) body.push(`-${from[index]}`);
      if (index < to.length) body.push(`+${to[index]}`);
    }
  }
  return [`--- ${fromName}`, `+++ ${toName}`, `@@ -1,${from.length} +1,${to.length} @@`, ...body, ""].join("\n");
}

function linesOf(text: string): string[] {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed === "" ? [] : trimmed.split("\n");
}

function writeSession(out: string, round: number, role: string, jsonl: string): void {
  const relative = `round${round}/sessions/${role}.jsonl`;
  const body = jsonl.endsWith("\n") ? jsonl : `${jsonl}\n`;
  writeText(join(out, relative), body);
  const manifestPath = join(out, `round${round}`, "sessions", "manifest.json");
  const current = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as { sessions: { role: string; file: string; sha256: string }[] }
    : { sessions: [] };
  const file = relative;
  const sha = sha256(readFileSync(join(out, relative)));
  const sessions = current.sessions.filter((item) => item.role !== role);
  sessions.push({ role, file, sha256: sha });
  writeJson(manifestPath, { sessions });
}

function writeClosure(out: string, round: number, record: ClosureRecord): void {
  writeJson(join(out, `round${round}`, "closure.json"), {
    ...record,
    closed: record.gapCitedTrace && record.knobMatched && record.patchActive && record.reviewFedForward === true,
  });
}

function updateFedForward(out: string, round: number, reason: string): void {
  const file = join(out, `round${round}`, "closure.json");
  if (!existsSync(file)) return;
  const prior = JSON.parse(readFileSync(file, "utf8")) as ClosureRecord;
  const gapInput = JSON.parse(readFileSync(join(out, `round${round + 1}`, "gap-input.json"), "utf8")) as {
    previousReview?: { reason?: string };
  };
  const fed = gapInput.previousReview?.reason === reason;
  writeClosure(out, round, { ...prior, reviewFedForward: fed });
}

function writeNotes(
  out: string,
  round: number,
  started: Date,
  ended: Date,
  threshold: number,
  patchHash: string | null,
  controlSha: string,
): void {
  const lines = [
    `start: ${started.toISOString()}`,
    `end: ${ended.toISOString()}`,
    `ewiThresholdSec: ${threshold}`,
    `controlConfigSha: ${controlSha}`,
    `patchSha: ${patchHash ?? ""}`,
    "",
  ];
  writeText(join(out, `round${round}`, "run-notes.md"), lines.join("\n"));
}

function sessionLines(role: string, text: string): string {
  return `${JSON.stringify({ type: "session", role })}\n${JSON.stringify({ type: "message", role: "assistant", text })}\n`;
}

function relativeTo(root: string, file: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeText(file: string, body: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}
