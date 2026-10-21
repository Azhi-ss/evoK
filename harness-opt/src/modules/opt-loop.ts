import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  absentResultWatcher,
  DEFAULT_EWI_THRESHOLD_SEC,
  EWI_THRESHOLD_LABEL,
  measureRunEwi,
  PREREGISTERED_RESULT_FILE,
  resolveEwiIdleScript,
  scoreRelayEwi,
  type ResultWriteWatcher,
  type ScoredRelayEwi,
} from "./ewi";
import {
  CommandOptExecutor,
  copyCheckerBeforeSign,
  createDryRunExecutor,
  hostRunId,
  tokenCap,
  type OptExecutor,
  type OptRunRequest,
  type OptTask,
} from "./opt-executor";
import { capHit, signPreRound1 } from "./loop-driver";
import {
  buildRoleSpawn,
  hostWriteSession,
  launchRolePi,
  recordedSessionSha,
  rolePiArgv,
  type RoleSpawnConfig,
} from "./role-spawn";

/** Pinned test id. Calls go out through BASE_URL; this package does not pick a host. */
export const OPT_MODEL = "deepseek-v4-1-flash-261017";

export const DEV_TASK: OptTask = {
  id: "i014",
  path: "tasks2/i014",
  split: "dev",
  network: "devii-004-int",
  tokenW: 1_625_811,
};

export const HELD_OUT_TASKS: readonly OptTask[] = [
  {
    id: "002",
    path: "tasks1/002-bigwig-h3k27ac-igg-peak-audit",
    split: "held-out",
    network: "devii-004-int",
    tokenW: 2_383_647,
  },
  { id: "i030", path: "tasks2/i030", split: "held-out", network: "devii-004-int", tokenW: 4_876_782 },
  { id: "hb003", path: "tasks3/hb003", split: "held-out", network: "devii-004-int", tokenW: 9_024_166 },
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
  /** Host-assigned session file. The host writes it. The return text is ignored. */
  readonly sessionPath: string;
  /** Spawn limits for this role. Gap has no write, edit, or bash tool. */
  readonly spawn: RoleSpawnConfig;
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
  readonly spawn: RoleSpawnConfig;
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
  readonly postWriteS: number | null;
  readonly idleS: number | null;
  readonly gapMaxS: number | null;
  /** True only for an EWI hit. Null is 「EWI不可判」 and is not a clear run. */
  readonly ewi: boolean | null;
  readonly ewiVerdict: "EWI不可判" | boolean;
  readonly referenceIdleS: number | null;
  readonly referenceEwi: boolean | null;
  readonly ewi_trace_ref: {
    readonly idleS: number;
    readonly gapMaxS: number;
    readonly postWriteS: number;
    readonly ewi: boolean;
  } | null;
}

export interface ReviewCall {
  readonly round: number;
  readonly patchHash: string;
  readonly summary: string;
  readonly knob: string;
  readonly runs: readonly RunView[];
  readonly ewiSeeds: readonly number[];
  readonly sessionPath: string;
  readonly spawn: RoleSpawnConfig;
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
  /** When set, gap and reviewer are exec'd with this binary and `--tools read`. */
  readonly piBin?: string;
  /** Host watcher for the preregistered result file. Absent observation stays undecided. */
  readonly resultWatcher?: ResultWriteWatcher;
  /** Host total of innovator+critic+ranker relay tokens. Absent means zero. */
  readonly readOnlyTokens?: () => number;
  /** Host read-only wall clock in seconds. Absent means the loop's own timer. */
  readonly readOnlyWallS?: () => number;
  /** False stops the loop before the next call. */
  readonly antiForgery?: () => boolean;
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
  readonly ewiThresholdLabel: typeof EWI_THRESHOLD_LABEL;
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
  readonly stopReport: {
    readonly reason: string | null;
    readonly faultRounds: number;
    readonly reviewerRejectRounds: number;
  };
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
  readonly ewi: ScoredRelayEwi;
  readonly runDir: string;
  readonly tracePath: string;
  readonly verified: VerifiedAttestation | null;
  readonly attestReasons: readonly string[];
  readonly relayPatchActive: boolean;
}

