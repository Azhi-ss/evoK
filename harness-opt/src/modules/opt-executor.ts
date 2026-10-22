import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateHashFragment } from "./activation";
import { writeHostAttestation, type AttestRunMeta } from "./attestation";

export interface OptTask {
  readonly id: string;
  readonly path: string;
  readonly split: "dev" | "held-out";
  readonly network: "devii-004-int";
  readonly tokenW: number;
}

export function tokenCap(task: OptTask): number {
  return 6 * task.tokenW;
}

export interface OptRunRequest {
  readonly task: OptTask;
  readonly seed: number;
  readonly arm: "control" | "candidate";
  readonly configPath: string;
  readonly runDir: string;
  /** Loop output directory. The host attestation signs the run path relative to it. */
  readonly outDir?: string;
  /** Host directory for `{attestDir}/attestation.json`. Never taken from stdout. */
  readonly attestDir: string;
  /** Host harness file mounted over the image harness. Optional unless `{harness}` is used. */
  readonly harnessPath?: string;
  /** Host-allocated id. The wrapper copies it into `run.runId`. 32 hex, not a path hash. */
  readonly runId?: string;
  /** One-time nonce bound into the attestation. */
  readonly nonce?: string;
  /** Host directory for the relay log of this run. Outside every mount. */
  readonly relayLogRoot?: string;
  readonly model: string;
  readonly tokenCap: number;
}

/** 32 hex characters from 16 random bytes. Not derived from the run directory. */
export function hostRunId(): string {
  return randomBytes(16).toString("hex");
}

/** Scored runs copy and sign the checker. A missing relay log root is a failure, not a skip. */
export function assertScoredRelayLog(relayLogRoot: string | undefined): asserts relayLogRoot is string {
  if (typeof relayLogRoot !== "string" || relayLogRoot.trim() === "") {
    throw new Error("scored run needs relayLogRoot");
  }
}

export interface OptRunObservation {
  readonly reward: number | null;
  readonly scoreStatus: "scored" | "unscored";
  readonly unscoredReason?: string;
  readonly tokens: number;
  readonly wallS: number;
  readonly timedOut: boolean;
  readonly tracePath: string;
  readonly outputsDir: string;
  readonly batchLogPath: string;
}

export interface OptExecutor {
  readonly name: string;
  run(request: OptRunRequest): Promise<OptRunObservation>;
}

export interface SpawnResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CommandExecutorOptions {
  readonly command: readonly string[];
  /** Defaults to "command". The loop's real-run entry uses "once". */
  readonly name?: string;
  readonly driver?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: { readonly encoding: "utf8"; readonly env: NodeJS.ProcessEnv; readonly timeout?: number },
  ) => SpawnResult;
}

const PLACEHOLDERS = [
  "task",
  "taskPath",
  "seed",
  "arm",
  "config",
  "runDir",
  "outDir",
  "runId",
  "nonce",
  "relayLog",
  "attestDir",
  "harness",
  "model",
  "network",
  "tokenCap",
  "driver",
] as const;

type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Fill a caller-supplied argv. The package does not choose a box path.
 * `{driver}` comes from the argument or `HARNESS_OPT_DRIVER`.
 */
export function renderExecutorCommand(
  template: readonly string[],
  request: OptRunRequest,
  driver?: string,
): string[] {
  const text = template.join("\n");
  if (text.includes("{marker}") || text.includes("{patchHash}")) {
    throw new Error("executor command must not receive {marker} or {patchHash}");
  }
  if (text.includes("{attestKey}") || text.includes("HARNESS_ATTEST_KEY_FILE")) {
    throw new Error("executor command must not receive the attest key path");
  }
  if (request.task.network !== "devii-004-int") {
    throw new Error("executor network must be devii-004-int");
  }
  const namesTask = text.includes("{task}") || text.includes("{taskPath}");
  if (!namesTask || !text.includes("{runDir}") || !text.includes("{attestDir}")) {
    throw new Error("executor command must include {task} or {taskPath}, {runDir}, and {attestDir}");
  }
  return template.map((arg) => arg.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (!isPlaceholder(name)) return whole;
    return placeholderValue(name, request, driver);
  }));
}

