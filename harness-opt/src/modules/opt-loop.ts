import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { inspectAttestedActivation, runStartConfigHash, type ActivationInspection } from "./activation";
import {
  assertAttestIsolated,
  assertAttestRoot,
  loadAttestKey,
  sha256File,
  verifyHostAttestation,
  type VerifiedAttestation,
} from "./attestation";
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

/**
 * Compact bytes of that control file. On the box this sha is
 * 3e5d312d252f8f70a7f16f3a37a109f706fe85db59d4515a323828bdac5c192c.
 * The loop hashes the host file it was given. A different serialization does not match.
 */
export const CONTROL_CONFIG_TEXT = "{\"parts\":{\"agent-loop\":{\"maxSteps\":25}}}\n";
export const CONTROL_CONFIG_SHA = "3e5d312d252f8f70a7f16f3a37a109f706fe85db59d4515a323828bdac5c192c";

export interface RoleSession {
  readonly jsonl: string;
}

export interface TraceHint {
  readonly file: string;
  readonly line: number;
  /** Host hash of `file`. A role-returned path does not supply this. */
  readonly sha256: string;
}

export interface ReviewNote {
  readonly accept: boolean;
  readonly reason: string;
}

export interface GapCall {
  readonly round: number;
  readonly traces: readonly TraceHint[];
  readonly previousReview: ReviewNote | null;
  /** Previous reviewer Pi session captured by the host. The next gap has to read this file. */
  readonly previousReviewSession: string | null;
  /** Host-assigned session file. The role writes here. The return text is ignored. */
  readonly sessionPath: string;
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
  readonly sessionPath: string;
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
  readonly sessionPath: string;
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
  /** Directory outside `out`. The loop assigns `{attestDir}` under it before spawn. */
  readonly attestRoot: string;
  /** Host key file. Also read by the wrapper from `HARNESS_ATTEST_KEY_FILE`. Never placed on argv. */
  readonly attestKeyFile: string;
  /** Harness file the wrapper mounts. Its sha is checked against `mountedHarnessSha` when set. */
  readonly harnessPath: string;
  /** Host control config bytes. Defaults to `CONTROL_CONFIG_TEXT`. */
  readonly controlConfigPath?: string;
  /** Host attestation directories for the round-1 control runs. Not trace paths and not stdout. */
  readonly controlAttests: readonly string[];
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
  readonly runDir: string;
  readonly tracePath: string;
  readonly verified: VerifiedAttestation | null;
  readonly attestReasons: readonly string[];
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
  const attestKey = loadAttestKey(options.attestKeyFile);
  assertAttestRoot(options.attestRoot, options.out);
  assertKeyOutside(options.attestKeyFile, [options.out]);
  const executor = options.executor ?? executorFor(options, env, attestKey);
  const now = options.now ?? (() => new Date());
  mkdirSync(options.out, { recursive: true });

  const controlPath = join(options.out, "control", "config.json");
  const controlBytes = options.controlConfigPath ? readFileSync(options.controlConfigPath) : Buffer.from(CONTROL_CONFIG_TEXT);
  writeText(controlPath, controlBytes.toString("utf8"));
  const control = JSON.parse(controlBytes.toString("utf8")) as ConfigFile;
  const controlSha = sha256File(controlPath);
  const traces = loadControlAttests(options.controlAttests, controlPath, attestKey, options.harnessPath);
  let traceHints: TraceHint[] = traces;

  const tried: string[] = [];
  let accepted: AcceptedCandidate | null = null;
  let previousReview: ReviewNote | null = null;
  let previousReviewSession: string | null = null;
  let previousReviewSha: string | null = null;
  const roundSummaries: OptLoopResult["rounds"][number][] = [];

