import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  assertScoredRelayLog,
  copyCheckerBeforeSign,
  createDryRunExecutor,
  hostRunId,
  tokenCap,
  type OptExecutor,
  type OptRunObservation,
  type OptRunRequest,
  type OptTask,
} from "./opt-executor";
import { EFFECTIVE_KNOBS, isEffectiveKnob, leafKnobPaths } from "./effective-knobs";
import { bindRoleCall, capHit, LOOP_CAPS, rankCandidates, rankingBudget, relayCallUsage, signPreRound1 } from "./loop-driver";
import { evaluateReviewerGates } from "./reviewer-gates";
import {
  buildRoleSpawn,
  hostWriteSession,
  killLiveRolePi,
  launchRolePiAsync,
  outputHitLengthLimit,
  recordLedgerRank,
  recordedSessionSha,
  RoleOutputTruncated,
  roleArgvRecord,
  rolePiArgv,
  type OptRoleName,
  type RoleSpawnConfig,
} from "./role-spawn";

/** Pinned test id. Calls go out through BASE_URL; this package does not pick a host. */
export const OPT_MODEL = "deepseek-v4-1-flash-261017";

/** Innovators per round. The real run is seed 0 of the one candidate left, or of the ranker winner. */
const INNOVATORS_PER_ROUND = 6;

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
  /** Relay data plane for this call. The record path stays on the host. */
  readonly baseUrl: string;
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
  readonly baseUrl: string;
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

export interface CandidateView {
  readonly id: string;
  readonly summary: string;
  readonly changedKeys: number;
}

export interface CriticCall {
  readonly round: number;
  readonly candidates: readonly CandidateView[];
  readonly sessionPath: string;
  readonly spawn: RoleSpawnConfig;
  readonly baseUrl: string;
}

export interface CriticTurn {
  readonly session: RoleSession;
  readonly excluded: readonly string[];
}

export interface RankerCall {
  readonly round: number;
  readonly candidates: readonly CandidateView[];
  readonly excluded: readonly string[];
  readonly sessionPath: string;
  readonly spawn: RoleSpawnConfig;
  readonly baseUrl: string;
}

export interface RankerTurn {
  readonly session: RoleSession;
  readonly winnerId: string;
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
  readonly baseUrl: string;
}

export interface ReviewerTurn {
  readonly session: RoleSession;
  readonly accept: boolean;
  readonly reason: string;
}

export interface OptRoles {
  gap(input: GapCall): Promise<GapTurn>;
  innovate(input: InnovateCall): Promise<InnovatorTurn>;
  critic(input: CriticCall): Promise<CriticTurn>;
  ranker(input: RankerCall): Promise<RankerTurn>;
  review(input: ReviewCall): Promise<ReviewerTurn>;
}

export interface OptLoopOptions {
  readonly out: string;
  /** Ceiling at or below the signed maxRounds. Omitted means that signed cap. */
  readonly rounds?: number;
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
  /** When set on execute, each role is this binary after the relay run is open. Dry-run keeps the stubs. */
  readonly piBin?: string;
  /** Host watcher for the preregistered result file. Absent observation stays undecided. */
  readonly resultWatcher?: ResultWriteWatcher;
  /** Dry-run tests only. Execute mode always sums the relay log. */
  readonly readOnlyTokens?: () => number;
  /** Host read-only wall clock in seconds. Absent means the loop's own timer. */
  readonly readOnlyWallS?: () => number;
  /** False stops the loop before the next call. */
  readonly antiForgery?: () => boolean;
  /** Target task. Required. The loop has no built-in task. */
  readonly task: OptTask;
  /** Round-0 trace path. Required. A missing file is signed as a declared identity. */
  readonly round0TracePath: string;
  /** Round-0 sha256. Required. A present file must match this pin. */
  readonly round0TraceSha: string;
  /** Flip one byte of the host copy after it is signed. */
  readonly round0Tamper?: boolean;
  /**
   * After the roles finish, skip once/docker and still run reviewer-gate.
   * `optimize --execute --stop-before-run` sets this. The live smoke uses that flag.
   */
  readonly stopBeforeRun?: boolean;
  /** Per-role output cap override. Absent roles use `ROLE_OUTPUT_CAPS`, then the documented model max. */
  readonly roleMaxTokens?: Partial<Record<OptRoleName, number>>;
  /** Test seam. Absent waits `ROLE_RETRY_DELAYS_MS`. */
  readonly roleRetrySleep?: (ms: number) => Promise<void>;
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
    /** Visible stop for this round, such as a citation failure or role_failed. */
    readonly reason?: string;
    /** Set when a role exit stopped this round. */
    readonly roleFailure?: RoleFailureInfo;
    /** Innovators that produced no usable candidate. */
    readonly invalidCandidates?: readonly InvalidCandidate[];
    /** Set when this round closed with no candidate to run. */
    readonly noWinner?: string;
    /** Key-count order. Recorded when the ranker ran. It does not pick the winner. */
    readonly codeRank?: CodeRankRecord;
  }[];
  readonly accepted: AcceptedCandidate | null;
  readonly finalBlock: { readonly order: readonly string[] } | null;
  readonly heldOut: { readonly calls: number; readonly gatewayOnly: readonly string[] } | null;
  readonly skippedFinal: boolean;
  readonly stopReport: {
    readonly reason: string | null;
    readonly faultRounds: number;
    readonly reviewerRejectRounds: number;
    /** Set when `reason` is `role_failed`, `no_conclusion`, or `internal_error`. */
    readonly role?: string;
    readonly exitCode?: number | null;
    readonly stderrTail?: string;
    /** One entry for every round that closed with no candidate to run. */
    readonly noWinner?: readonly { readonly round: number; readonly reason: string }[];
  };
}

interface RoleFailureInfo {
  readonly role: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;
}

interface InvalidCandidate {
  readonly id: string;
  readonly role: string;
  readonly reason: "no_output" | "patch_without_config" | "no_conclusion" | "role_failed" | "role_output_truncated" | "cap_hit" | "duplicate" | "invalid: non_effective_key";
  readonly exitCode?: number | null;
  readonly stderrTail?: string;
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
  /** Host run signature. Reviewer input and run-notes both verify this file. */
  readonly runRecordPath?: string;
  /** Set when this run is the configured seed-9 control prereg. Statistics omit it. */
  readonly purpose?: "reconcile";
}

const HOST_EVIDENCE_FAULTS = new Set([
  "attest_mismatch",
  "prerun_layout",
  "usage_missing",
  "relay_restart",
  "docker_daemon_event",
]);

interface CodeRankRecord {
  status: string;
  winner?: string;
  reason?: string;
}

interface ClosureRecord {
  round: number;
  closed: boolean;
  gapCitedTrace: boolean;
  knobMatched: boolean;
  patchActive: boolean;
  reviewFedForward: boolean | null;
  rank?: "walkover";
  /** Why this round stopped, when the stop is a citation failure or a role failure. */
  reason?: string;
  roleFailure?: RoleFailureInfo;
  invalidCandidates?: readonly InvalidCandidate[];
  /** Why this round closed with no candidate to run. */
  noWinner?: string;
  /** Key-count order from `rankCandidates`. Recorded, not a veto. */
  codeRank?: CodeRankRecord;
  /** Host reviewer gates, in order. The LLM reason cannot change this verdict. */
  gates?: readonly { readonly id: "G0" | "G1" | "G2" | "G3"; readonly pass: boolean; readonly code?: string }[];
  rejectCode?: string;
  reviewReason?: string;
}

const RANKING_ROUND_CAP = 3_000_000;

class CapExceeded extends Error {
  constructor() {
    super("cap_hit");
    this.name = "CapExceeded";
  }
}

/** Three launches. The waits before the second and third are 5s and 20s. 60s is the next backoff. */
export const ROLE_ATTEMPTS = 3;
export const ROLE_RETRY_DELAYS_MS = [5_000, 20_000, 60_000] as const;
const STDERR_TAIL = 2_000;

export class RoleFailed extends Error {
  readonly reason = "role_failed";
  constructor(
    readonly role: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
    readonly transient: boolean,
  ) {
    super("role_failed");
    this.name = "RoleFailed";
  }
}

export function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length <= STDERR_TAIL ? trimmed : trimmed.slice(trimmed.length - STDERR_TAIL);
}