const HOST_EVIDENCE_FAULTS = new Set([
  "attest_mismatch",
  "prerun_layout",
  "usage_missing",
  "relay_restart",
  "docker_daemon_event",
]);

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
  const firstRun = join(options.out, "round1", "runs", DEV_TASK.id, `seed${seeds[0]}`, "candidate");
  if (existsSync(join(firstRun, "result.json"))) throw new Error("run dir already exists");
  const attestKey = loadAttestKey(options.attestKeyFile);
  const roles = options.roles ?? (options.mode === "dry-run" ? stubOptRoles(attestKey) : undefined);
  if (!roles) throw new Error("execute mode needs roles");
  assertAttestRoot(options.attestRoot, options.out);
  assertKeyOutside(options.attestKeyFile, [options.out]);
  const executor = options.executor ?? executorFor(options, env, attestKey);
  const now = options.now ?? (() => new Date());
  const scoreHost = {
    now: () => now().getTime() / 1000,
    watcher: options.resultWatcher ?? absentResultWatcher(),
  };
  mkdirSync(options.out, { recursive: true });
  writeJson(join(options.out, "pre-round1.json"), signPreRound1(attestKey, { tools: ["read"] }, { tools: ["read"] }));

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
  let stopReason: string | null = null;
  let faultRounds = 0;
  let reviewerRejectRounds = 0;
  let consecutiveNoAccept = 0;
  let realRunWallS = 0;
  let readOnlyWallS = 0;
  const loopCap = (startedRounds: number) => capHit({
    startedRounds,
    readOnlyTokens: options.readOnlyTokens?.() ?? 0,
    readOnlyWallS: options.readOnlyWallS?.() ?? readOnlyWallS,
    realRunWallS,
  });

  for (let round = 1; round <= rounds; round += 1) {
    if (existsSync(join(options.out, "STOP"))) {
      stopReason = "stop_file";
      break;
    }
    if (options.antiForgery?.() === false) {
      stopReason = "anti_forgery";
      break;
    }
    if (consecutiveNoAccept >= 3) {
      stopReason = "no_accept";
      break;
    }
    const opened = loopCap(round - 1);
    if (opened) {
      stopReason = opened;
      break;
    }
    const started = now();
    const roleMs = started.getTime();
    const gapSpawn = prepareRole(options.out, round, "gap-finder", options.piBin, [
      ...traceHints.map((hint) => hint.file),
      ...(previousReviewSession ? [previousReviewSession] : []),
    ]);
    const gapInput: GapCall = {
      round,
      traces: traceHints,
      previousReview,
      previousReviewSession,
      sessionPath: gapSpawn.sessionPath,
      spawn: gapSpawn,
    };
    assertNoHeldOutLeak(gapInput, "gap input");
    writeJson(join(options.out, `round${round}`, "gap-input.json"), gapInput);
    const gap = await roles.gap(gapInput);
    const gapCaptured = captureSession(options.out, round, "gap-finder", gapSpawn.sessionPath, attestKey);
    const gapLog = join(options.out, `round${round}`, "relay", "gap-finder.jsonl");
    const gapCitedTrace = traceHints.length > 0 && traceHints.every((hint) => relayCited(gapLog, hint.file, hint.sha256));
    if (round > 1 && previousReviewSession && previousReviewSha) {
      const fed = relayCited(gapLog, previousReviewSession, previousReviewSha);
      const prior = JSON.parse(readFileSync(join(options.out, `round${round - 1}`, "closure.json"), "utf8")) as ClosureRecord;
      writeClosure(options.out, round - 1, { ...prior, reviewFedForward: fed });
    }
    const innovatorSpawn = prepareRole(options.out, round, "innovator", options.piBin, []);
    const innovateInput: InnovateCall = {
      round,
      knob: gap.knob,
      gapSummary: gap.summary,
      triedSummaries: [...tried],
      control,
      sessionPath: innovatorSpawn.sessionPath,
      spawn: innovatorSpawn,
    };
    assertNoHeldOutLeak(innovateInput, "innovator input");
    writeJson(join(options.out, `round${round}`, "innovator-input.json"), innovateInput);
    const proposed = await roles.innovate(innovateInput);
    captureSession(options.out, round, "innovator", innovatorSpawn.sessionPath, attestKey);

    readOnlyWallS += Math.max(0, (now().getTime() - roleMs) / 1000);
    if (tried.includes(proposed.summary)) {
      consecutiveNoAccept += 1;
      const note = "duplicate summary";
      const reviewSpawn = prepareRole(options.out, round, "reviewer-gate", options.piBin, []);
      hostWriteSession(reviewSpawn, sessionLines("reviewer-gate", note), attestKey);
      const reviewSha = captureSession(options.out, round, "reviewer-gate", reviewSpawn.sessionPath, attestKey)?.sha256 ?? null;
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
      previousReviewSession = reviewSpawn.sessionPath;
      previousReviewSha = reviewSha;
      const afterDuplicate = loopCap(round - 1);
      if (afterDuplicate) {
        stopReason = afterDuplicate;
        break;
      }
      continue;
    }
    const afterRoles = loopCap(round - 1);
    if (afterRoles) {
      stopReason = afterRoles;
      writeNotes(options.out, round, started, now(), threshold, null, controlSha);
      roundSummaries.push({ round, accepted: false, duplicate: false, patchHash: null, ewiSeeds: [] });
      break;
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
    let stopBeforeReview = false;
    for (const seed of seeds) {
      const beforeSeed = loopCap(round - 1);
      if (beforeSeed) {
        stopReason = beforeSeed;
        stopBeforeReview = true;
        break;
      }
      const seedMs = now().getTime();
      runs.push(await executeScored(executor, {
        task: DEV_TASK,
        seed,
        arm: "candidate",
        configPath,
        runDir: join(options.out, `round${round}`, "runs", DEV_TASK.id, `seed${seed}`, "candidate"),
        model,
        tokenCap: tokenCap(DEV_TASK),
      }, hostFor(options, attestKey, `round${round}`, DEV_TASK.id, `seed${seed}`, "candidate"), threshold, scoreHost));
      realRunWallS += Math.max(0, (now().getTime() - seedMs) / 1000);
      const afterSeed = loopCap(round);
      if (afterSeed) {
        stopReason = afterSeed;
        stopBeforeReview = true;
        break;
      }
    }
    const activation = activationRecord({
      runs,
      patchHash,
      controlSha,
      candidateSha: sha256File(configPath),
      knob: gap.knob,
      knobValue,
      relayPatchActive: runs.every((run) => run.relayPatchActive),
    });
    writeJson(join(options.out, `round${round}`, "activation.json"), activation);
    const metrics = summarize(runs, threshold);
    writeJson(join(options.out, `round${round}`, "metrics.json"), metrics);
    if (runs.some((run) => run.unscoredReason !== undefined && HOST_EVIDENCE_FAULTS.has(run.unscoredReason))) {
      faultRounds += 1;
    }
    if (stopBeforeReview) {
      writeClosure(options.out, round, {
        round,
        closed: false,
        gapCitedTrace,
        knobMatched,
        patchActive: activation.patchActive,
        reviewFedForward: null,
      });
      writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha);
      roundSummaries.push({
        round,
        accepted: false,
        duplicate: false,
        patchHash,
        ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
      });
      break;
    }

    const reviewSpawn = prepareRole(options.out, round, "reviewer-gate", options.piBin, [diffPath]);
    const reviewInput: ReviewCall = {
      round,
      patchHash,
      summary: proposed.summary,
      knob: gap.knob,
      runs: metrics.runs,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
      sessionPath: reviewSpawn.sessionPath,
      spawn: reviewSpawn,
    };
    assertNoHeldOutLeak(reviewInput, "reviewer input");
    writeJson(join(options.out, `round${round}`, "review-input.json"), reviewInput);
    const verdict = await roles.review(reviewInput);
    const reviewCaptured = captureSession(options.out, round, "reviewer-gate", reviewSpawn.sessionPath, attestKey);
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
    if (!verdict.accept) reviewerRejectRounds += 1;
    if (take) {
      accepted = { round, patchHash, configPath, knob: gap.knob, knobValue };
      consecutiveNoAccept = 0;
    } else {
      consecutiveNoAccept += 1;
    }
    previousReview = { accept: verdict.accept, reason: verdict.reason };
    previousReviewSession = reviewCaptured ? reviewSpawn.sessionPath : null;
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

  const stopReport = { reason: stopReason, faultRounds, reviewerRejectRounds };
  if (!accepted || stopReason) {
    const result: OptLoopResult = {
      model,
      ewiThresholdSec: threshold,
      ewiThresholdLabel: EWI_THRESHOLD_LABEL,
      rounds: roundSummaries,
      accepted,
      finalBlock: null,
      heldOut: null,
      skippedFinal: true,
      stopReport,
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
    }, hostFor(options, attestKey, "final", DEV_TASK.id, `seed${seed}`, "control"), threshold, scoreHost));
    order.push(`X${seed}`);
    finalRuns.push(await executeScored(executor, {
      task: DEV_TASK,
      seed,
      arm: "candidate",
      configPath: accepted.configPath,
      runDir: join(options.out, "final", "runs", DEV_TASK.id, `seed${seed}`, "candidate"),
      model,
      tokenCap: tokenCap(DEV_TASK),
    }, hostFor(options, attestKey, "final", DEV_TASK.id, `seed${seed}`, "candidate"), threshold, scoreHost));
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
      }, hostFor(options, attestKey, "heldout", task.id, `seed${seed}`, "candidate"), threshold, scoreHost));
    }
  }
  const heldOut = {
    calls: heldRuns.length,
    gatewayOnly: HELD_OUT_TASKS.map((task) => task.id),
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
    ewiThresholdLabel: EWI_THRESHOLD_LABEL,
    rounds: roundSummaries,
    accepted,
    finalBlock: { order },
    heldOut: { calls: heldOut.calls, gatewayOnly: heldOut.gatewayOnly },
    skippedFinal: false,
    stopReport,
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
  const model = options.model ?? OPT_MODEL;
  const attestKey = loadAttestKey(options.attestKeyFile);
  assertAttestRoot(options.attestRoot, options.out);
  assertKeyOutside(options.attestKeyFile, [options.out]);
  const runDir = join(options.out, "once", task.id, `seed${seed}`, "candidate");
  const attestDir = join(options.attestRoot, "once", task.id, `seed${seed}`, "candidate");
  if (existsSync(join(runDir, "result.json"))) throw new Error("run dir already exists");
  assertAttestIsolated(attestDir, runDir);
  const runId = hostRunId();
  const nonce = claimNonce(options.attestRoot);
  const relayLogRoot = join(options.attestRoot, "relay-logs");
  const candidateSha = sha256File(options.configPath);
  const controlSha = sha256File(options.controlConfigPath);
  const knobValue = valueAt(JSON.parse(readFileSync(options.configPath, "utf8")) as ConfigFile, options.knob);
  const layoutOk = hostPreRun(runDir, attestDir, options.configPath, options.harnessPath, options.attestKeyFile);
  if (!layoutOk) {
    const activation = {
      seed,
      ...inspectAttestedActivation({
        verified: null,
        rejection: ["prerun_layout"],
        candidateSha,
        controlSha,
        knob: options.knob,
        knobValue,
        relayPatchActive: false,
      }),
    };
    const blocked: OptOnceResult = {
      model,
      seed,
      runDir,
      patchActive: false,
      candidateConfigSha: candidateSha,
      controlConfigSha: controlSha,
      activation,
    };
    writeJson(join(options.out, "once", "activation.json"), blocked);
    return blocked;
  }
  const request: OptRunRequest = {
    task,
    seed,
    arm: "candidate",
    configPath: options.configPath,
    runDir,
    attestDir,
    harnessPath: options.harnessPath,
    runId,
    nonce,
    relayLogRoot,
    model,
    tokenCap: tokenCap(task),
  };
  await options.executor.run(request);
  const verified = verifyHostAttestation({
    attestDir,
    key: attestKey,
    configPath: options.configPath,
    harnessPath: options.harnessPath,
    runDir,
    runId,
    expectedNonce: nonce,
  });
  const relayPatchActive = relayActive(join(relayLogRoot, runId, "relay.jsonl"), candidateSha);
  const activation = {
    seed,
    ...inspectAttestedActivation({
      verified: verified.ok ? verified : null,
      ...(verified.ok ? {} : { rejection: verified.reasons }),
      candidateSha,
      controlSha,
      knob: options.knob,
      knobValue,
      relayPatchActive,
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

/** Dry-run roles. The host writes the session. It does not fabricate a read. */
export function stubOptRoles(key: Buffer): OptRoles {
  return {
    async gap(input) {
      hostWriteSession(input.spawn, sessionLines("gap-finder", "gap"), key);
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
      hostWriteSession(input.spawn, sessionLines("innovator", summary), key);
      return {
        session: { jsonl: "ignored-return\n" },
        summary,
        parts: { "agent-loop": { maxSteps } },
      };
    },
    async review(input) {
      const accept = input.round === 1;
      const reason = accept ? "accept the idle cap" : "reject this candidate";
      hostWriteSession(input.spawn, sessionLines("reviewer-gate", reason), key);
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
  readonly keyFile: string;
  readonly harnessPath: string;
  readonly relayLogRoot: string;
  readonly attestRoot: string;
}

function hostFor(options: OptLoopOptions, key: Buffer, ...parts: string[]): AttestHost {
  return {
    attestDir: join(options.attestRoot, ...parts),
    key,
    keyFile: options.attestKeyFile,
    harnessPath: options.harnessPath,
    relayLogRoot: join(options.attestRoot, "relay-logs"),
    attestRoot: options.attestRoot,
  };
}

async function executeScored(
  executor: OptExecutor,
  request: Omit<OptRunRequest, "attestDir" | "harnessPath">,
  host: AttestHost,
  threshold: number,
  scoreHost: { readonly now: () => number; readonly watcher: ResultWriteWatcher },
): Promise<ScoredRun> {
  resolveEwiIdleScript();
  if (existsSync(join(request.runDir, "result.json"))) throw new Error("run dir already exists");
  assertAttestIsolated(host.attestDir, request.runDir);
  const runId = request.runId && request.runId.trim() !== "" ? request.runId : hostRunId();
  const nonce = claimNonce(host.attestRoot);
  const layoutOk = hostPreRun(request.runDir, host.attestDir, request.configPath, host.harnessPath, host.keyFile);
  if (!layoutOk) return unscoredRun(request, "prerun_layout", false);
  const full: OptRunRequest = {
    ...request,
    attestDir: host.attestDir,
    harnessPath: host.harnessPath,
    runId,
    nonce,
    relayLogRoot: host.relayLogRoot,
  };
  const resultFile = join(request.runDir, "outputs", PREREGISTERED_RESULT_FILE);
  scoreHost.watcher.arm(resultFile);
  const observation = await executor.run(full);
  copyCheckerBeforeSign(request.runDir, host.relayLogRoot, runId);
  const tEnd = scoreHost.now();
  const watch = scoreHost.watcher.snapshot();
  const responseEnds = relayResponseEnds(join(host.relayLogRoot, runId, "relay.jsonl"));
  const verified = verifyHostAttestation({
    attestDir: host.attestDir,
    key: host.key,
    configPath: request.configPath,
    harnessPath: host.harnessPath,
    runDir: request.runDir,
    runId,
    expectedNonce: nonce,
  });
  const rewardFile = readReward(request.runDir);
  let scoreStatus = observation.scoreStatus;
  let reward = scoreStatus === "unscored" ? null : rewardFile.reward;
  let unscoredReason = observation.unscoredReason ?? rewardFile.reason;
  if (!verified.ok) {
    scoreStatus = "unscored";
    reward = null;
    unscoredReason = "attest_mismatch";
  }
  const resultId = resultRunId(request.runDir);
  if (resultId !== undefined && resultId !== runId) {
    scoreStatus = "unscored";
    reward = null;
    unscoredReason = "result_runid_mismatch";
  }
  if (observation.tokens > request.tokenCap) {
    scoreStatus = "unscored";
    reward = null;
    unscoredReason = "token_cap";
  } else if (reward === null) {
    scoreStatus = "unscored";
  }
  const scored = scoreRelayEwi({
    tFirst: watch.tFirst,
    tLastWrite: watch.tLastWrite,
    responseEnds,
    tEnd,
    timedOut: observation.timedOut,
    thresholdSec: threshold,
  });
  let ewi_trace_ref: ScoredRelayEwi["ewi_trace_ref"] = null;
  try {
    const ref = measureRunEwi({
      task: request.task.id,
      seed: String(request.seed),
      timedOut: observation.timedOut,
      tracePath: observation.tracePath,
      outputsDir: observation.outputsDir,
      batchLogPath: observation.batchLogPath,
      runNumber: 1,
    }, threshold);
    ewi_trace_ref = { idleS: ref.idleS, gapMaxS: ref.gapMaxS, postWriteS: ref.postWriteS, ewi: ref.ewi };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("EWI_IDLE_SCRIPT") || message.includes("ewi_idle.py sha")) throw error;
    ewi_trace_ref = null;
  }
  const ewi: ScoredRelayEwi = { ...scored, ewi_trace_ref };
  const mountedSha = sha256File(request.configPath);
  const relayPatchActive = relayActive(join(host.relayLogRoot, runId, "relay.jsonl"), mountedSha);
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
    relayPatchActive,
  };
}

function unscoredRun(
  request: Omit<OptRunRequest, "attestDir" | "harnessPath">,
  reason: string,
  relayPatchActive: boolean,
): ScoredRun {
  return {
    task: request.task.id,
    seed: request.seed,
    arm: request.arm,
    reward: null,
    scoreStatus: "unscored",
    unscoredReason: reason,
    tokens: 0,
    wallS: 0,
    timedOut: false,
    ewi: {
      version: "EWI-relay-v1",
      verdict: "EWI不可判",
      ewi: null,
      idleS: null,
      gapMaxS: null,
      thresholdSec: DEFAULT_EWI_THRESHOLD_SEC,
      thresholdLabel: EWI_THRESHOLD_LABEL,
      ewi_trace_ref: null,
    },
    runDir: request.runDir,
    tracePath: join(request.runDir, "trace.jsonl"),
    verified: null,
    attestReasons: [reason],
    relayPatchActive,
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
  readonly relayPatchActive: boolean;
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
      relayPatchActive: run.relayPatchActive && input.relayPatchActive,
    }),
  }));
  return {
    patchHash: input.patchHash,
    controlConfigSha: input.controlSha,
    candidateConfigSha: input.candidateSha,
    differsFromControl: input.candidateSha !== input.controlSha,
    patchActive: input.relayPatchActive && runs.length > 0 && runs.every((run) => run.active),
    runs,
  };
}