  for (let round = 1; round <= rounds; round += 1) {
    const started = now();
    const gapSessionPath = sessionPath(options.out, round, "gap-finder");
    const gapInput: GapCall = {
      round,
      traces: traceHints,
      previousReview,
      previousReviewSession,
      sessionPath: gapSessionPath,
    };
    assertNoHeldOutLeak(gapInput, "gap input");
    writeJson(join(options.out, `round${round}`, "gap-input.json"), gapInput);
    const gap = await roles.gap(gapInput);
    const gapCaptured = captureSession(options.out, round, "gap-finder", gapSessionPath);
    const gapCitedTrace = gapCaptured
      ? citedByCapturedRead(gapCaptured.text, traceHints, options.out)
      : false;
    if (round > 1 && previousReviewSession && previousReviewSha) {
      const fed = gapCaptured
        ? citedByCapturedRead(gapCaptured.text, [{ file: previousReviewSession, line: 1, sha256: previousReviewSha }], options.out)
        : false;
      const prior = JSON.parse(readFileSync(join(options.out, `round${round - 1}`, "closure.json"), "utf8")) as ClosureRecord;
      writeClosure(options.out, round - 1, { ...prior, reviewFedForward: fed });
    }
    const innovatorPath = sessionPath(options.out, round, "innovator");
    const innovateInput: InnovateCall = {
      round,
      knob: gap.knob,
      gapSummary: gap.summary,
      triedSummaries: [...tried],
      control,
      sessionPath: innovatorPath,
    };
    assertNoHeldOutLeak(innovateInput, "innovator input");
    writeJson(join(options.out, `round${round}`, "innovator-input.json"), innovateInput);
    const proposed = await roles.innovate(innovateInput);
    captureSession(options.out, round, "innovator", innovatorPath);

    if (tried.includes(proposed.summary)) {
      const note = "duplicate summary";
      const reviewPath = sessionPath(options.out, round, "reviewer-gate");
      writeText(reviewPath, sessionLines("reviewer-gate", note));
      const reviewSha = captureSession(options.out, round, "reviewer-gate", reviewPath)?.sha256 ?? null;
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
      previousReviewSession = reviewPath;
      previousReviewSha = reviewSha;
      continue;
    }

    const candidate = mergeConfig(control, proposed.parts);
    const configPath = join(options.out, `round${round}`, "candidate", "config.json");
    writeJson(configPath, candidate);
    const diff = unifiedDiff("control/config.json", readFileSync(controlPath, "utf8"), `round${round}/candidate/config.json`, readFileSync(configPath, "utf8"));
    const diffPath = join(options.out, `round${round}`, "patch.diff");
    writeText(diffPath, diff);
    const patchHash = sha256(readFileSync(diffPath));
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
        tokenCap: tokenCap(DEV_TASK),
      }, hostFor(options, attestKey, `round${round}`, DEV_TASK.id, `seed${seed}`, "candidate"), threshold));
    }
    const activation = activationRecord({
      runs,
      patchHash,
      controlSha,
      candidateSha: sha256File(configPath),
      knob: gap.knob,
      knobValue,
    });
    writeJson(join(options.out, `round${round}`, "activation.json"), activation);
    const metrics = summarize(runs, threshold);
    writeJson(join(options.out, `round${round}`, "metrics.json"), metrics);

    const reviewPath = sessionPath(options.out, round, "reviewer-gate");
    const reviewInput: ReviewCall = {
      round,
      patchHash,
      summary: proposed.summary,
      knob: gap.knob,
      runs: metrics.runs,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
      sessionPath: reviewPath,
    };
    assertNoHeldOutLeak(reviewInput, "reviewer input");
    writeJson(join(options.out, `round${round}`, "review-input.json"), reviewInput);
    const verdict = await roles.review(reviewInput);
    const reviewCaptured = captureSession(options.out, round, "reviewer-gate", reviewPath);
    writeClosure(options.out, round, {
      round,
      closed: false,
      gapCitedTrace,
      knobMatched,
      patchActive: activation.patchActive,
      reviewFedForward: null,
    });
    writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha);
    const take = verdict.accept && activation.patchActive && gapCitedTrace;
    if (take) {
      accepted = { round, patchHash, configPath, knob: gap.knob, knobValue };
    }
    previousReview = { accept: verdict.accept, reason: verdict.reason };
    previousReviewSession = reviewCaptured ? reviewPath : null;
    previousReviewSha = reviewCaptured?.sha256 ?? null;
    traceHints = runs.flatMap((run) => {
      if (!run.verified?.traceSha || !run.verified.tracePath) return [];
      return [{ file: run.verified.tracePath, line: 1, sha256: run.verified.traceSha }];
    });
    roundSummaries.push({
      round,
      accepted: take,
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
      tokenCap: tokenCap(DEV_TASK),
    }, hostFor(options, attestKey, "final", DEV_TASK.id, `seed${seed}`, "control"), threshold));
    order.push(`X${seed}`);
    finalRuns.push(await executeScored(executor, {
      task: DEV_TASK,
      seed,
      arm: "candidate",
      configPath: accepted.configPath,
      runDir: join(options.out, "final", "runs", DEV_TASK.id, `seed${seed}`, "candidate"),
      model,
      tokenCap: tokenCap(DEV_TASK),
    }, hostFor(options, attestKey, "final", DEV_TASK.id, `seed${seed}`, "candidate"), threshold));
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
        tokenCap: tokenCap(task),
      }, hostFor(options, attestKey, "heldout", task.id, `seed${seed}`, "candidate"), threshold));
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