/** HTTP 5xx or a network error in the relay log or on stderr. A 429 counts only from a known relay log, and a cap refusal is not transient. */
export function roleFailureIsTransient(logPath: string, stderr: string): { readonly transient: boolean; readonly cap: "readOnlyTokenCap" | "innovatorCap" | null } {
  let transient = /\b(?:500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|upstream network/i.test(stderr);
  let cap: "readOnlyTokenCap" | "innovatorCap" | null = null;
  if (logPath !== "" && existsSync(logPath)) {
    for (const event of readJsonl(logPath)) {
      if (!event || typeof event !== "object") continue;
      const row = event as { type?: unknown; status?: unknown; errClass?: unknown; error?: unknown };
      if (row.type !== "done") continue;
      const err = typeof row.errClass === "string" ? row.errClass : "";
      if (err === "readOnlyTokenCap" || err === "innovatorCap") cap = err;
      const status = typeof row.status === "number" ? row.status : null;
      if (err === "network" || err === "5xx" || row.error === "upstream_network") transient = true;
      if (status !== null && status >= 500) transient = true;
      if (status === 429 && err !== "readOnlyTokenCap" && err !== "innovatorCap") transient = true;
    }
  }
  if (cap) return { transient: false, cap };
  return { transient, cap: null };
}

function requireLoopTask(task: OptTask | undefined): OptTask {
  if (!task || task.id.trim() === "" || task.path.trim() === "" || !Number.isFinite(task.tokenW) || task.tokenW <= 0) {
    throw new Error("loop target task is required");
  }
  if (task.network !== "devii-004-int") throw new Error("task network must be devii-004-int");
  if (task.split !== "dev") throw new Error("loop target split must be dev");
  return task;
}

function requireRound0(path: string | undefined, sha: string | undefined): { readonly path: string; readonly sha: string } {
  if (path === undefined || path.trim() === "") throw new Error("round-0 trace path is required");
  if (sha === undefined || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("round-0 trace sha is required");
  return { path, sha };
}

function round0IsFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Gap, six innovators, critic, ranker, one seed-0 run, reviewer. No model call lives in this function. */
export async function runOptLoop(options: OptLoopOptions): Promise<OptLoopResult> {
  const rounds = Math.min(options.rounds ?? LOOP_CAPS.maxRounds, LOOP_CAPS.maxRounds);
  const threshold = options.ewiThresholdSec ?? DEFAULT_EWI_THRESHOLD_SEC;
  const model = options.model ?? OPT_MODEL;
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
  const task = requireLoopTask(options.task);
  const round0Pin = requireRound0(options.round0TracePath, options.round0TraceSha);
  const env = options.env ?? process.env;
  if (options.mode === "execute" && !env.BASE_URL) throw new Error("execute mode needs BASE_URL");
  const firstRun = join(options.out, "round1", "runs", task.id, "seed0", "candidate");
  if (existsSync(join(firstRun, "result.json"))) throw new Error("run dir already exists");
  const attestKey = loadAttestKey(options.attestKeyFile);
  const roles = options.roles ?? (options.mode === "dry-run" ? stubOptRoles(attestKey) : options.piBin ? piSubagentRoles(options.piBin) : undefined);
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
  const round0Copy = {
    srcPath: round0Pin.path,
    srcSha256: round0Pin.sha,
    ...(round0IsFile(round0Pin.path)
      ? { hostCopyPath: join(options.attestRoot, "private", "round0-trace.jsonl") }
      : {}),
  };
  const preRound1 = signPreRound1(options.attestKeyFile, { tools: ["read"] }, { tools: ["read"] }, round0Copy);
  writeJson(join(options.out, "pre-round1.json"), preRound1);
  const signedRound0 = preRound1.round0Record as { srcPath?: string; srcSha256?: string; hostCopyPath?: string } | undefined;
  let round0: { readonly hostCopyPath: string; readonly srcSha256: string } | null = null;
  if (signedRound0 && typeof signedRound0.hostCopyPath === "string" && signedRound0.hostCopyPath !== "" && typeof signedRound0.srcSha256 === "string") {
    round0 = { hostCopyPath: signedRound0.hostCopyPath, srcSha256: signedRound0.srcSha256 };
    if (options.round0Tamper) {
      const bytes = readFileSync(round0.hostCopyPath);
      const flipped = Buffer.from(bytes);
      flipped[0] = flipped[0] === 0 ? 1 : 0;
      writeFileSync(round0.hostCopyPath, flipped);
    }
  }

  const controlPath = join(options.out, "control", "config.json");
  const controlBytes = options.controlConfigPath ? readFileSync(options.controlConfigPath) : Buffer.from(CONTROL_CONFIG_TEXT);
  writeText(controlPath, controlBytes.toString("utf8"));
  const control = JSON.parse(controlBytes.toString("utf8")) as ConfigFile;
  const controlSha = sha256File(controlPath);
  const loadedControl = loadControlAttests(options.controlAttests, controlPath, attestKey, options.harnessPath);
  let traceHints: TraceHint[] = loadedControl.hints;
  let baselineReward: number | null = loadedControl.reward;

  const tried: string[] = [];
  let accepted: AcceptedCandidate | null = null;
  let previousReview: ReviewNote | null = null;
  let previousReviewSession: string | null = null;
  let previousReviewSha: string | null = null;
  const roundSummaries: OptLoopResult["rounds"][number][] = [];
  let stopReason: string | null = null;
  let failedRole: RoleFailureInfo | undefined;
  let faultRounds = 0;
  const assignStop = (reason: string): void => {
    if (reason === "usage_missing") faultRounds += 1;
    stopReason = reason;
  };
  let reviewerRejectRounds = 0;
  const noWinnerRounds: { round: number; reason: string }[] = [];
  let consecutiveNoAccept = 0;
  let realRunWallS = 0;
  let readOnlyWallS = 0;
  const innovatorCap = typeof preRound1.innovatorCap === "number" ? preRound1.innovatorCap : LOOP_CAPS.innovatorCap;
  const relayRoot = loopRelayRoot(options, env);
  const relayPort = relayListenPort(env);
  const upstreamKeyFile = ensureUpstreamKey(options.attestRoot, options.attestKeyFile, env);
  const relayCtl = new RelayControl(relayRoot, relayPort, relayBindHost(env), relayUpstream(env), options.attestKeyFile, upstreamKeyFile, options.mode);
  activeRelay = relayCtl;
  activeRelayRoot = relayRoot;
  let readOnlyTotal = 0;
  const relayTotal = (): { readonly tokens: number; readonly usageMissing: boolean } => ({ tokens: readOnlyTotal, usageMissing: false });
  const loopCap = (startedRounds: number) => {
    const summed = options.mode === "dry-run" && options.readOnlyTokens
      ? { tokens: options.readOnlyTokens(), usageMissing: false }
      : relayTotal();
    if (summed.usageMissing) return "usage_missing" as const;
    return capHit({
      startedRounds,
      readOnlyTokens: summed.tokens,
      readOnlyWallS: options.readOnlyWallS?.() ?? readOnlyWallS,
      realRunWallS,
    });
  };

  try {
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
      assignStop(opened);
      break;
    }
    if (round0 && sha256(readFileSync(round0.hostCopyPath)) !== round0.srcSha256) {
      stopReason = "anti_forgery";
      break;
    }
    const started = now();
    const roleMs = started.getTime();
    let roundRank: "walkover" | undefined;
    let codeRank: CodeRankRecord | undefined;
    let gapCitedTrace = false;
    const invalidCandidates: InvalidCandidate[] = [];
    const emitClosure = (record: ClosureRecord): void => {
      writeClosure(options.out, round, invalidCandidates.length === 0 ? record : { ...record, invalidCandidates: [...invalidCandidates] });
    };
    const pushRound = (record: OptLoopResult["rounds"][number]): void => {
      roundSummaries.push(invalidCandidates.length === 0 ? record : { ...record, invalidCandidates: [...invalidCandidates] });
    };
    const stopLoop = (reason: string, failure?: RoleFailureInfo, extra?: Partial<ClosureRecord> & { patchHash?: string | null }): void => {
      if (reason === "usage_missing" || reason === "role_output_truncated" || reason === "attest_mismatch" || reason === "relay_close_failed") faultRounds += 1;
      stopReason = reason;
      if ((reason === "role_failed" || reason === "no_conclusion" || reason === "internal_error") && failure) failedRole = failure;
      emitClosure({
        round,
        closed: false,
        gapCitedTrace: extra?.gapCitedTrace ?? gapCitedTrace,
        knobMatched: extra?.knobMatched ?? false,
        patchActive: extra?.patchActive ?? false,
        reviewFedForward: null,
        reason,
        ...(failure ? { roleFailure: failure } : {}),
        ...(extra?.rank ? { rank: extra.rank } : {}),
        ...(extra?.codeRank ? { codeRank: extra.codeRank } : {}),
      });
      writeNotes(options.out, round, started, now(), threshold, extra?.patchHash ?? null, controlSha, null);
      pushRound({
        round,
        accepted: false,
        duplicate: false,
        patchHash: extra?.patchHash ?? null,
        ewiSeeds: [],
        reason,
        ...(failure ? { roleFailure: failure } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
    };
    const attemptRole = async <T>(spec: {
      readonly sessionName: string;
      readonly kind: string;
      readonly continuing: boolean;
      readonly hardCap?: { readonly kind: "innovator" | "ranking"; readonly limit: number; readonly spent: () => number };
      readonly build: (relay: RoleRelay) => { readonly spawn: RoleSpawnConfig; readonly call: () => Promise<T> };
    }): Promise<
      | { readonly status: "ok"; readonly value: T; readonly relay: RoleRelay; readonly report: RelayReport; readonly spawn: RoleSpawnConfig; readonly attemptTokens: number; readonly attemptLogs: readonly string[] }
      | { readonly status: "stop"; readonly reason: string; readonly failure?: RoleFailureInfo }
      | { readonly status: "ranking_cap" }
      | { readonly status: "innovator_failed"; readonly failure: RoleFailureInfo; readonly spawn: RoleSpawnConfig; readonly invalidReason: InvalidCandidate["reason"]; readonly attemptTokens: number }
    > => {
      const attempts: { n: number; runId: string; exitCode: number | null; transient: boolean; stderrTail: string; sessionPath: string }[] = [];
      const attemptLogs: string[] = [];
      let attemptTokens = 0;
      const sleep = options.roleRetrySleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      let lastSpawn: RoleSpawnConfig | null = null;
      const finishInnovator = (error: unknown, info: RoleFailureInfo, reason?: InvalidCandidate["reason"]): { readonly status: "innovator_failed"; readonly failure: RoleFailureInfo; readonly spawn: RoleSpawnConfig; readonly invalidReason: InvalidCandidate["reason"]; readonly attemptTokens: number } => ({
        status: "innovator_failed",
        failure: info,
        spawn: lastSpawn as RoleSpawnConfig,
        invalidReason: reason ?? innovatorInvalidReason(error, lastSpawn?.cwd ?? ""),
        attemptTokens,
      });
      const overHardCap = (logPath: string): boolean => {
        if (!spec.hardCap) return false;
        return attemptTokens + spec.hardCap.spent() + weighedLogTokens(logPath) >= spec.hardCap.limit;
      };
      const capNow = (): { readonly status: "ranking_cap" } | ReturnType<typeof finishInnovator> => {
        if (spec.hardCap?.kind === "ranking") return { status: "ranking_cap" };
        return finishInnovator(new CapExceeded(), { role: spec.sessionName, exitCode: null, stderrTail: "cap_hit" }, "cap_hit");
      };
      for (let n = 1; n <= ROLE_ATTEMPTS; n += 1) {
        if (n > 1) {
          if (spec.hardCap && attemptTokens + spec.hardCap.spent() >= spec.hardCap.limit) return capNow();
          const blocked = loopCap(round - 1);
          if (blocked) return { status: "stop", reason: blocked };
          const wait = ROLE_RETRY_DELAYS_MS[n - 2] ?? ROLE_RETRY_DELAYS_MS[ROLE_RETRY_DELAYS_MS.length - 1] ?? 60_000;
          await sleep(wait);
        }
        const relay = roleRelay(relayRoot, env);
        const built = spec.build(relay);
        lastSpawn = built.spawn;
        await relayRpc({ op: "open", runId: relay.runId, kind: spec.kind, expectedSha: controlSha });
        const note = (exitCode: number | null, transient: boolean, tail: string): void => {
          const kept = preserveAttemptSession(built.spawn.sessionPath, n);
          attempts.push({ n, runId: relay.runId, exitCode, transient, stderrTail: tail, sessionPath: kept });
          writeSpawnAttempts(built.spawn.sessionPath, attempts);
        };
        const countAttempt = (report: RelayReport): void => {
          attemptLogs.push(relay.relayLog);
          attemptTokens += report.tokens;
        };
        const finishClose = async (): Promise<RelayReport | { readonly status: "stop"; readonly reason: "relay_close_failed"; readonly failure: RoleFailureInfo }> => {
          try {
            return await closeRelay(relay.runId);
          } catch (error) {
            const tail = error instanceof Error ? stderrTail(error.message) : "";
            const info: RoleFailureInfo = { role: spec.sessionName, exitCode: null, stderrTail: tail };
            note(null, false, tail);
            return { status: "stop", reason: "relay_close_failed", failure: info };
          }
        };
        try {
          const abort = new AbortController();
          let sawCap = false;
          const pending = built.call();
          const watcher = (async () => {
            while (!abort.signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              if (abort.signal.aborted) return;
              if (overHardCap(relay.relayLog)) {
                sawCap = true;
                killLiveRolePi();
                return;
              }
            }
          })();
          let value: T;
          try {
            value = await Promise.race([
              pending.then((item) => {
                abort.abort();
                return item;
              }),
              watcher.then(() => {
                if (sawCap) throw new CapExceeded();
                throw new Error("watcher ended");
              }),
            ]);
          } catch (error) {
            abort.abort();
            if (!(error instanceof CapExceeded)) throw error;
            const closed = await finishClose();
            if (!isRelayReport(closed)) return closed;
            readOnlyTotal = closed.loopTokens;
            countAttempt(closed);
            note(readSpawnExit(built.spawn.sessionPath), false, "cap_hit");
            if (closed.refused === "readOnlyTokenCap") {
              return { status: "stop", reason: "readOnlyTokenCap", failure: { role: spec.sessionName, exitCode: null, stderrTail: "cap_hit" } };
            }
            return capNow();
          }
          abort.abort();
          const closed = await finishClose();
          if (!isRelayReport(closed)) return closed;
          note(readSpawnExit(built.spawn.sessionPath), false, "");
          readOnlyTotal = closed.loopTokens;
          countAttempt(closed);
          if (closed.refused === "readOnlyTokenCap") {
            return { status: "stop", reason: "readOnlyTokenCap", failure: { role: spec.sessionName, exitCode: null, stderrTail: "" } };
          }
          if (spec.hardCap && (overHardCap("") || (spec.hardCap.kind === "innovator" && closed.refused === "innovatorCap"))) return capNow();
          return { status: "ok", value, relay, report: closed, spawn: built.spawn, attemptTokens, attemptLogs };
        } catch (error) {
          const closed = await finishClose();
          if (!isRelayReport(closed)) return closed;
          readOnlyTotal = closed.loopTokens;
          countAttempt(closed);
          const failure = failureFrom(error, relay.relayLog);
          note(failure.exitCode, failure.transient, failure.stderrTail);
          const info: RoleFailureInfo = { role: spec.sessionName, exitCode: failure.exitCode, stderrTail: failure.stderrTail };
          if (closed.refused === "readOnlyTokenCap" || failure.cap === "readOnlyTokenCap") {
            return { status: "stop", reason: "readOnlyTokenCap", failure: info };
          }
          if (spec.hardCap?.kind === "ranking" && attemptTokens + spec.hardCap.spent() >= spec.hardCap.limit) return { status: "ranking_cap" };
          if (spec.continuing && (closed.refused === "innovatorCap" || failure.cap === "innovatorCap" || (spec.hardCap && attemptTokens + spec.hardCap.spent() >= spec.hardCap.limit))) {
            return finishInnovator(error, info, "cap_hit");
          }
          if (failure.cap) return { status: "stop", reason: failure.cap, failure: info };
          const blocked = loopCap(round - 1);
          if (blocked) return { status: "stop", reason: blocked, failure: info };
          if (closed.fault) return { status: "stop", reason: closed.fault, failure: info };
          if (error instanceof RoleOutputTruncated) {
            if (spec.continuing && lastSpawn) return finishInnovator(error, info);
            return { status: "stop", reason: error.reason, failure: info };
          }
          if (failure.transient && n < ROLE_ATTEMPTS) continue;
          if (spec.continuing && lastSpawn) return finishInnovator(error, info);
          return { status: "stop", reason: roleStopReason(error), failure: info };
        }
      }
      const info: RoleFailureInfo = { role: spec.sessionName, exitCode: null, stderrTail: "" };
      if (spec.continuing && lastSpawn) return finishInnovator(new RoleFailed(spec.sessionName, null, "", false), info);
      return { status: "stop", reason: "role_failed", failure: info };
    };
    try {
    const gapCwd = join(options.out, `round${round}`, "roles", "gap-finder");
    let gapTraces: TraceHint[];
    try {
      gapTraces = stageGapTraces(gapCwd, gapTraceSources(round, round0, traceHints));
    } catch (error) {
      if (!(error instanceof GapTraceShaError) && !(error instanceof GapTracePathError)) throw error;
      stopLoop("anti_forgery");
      break;
    }
    writeJson(join(options.out, `round${round}`, "gap-traces.json"), { traces: gapTraces });
    const gapPrompt = gapTaskPrompt({ round, traces: gapTraces, previousReview });
    const gapRun = await attemptRole({
      sessionName: "gap-finder",
      kind: "role:gap-finder",
      continuing: false,
      build(relay) {
        const spawn = prepareRole(options.out, round, "gap-finder", options.piBin, [
          ...gapTraces.map((hint) => hint.file),
          ...(previousReviewSession ? [previousReviewSession] : []),
        ], relay, gapPrompt, "gap-finder", options.roleMaxTokens?.["gap-finder"]);
        const input: GapCall = {
          round,
          traces: gapTraces,
          previousReview,
          previousReviewSession,
          sessionPath: spawn.sessionPath,
          spawn: roleFacing(spawn),
          baseUrl: relay.baseUrl,
        };
        assertNoHeldOutLeak(input, "gap input");
        writeJson(join(options.out, `round${round}`, "gap-input.json"), input);
        return { spawn, call: () => roles.gap(input) };
      },
    });
    if (gapRun.status !== "ok") {
      if (gapRun.status === "stop") stopLoop(gapRun.reason, gapRun.failure);
      break;
    }
    const gap = gapRun.value;
    const gapRelay = gapRun.relay;
    const gapSpawn = gapRun.spawn;
    const gapReport = gapRun.report;
    const gapFault = gapReport.fault;
    if (gapFault) {
      stopLoop(gapFault);
      break;
    }
    const gapCaptured = captureSession(options.out, round, "gap-finder", gapSpawn.sessionPath, attestKey);
    const gapLog = gapRelay.relayLog;
    gapCitedTrace = gapTraces.length > 0 && gapTraces.every((hint) => relayCited(gapLog, hint.file, hint.sha256, gapSpawn.cwd));
    const round0Copy = gapTraces.find((hint) => basename(hint.file) === "round0-trace.jsonl");
    if (round === 1 && round0 && (!round0Copy || !relayCited(gapLog, round0Copy.file, round0.srcSha256, gapSpawn.cwd))) {
      stopReason = "anti_forgery";
      emitClosure({
        round,
        closed: false,
        gapCitedTrace,
        knobMatched: false,
        patchActive: false,
        reviewFedForward: null,
        reason: "anti_forgery",
      });
      writeNotes(options.out, round, started, now(), threshold, null, controlSha, null);
      pushRound({ round, accepted: false, duplicate: false, patchHash: null, ewiSeeds: [], reason: "anti_forgery" });
      break;
    }
    if (round > 1 && previousReviewSession && previousReviewSha) {
      const fed = relayCited(gapLog, previousReviewSession, previousReviewSha, gapSpawn.cwd);
      const prior = JSON.parse(readFileSync(join(options.out, `round${round - 1}`, "closure.json"), "utf8")) as ClosureRecord;
      writeClosure(options.out, round - 1, { ...prior, reviewFedForward: fed });
    }
    const closeWithoutRun = (note: string, duplicate: boolean): boolean => {
      consecutiveNoAccept += 1;
      const reviewSpawn = prepareRole(options.out, round, "reviewer-gate", options.piBin, [], roleRelay(relayRoot, env), "这一轮没有候选，不评测。", "reviewer-gate", options.roleMaxTokens?.["reviewer-gate"]);
      hostWriteSession(reviewSpawn, sessionLines("reviewer-gate", note), attestKey);
      const reviewSha = captureSession(options.out, round, "reviewer-gate", reviewSpawn.sessionPath, attestKey)?.sha256 ?? null;
      emitClosure({
        round,
        closed: false,
        gapCitedTrace,
        knobMatched: false,
        patchActive: false,
        reviewFedForward: null,
        noWinner: note,
        reason: note,
        ...(roundRank ? { rank: roundRank } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
      writeNotes(options.out, round, started, now(), threshold, null, controlSha);
      pushRound({
        round,
        accepted: false,
        duplicate,
        patchHash: null,
        ewiSeeds: [],
        noWinner: note,
        ...(codeRank ? { codeRank } : {}),
      });
      noWinnerRounds.push({ round, reason: note });
      previousReview = { accept: false, reason: note };
      previousReviewSession = reviewSpawn.sessionPath;
      previousReviewSha = reviewSha;
      const afterSkip = loopCap(round - 1);
      if (afterSkip) assignStop(afterSkip);
      return afterSkip !== null;
    };

    const seen = new Set(tried);
    const proposals: { id: string; slot: number; summary: string; changedKeys: number; parts: InnovatorTurn["parts"] }[] = [];
    const capExcluded: string[] = [];
    let innovatorHalted = false;
    for (let slot = 0; slot < INNOVATORS_PER_ROUND; slot += 1) {
      const sessionName = `innovator-${slot}`;
      const innovatePrompt = innovatorTaskPrompt({
        round,
        knob: gap.knob,
        gapSummary: gap.summary,
        triedSummaries: [...tried],
        control,
      });
      const innovatorRun = await attemptRole({
        sessionName,
        kind: "role:innovator",
        continuing: true,
        hardCap: { kind: "innovator", limit: innovatorCap, spent: () => 0 },
        build(relay) {
          const spawn = prepareRole(options.out, round, "innovator", options.piBin, [], relay, innovatePrompt, sessionName, options.roleMaxTokens?.innovator);
          writeJson(join(spawn.cwd, "effective-knobs.json"), { knobs: EFFECTIVE_KNOBS });
          const input: InnovateCall = {
            round,
            knob: gap.knob,
            gapSummary: gap.summary,
            triedSummaries: [...tried],
            control,
            sessionPath: spawn.sessionPath,
            spawn: roleFacing(spawn),
            baseUrl: relay.baseUrl,
          };
          assertNoHeldOutLeak(input, "innovator input");
          writeJson(join(options.out, `round${round}`, `${sessionName}-input.json`), input);
          return { spawn, call: () => roles.innovate(input) };
        },
      });
      if (innovatorRun.status === "stop") {
        stopLoop(innovatorRun.reason, innovatorRun.failure);
        innovatorHalted = true;
        break;
      }
      if (innovatorRun.status === "innovator_failed") {
        invalidCandidates.push({
          id: `c${slot}`,
          role: sessionName,
          reason: innovatorRun.invalidReason,
          exitCode: innovatorRun.failure.exitCode,
          stderrTail: innovatorRun.failure.stderrTail,
        });
        continue;
      }
      if (innovatorRun.status === "ranking_cap") continue;
      const turn = innovatorRun.value;
      const innovatorSpawn = innovatorRun.spawn;
      const innovatorReport = innovatorRun.report;
      captureSession(options.out, round, "innovator", innovatorSpawn.sessionPath, attestKey);
      if (innovatorReport.fault) {
        stopLoop(innovatorReport.fault);
        innovatorHalted = true;
        break;
      }
      if (innovatorReport.refused === "readOnlyTokenCap") {
        stopLoop("readOnlyTokenCap");
        innovatorHalted = true;
        break;
      }
      if (innovatorReport.usageMissing) {
        stopLoop("usage_missing");
        innovatorHalted = true;
        break;
      }
      readOnlyTotal = innovatorReport.loopTokens;
      const opened = loopCap(round - 1);
      if (opened) {
        stopLoop(opened);
        innovatorHalted = true;
        break;
      }
      if (innovatorReport.refused === "innovatorCap" || innovatorRun.attemptTokens >= innovatorCap) {
        invalidCandidates.push({ id: `c${slot}`, role: sessionName, reason: "cap_hit" });
        continue;
      }
      const artifact = innovatorArtifactIssue(innovatorSpawn.cwd, turn);
      if (artifact) {
        invalidCandidates.push({ id: `c${slot}`, role: sessionName, reason: artifact });
        continue;
      }
      if (leafKnobPaths(turn.parts).some((path) => !isEffectiveKnob(path))) {
        invalidCandidates.push({ id: `c${slot}`, role: sessionName, reason: "invalid: non_effective_key" });
        continue;
      }
      if (seen.has(turn.summary)) {
        invalidCandidates.push({ id: `c${slot}`, role: sessionName, reason: "duplicate" });
        continue;
      }
      seen.add(turn.summary);
      tried.push(turn.summary);
      proposals.push({ id: `c${slot}`, slot, summary: turn.summary, changedKeys: leafCount(turn.parts), parts: turn.parts });
    }
    readOnlyWallS += Math.max(0, (now().getTime() - roleMs) / 1000);
    if (innovatorHalted) break;
    if (stopReason === "role_output_truncated") break;
    if (proposals.length === 0) {
      const onlyDuplicates = invalidCandidates.length > 0 && invalidCandidates.every((item) => item.reason === "duplicate");
      const note = invalidCandidates.length === 0 || onlyDuplicates ? "duplicate summary" : "no_winner";
      if (closeWithoutRun(note, invalidCandidates.length === 0 || onlyDuplicates)) break;
      continue;
    }

    const listed = proposals.map((item) => ({ id: item.id, summary: item.summary, changedKeys: item.changedKeys }));
    const criticPrompt = criticTaskPrompt({ round, candidates: listed });
    const criticRun = await attemptRole({
      sessionName: "critic",
      kind: "role:critic",
      continuing: false,
      hardCap: { kind: "ranking", limit: RANKING_ROUND_CAP, spent: () => 0 },
      build(relay) {
        const spawn = prepareRole(options.out, round, "critic", options.piBin, [], relay, criticPrompt, "critic", options.roleMaxTokens?.critic);
        const input: CriticCall = {
          round,
          candidates: listed,
          sessionPath: spawn.sessionPath,
          spawn: roleFacing(spawn),
          baseUrl: relay.baseUrl,
        };
        assertNoHeldOutLeak(input, "critic input");
        writeJson(join(options.out, `round${round}`, "critic-input.json"), input);
        return { spawn, call: () => roles.critic(input) };
      },
    });
    if (criticRun.status === "ranking_cap") {
      if (closeWithoutRun("no_winner:cap_hit", false)) break;
      continue;
    }
    if (criticRun.status !== "ok") {
      if (criticRun.status === "stop") stopLoop(criticRun.reason, criticRun.failure);
      break;
    }
    const criticTurn = criticRun.value;
    const criticRelay = criticRun.relay;
    const criticSpawn = criticRun.spawn;
    const criticReport = criticRun.report;
    captureSession(options.out, round, "critic", criticSpawn.sessionPath, attestKey);
    if (criticReport.fault) {
      stopLoop(criticReport.fault);
      break;
    }
    if (criticReport.refused === "readOnlyTokenCap") {
      stopLoop("readOnlyTokenCap");
      break;
    }
    if (criticReport.usageMissing) {
      stopLoop("usage_missing");
      break;
    }
    readOnlyTotal = criticReport.loopTokens;
    const afterCritic = loopCap(round - 1);
    if (afterCritic) {
      stopLoop(afterCritic);
      break;
    }

    const excluded = [...new Set([...criticTurn.excluded, ...capExcluded])];
    const remaining = proposals.filter((item) => !excluded.includes(item.id));
    let winner: (typeof proposals)[number] | undefined;
    if (remaining.length === 0) {
      if (closeWithoutRun("no_winner", false)) break;
      continue;
    }
    if (remaining.length === 1) {
      const budget = rankingBudget(roleAttemptEvents(criticRun.attemptLogs, "critic", round));
      if (budget.capHit) {
        if (closeWithoutRun(budget.reason ?? "no_winner:cap_hit", false)) break;
        continue;
      }
      const criticBound = bindConclusion("critic", criticRelay, { excluded: criticTurn.excluded });
      if (!criticBound) {
        if (closeWithoutRun("no_winner", false)) break;
        continue;
      }
      winner = remaining[0];
      roundRank = "walkover";
      recordLedgerRank(join(options.out, `round${round}`, "sessions", "ledger.json"), "walkover");
    } else {
      const rankerPrompt = rankerTaskPrompt({ round, candidates: listed, excluded });
      const rankerRun = await attemptRole({
        sessionName: "ranker",
        kind: "role:ranker",
        continuing: false,
        hardCap: { kind: "ranking", limit: RANKING_ROUND_CAP, spent: () => criticRun.attemptTokens },
        build(relay) {
          const spawn = prepareRole(options.out, round, "ranker", options.piBin, [], relay, rankerPrompt, "ranker", options.roleMaxTokens?.ranker);
          const input: RankerCall = {
            round,
            candidates: listed,
            excluded,
            sessionPath: spawn.sessionPath,
            spawn: roleFacing(spawn),
            baseUrl: relay.baseUrl,
          };
          assertNoHeldOutLeak(input, "ranker input");
          writeJson(join(options.out, `round${round}`, "ranker-input.json"), input);
          return { spawn, call: () => roles.ranker(input) };
        },
      });
      if (rankerRun.status === "ranking_cap") {
        if (closeWithoutRun("no_winner:cap_hit", false)) break;
        continue;
      }
      if (rankerRun.status !== "ok") {
        if (rankerRun.status === "stop") stopLoop(rankerRun.reason, rankerRun.failure);
        break;
      }
      const rankerTurn = rankerRun.value;
      const rankerRelay = rankerRun.relay;
      const rankerSpawn = rankerRun.spawn;
      const rankerReport = rankerRun.report;
      captureSession(options.out, round, "ranker", rankerSpawn.sessionPath, attestKey);
      if (rankerReport.fault) {
        stopLoop(rankerReport.fault);
        break;
      }
      if (rankerReport.refused === "readOnlyTokenCap") {
        stopLoop("readOnlyTokenCap");
        break;
      }
      if (rankerReport.usageMissing) {
        stopLoop("usage_missing");
        break;
      }
      readOnlyTotal = rankerReport.loopTokens;
      const budget = rankingBudget([
        ...roleAttemptEvents(criticRun.attemptLogs, "critic", round),
        ...roleAttemptEvents(rankerRun.attemptLogs, "ranker", round),
      ]);
      if (budget.capHit) {
        if (closeWithoutRun(budget.reason ?? "no_winner:cap_hit", false)) break;
        continue;
      }
      const criticBound = bindConclusion("critic", criticRelay, { excluded: criticTurn.excluded });
      const rankerBound = bindConclusion("ranker", rankerRelay, { winnerId: rankerTurn.winnerId });
      const ranked = rankCandidates(listed.map((item) => ({ id: item.id, changedKeys: item.changedKeys })), excluded);
      codeRank = {
        status: ranked.status,
        ...(typeof ranked.winner === "string" ? { winner: ranked.winner } : {}),
        ...(typeof ranked.reason === "string" ? { reason: ranked.reason } : {}),
      };
      writeJson(join(options.out, `round${round}`, "ranking.json"), {
        codeWinner: ranked.winner ?? null,
        codeStatus: ranked.status,
        rankerWinnerId: rankerTurn.winnerId,
      });
      const named = rankerTurn.winnerId;
      const listedIds = proposals.map((item) => item.id);
      if (!criticBound || !rankerBound) {
        if (closeWithoutRun("no_winner", false)) break;
        continue;
      }
      if (named === "" || !listedIds.includes(named) || excluded.includes(named)) {
        if (closeWithoutRun("no_winner:ranker_invalid", false)) break;
        continue;
      }
      winner = proposals.find((item) => item.id === named);
      if (!winner) {
        if (closeWithoutRun("no_winner:ranker_invalid", false)) break;
        continue;
      }
    }
    if (!winner) continue;
    const proposed = { summary: winner.summary, parts: winner.parts };
    const afterRoles = loopCap(round - 1);
    if (afterRoles) {
      stopLoop(afterRoles);
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

    const runs: ScoredRun[] = [];
    let stopBeforeReview = false;
    const seed = 0;
    const beforeSeed = options.stopBeforeRun ? null : loopCap(round - 1);
    if (options.stopBeforeRun) {
      // Reviewer still runs below. once/docker does not.
    } else if (beforeSeed) {
      assignStop(beforeSeed);
      stopBeforeReview = true;
    } else {
      const seedMs = now().getTime();
      runs.push(await executeScored(executor, {
        task,
        seed,
        arm: "candidate",
        configPath,
        runDir: join(options.out, `round${round}`, "runs", task.id, `seed${seed}`, "candidate"),
        model,
        tokenCap: tokenCap(task),
      }, hostFor(options, attestKey, `round${round}`, task.id, `seed${seed}`, "candidate"), threshold, scoreHost));
      realRunWallS += Math.max(0, (now().getTime() - seedMs) / 1000);
      if (runs[runs.length - 1]?.unscoredReason === "attest_mismatch") {
        stopReason = "anti_forgery";
        stopBeforeReview = true;
      } else {
        const afterSeed = loopCap(round);
        if (afterSeed) {
          assignStop(afterSeed);
          stopBeforeReview = true;
        }
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
      writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha, runs[0]?.reward ?? null);
      if (!displayedRewardOk(options.attestKeyFile, runs[0], join(options.out, `round${round}`, "run-notes.md"))) {
        stopReason = "anti_forgery";
      }
      emitClosure({
        round,
        closed: false,
        gapCitedTrace,
        knobMatched,
        patchActive: activation.patchActive,
        reviewFedForward: null,
        ...(stopReason ? { reason: stopReason } : {}),
        ...(roundRank ? { rank: roundRank } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
      pushRound({
        round,
        accepted: false,
        duplicate: false,
        patchHash,
        ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
        ...(stopReason ? { reason: stopReason } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
      break;
    }

    if (runs.some((run) => run.runRecordPath !== undefined && !storedRecordOk(options.attestKeyFile, run))) {
      stopReason = "anti_forgery";
      emitClosure({
        round,
        closed: false,
        gapCitedTrace,
        knobMatched,
        patchActive: activation.patchActive,
        reviewFedForward: null,
        reason: "anti_forgery",
        ...(roundRank ? { rank: roundRank } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
      writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha, runs[0]?.reward ?? null);
      if (!displayedRewardOk(options.attestKeyFile, runs[0], join(options.out, `round${round}`, "run-notes.md"))) {
        stopReason = "anti_forgery";
      }
      pushRound({
        round,
        accepted: false,
        duplicate: false,
        patchHash,
        ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
        reason: "anti_forgery",
        ...(codeRank ? { codeRank } : {}),
      });
      break;
    }
    const reviewPrompt = reviewerTaskPrompt({
      round,
      patchHash,
      summary: proposed.summary,
      knob: gap.knob,
      runs: metrics.runs,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
    });
    const reviewRun = await attemptRole({
      sessionName: "reviewer-gate",
      kind: "role:reviewer",
      continuing: false,
      build(relay) {
        const spawn = prepareRole(options.out, round, "reviewer-gate", options.piBin, [diffPath], relay, reviewPrompt, "reviewer-gate", options.roleMaxTokens?.["reviewer-gate"]);
        const input: ReviewCall = {
          round,
          patchHash,
          summary: proposed.summary,
          knob: gap.knob,
          runs: metrics.runs,
          ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
          sessionPath: spawn.sessionPath,
          spawn: roleFacing(spawn),
          baseUrl: relay.baseUrl,
        };
        assertNoHeldOutLeak(input, "reviewer input");
        writeJson(join(options.out, `round${round}`, "review-input.json"), input);
        return { spawn, call: () => roles.review(input) };
      },
    });
    if (reviewRun.status !== "ok") {
      if (reviewRun.status === "stop") {
        stopLoop(reviewRun.reason, reviewRun.failure, { gapCitedTrace, knobMatched, patchActive: activation.patchActive, patchHash });
      }
      break;
    }
    const verdict = reviewRun.value;
    const reviewSpawn = reviewRun.spawn;
    const reviewReport = reviewRun.report;
    const reviewGate = reviewReport.fault;
    const reviewCaptured = captureSession(options.out, round, "reviewer-gate", reviewSpawn.sessionPath, attestKey);
    emitClosure({
      round,
      closed: false,
      gapCitedTrace,
      knobMatched,
      patchActive: activation.patchActive,
      reviewFedForward: null,
      ...(roundRank ? { rank: roundRank } : {}),
      ...(codeRank ? { codeRank } : {}),
    });
    writeNotes(options.out, round, started, now(), threshold, patchHash, controlSha, runs[0]?.reward ?? null);
    const sealReview = (reason: string, extra?: Partial<ClosureRecord>): void => {
      if (reason === "usage_missing" || reason === "attest_mismatch" || reason === "role_output_truncated" || reason === "relay_close_failed") faultRounds += 1;
      stopReason = reason;
      emitClosure({
        round,
        closed: false,
        gapCitedTrace,
        knobMatched,
        patchActive: activation.patchActive,
        reviewFedForward: null,
        reason,
        ...(extra ?? {}),
        ...(roundRank ? { rank: roundRank } : {}),
        ...(codeRank ? { codeRank } : {}),
      });
      pushRound({
        round,
        accepted: false,
        duplicate: false,
        patchHash,
        ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
        reason,
        ...(codeRank ? { codeRank } : {}),
      });
    };
    if (reviewGate) {
      sealReview(reviewGate);
      break;
    }
    if (reviewReport.usageMissing) {
      sealReview("usage_missing");
      break;
    }
    if (options.stopBeforeRun) {
      previousReview = { accept: false, reason: verdict.reason };
      previousReviewSession = reviewCaptured ? reviewSpawn.sessionPath : null;
      previousReviewSha = reviewCaptured?.sha256 ?? null;
      pushRound({
        round,
        accepted: false,
        duplicate: false,
        patchHash,
        ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
        ...(codeRank ? { codeRank } : {}),
      });
      break;
    }
    const notesPath = join(options.out, `round${round}`, "run-notes.md");
    const seeded = runs[0];
    const edges = readRunEdges(seeded?.verified?.tracePath ?? seeded?.tracePath ?? "");
    const changed = changedLeaves(control, candidate);
    const hostVerdict = evaluateReviewerGates({
      evidenceOk: runEvidenceOk(runs, options.attestKeyFile, notesPath),
      gapCitedPrevious: gapCitedTrace,
      knobPaths: gap.knob.trim() === "" ? [] : [gap.knob],
      patchPaths: changed.map((leaf) => leaf.path),
      changed,
      effective: edges.effective,
      runEnd: edges.runEnd,
      scored: seeded?.scoreStatus === "scored",
      timedOut: seeded?.timedOut === true,
      reward: seeded?.reward ?? null,
      baselineReward,
    });
    emitClosure({
      round,
      closed: false,
      gapCitedTrace,
      knobMatched,
      patchActive: activation.patchActive,
      reviewFedForward: null,
      gates: hostVerdict.gates,
      reviewReason: verdict.reason,
      ...(hostVerdict.rejectCode ? { rejectCode: hostVerdict.rejectCode } : {}),
      ...(roundRank ? { rank: roundRank } : {}),
      ...(codeRank ? { codeRank } : {}),
    });
    if (hostVerdict.verdict === "anti_forgery") {
      sealReview("anti_forgery", { gates: hostVerdict.gates, reviewReason: verdict.reason });
      break;
    }
    const take = hostVerdict.verdict === "accept";
    if (!take) reviewerRejectRounds += 1;
    if (take) {
      accepted = { round, patchHash, configPath, knob: gap.knob, knobValue };
      consecutiveNoAccept = 0;
      if (seeded?.reward !== null && seeded?.reward !== undefined) baselineReward = seeded.reward;
    } else {
      consecutiveNoAccept += 1;
    }
    previousReview = { accept: take, reason: verdict.reason };
    previousReviewSession = reviewCaptured ? reviewSpawn.sessionPath : null;
    previousReviewSha = reviewCaptured?.sha256 ?? null;
    traceHints = runs.flatMap((run) => {
      if (!run.verified?.traceSha || !run.verified.tracePath) return [];
      return [{ file: run.verified.tracePath, line: 1, sha256: run.verified.traceSha }];
    });
    pushRound({
      round,
      accepted: take,
      duplicate: false,
      patchHash,
      ewiSeeds: metrics.ewiRuns.map((run) => run.seed),
      ...(codeRank ? { codeRank } : {}),
    });
    if (options.stopBeforeRun) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopLoop("internal_error", { role: "round", exitCode: null, stderrTail: stderrTail(message) });
      break;
    }
  }

  if (options.stopBeforeRun) assertRankerWinnerReviewed(options.out, relayRoot);

  const result: OptLoopResult = {
    model,
    ewiThresholdSec: threshold,
    ewiThresholdLabel: EWI_THRESHOLD_LABEL,
    rounds: roundSummaries,
    accepted,
    finalBlock: null,
    heldOut: null,
    skippedFinal: true,
    stopReport: {
      reason: stopReason,
      faultRounds,
      reviewerRejectRounds,
      ...((stopReason === "role_failed" || stopReason === "no_conclusion" || stopReason === "internal_error") && failedRole
        ? { role: failedRole.role, exitCode: failedRole.exitCode, stderrTail: failedRole.stderrTail }
        : {}),
      ...(noWinnerRounds.length > 0 ? { noWinner: noWinnerRounds } : {}),
    },
  };
  writeJson(join(options.out, "loop-result.json"), result);
  return result;
  } finally {
    activeRelay = null;
    activeRelayRoot = null;
    await relayCtl.shutdown();
  }
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
  /** Target task. Required. There is no built-in task. */
  readonly task: OptTask;
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
  const task = requireLoopTask(options.task);
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

const IGNORED_SESSION: RoleSession = { jsonl: "ignored-return\n" };

/**
 * Execute roles. Each call runs Pi in print mode after the relay run is open.
 * The task prompt carries this round's inputs. Conclusions come from that run's last done assistant text.
 */
export function piSubagentRoles(piBin: string): OptRoles {
  return {
    async gap(input) {
      const text = await piConclusion(piBin, input.spawn, input.baseUrl, gapTaskPrompt(input));
      const turn = gapFromAssistant(text);
      if (!turn) throw new Error("role gap-finder returned no conclusion");
      return { session: IGNORED_SESSION, ...turn };
    },
    async innovate(input) {
      const text = await piConclusion(piBin, input.spawn, input.baseUrl, innovatorTaskPrompt(input));
      const turn = innovatorFromAssistant(text);
      if (!turn) throw new Error("role innovator returned no conclusion");
      return { session: IGNORED_SESSION, ...turn };
    },
    async critic(input) {
      const text = await piConclusion(piBin, input.spawn, input.baseUrl, criticTaskPrompt(input));
      const excluded = criticFromAssistant(text);
      if (!excluded) throw new Error("role critic returned no conclusion");
      return { session: IGNORED_SESSION, excluded };
    },
    async ranker(input) {
      const text = await piConclusion(piBin, input.spawn, input.baseUrl, rankerTaskPrompt(input));
      const winnerId = rankerFromAssistant(text);
      if (winnerId === null) throw new Error("role ranker returned no conclusion");
      return { session: IGNORED_SESSION, winnerId };
    },
    async review(input) {
      const text = await piConclusion(piBin, input.spawn, input.baseUrl, reviewerTaskPrompt(input));
      const verdict = reviewerFromAssistant(text);
      if (!verdict) throw new Error("role reviewer-gate returned no conclusion");
      return { session: IGNORED_SESSION, ...verdict };
    },
  };
}

function spawnRecordPath(sessionPath: string): string | null {
  if (!sessionPath.endsWith(".jsonl")) return null;
  return `${sessionPath.slice(0, -".jsonl".length)}.spawn.json`;
}

function readSpawnExit(sessionPath: string): number | null {
  const file = spawnRecordPath(sessionPath);
  if (!file || !existsSync(file)) return null;
  const current = JSON.parse(readFileSync(file, "utf8")) as { exitCode?: unknown };
  return typeof current.exitCode === "number" ? current.exitCode : null;
}

function writeSpawnAttempts(
  sessionPath: string,
  attempts: readonly { readonly n: number; readonly runId: string; readonly exitCode: number | null; readonly transient: boolean; readonly stderrTail: string; readonly sessionPath?: string }[],
): void {
  const file = spawnRecordPath(sessionPath);
  if (!file || !existsSync(file)) return;
  const current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeJson(file, { ...current, attempts });
}

function roleStopReason(error: unknown): string {
  if (error instanceof RoleOutputTruncated) return error.reason;
  const message = error instanceof RoleFailed ? error.stderrTail : error instanceof Error ? error.message : "";
  if (/no conclusion/i.test(message)) return "no_conclusion";
  if (error instanceof RoleFailed) return "role_failed";
  return "internal_error";
}

function innovatorInvalidReason(error: unknown, cwd: string): InvalidCandidate["reason"] {
  if (error instanceof RoleOutputTruncated) return "role_output_truncated";
  const message = error instanceof RoleFailed ? error.stderrTail : error instanceof Error ? error.message : "";
  if (/no conclusion/i.test(message)) return "no_conclusion";
  const artifact = innovatorArtifactIssue(cwd, null);
  if (artifact) return artifact;
  if (error instanceof RoleFailed) return "no_output";
  return "role_failed";
}

function roleAttemptEvents(logs: readonly string[], role: string, round: number): unknown[] {
  return logs.flatMap((log) => hostedEvents(log, role, round));
}

function failureFrom(error: unknown, logPath: string): { readonly exitCode: number | null; readonly stderrTail: string; readonly transient: boolean; readonly cap: "readOnlyTokenCap" | "innovatorCap" | null } {
  const raw = error instanceof RoleFailed ? error.stderrTail : error instanceof Error ? error.message : "";
  const exitCode = error instanceof RoleFailed ? error.exitCode : null;
  const judged = roleFailureIsTransient(logPath, raw);
  const transient = judged.cap ? false : judged.transient || (error instanceof RoleFailed && error.transient);
  return { exitCode, stderrTail: stderrTail(raw), transient, cap: judged.cap };
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function innovatorHasConfig(cwd: string): boolean {
  if (regularFile(join(cwd, "config.json"))) return true;
  const dir = join(cwd, "candidates");
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => regularFile(join(dir, name, "config.json")));
}

/** A patch file without a config, or a turn with nothing written, is not a candidate. */
function innovatorArtifactIssue(
  cwd: string,
  turn: { readonly summary: string; readonly parts: Readonly<Record<string, Readonly<Record<string, unknown>>>> } | null,
): "no_output" | "patch_without_config" | null {
  const config = innovatorHasConfig(cwd);
  if (regularFile(join(cwd, "patch.json")) && !config) return "patch_without_config";
  const output = turn !== null && (turn.summary.trim() !== "" || leafCount(turn.parts) > 0);
  if (!output && !config) return "no_output";
  return null;
}

function recordRoleExit(sessionPath: string, status: number | null): void {
  if (!sessionPath.endsWith(".jsonl")) return;
  const spawnPath = `${sessionPath.slice(0, -".jsonl".length)}.spawn.json`;
  if (!existsSync(spawnPath)) return;
  const current = JSON.parse(readFileSync(spawnPath, "utf8")) as Record<string, unknown>;
  writeJson(spawnPath, { ...current, exitCode: status });
}

async function piConclusion(piBin: string, spawn: RoleSpawnConfig, baseUrl: string, prompt: string): Promise<string> {
  const launched = await launchRolePiAsync(piBin, spawn, prompt);
  recordRoleExit(spawn.sessionPath, launched.status);
  const text = lastDoneAssistant(baseUrl);
  if (outputHitLengthLimit(launched.status, launched.stdout, launched.stderr, text)) throw new RoleOutputTruncated(spawn.role);
  if (launched.status !== 0) {
    let logPath = "";
    if (activeRelayRoot) {
      try {
        logPath = join(activeRelayRoot, runIdFromBase(baseUrl), "relay.jsonl");
      } catch {
        logPath = "";
      }
    }
    const judged = roleFailureIsTransient(logPath, launched.stderr);
    throw new RoleFailed(spawn.role, launched.status, stderrTail(launched.stderr), judged.cap ? false : judged.transient);
  }
  if (text === null) throw new RoleFailed(spawn.role, launched.status, "no conclusion", false);
  return text;
}

export class GapTraceShaError extends Error {
  constructor() {
    super("gap trace sha mismatch");
  }
}

export class GapTracePathError extends Error {
  constructor() {
    super("gap trace path");
  }
}

/** Read-only copy under gap-finder's traces/. The notice and the private host path stay out. */
export function stageGapTrace(src: string, dest: string, expectedSha: string): void {
  const name = basename(dest);
  if (basename(dirname(dest)) !== "traces" || name.includes("..") || name.toLowerCase().includes("private")) {
    throw new Error("gap trace name");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(src);
  } catch {
    throw new GapTraceShaError();
  }
  if (sha256(bytes) !== expectedSha) throw new GapTraceShaError();
  mkdirSync(dirname(dest), { recursive: true });
  try {
    if (lstatSync(dest).isSymbolicLink()) throw new GapTracePathError();
  } catch (error) {
    if (error instanceof GapTracePathError) throw error;
  }
  let fd: number;
  try {
    fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch {
    throw new GapTracePathError();
  }
  try {
    writeSync(fd, bytes);
    fchmodSync(fd, 0o444);
  } finally {
    closeSync(fd);
  }
  if (sha256File(dest) !== expectedSha) throw new GapTraceShaError();
}

function gapTraceSources(
  round: number,
  round0: { readonly hostCopyPath: string; readonly srcSha256: string } | null,
  hints: readonly TraceHint[],
): { readonly file: string; readonly sha256: string; readonly name: string }[] {
  const sources: { file: string; sha256: string; name: string }[] = [];
  if (round === 1 && round0) sources.push({ file: round0.hostCopyPath, sha256: round0.srcSha256, name: "round0-trace.jsonl" });
  hints.forEach((hint, index) => {
    const name = round === 1
      ? (hints.length === 1 ? "control-trace.jsonl" : `control-trace-${index}.jsonl`)
      : `trace-${index}.jsonl`;
    sources.push({ file: hint.file, sha256: hint.sha256, name });
  });
  return sources;
}

function stageGapTraces(
  cwd: string,
  sources: readonly { readonly file: string; readonly sha256: string; readonly name: string }[],
): TraceHint[] {
  return sources.map((source) => {
    const dest = join(cwd, "traces", source.name);
    stageGapTrace(source.file, dest, source.sha256);
    return { file: dest, line: 1, sha256: source.sha256 };
  });
}

function gapTaskPrompt(input: { readonly round: number; readonly traces: readonly TraceHint[]; readonly previousReview: ReviewNote | null }): string {
  const traces = input.traces.map((hint) => `${hint.file} sha256=${hint.sha256} line=${hint.line}`).join("\n");
  const review = input.previousReview ? JSON.stringify({ accept: input.previousReview.accept, reason: input.previousReview.reason }) : "无";
  return [
    `第 ${input.round} 轮 gap-finder。`,
    "只读下面列出的 traces/ 文件，归纳一个共同失败模式。",
    traces || "没有附带 trace。",
    `上一轮评语：${review}`,
    "最后一条 assistant 消息只放一个 JSON 对象，字段为 knob、failureClass、summary、citations。",
    "knob 是配置路径。failureClass 只能是 timeout、idle-loop、tool-misuse、context-overflow、skill-not-triggered、format-invalid。",
    "citations 是字符串数组。",
  ].join("\n");
}

function innovatorTaskPrompt(input: { readonly round: number; readonly knob: string; readonly gapSummary: string; readonly triedSummaries: readonly string[]; readonly control: unknown }): string {
  return [
    `第 ${input.round} 轮 innovator。`,
    `旋钮 ${input.knob}。`,
    `缺口：${input.gapSummary}`,
    `已试过：${input.triedSummaries.join(" | ") || "无"}`,
    `control：${JSON.stringify(input.control)}`,
    "最后一条 assistant 消息只放一个 JSON 对象。summary 是字符串。parts 的键是 part 名，值是要改的字段。",
    "part 只能是 agent-loop、context、memory、toolchain、skills、goal。",
    "只能改下面这些有效旋钮。碰了名单以外的键，这一条候选无效，原因是 invalid: non_effective_key。",
    "agent-loop.maxSteps 是 agent_end 步数。goal.maxContinuationTurns 是 continuation turn（pi-goal 的 automatic model response），写进 continuationLimits.automaticTurns，并且就是 run_end.goalContinuationTurns。relay 调用是 trace 里的 assistant_message 和 auto_retry_start，不由这两个上限截断。",
    ...EFFECTIVE_KNOBS,
  ].join("\n");
}

function criticTaskPrompt(input: { readonly round: number; readonly candidates: readonly CandidateView[] }): string {
  const lines = input.candidates.map((item) => `${item.id} changedKeys=${item.changedKeys} ${item.summary}`);
  return [
    `第 ${input.round} 轮 critic。`,
    "只看候选改了什么。",
    lines.join("\n") || "没有候选。",
    "最后一条 assistant 消息只放一个 JSON 对象：excluded 是要排除的候选 id 数组。没有要排除的就用空数组。",
  ].join("\n");
}

function rankerTaskPrompt(input: { readonly round: number; readonly candidates: readonly CandidateView[]; readonly excluded: readonly string[] }): string {
  const lines = input.candidates.map((item) => `${item.id} changedKeys=${item.changedKeys} ${item.summary}`);
  return [
    `第 ${input.round} 轮 ranker。`,
    "每一对比较两次：A 对 B 和 B 对 A 各一次，按总胜场选赢家。平局或无法决定时没有赢家。",
    lines.join("\n") || "没有候选。",
    `已排除：${input.excluded.join(" ") || "无"}`,
    "最后一条 assistant 消息只放一个 JSON 对象：winnerId 是字符串。平局或无法决定时 winnerId 为空字符串。",
  ].join("\n");
}

function reviewerTaskPrompt(input: { readonly round: number; readonly patchHash: string; readonly summary: string; readonly knob: string; readonly runs: readonly RunView[]; readonly ewiSeeds: readonly number[] }): string {
  const runs = input.runs.map((run) => `seed=${run.seed} reward=${run.reward ?? "null"} status=${run.scoreStatus} tokens=${run.tokens}`);
  return [
    `第 ${input.round} 轮 reviewer-gate。`,
    `补丁 ${input.patchHash}。旋钮 ${input.knob}。摘要 ${input.summary}。`,
    runs.join("\n") || "没有运行。",
    `ewiSeeds：${input.ewiSeeds.join(" ") || "无"}`,
    "最后一条 assistant 消息只放一个 JSON 对象：accept 是布尔值，reason 是字符串。",
  ].join("\n");
}

function gapFromAssistant(text: string): { knob: string; failureClass: string; summary: string; citations: string[] } | null {
  let found: { knob: string; failureClass: string; summary: string; citations: string[] } | null = null;
  for (const obj of jsonObjects(text)) {
    if (typeof obj.knob !== "string" || obj.knob === "") continue;
    if (typeof obj.failureClass === "string" && typeof obj.summary === "string") {
      found = {
        knob: obj.knob,
        failureClass: obj.failureClass,
        summary: obj.summary,
        citations: stringList(obj.citations),
      };
      continue;
    }
    const gaps = Array.isArray(obj.gaps) ? obj.gaps : [];
    const first = gaps[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) continue;
    const gap = first as Record<string, unknown>;
    if (typeof gap.failureClass !== "string" || typeof gap.summary !== "string") continue;
    found = {
      knob: obj.knob,
      failureClass: gap.failureClass,
      summary: gap.summary,
      citations: stringList(gap.traceIds),
    };
  }
  return found;
}

function innovatorFromAssistant(text: string): { summary: string; parts: Readonly<Record<string, Readonly<Record<string, unknown>>>> } | null {
  let found: { summary: string; parts: Readonly<Record<string, Readonly<Record<string, unknown>>>> } | null = null;
  for (const obj of jsonObjects(text)) {
    if (typeof obj.summary !== "string" || obj.summary === "") continue;
    const parts = asParts(obj.parts);
    if (parts && Object.keys(parts).length > 0) {
      found = { summary: obj.summary, parts };
      continue;
    }
    if (typeof obj.part !== "string" || obj.part === "") continue;
    const changes = asRecord(obj.changes);
    if (!changes) continue;
    found = { summary: obj.summary, parts: { [obj.part]: changes } };
  }
  return found;
}

function criticFromAssistant(text: string): string[] | null {
  let found: string[] | null = null;
  for (const obj of jsonObjects(text)) {
    if (Array.isArray(obj.excluded) && obj.excluded.every((item) => typeof item === "string")) found = [...obj.excluded];
  }
  return found;
}

function rankerFromAssistant(text: string): string | null {
  let found: string | null = null;
  for (const obj of jsonObjects(text)) {
    if (typeof obj.winnerId === "string") found = obj.winnerId;
  }
  return found;
}

function reviewerFromAssistant(text: string): { accept: boolean; reason: string } | null {
  let found: { accept: boolean; reason: string } | null = null;
  for (const obj of jsonObjects(text)) {
    if (typeof obj.accept === "boolean" && typeof obj.reason === "string") found = { accept: obj.accept, reason: obj.reason };
  }
  return found;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asParts(value: unknown): Record<string, Record<string, unknown>> | null {
  const record = asRecord(value);
  if (!record) return null;
  const parts: Record<string, Record<string, unknown>> = {};
  for (const [key, child] of Object.entries(record)) {
    const section = asRecord(child);
    if (!section) return null;
    parts[key] = section;
  }
  return parts;
}

function jsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1)) as unknown;
          const record = asRecord(parsed);
          if (record) found.push(record);
        } catch {
          // skip a brace pair that is not JSON
        }
        start = -1;
      }
    }
  }
  return found;
}

function lastDoneAssistant(baseUrl: string): string | null {
  if (!activeRelayRoot) return null;
  const runId = runIdFromBase(baseUrl);
  let text: string | null = null;
  for (const event of readJsonl(join(activeRelayRoot, runId, "relay.jsonl"))) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; assistant?: unknown };
    if (row.type === "done" && typeof row.assistant === "string" && row.assistant.trim() !== "") text = row.assistant;
  }
  return text;
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
      await plantStubDone(input.baseUrl, "innovator", input.round, { summary });
      hostWriteSession(input.spawn, sessionLines("innovator", summary), key);
      return {
        session: { jsonl: "ignored-return\n" },
        summary,
        parts: { "agent-loop": { maxSteps } },
      };
    },
    async critic(input) {
      const excluded: string[] = [];
      const body = { excluded };
      await plantStubDone(input.baseUrl, "critic", input.round, body);
      hostWriteSession(input.spawn, sessionLines("critic", "critic"), key);
      return { session: { jsonl: "ignored-return\n" }, excluded };
    },
    async ranker(input) {
      const winnerId = [...input.candidates]
        .filter((item) => !input.excluded.includes(item.id))
        .sort((left, right) => left.changedKeys - right.changedKeys || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]?.id ?? "";
      const body = { winnerId };
      await plantStubDone(input.baseUrl, "ranker", input.round, body);
      hostWriteSession(input.spawn, sessionLines("ranker", winnerId), key);
      return { session: { jsonl: "ignored-return\n" }, winnerId };
    },
    async review(input) {
      const accept = input.round === 1;
      const reason = accept ? "accept the idle cap" : "reject this candidate";
      const body = { accept, reason };
      await plantStubDone(input.baseUrl, "reviewer", input.round, body);
      hostWriteSession(input.spawn, sessionLines("reviewer-gate", reason), key);
      return { session: { jsonl: "ignored-return\n" }, accept, reason };
    },
  };
}

/** Real-run argv. The loop opens the relay run; this process uses `--relay-external` and does not bind. */
export function realRunCommand(): readonly string[] {
  const script = fileURLToPath(new URL("../../relay/devii_docker_v2.py", import.meta.url));
  return [
    "python3", script, "once",
    "--task", "{taskPath}",
    "--seed", "{seed}",
    "--arm", "{arm}",
    "--config", "{config}",
    "--run-dir", "{runDir}",
    "--harness", "{harness}",
    "--run-id", "{runId}",
    "--relay-log", "{relayLog}",
    "--relay-external",
    "--network", "{network}",
    "--model", "{model}",
    "--token-cap", "{tokenCap}",
    "--attest-dir", "{attestDir}",
    "--nonce", "{nonce}",
  ];
}

function executorFor(options: OptLoopOptions, env: NodeJS.ProcessEnv, key: Buffer): OptExecutor {
  if (options.mode === "dry-run") return createDryRunExecutor({ key, harnessPath: options.harnessPath });
  const supplied = options.executorCommand !== undefined && options.executorCommand.length > 0;
  return new CommandOptExecutor({
    command: supplied ? options.executorCommand ?? [] : realRunCommand(),
    ...(supplied ? {} : { name: "once" }),
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
  const scoredRelayRoot = executor.name === "once" && activeRelayRoot ? activeRelayRoot : host.relayLogRoot;
  assertScoredRelayLog(scoredRelayRoot);
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
    relayLogRoot: scoredRelayRoot,
  };
  const resultFile = join(request.runDir, "outputs", PREREGISTERED_RESULT_FILE);
  scoreHost.watcher.arm(resultFile);
  let openedExecutor = false;
  if (executor.name === "once") {
    await relayRpc({ op: "open", runId, kind: "executor", expectedSha: sha256File(request.configPath) });
    openedExecutor = true;
  }
  let observation: OptRunObservation;
  try {
    observation = await executor.run(full);
  } finally {
    if (openedExecutor) await closeRelay(runId);
  }
  copyCheckerBeforeSign(request.runDir, scoredRelayRoot, runId);
  const tEnd = scoreHost.now();
  const watch = scoreHost.watcher.snapshot();
  const responseEnds = relayResponseEnds(join(scoredRelayRoot, runId, "relay.jsonl"));
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
  const checkerDir = join(scoredRelayRoot, runId, "checker");
  let evaluatorNull: string | null = null;
  if (observation.tokens > request.tokenCap) {
    scoreStatus = "unscored";
    reward = null;
    unscoredReason = "token_cap";
  } else if (scoreStatus === "scored") {
    evaluatorNull = readEvaluatorNullScore(request.runDir, checkerDir);
    if (evaluatorNull) {
      scoreStatus = "unscored";
      reward = null;
      unscoredReason = evaluatorNull;
    } else if (reward === null) {
      scoreStatus = "unscored";
    }
  } else if (reward === null) {
    const noted = readEvaluatorNullScore(request.runDir, checkerDir);
    if (noted) {
      evaluatorNull = noted;
      if (!unscoredReason || unscoredReason === "unscored") unscoredReason = noted;
    }
    scoreStatus = "unscored";
  }
  let runRecordPath: string | undefined;
  if (!evaluatorNull && existsSync(join(checkerDir, "reward.txt"))) {
    const signed = signRunRecord(host.keyFile, checkerDir, request.runDir, runId);
    if (!signed) {
      scoreStatus = "unscored";
      reward = null;
      unscoredReason = "attest_mismatch";
    } else {
      runRecordPath = join(scoredRelayRoot, runId, "run-record.json");
      writeFileSync(runRecordPath, `${JSON.stringify(signed)}\n`);
    }
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
  const prereg = request.seed === 9 && request.arm === "control" && scoreStatus === "scored" && reward !== null
    ? reconcilePrereg(request.task.path, request.task.id, request.configPath, request.seed, request.arm)
    : null;
  const mountedSha = sha256File(request.configPath);
  const relayPatchActive = relayActive(join(scoredRelayRoot, runId, "relay.jsonl"), mountedSha);
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
    ...(runRecordPath ? { runRecordPath } : {}),
    ...(prereg?.exclude ? { purpose: "reconcile" as const } : {}),
  };
}

/** Seed-9 control prereg. expectedTask is the loop's required task. An empty task is refused. */
export function reconcilePrereg(
  task: string,
  expectedTask: string,
  configPath: string,
  seed: number,
  arm: string,
  already = false,
): { readonly accepted: boolean; readonly purpose: string | null; readonly exclude: boolean } {
  if (expectedTask.trim() === "") throw new Error("reconcile task");
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const proc = spawnSync("python3", [
    "-c",
    [
      "import hashlib, json, sys",
      "from pathlib import Path",
      "sys.path.insert(0, sys.argv[1])",
      "import hooks",
      "sha = hashlib.sha256(Path(sys.argv[4]).read_bytes()).hexdigest()",
      "print(json.dumps(hooks.reconcile_first_run(task=sys.argv[2], expected_task=sys.argv[3], config_sha=sha, seed=int(sys.argv[5]), arm=sys.argv[6], reconcile=True, already=sys.argv[7] == '1')))",
    ].join("\n"),
    relayDir,
    task,
    expectedTask,
    configPath,
    String(seed),
    arm,
    already ? "1" : "0",
  ], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "reconcile task").trim());
  const parsed = JSON.parse(proc.stdout) as { accepted?: unknown; purpose?: unknown; exclude?: unknown };
  return {
    accepted: parsed.accepted === true,
    purpose: typeof parsed.purpose === "string" ? parsed.purpose : null,
    exclude: parsed.exclude === true,
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

function readEvaluatorNullScore(runDir: string, checkerDir: string): string | null {
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const proc = spawnSync("python3", [
    "-c",
    [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import hooks",
      "print(json.dumps(hooks.null_score_status(sys.argv[2], sys.argv[3])))",
    ].join("\n"),
    relayDir,
    join(runDir, "verifier"),
    checkerDir,
  ], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "null score").trim());
  const parsed = JSON.parse(proc.stdout) as { nullScore?: unknown; unscored_reason?: unknown };
  if (parsed.nullScore !== true) return null;
  return typeof parsed.unscored_reason === "string" && parsed.unscored_reason !== "" ? parsed.unscored_reason : "null score";
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
  const views = runs.filter((run) => run.purpose !== "reconcile").map(toView);
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

interface RoleRelay {
  readonly relayLog: string;
  readonly runId: string;
  readonly seq: number;
  readonly baseUrl: string;
}

function loopRelayRoot(options: OptLoopOptions, env: NodeJS.ProcessEnv): string {
  const configured = env.HARNESS_RELAY_LOG_ROOT;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  if (options.mode === "dry-run") return join(options.attestRoot, "relay-logs");
  return defaultRelayRoot();
}

function defaultRelayRoot(): string {
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const proc = spawnSync("python3", ["-c", "import hooks; print(hooks.DEFAULT_RELAY_ROOT, end='')"], {
    cwd: relayDir,
    encoding: "utf8",
  });
  if (proc.status !== 0 || proc.stdout.trim() === "") throw new Error((proc.stderr || proc.stdout || "relay root").trim());
  return proc.stdout.trim();
}

function relayListenPort(env: NodeJS.ProcessEnv): string {
  return typeof env.HARNESS_RELAY_PORT === "string" && env.HARNESS_RELAY_PORT.trim() !== "" ? env.HARNESS_RELAY_PORT.trim() : "8642";
}

function relayBindHost(env: NodeJS.ProcessEnv): string {
  const configured = env.HARNESS_RELAY_BIND;
  return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : "10.204.0.1";
}

function relayUpstream(env: NodeJS.ProcessEnv): string {
  const configured = env.HARNESS_RELAY_UPSTREAM;
  return typeof configured === "string" ? configured.trim() : "";
}

function roleRelay(root: string, env: NodeJS.ProcessEnv): RoleRelay {
  const runId = hostRunId();
  const port = relayListenPort(env);
  return {
    relayLog: join(root, runId, "relay.jsonl"),
    runId,
    seq: 1,
    baseUrl: `http://${relayBindHost(env)}:${port}/r/${runId}/v1`,
  };
}

function roleFacing(spawn: RoleSpawnConfig): RoleSpawnConfig {
  const { relayLog: _hidden, ...rest } = spawn;
  return rest;
}

function prepareRole(
  out: string,
  round: number,
  role: RoleSpawnConfig["role"],
  piBin: string | undefined,
  allowedPaths: readonly string[],
  relay: RoleRelay,
  prompt: string,
  sessionName: string = role,
  maxTokens?: number,
): RoleSpawnConfig {
  const cwd = join(out, `round${round}`, "roles", sessionName);
  mkdirSync(cwd, { recursive: true });
  const config = buildRoleSpawn({
    role,
    cwd,
    allowedPaths,
    sessionPath: sessionPath(out, round, sessionName),
    ledgerPath: join(out, `round${round}`, "sessions", "ledger.json"),
    relayLog: relay.relayLog,
    baseUrl: relay.baseUrl,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });
  writeJson(join(out, `round${round}`, "sessions", `${sessionName}.spawn.json`), roleFacing(config));
  const argv = rolePiArgv(piBin ?? "pi", config, prompt);
  writeJson(join(out, `round${round}`, "sessions", `${sessionName}.argv.json`), roleArgvRecord(config, argv));
  return config;
}

/**
 * A Pi launch counts only with exit 0 and a done line whose usage weighs to tokens > 0.
 */
export function assertLiveRoleCall(role: string, status: number | null, relayLog: string): void {
  if (status !== 0) throw new Error(`role ${role} pi exited ${status ?? "null"}`);
  if (maxDoneTokens(relayLog) <= 0) throw new Error(`role ${role} made no relay request`);
}

/**
 * When a ranker relay conclusion names a candidate that is still eligible,
 * reviewer-gate must have its own relay done (tokens > 0) and a recorded verdict.
 * An empty, unknown, or excluded winnerId is not a named winner.
 */
function assertRankerWinnerReviewed(out: string, relayRoot: string): void {
  if (!existsSync(out)) return;
  for (const name of readdirSync(out)) {
    if (!/^round\d+$/.test(name)) continue;
    const roundDir = join(out, name);
    const rankerSpawnPath = join(roundDir, "sessions", "ranker.spawn.json");
    if (!existsSync(rankerSpawnPath)) continue;
    const rankerSpawn = JSON.parse(readFileSync(rankerSpawnPath, "utf8")) as { baseUrl?: unknown };
    if (typeof rankerSpawn.baseUrl !== "string") continue;
    const rankerText = lastAssistantText(join(relayRoot, runIdFromBase(rankerSpawn.baseUrl), "relay.jsonl"));
    const winnerId = rankerText === null ? null : rankerFromAssistant(rankerText);
    if (winnerId === null || winnerId === "") continue;
    const inputPath = join(roundDir, "ranker-input.json");
    if (!existsSync(inputPath)) throw new Error("ranker named a winner but reviewer-gate did not run");
    const input = JSON.parse(readFileSync(inputPath, "utf8")) as { candidates?: { id?: unknown }[]; excluded?: unknown };
    const ids = Array.isArray(input.candidates)
      ? input.candidates.flatMap((item) => (typeof item.id === "string" ? [item.id] : []))
      : [];
    const excluded = Array.isArray(input.excluded) ? input.excluded.filter((item): item is string => typeof item === "string") : [];
    if (!ids.includes(winnerId) || excluded.includes(winnerId)) continue;
    const reviewSpawnPath = join(roundDir, "sessions", "reviewer-gate.spawn.json");
    if (!existsSync(reviewSpawnPath)) throw new Error("ranker named a winner but reviewer-gate did not run");
    const reviewSpawn = JSON.parse(readFileSync(reviewSpawnPath, "utf8")) as { baseUrl?: unknown };
    if (typeof reviewSpawn.baseUrl !== "string") throw new Error("ranker named a winner but reviewer-gate did not run");
    const reviewLog = join(relayRoot, runIdFromBase(reviewSpawn.baseUrl), "relay.jsonl");
    const reviewText = lastAssistantText(reviewLog);
    if (maxDoneTokens(reviewLog) <= 0 || reviewText === null || !reviewerFromAssistant(reviewText)) {
      throw new Error("ranker named a winner but reviewer-gate did not run");
    }
  }
}

/**
 * Real round-1 chain through `optimize --execute --stop-before-run`.
 * Citation is the loop's anti_forgery check against the traces/ copies.
 * Stops before once/docker. Opt-in via LOOP_LIVE_SMOKE, PI_BIN, LOOP_LIVE_ROUND0, and LOOP_LIVE_ROUND0_SHA.
 */
export async function runLiveRoleSmoke(options: {
  readonly out: string;
  readonly attestRoot: string;
  readonly attestKeyFile: string;
  readonly piBin: string;
  readonly harnessPath: string;
  readonly controlAttests: readonly string[];
  readonly controlConfigPath: string;
  readonly task: OptTask;
  readonly round0TracePath: string;
  readonly round0TraceSha: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly dockerRuns: number; readonly gapCitedTrace: boolean; readonly rank: "walkover" | null }> {
  const env = options.env ?? process.env;
  if (!env.BASE_URL) throw new Error("execute mode needs BASE_URL");
  if (!existsSync(options.round0TracePath)) throw new Error("live chain round-0 trace is missing");
  const pinned = sha256(readFileSync(options.round0TracePath));
  if (pinned !== options.round0TraceSha) throw new Error("live chain round-0 sha mismatch");
  const saved = applySmokeEnv(env);
  let stderr = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const { main } = await import("../cli");
    const code = await main([
      "optimize",
      "--execute",
      "--stop-before-run",
      "--rounds", "1",
      "--out", options.out,
      "--pi-bin", options.piBin,
      "--attest-root", options.attestRoot,
      "--attest-key-file", options.attestKeyFile,
      "--harness", options.harnessPath,
      "--control-config", options.controlConfigPath,
      ...options.controlAttests.flatMap((dir) => ["--control-attest", dir]),
      "--task", options.task.id,
      "--task-path", options.task.path,
      "--network", options.task.network,
      "--token-w", String(options.task.tokenW),
      "--round0-trace", options.round0TracePath,
      "--round0-sha", options.round0TraceSha,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || "live chain failed");
  } finally {
    process.stderr.write = write;
    restoreSmokeEnv(saved);
  }
  if (existsSync(join(options.out, "round1", "runs"))) throw new Error("docker must not start");
  const loop = JSON.parse(readFileSync(join(options.out, "loop-result.json"), "utf8")) as { stopReport?: { reason?: string | null } };
  if (loop.stopReport?.reason) throw new Error(`live chain stopped: ${loop.stopReport.reason}`);
  const closurePath = join(options.out, "round1", "closure.json");
  if (!existsSync(closurePath)) throw new Error("live chain citation check failed");
  const closure = JSON.parse(readFileSync(closurePath, "utf8")) as { gapCitedTrace?: boolean; rank?: string };
  if (closure.gapCitedTrace !== true) throw new Error("live chain citation check failed");
  const relayRoot = typeof env.HARNESS_RELAY_LOG_ROOT === "string" && env.HARNESS_RELAY_LOG_ROOT.trim() !== ""
    ? env.HARNESS_RELAY_LOG_ROOT.trim()
    : defaultRelayRoot();
  const kinds = relayRoleKinds(relayRoot);
  for (const kind of ["role:gap-finder", "role:critic", "role:reviewer"] as const) {
    if (!kinds.includes(kind)) throw new Error(`role ${kind} made no relay request`);
  }
  if (kinds.filter((kind) => kind === "role:innovator").length !== INNOVATORS_PER_ROUND) {
    throw new Error("role role:innovator made no relay request");
  }
  const rank = closure.rank === "walkover" ? "walkover" as const : null;
  if (rank !== "walkover" && !kinds.includes("role:ranker")) throw new Error("role role:ranker made no relay request");
  if (rank === "walkover" && kinds.includes("role:ranker")) throw new Error("walkover must not call ranker");
  assertRankerWinnerReviewed(options.out, relayRoot);
  return { dockerRuns: 0, gapCitedTrace: true, rank };
}

const SMOKE_ENV_KEYS = [
  "BASE_URL",
  "HARNESS_RELAY_BIND",
  "HARNESS_RELAY_LOG_ROOT",
  "HARNESS_RELAY_PORT",
  "HARNESS_RELAY_UPSTREAM",
  "RELAY_UPSTREAM_KEY_FILE",
  "HARNESS_ATTEST_KEY_FILE",
] as const;

function applySmokeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> | null {
  if (env === process.env) return null;
  const saved: Record<string, string | undefined> = {};
  for (const key of SMOKE_ENV_KEYS) {
    saved[key] = process.env[key];
    const value = env[key];
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
  return saved;
}

function restoreSmokeEnv(saved: Record<string, string | undefined> | null): void {
  if (!saved) return;
  for (const key of SMOKE_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function relayRoleKinds(relayRoot: string): string[] {
  if (!existsSync(relayRoot)) throw new Error("live chain made no relay request");
  const kinds: string[] = [];
  for (const runId of readdirSync(relayRoot)) {
    const log = join(relayRoot, runId, "relay.jsonl");
    if (!existsSync(log)) continue;
    let kind = "";
    for (const event of readJsonl(log)) {
      if (!event || typeof event !== "object") continue;
      const row = event as { type?: unknown; kind?: unknown };
      if (row.type === "open" && typeof row.kind === "string") kind = row.kind;
    }
    if (!kind.startsWith("role:")) continue;
    assertLiveRoleCall(kind, 0, log);
    kinds.push(kind);
  }
  return kinds;
}

function lastAssistantText(log: string): string | null {
  if (!existsSync(log)) return null;
  let text: string | null = null;
  for (const event of readJsonl(log)) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; assistant?: unknown };
    if (row.type === "done" && typeof row.assistant === "string" && row.assistant.trim() !== "") text = row.assistant;
  }
  return text;
}

/** Ledger weight: prompt + completion. A missing cached field is not a counted done. */
function maxDoneTokens(relayLog: string): number {
  if (!existsSync(relayLog)) return 0;
  let best = 0;
  for (const event of readJsonl(relayLog)) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; usage?: unknown };
    if (row.type !== "done") continue;
    const weighed = usageWeight(row.usage);
    if (weighed !== null && weighed > best) best = weighed;
  }
  return best;
}

function usageWeight(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const row = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: unknown;
    prompt_cache_hit_tokens?: unknown;
  };
  let cache: unknown;
  const details = row.prompt_tokens_details;
  if (details && typeof details === "object" && "cached_tokens" in details) {
    cache = (details as { cached_tokens?: unknown }).cached_tokens;
  } else if ("prompt_cache_hit_tokens" in row) {
    cache = row.prompt_cache_hit_tokens;
  } else {
    return null;
  }
  const prompt = row.prompt_tokens;
  const completion = row.completion_tokens;
  if (typeof cache !== "number" || typeof prompt !== "number" || typeof completion !== "number") return null;
  if (!Number.isFinite(cache) || !Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return (prompt - cache) + completion + cache;
}

function bindConclusion(
  role: "critic" | "ranker" | "reviewer",
  call: { readonly relayLog: string; readonly runId: string; readonly seq: number },
  body: unknown,
): boolean {
  if (!existsSync(call.relayLog)) return false;
  return bindRoleCall(role, { seq: call.seq, runId: call.runId, conclusion: body }, readJsonl(call.relayLog)).ok;
}

let activeRelay: RelayControl | null = null;
let activeRelayRoot: string | null = null;

interface RelayReport {
  readonly fault: "usage_missing" | "attest_mismatch" | null;
  readonly tokens: number;
  readonly usageMissing: boolean;
  readonly refused: "readOnlyTokenCap" | "innovatorCap" | null;
  readonly loopTokens: number;
}

function isRelayReport(closed: RelayReport | { readonly status: "stop" }): closed is RelayReport {
  return !("status" in closed);
}

async function closeRelay(runId: string): Promise<RelayReport> {
  const reply = await relayRpc({ op: "close", runId });
  const fault = reply.fault === "usage_missing" || reply.fault === "attest_mismatch" ? reply.fault : null;
  const refused = reply.refused === "readOnlyTokenCap" || reply.refused === "innovatorCap" ? reply.refused : null;
  return {
    fault,
    tokens: typeof reply.tokens === "number" ? reply.tokens : 0,
    usageMissing: reply.usageMissing === true,
    refused,
    loopTokens: typeof reply.loopTokens === "number" ? reply.loopTokens : 0,
  };
}

async function relayRpc(msg: object): Promise<{ ok?: boolean; error?: string; fault?: unknown; tokens?: unknown; usageMissing?: unknown; refused?: unknown; loopTokens?: unknown }> {
  const ctl = activeRelay;
  if (!ctl) throw new Error("relay control is not running");
  const reply = await ctl.request(msg);
  if (reply.ok !== true) throw new Error(reply.error || "relay control failed");
  return reply;
}

function plantStubDone(baseUrl: string, role: string, round: number, body: unknown): Promise<void> {
  return relayPlantRole(baseUrl, role, round, body);
}

/** Dry-run / test record through the live relay, so the line is on the memory chain. */
export async function relayPlantRole(baseUrl: string, role: string, round: number, body: unknown): Promise<void> {
  await relayRpc({
    op: "plant-role",
    runId: runIdFromBase(baseUrl),
    role,
    round,
    seq: 1,
    assistant: JSON.stringify(body),
  });
}

/** Host-side read evidence. The relay appends it; a role edit of the file still mismatches. */
export async function relayPlantRead(baseUrl: string, files: readonly string[]): Promise<void> {
  await relayRpc({ op: "plant-read", runId: runIdFromBase(baseUrl), files });
}

/** Append one JSON row through the relay process. */
export async function relayRecord(baseUrl: string, row: unknown): Promise<void> {
  await relayRpc({ op: "record", runId: runIdFromBase(baseUrl), row });
}

function runIdFromBase(baseUrl: string): string {
  const runId = baseUrl.split("/r/")[1]?.split("/")[0] ?? "";
  if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error("base url has no run id");
  return runId;
}

function ensureUpstreamKey(attestRoot: string, attestKeyFile: string, env: NodeJS.ProcessEnv): string {
  const configured = env.RELAY_UPSTREAM_KEY_FILE;
  if (typeof configured === "string" && configured.trim() !== "" && resolve(configured) !== resolve(attestKeyFile)) return configured.trim();
  const path = join(attestRoot, "upstream.key");
  if (!existsSync(path)) {
    writeFileSync(path, Buffer.from("relay-upstream-key\n"));
    chmodSync(path, 0o600);
  }
  return path;
}

class RelayControl {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: { resolve: (value: { ok?: boolean; error?: string; fault?: unknown; tokens?: unknown; usageMissing?: unknown; refused?: unknown; loopTokens?: unknown }) => void; reject: (err: Error) => void }[] = [];
  private buf = "";
  private stderr = "";
  private dead: Error | null = null;

  constructor(root: string, port: string, bindHost: string, upstreamUrl: string, attestKeyFile: string, upstreamKeyFile: string, mode: "dry-run" | "execute") {
    const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
    const script = fileURLToPath(new URL("../../relay/harness_relay.py", import.meta.url));
    const args = [script, "control", "--log-root", root, "--port", port, "--bind", bindHost, "--mode", mode];
    if (upstreamUrl !== "") args.push("--upstream", upstreamUrl);
    this.child = spawn("python3", args, {
      cwd: relayDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HARNESS_ATTEST_KEY_FILE: attestKeyFile,
        RELAY_UPSTREAM_KEY_FILE: upstreamKeyFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) break;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const waiter = this.queue.shift();
        if (!waiter) continue;
        try {
          waiter.resolve(JSON.parse(line) as { ok?: boolean; error?: string; fault?: unknown; tokens?: unknown; usageMissing?: unknown; refused?: unknown; loopTokens?: unknown });
        } catch (err) {
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (err) => this.fail(err));
    this.child.on("exit", (code) => {
      this.fail(new Error((this.stderr || `relay control exited ${code ?? "null"}`).trim()));
    });
  }

  private fail(err: Error): void {
    if (!this.dead) this.dead = err;
    while (this.queue.length > 0) this.queue.shift()?.reject(this.dead);
  }

  request(msg: object): Promise<{ ok?: boolean; error?: string; fault?: unknown; tokens?: unknown; usageMissing?: unknown; refused?: unknown; loopTokens?: unknown }> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch (err) {
        this.queue.pop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.dead) return;
    try {
      await this.request({ op: "shutdown" });
    } catch {
      return;
    }
    this.child.kill();
  }
}

function readJsonl(file: string): unknown[] {
  const events: unknown[] = [];
  if (!existsSync(file)) return events;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return events;
}

function preserveAttemptSession(canonical: string, attempt: number): string {
  const kept = canonical.replace(/\.jsonl$/, `.attempt-${attempt}.jsonl`);
  if (existsSync(canonical)) copyFileSync(canonical, kept);
  return kept;
}

function weightUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; prompt_cache_hit_tokens?: unknown };
  const cache = row.prompt_tokens_details && typeof row.prompt_tokens_details === "object" && "cached_tokens" in row.prompt_tokens_details
    ? row.prompt_tokens_details.cached_tokens
    : row.prompt_cache_hit_tokens;
  const prompt = row.prompt_tokens;
  const completion = row.completion_tokens;
  if (typeof cache !== "number" || typeof prompt !== "number" || typeof completion !== "number") return null;
  if (!Number.isFinite(cache) || !Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return (prompt - cache) + completion + cache;
}

/** Sum of 2xx done usage in an open relay log. Missing usage is not a number, so it does not trip the cap. */
function weighedLogTokens(logPath: string): number {
  if (logPath === "" || !existsSync(logPath)) return 0;
  let total = 0;
  for (const event of readJsonl(logPath)) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; status?: unknown; usage?: unknown };
    if (row.type !== "done") continue;
    const status = typeof row.status === "number" ? row.status : 200;
    if (status < 200 || status > 299) continue;
    const weighed = weightUsage(row.usage);
    if (weighed === null) continue;
    total += weighed;
  }
  return total;
}

function flattenConfig(config: ConfigFile): Record<string, unknown> {
  return leafKnobPaths(config.parts).reduce<Record<string, unknown>>((out, path) => {
    out[path] = valueAt(config, path);
    return out;
  }, {});
}

function changedLeaves(control: ConfigFile, candidate: ConfigFile): { readonly path: string; readonly value: unknown }[] {
  const left = flattenConfig(control);
  const right = flattenConfig(candidate);
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: { path: string; value: unknown }[] = [];
  for (const path of paths) {
    if (JSON.stringify(left[path]) !== JSON.stringify(right[path])) changed.push({ path, value: right[path] });
  }
  return changed;
}

function readRunEdges(tracePath: string): { readonly effective: Record<string, unknown> | null; readonly runEnd: Record<string, unknown> | null } {
  if (tracePath === "" || !existsSync(tracePath)) return { effective: null, runEnd: null };
  let effective: Record<string, unknown> | null = null;
  let runEnd: Record<string, unknown> | null = null;
  for (const event of readJsonl(tracePath)) {
    if (!event || typeof event !== "object") continue;
    const row = event as { type?: unknown; effective?: unknown };
    if (row.type === "run_start" && row.effective && typeof row.effective === "object" && !Array.isArray(row.effective)) {
      effective = row.effective as Record<string, unknown>;
    }
    if (row.type === "run_end") runEnd = row as Record<string, unknown>;
  }
  return { effective, runEnd };
}

function runEvidenceOk(runs: readonly ScoredRun[], keyFile: string, notesPath: string): boolean {
  if (runs.length === 0) return false;
  for (const run of runs) {
    if (!run.verified || run.attestReasons.length > 0) return false;
    if (!run.runRecordPath || !storedRecordOk(keyFile, run)) return false;
  }
  return displayedRewardOk(keyFile, runs[0], notesPath);
}

function roleCallUsage(log: string): { readonly tokens: number; readonly usageMissing: boolean } {
  let linked;
  try {
    linked = lstatSync(log);
  } catch {
    return { tokens: 0, usageMissing: true };
  }
  if (!linked.isFile()) return { tokens: 0, usageMissing: true };
  return relayCallUsage(readJsonl(log));
}

function hostedEvents(log: string, role: string, round: number): unknown[] {
  return readJsonl(log).map((event) => {
    if (!event || typeof event !== "object") return event;
    return { ...(event as Record<string, unknown>), role, round };
  });
}

function leafCount(parts: Readonly<Record<string, Readonly<Record<string, unknown>>>>): number {
  let count = 0;
  for (const section of Object.values(parts)) count += Object.keys(section).length;
  return count;
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
  const name = file.split("/").pop() ?? `${role}.jsonl`;
  const relative = `round${round}/sessions/${name}`;
  const sessions = current.sessions.filter((item) => item.file !== relative);
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
): { readonly hints: TraceHint[]; readonly reward: number | null } {
  if (attestDirs.length === 0) throw new Error("round 1 needs control attestations");
  let reward: number | null = null;
  const hints = attestDirs.map((attestDir) => {
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
    if (typeof verified.reward === "number") reward = verified.reward;
    return { file: verified.tracePath, line: 1, sha256: verified.traceSha };
  });
  return { hints, reward };
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

const RUN_RECORD_PY = [
  "import json, os, stat, sys",
  "from pathlib import Path",
  "sys.path.insert(0, sys.argv[1])",
  "import hooks",
  "key_path = os.environ.get('HARNESS_ATTEST_KEY_FILE') or ''",
  "try:",
  "    st = os.lstat(key_path)",
  "except OSError:",
  "    print(json.dumps({'ok': False}))",
  "    raise SystemExit(0)",
  "if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600:",
  "    print(json.dumps({'ok': False}))",
  "    raise SystemExit(0)",
  "key = open(key_path, 'rb').read()",
  "checker = sys.argv[2]",
  "container = sys.argv[3] or None",
  "mode = sys.argv[4]",
  "extra = sys.argv[5] if len(sys.argv) > 5 else ''",
  "if mode == 'sign':",
  "    try:",
  "        binding = hooks.relay_binding(str(Path(checker).parent / 'relay.jsonl'))",
  "        sig = hooks.sign_run_record(key, checker, relay_log_sha=binding['relayLogSha'], relay_sha=binding['relaySha'], boot_id=binding['bootId'], expected_run_id=extra)",
  "    except Exception:",
  "        print(json.dumps({'ok': False}))",
  "        raise SystemExit(0)",
  "    result = hooks.verify_run_record(sig, checker, sig['reward'], key, container_dir=container)",
  "    print(json.dumps({'ok': result.get('ok') is True, 'sig': sig}))",
  "elif mode == 'verify':",
  "    sig = json.loads(sys.stdin.read())",
  "    reward = json.loads(extra)",
  "    print(json.dumps(hooks.verify_run_record(sig, checker, reward, key, container_dir=container)))",
  "elif mode == 'notes':",
  "    sig = json.loads(sys.stdin.read())",
  "    notes = open(extra, encoding='utf-8').read()",
  "    print(json.dumps(hooks.verify_notes_reward(notes, sig, checker, key)))",
  "else:",
  "    print(json.dumps({'ok': False}))",
].join("\n");

/** Argv of the run-record child. The HMAC key is read from HARNESS_ATTEST_KEY_FILE, not from this list. */
export function runRecordArgv(checkerDir: string, containerDir: string, mode: string, extra: string): readonly string[] {
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  return ["python3", "-c", RUN_RECORD_PY, relayDir, checkerDir, containerDir, mode, extra];
}

function runRecord(keyFile: string, mode: "sign" | "verify" | "notes", checkerDir: string, containerDir: string, extra: string, input?: string): { ok?: boolean; sig?: Record<string, unknown> } | null {
  const argv = runRecordArgv(checkerDir, containerDir, mode, extra);
  const proc = spawnSync(argv[0] ?? "python3", argv.slice(1), {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ATTEST_KEY_FILE: keyFile },
    ...(input !== undefined ? { input } : {}),
  });
  if (proc.status !== 0 || !proc.stdout) return null;
  try {
    return JSON.parse(proc.stdout) as { ok?: boolean; sig?: Record<string, unknown> };
  } catch {
    return null;
  }
}

function signRunRecord(keyFile: string, checkerDir: string, runDir: string, runId: string): Record<string, unknown> | null {
  const parsed = runRecord(keyFile, "sign", checkerDir, runDir, runId);
  if (!parsed || parsed.ok !== true || !parsed.sig) return null;
  return parsed.sig;
}

function storedRecordOk(keyFile: string, run: ScoredRun): boolean {
  if (!run.runRecordPath || !existsSync(run.runRecordPath)) return false;
  const raw = readFileSync(run.runRecordPath, "utf8");
  let sig: { reward?: unknown };
  try {
    sig = JSON.parse(raw) as { reward?: unknown };
  } catch {
    return false;
  }
  const checker = join(run.runRecordPath, "..", "checker");
  const reward = run.reward === null ? sig.reward : run.reward;
  const parsed = runRecord(keyFile, "verify", checker, run.runDir, JSON.stringify(reward), raw);
  return parsed?.ok === true;
}

function displayedRewardOk(keyFile: string, run: ScoredRun | undefined, notesPath: string): boolean {
  if (!run?.runRecordPath || run.reward === null) return true;
  if (!existsSync(run.runRecordPath) || !existsSync(notesPath)) return false;
  const checker = join(run.runRecordPath, "..", "checker");
  const parsed = runRecord(keyFile, "notes", checker, "", notesPath, readFileSync(run.runRecordPath, "utf8"));
  return parsed?.ok === true;
}

export interface CiteEvidence {
  readonly ok: boolean;
  readonly reason?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** Offline citation check. Relative reads resolve against `cwd`, not the process cwd. */
export function citeEvidence(input: { readonly log: string; readonly file: string; readonly sha: string; readonly cwd: string }): CiteEvidence {
  return readEvidence(input.log, input.file, input.sha, input.cwd);
}

function relayCited(logPath: string, hostFile: string, sha: string, roleCwd: string): boolean {
  return readEvidence(logPath, hostFile, sha, roleCwd).ok;
}

function readEvidence(logPath: string, hostFile: string, sha: string, roleCwd: string): CiteEvidence {
  if (!existsSync(logPath) || !existsSync(hostFile)) return { ok: false, reason: "missing" };
  const script = fileURLToPath(new URL("../../relay/ledger.py", import.meta.url));
  const proc = spawnSync("python3", [script, "read-evidence", "--log", logPath, "--file", hostFile, "--sha", sha, "--cwd", roleCwd], { encoding: "utf8" });
  if (!proc.stdout) return { ok: false, reason: "no_segment" };
  try {
    const parsed = JSON.parse(proc.stdout) as { ok?: unknown; reason?: unknown; startLine?: unknown; endLine?: unknown };
    return {
      ok: parsed.ok === true,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(typeof parsed.startLine === "number" ? { startLine: parsed.startLine } : {}),
      ...(typeof parsed.endLine === "number" ? { endLine: parsed.endLine } : {}),
    };
  } catch {
    return { ok: false, reason: "no_segment" };
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
  reward: number | null = null,
): void {
  const lines = [
    `start: ${started.toISOString()}`,
    `end: ${ended.toISOString()}`,
    `ewiThresholdSec: ${threshold}`,
    `controlConfigSha: ${controlSha}`,
    `patchSha: ${patchHash ?? ""}`,
    `reward: ${reward ?? ""}`,
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