export class CommandOptExecutor implements OptExecutor {
  readonly name: string;

  constructor(private readonly options: CommandExecutorOptions) {
    this.name = options.name ?? "command";
  }

  async run(request: OptRunRequest): Promise<OptRunObservation> {
    const env = this.options.env ?? process.env;
    const argv = renderExecutorCommand(this.options.command, request, this.options.driver ?? env.HARNESS_OPT_DRIVER);
    const [command, ...args] = argv;
    if (!command) throw new Error("executor command is empty");
    const spawn = this.options.spawn ?? spawnSync;
    const child = spawn(command, args, {
      encoding: "utf8",
      env: { ...env },
      ...(this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : {}),
    });
    if (child.error || child.status !== 0) {
      const detail = `${child.stderr ?? ""}${child.stdout ?? ""}`.trim() || child.error?.message || "executor command failed";
      throw new Error(redact(detail, env));
    }
    const observation = readObservation(request.runDir, request);
    if (observation.scoreStatus === "scored") assertScoredRelayLog(request.relayLogRoot);
    return observation;
  }
}

export interface DryRunHost {
  readonly key: Buffer;
  readonly harnessPath: string;
}

/** In-process executor for `--dry-run`. It writes artifacts and the host attestation. It does not spawn. */
export function createDryRunExecutor(host: DryRunHost): OptExecutor {
  return {
    name: "dry-run",
    async run(request) {
      const base = 1_700_000_000;
      writeRunArtifacts(request, {
        reward: 1,
        tokens: 100,
        wallS: 10,
        timedOut: false,
        tWrite: base,
        tEnd: base + 1,
        assistantTs: [base + 0.2],
      }, { key: host.key, harnessPath: host.harnessPath });
      return observationOf(request, { reward: 1, tokens: 100, wallS: 10, timedOut: false });
    },
  };
}

export interface RunArtifactTiming {
  readonly reward: number;
  readonly tokens: number;
  readonly wallS: number;
  readonly timedOut: boolean;
  readonly tWrite: number;
  readonly tEnd: number;
  readonly assistantTs: readonly number[];
}

export interface RunAttestHost {
  readonly key: Buffer;
  readonly harnessPath: string;
  readonly at?: string;
}

/**
 * Files a real driver leaves in the run directory, plus the host attestation
 * outside it when `attest` is set. The attestation is not derived from stdout.
 */