export interface OptOnceOptions {
  readonly out: string;
  readonly attestRoot: string;
  readonly attestKeyFile: string;
  readonly harnessPath: string;
  readonly configPath: string;
  readonly controlConfigPath: string;
  readonly knob: string;
  readonly seed?: number;
  readonly task?: OptTask;
  readonly model?: string;
  readonly executor: OptExecutor;
}

export interface OptOnceResult {
  readonly model: string;
  readonly seed: number;
  readonly runDir: string;
  readonly patchActive: boolean;
  readonly candidateConfigSha: string;
  readonly controlConfigSha: string;
  readonly activation: ActivationInspection & { readonly seed: number };
}

/** One candidate seed through the pluggable executor. Not the prereg final comparison. */
export async function runOptOnce(options: OptOnceOptions): Promise<OptOnceResult> {
  const seed = options.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  if (!existsSync(options.configPath) || !statSync(options.configPath).isFile()) {
    throw new Error(`candidate config is missing: ${options.configPath}`);
  }
  if (!existsSync(options.controlConfigPath) || !statSync(options.controlConfigPath).isFile()) {
    throw new Error(`control config is missing: ${options.controlConfigPath}`);
  }
  const task = options.task ?? DEV_TASK;
  if (task.id === DEV_TASK.id && task.network !== "shared") throw new Error("i014 network must be shared");
  const model = options.model ?? OPT_MODEL;
  const attestKey = loadAttestKey(options.attestKeyFile);
  assertAttestRoot(options.attestRoot, options.out);
  assertKeyOutside(options.attestKeyFile, [options.out]);
  const runDir = join(options.out, "once", task.id, `seed${seed}`, "candidate");
  const attestDir = join(options.attestRoot, "once", task.id, `seed${seed}`, "candidate");
  assertAttestIsolated(attestDir, runDir);
  mkdirSync(runDir, { recursive: true });
  const request: OptRunRequest = {
    task,
    seed,
    arm: "candidate",
    configPath: options.configPath,
    runDir,
    attestDir,
    harnessPath: options.harnessPath,
    model,
    tokenCap: tokenCap(task),
  };
  await options.executor.run(request);
  const candidateSha = sha256File(options.configPath);
  const controlSha = sha256File(options.controlConfigPath);
  const knobValue = valueAt(JSON.parse(readFileSync(options.configPath, "utf8")) as ConfigFile, options.knob);
  const verified = verifyHostAttestation({
    attestDir,
    key: attestKey,
    configPath: options.configPath,
    harnessPath: options.harnessPath,
    runDir,
  });
  const activation = {
    seed,
    ...inspectAttestedActivation({
      verified: verified.ok ? verified : null,
      ...(verified.ok ? {} : { rejection: verified.reasons }),
      candidateSha,
      controlSha,
      knob: options.knob,
      knobValue,
    }),
  };
  const result: OptOnceResult = {
    model,
    seed,
    runDir,
    patchActive: activation.active,
    candidateConfigSha: candidateSha,
    controlConfigSha: controlSha,
    activation,
  };
  writeJson(join(options.out, "once", "activation.json"), result);
  return result;
}