function summarize(runs: readonly ScoredRun[], threshold: number): {
  readonly ewiThresholdSec: number;
  readonly ewiThresholdLabel: typeof EWI_THRESHOLD_LABEL;
  readonly runs: readonly RunView[];
  readonly ewiRuns: readonly RunView[];
  readonly rewardMean: number | null;
  readonly withoutEwi: { readonly count: number; readonly rewardMean: number | null; readonly timedOut: number };
} {
  const views = runs.map(toView);
  const scored = views.filter((run) => run.scoreStatus === "scored" && run.reward !== null);
  const kept = scored.filter((run) => run.ewi === false);
  return {
    ewiThresholdSec: threshold,
    ewiThresholdLabel: EWI_THRESHOLD_LABEL,
    runs: views,
    ewiRuns: views.filter((run) => run.ewi === true),
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
    postWriteS: run.ewi.ewi_trace_ref?.postWriteS ?? null,
    idleS: run.ewi.idleS,
    gapMaxS: run.ewi.gapMaxS,
    ewi: run.ewi.ewi,
    ewiVerdict: run.ewi.verdict,
    referenceIdleS: run.ewi.ewi_trace_ref?.idleS ?? null,
    referenceEwi: run.ewi.ewi_trace_ref?.ewi ?? null,
    ewi_trace_ref: run.ewi.ewi_trace_ref,
  };
}