export function writeRunArtifacts(request: OptRunRequest, timing: RunArtifactTiming, attest?: RunAttestHost): void {
  assertScoredRelayLog(request.relayLogRoot);
  const outputs = join(request.runDir, "outputs");
  mkdirSync(outputs, { recursive: true });
  const answer = join(outputs, "answer.txt");
  writeFileSync(answer, "dry-run\n");
  utimesSync(answer, timing.tWrite, timing.tWrite);
  const configBytes = readFileSync(request.configPath);
  const config = JSON.parse(configBytes.toString()) as { parts?: Record<string, unknown> };
  const hash = createHash("sha256").update(configBytes).digest("hex");
  const start = {
    type: "run_start",
    candidateConfigHash: hash,
    effective: flatten(config.parts ?? {}),
  };
  const messages = timing.assistantTs.map((stamp) => ({ type: "assistant_message", ts: stamp * 1000 }));
  writeFileSync(
    join(request.runDir, "trace.jsonl"),
    [start, ...messages].map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  writeFileSync(join(request.runDir, "batch.log"), `${new Date(timing.tEnd * 1000).toISOString()} run 1 done\n`);
  mkdirSync(join(request.runDir, "verifier"), { recursive: true });
  writeFileSync(join(request.runDir, "verifier", "reward.txt"), `${timing.reward}\n`);
  const sessionDir = join(request.runDir, ".pi-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "dry-run",
    timestamp: new Date(0).toISOString(),
    cwd: request.runDir,
  })}\n${JSON.stringify({
    type: "message",
    id: "system",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "system",
      content: "",
      sections: { preamble: `lead${candidateHashFragment(hash)}` },
      timestamp: 0,
    },
  })}\n`);
  const runId = request.runId && request.runId.trim() !== "" ? request.runId : hostRunId();
  writeFileSync(join(request.runDir, "result.json"), `${JSON.stringify({
    reward: timing.reward,
    tokens: timing.tokens,
    wall_s: timing.wallS,
    timed_out: timing.timedOut,
    score_status: "scored",
    runId,
  })}\n`);
  const relayLogRoot = request.relayLogRoot;
  plantExecutorRelay(join(relayLogRoot, runId, "relay.jsonl"), runId, candidateHashFragment(hash));
  copyCheckerBeforeSign(request.runDir, relayLogRoot, runId);
  if (!attest) return;
  if (!request.outDir || request.outDir.trim() === "") throw new Error("attestation out dir is missing");
  const runPath = resolve(request.runDir);
  const meta: AttestRunMeta = {
    task: request.task.path,
    seed: request.seed,
    arm: request.arm,
    score_status: "scored",
    tokens: timing.tokens,
    exit: 0,
    runDir: runPath,
    runId,
    ...(request.nonce ? { nonce: request.nonce } : {}),
    runPath,
    at: attest.at ?? "2026-10-21T00:00:00+09:00",
  };
  writeHostAttestation({
    attestDir: request.attestDir,
    outDir: request.outDir,
    runDir: request.runDir,
    key: attest.key,
    harnessPath: attest.harnessPath,
    configPath: request.configPath,
    reward: timing.reward,
    meta,
  });
}

const COPY_CHECKER_PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import hooks",
  "print(json.dumps(hooks.copy_checker_before_sign(sys.argv[2], sys.argv[3], sys.argv[4])))",
].join("\n");

/** Host copy of {run}/verifier into the relay checker directory. Runs before the attestation is signed. */
export function copyCheckerBeforeSign(runDir: string, relayRoot: string, runId: string): void {
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const proc = spawnSync("python3", ["-c", COPY_CHECKER_PY, relayDir, runDir, runId, relayRoot], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "checker copy failed").trim());
}

function observationOf(
  request: OptRunRequest,
  fields: { readonly reward: number | null; readonly tokens: number; readonly wallS: number; readonly timedOut: boolean; readonly unscoredReason?: string },
): OptRunObservation {
  return {
    reward: fields.reward,
    scoreStatus: fields.reward === null ? "unscored" : "scored",
    ...(fields.unscoredReason ? { unscoredReason: fields.unscoredReason } : {}),
    tokens: fields.tokens,
    wallS: fields.wallS,
    timedOut: fields.timedOut,
    tracePath: join(request.runDir, "trace.jsonl"),
    outputsDir: join(request.runDir, "outputs"),
    batchLogPath: join(request.runDir, "batch.log"),
  };
}

function readObservation(runDir: string, request: OptRunRequest): OptRunObservation {
  const file = join(runDir, "result.json");
  if (!existsSync(file)) throw new Error(`executor result is missing: ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    reward?: unknown;
    wall_s?: unknown;
    timed_out?: unknown;
    score_status?: unknown;
    unscored_reason?: unknown;
  };
  const runId = typeof request.runId === "string" ? request.runId.trim() : "";
  const scored = parsed.score_status !== "unscored";
  const relay = request.relayLogRoot && runId
    ? relayUsage(request.relayLogRoot, runId)
    : scored && request.relayLogRoot
      ? { tokens: 0, usageMissing: true }
      : { tokens: 0, usageMissing: false };
  const usageMissing = relay.usageMissing;
  const unscored = parsed.score_status === "unscored" || usageMissing;
  const reward = typeof parsed.reward === "number" && Number.isFinite(parsed.reward) ? parsed.reward : null;
  const reason = usageMissing
    ? "usage_missing"
    : typeof parsed.unscored_reason === "string" ? parsed.unscored_reason : "unscored";
  return {
    reward: unscored ? null : reward,
    scoreStatus: unscored ? "unscored" : "scored",
    ...(unscored ? { unscoredReason: reason } : {}),
    tokens: relay.tokens,
    wallS: typeof parsed.wall_s === "number" ? parsed.wall_s : 0,
    timedOut: parsed.timed_out === true,
    tracePath: join(runDir, "trace.jsonl"),
    outputsDir: join(runDir, "outputs"),
    batchLogPath: join(runDir, "batch.log"),
  };
}