export function stubOptRoles(): OptRoles {
  return {
    async gap(input) {
      const files = input.traces.map((hint) => hint.file);
      if (input.previousReviewSession) files.push(input.previousReviewSession);
      const reads = files.map((file, index) => toolExchange(file, index)).join("");
      writeText(input.sessionPath, `${sessionLines("gap-finder", "gap")}${reads}`);
      return {
        session: { jsonl: "ignored-return\n" },
        citations: [],
        knob: "agent-loop.maxSteps",
        failureClass: "idle-loop",
        summary: "early write then idle",
      };
    },
    async innovate(input) {
      const maxSteps = 25 - input.round;
      const summary = `agent-loop.maxSteps=${maxSteps}`;
      writeText(input.sessionPath, sessionLines("innovator", summary));
      return {
        session: { jsonl: "ignored-return\n" },
        summary,
        parts: { "agent-loop": { maxSteps } },
      };
    },
    async review(input) {
      const accept = input.round === 1;
      const reason = accept ? "accept the idle cap" : "reject this candidate";
      writeText(input.sessionPath, sessionLines("reviewer-gate", reason));
      return { session: { jsonl: "ignored-return\n" }, accept, reason };
    },
  };
}

function executorFor(options: OptLoopOptions, env: NodeJS.ProcessEnv, key: Buffer): OptExecutor {
  if (options.mode === "dry-run") return createDryRunExecutor({ key, harnessPath: options.harnessPath });
  if (!options.executorCommand || options.executorCommand.length === 0) {
    throw new Error("execute mode needs an executor command");
  }
  return new CommandOptExecutor({
    command: options.executorCommand,
    ...(options.driver ? { driver: options.driver } : {}),
    env,
  });
}

interface AttestHost {
  readonly attestDir: string;
  readonly key: Buffer;
  readonly harnessPath: string;
}

function hostFor(options: OptLoopOptions, key: Buffer, ...parts: string[]): AttestHost {
  return {
    attestDir: join(options.attestRoot, ...parts),
    key,
    harnessPath: options.harnessPath,
  };
}