function relayResponseEnds(logPath: string): number[] | null {
  if (!existsSync(logPath)) return null;
  const ends: number[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let row: { type?: unknown; ts_resp_end?: unknown };
    try {
      row = JSON.parse(line) as { type?: unknown; ts_resp_end?: unknown };
    } catch {
      return null;
    }
    if (row.type !== "done") continue;
    if (typeof row.ts_resp_end !== "number" || !Number.isFinite(row.ts_resp_end)) return null;
    ends.push(row.ts_resp_end);
  }
  return ends;
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

function prepareRole(
  out: string,
  round: number,
  role: RoleSpawnConfig["role"],
  piBin: string | undefined,
  allowedPaths: readonly string[],
): RoleSpawnConfig {
  const cwd = join(out, `round${round}`, "roles", role);
  mkdirSync(cwd, { recursive: true });
  const config = buildRoleSpawn({
    role,
    cwd,
    allowedPaths,
    sessionPath: sessionPath(out, round, role),
    ledgerPath: join(out, `round${round}`, "sessions", "ledger.json"),
  });
  writeJson(join(out, `round${round}`, "sessions", `${role}.spawn.json`), config);
  const argv = rolePiArgv(piBin ?? "pi", config);
  writeJson(join(out, `round${round}`, "sessions", `${role}.argv.json`), argv);
  if (piBin) launchRolePi(piBin, config);
  return config;
}

function captureSession(
  out: string,
  round: number,
  role: string,
  file: string,
  key: Buffer,
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
  const recorded = recordedSessionSha(join(out, `round${round}`, "sessions", "ledger.json"), role, key);
  if (recorded !== sha) return null;
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

/** Remember a one-time nonce. A repeated value is rejected. */
export function claimNonce(attestRoot: string, nonce = randomBytes(16).toString("hex")): string {
  const file = join(attestRoot, "issued-runs.json");
  let nonces: string[] = [];
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { nonces?: unknown };
    if (Array.isArray(parsed.nonces)) nonces = parsed.nonces.filter((item): item is string => typeof item === "string");
  }
  if (nonces.includes(nonce)) throw new Error("nonce already used");
  nonces.push(nonce);
  writeJson(file, { nonces });
  return nonce;
}

function resultRunId(runDir: string): string | undefined {
  const file = join(runDir, "result.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { runId?: unknown };
    return typeof parsed.runId === "string" ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

const PRE_RUN_PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import hooks",
  "mounts = json.loads(sys.argv[3])",
  "layout = hooks.pre_run_layout(sys.argv[2], mounts, mounts)",
  "sealed = hooks.seal_layout(layout, open(sys.argv[4], 'rb').read())",
  "print(json.dumps(sealed))",
].join("\n");

function hostPreRun(runDir: string, attestDir: string, configPath: string, harnessPath: string, keyFile: string): boolean {
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const mounts = JSON.stringify([
    { source: configPath, target: "/opt/config.json" },
    { source: harnessPath, target: "/opt/harness.mjs" },
  ]);
  const proc = spawnSync("python3", ["-c", PRE_RUN_PY, relayDir, runDir, mounts, keyFile], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "pre-run failed").trim());
  const sealed = JSON.parse(proc.stdout) as { ok?: boolean };
  mkdirSync(attestDir, { recursive: true });
  writeFileSync(join(attestDir, "preRunLayout.json"), `${JSON.stringify(sealed, null, 2)}\n`);
  return sealed.ok === true;
}

function relayActive(logPath: string, mountedSha: string): boolean {
  if (!existsSync(logPath)) return true;
  const script = fileURLToPath(new URL("../../relay/harness_relay.py", import.meta.url));
  const proc = spawnSync("python3", [script, "patch-active", "--log", logPath, "--sha", mountedSha], { encoding: "utf8" });
  if (!proc.stdout) return false;
  try {
    const parsed = JSON.parse(proc.stdout) as { active?: unknown };
    return parsed.active === true;
  } catch {
    return false;
  }
}

function relayCited(logPath: string, hostFile: string, sha: string): boolean {
  if (!existsSync(logPath) || !existsSync(hostFile)) return false;
  const script = fileURLToPath(new URL("../../relay/ledger.py", import.meta.url));
  const proc = spawnSync("python3", [script, "read-evidence", "--log", logPath, "--file", hostFile, "--sha", sha], { encoding: "utf8" });
  if (!proc.stdout) return false;
  try {
    const parsed = JSON.parse(proc.stdout) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
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
    `screenshot: round${round}/screenshot.svg`,
    `sessions: round${round}/sessions`,
    "",
  ];
  writeText(join(out, `round${round}`, "screenshot.svg"), `<svg xmlns="http://www.w3.org/2000/svg" data-round="${round}"/>\n`);
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