/** Token total from the relay log. result.json tokens are ignored. A missing log is usage_missing. */
function relayUsage(root: string, runId: string): { readonly tokens: number; readonly usageMissing: boolean } {
  const log = join(root, runId, "relay.jsonl");
  if (runId.trim() === "" || !existsSync(log)) return { tokens: 0, usageMissing: true };
  const relayDir = fileURLToPath(new URL("../../relay", import.meta.url));
  const code = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from ledger import load, tokens",
    "info = tokens(load(sys.argv[2]))",
    "print(json.dumps({'tokens': 0 if info['tokens'] is None else info['tokens'], 'usage_missing': bool(info['usage_missing'])}))",
  ].join("\n");
  const proc = spawnSync("python3", ["-c", code, relayDir, log], { encoding: "utf8" });
  if (proc.status !== 0 || !proc.stdout) return { tokens: 0, usageMissing: true };
  try {
    const parsed = JSON.parse(proc.stdout) as { tokens?: unknown; usage_missing?: unknown };
    return {
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : 0,
      usageMissing: parsed.usage_missing === true,
    };
  } catch {
    return { tokens: 0, usageMissing: true };
  }
}

function isPlaceholder(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

function placeholderValue(name: Placeholder, request: OptRunRequest, driver: string | undefined): string {
  if (name === "driver") {
    if (!driver) throw new Error("executor command needs HARNESS_OPT_DRIVER or --driver for {driver}");
    return driver;
  }
  if (name === "harness") {
    if (!request.harnessPath) throw new Error("executor command needs --harness for {harness}");
    return request.harnessPath;
  }
  if (name === "runId") {
    if (!request.runId || request.runId.trim() === "") throw new Error("executor command needs a host run id for {runId}");
    return request.runId;
  }
  if (name === "nonce") {
    if (!request.nonce || request.nonce.trim() === "") throw new Error("executor command needs a nonce for {nonce}");
    return request.nonce;
  }
  if (name === "relayLog") {
    if (!request.relayLogRoot || !request.runId) throw new Error("executor command needs a relay log for {relayLog}");
    return join(request.relayLogRoot, request.runId, "relay.jsonl");
  }
  if (name === "outDir") {
    if (!request.outDir || request.outDir.trim() === "") throw new Error("executor command needs an out dir for {outDir}");
    return request.outDir;
  }
  const values: Record<Exclude<Placeholder, "driver" | "harness" | "runId" | "nonce" | "relayLog" | "outDir">, string> = {
    task: request.task.id,
    taskPath: request.task.path,
    seed: String(request.seed),
    arm: request.arm,
    config: request.configPath,
    runDir: request.runDir,
    attestDir: request.attestDir,
    model: request.model,
    network: request.task.network,
    tokenCap: String(request.tokenCap),
  };
  return values[name];
}

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(out, flatten(child as Record<string, unknown>, path));
    } else {
      out[path] = child;
    }
  }
  return out;
}

function plantExecutorRelay(logPath: string, runId: string, systemText: string): void {
  const script = fileURLToPath(new URL("../../relay/plant.py", import.meta.url));
  const proc = spawnSync("python3", [script, "plant-request", "--log", logPath, "--run-id", runId, "--system", systemText], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "relay plant failed").trim());
}

function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const secret of [env.API_KEY, env.BOHR_ACCESS_KEY, env.HARNESS_ATTEST_KEY_FILE]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