async function executeScored(
  executor: OptExecutor,
  request: Omit<OptRunRequest, "attestDir" | "harnessPath">,
  host: AttestHost,
  threshold: number,
): Promise<ScoredRun> {
  if (request.task.id === DEV_TASK.id && request.task.network !== "shared") {
    throw new Error("i014 network must be shared");
  }
  assertAttestIsolated(host.attestDir, request.runDir);
  const full: OptRunRequest = { ...request, attestDir: host.attestDir, harnessPath: host.harnessPath };
  mkdirSync(request.runDir, { recursive: true });
  const observation = await executor.run(full);
  const verified = verifyHostAttestation({
    attestDir: host.attestDir,
    key: host.key,
    configPath: request.configPath,
    harnessPath: host.harnessPath,
    runDir: request.runDir,
  });
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
    runDir: request.runDir,
    tracePath: observation.tracePath,
    verified: verified.ok ? verified : null,
    attestReasons: verified.ok ? [] : verified.reasons,
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
  readonly patchHash: string;
  readonly controlSha: string;
  readonly candidateSha: string;
  readonly knob: string;
  readonly knobValue: unknown;
}): {
  readonly patchHash: string;
  readonly controlConfigSha: string;
  readonly candidateConfigSha: string;
  readonly differsFromControl: boolean;
  readonly patchActive: boolean;
  readonly runs: readonly (ActivationInspection & { readonly seed: number })[];
} {
  const runs = input.runs.map((run) => ({
    seed: run.seed,
    ...inspectAttestedActivation({
      verified: run.verified,
      rejection: run.attestReasons,
      candidateSha: input.candidateSha,
      controlSha: input.controlSha,
      knob: input.knob,
      knobValue: input.knobValue,
    }),
  }));
  return {
    patchHash: input.patchHash,
    controlConfigSha: input.controlSha,
    candidateConfigSha: input.candidateSha,
    differsFromControl: input.candidateSha !== input.controlSha,
    patchActive: runs.length > 0 && runs.every((run) => run.active),
    runs,
  };
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

function sessionPath(out: string, round: number, role: string): string {
  const file = join(out, `round${round}`, "sessions", `${role}.jsonl`);
  mkdirSync(join(file, ".."), { recursive: true });
  return file;
}

function captureSession(
  out: string,
  round: number,
  role: string,
  file: string,
): { readonly sha256: string; readonly text: string } | null {
  if (!existsSync(file)) return null;
  let linked;
  try {
    linked = statSync(file);
  } catch {
    return null;
  }
  if (!linked.isFile()) return null;
  const bytes = readFileSync(file);
  const sha = sha256(bytes);
  const manifestPath = join(out, `round${round}`, "sessions", "manifest.json");
  const current = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as { sessions: { role: string; file: string; sha256: string }[] }
    : { sessions: [] };
  const relative = `round${round}/sessions/${role}.jsonl`;
  const sessions = current.sessions.filter((item) => item.role !== role);
  sessions.push({ role, file: relative, sha256: sha });
  writeJson(manifestPath, { sessions });
  return { sha256: sha, text: bytes.toString("utf8") };
}

function writeClosure(out: string, round: number, record: ClosureRecord): void {
  writeJson(join(out, `round${round}`, "closure.json"), {
    ...record,
    closed: record.gapCitedTrace && record.knobMatched && record.patchActive && record.reviewFedForward === true,
  });
}

function loadControlAttests(
  attestDirs: readonly string[],
  controlPath: string,
  key: Buffer,
  harnessPath: string,
): TraceHint[] {
  if (attestDirs.length === 0) throw new Error("round 1 needs control attestations");
  return attestDirs.map((attestDir) => {
    const verified = verifyHostAttestation({
      attestDir,
      key,
      configPath: controlPath,
      harnessPath,
    });
    if (!verified.ok) throw new Error(`control attestation rejected: ${verified.reasons.join(",")}`);
    if (verified.arm !== "control") throw new Error("control attestation rejected: arm");
    if (!verified.tracePath || !verified.traceSha) throw new Error("control attestation rejected: trace");
    if (verified.mountedConfigSha !== sha256File(controlPath)) throw new Error("control attestation rejected: config");
    const recorded = runStartConfigHash(verified.tracePath);
    if (recorded !== verified.mountedConfigSha) {
      throw new Error("control trace candidateConfigHash does not match the attested config");
    }
    return { file: verified.tracePath, line: 1, sha256: verified.traceSha };
  });
}

function citedByCapturedRead(jsonl: string, targets: readonly TraceHint[], root: string): boolean {
  if (targets.length === 0) return false;
  const reads = successfulReads(jsonl);
  return targets.every((target) => {
    let hostSha: string;
    try {
      hostSha = sha256File(target.file);
    } catch {
      return false;
    }
    if (hostSha !== target.sha256) return false;
    return reads.some((read) => sameFile(root, read.path, target.file) && sha256(read.text) === target.sha256);
  });
}

function successfulReads(jsonl: string): { readonly path: string; readonly text: string }[] {
  const calls = new Map<string, string>();
  const reads: { path: string; text: string }[] = [];
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = entry && typeof entry === "object" ? (entry as { message?: unknown }).message : undefined;
    if (!message || typeof message !== "object") continue;
    const record = message as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const block of record.content) {
        if (!block || typeof block !== "object") continue;
        const tool = block as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
        if (tool.type !== "toolCall" || tool.name !== "read" || typeof tool.id !== "string") continue;
        if (!tool.arguments || typeof tool.arguments !== "object") continue;
        const path = (tool.arguments as { path?: unknown }).path;
        if (typeof path !== "string" || path === "") continue;
        calls.set(tool.id, path);
      }
    }
    if (record.role !== "toolResult" || record.toolName !== "read" || record.isError !== false) continue;
    if (typeof record.toolCallId !== "string") continue;
    const path = calls.get(record.toolCallId);
    if (!path) continue;
    const text = toolResultText(record.content);
    if (text === null) continue;
    reads.push({ path, text });
  }
  return reads;
}

function toolResultText(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") return null;
    const item = block as { type?: unknown; text?: unknown };
    if (item.type !== "text" || typeof item.text !== "string") return null;
    out += item.text;
  }
  return out;
}

function sameFile(root: string, left: string, right: string): boolean {
  const a = resolve(root, left);
  const b = resolve(root, right);
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function toolExchange(file: string, index: number): string {
  const text = readFileSync(file, "utf8");
  const callId = `c${index}`;
  const call = {
    type: "message",
    id: `r${index}`,
    parentId: null,
    timestamp: "2026-10-21T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: file } }],
      timestamp: 0,
    },
  };
  const result = {
    type: "message",
    id: `t${index}`,
    parentId: `r${index}`,
    timestamp: "2026-10-21T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`;
}

function assertKeyOutside(keyFile: string, dirs: readonly string[]): void {
  const key = resolve(keyFile);
  for (const dir of dirs) {
    const root = resolve(dir);
    if (key === root || key.startsWith(root + sep)) throw new Error("attest key must stay outside the loop output directory");
  }
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
