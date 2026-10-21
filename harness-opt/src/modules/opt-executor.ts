import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OptTask {
  readonly id: string;
  readonly path: string;
  readonly split: "dev" | "held-out";
  readonly network: "gateway-only" | "shared";
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
  readonly model: string;
  readonly patchHash: string;
  readonly marker: string;
  readonly tokenCap: number;
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
  "model",
  "patchHash",
  "marker",
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
  const namesTask = text.includes("{task}") || text.includes("{taskPath}");
  if (!namesTask || !text.includes("{runDir}")) {
    throw new Error("executor command must include {task} or {taskPath}, and {runDir}");
  }
  return template.map((arg) => arg.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    if (!isPlaceholder(name)) return whole;
    return placeholderValue(name, request, driver);
  }));
}

export class CommandOptExecutor implements OptExecutor {
  readonly name = "command";

  constructor(private readonly options: CommandExecutorOptions) {}

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
    return readObservation(request.runDir);
  }
}

/** In-process executor for `--dry-run`. It writes the artifact contract and does not spawn. */
export function createDryRunExecutor(): OptExecutor {
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
      });
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

/** Files a real driver must leave behind: trace, outputs, batch.log, reward.txt, result.json. */
export function writeRunArtifacts(request: OptRunRequest, timing: RunArtifactTiming): void {
  const outputs = join(request.runDir, "outputs");
  mkdirSync(outputs, { recursive: true });
  const answer = join(outputs, "answer.txt");
  writeFileSync(answer, "dry-run\n");
  utimesSync(answer, timing.tWrite, timing.tWrite);
  const configBytes = readFileSync(request.configPath);
  const config = JSON.parse(configBytes.toString()) as { parts?: Record<string, unknown> };
  const start = {
    type: "run_start",
    candidateConfigHash: createHash("sha256").update(configBytes).digest("hex"),
    effective: flatten(config.parts ?? {}),
    systemPrompt: request.marker ? `system\n${request.marker}\n` : "system\n",
  };
  const messages = timing.assistantTs.map((stamp) => ({ type: "assistant_message", ts: stamp * 1000 }));
  writeFileSync(
    join(request.runDir, "trace.jsonl"),
    [start, ...messages].map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  writeFileSync(join(request.runDir, "batch.log"), `${new Date(timing.tEnd * 1000).toISOString()} run 1 done\n`);
  mkdirSync(join(request.runDir, "verifier"), { recursive: true });
  writeFileSync(join(request.runDir, "verifier", "reward.txt"), `${timing.reward}\n`);
  writeFileSync(join(request.runDir, "result.json"), `${JSON.stringify({
    reward: timing.reward,
    tokens: timing.tokens,
    wall_s: timing.wallS,
    timed_out: timing.timedOut,
    score_status: "scored",
  })}\n`);
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

function readObservation(runDir: string): OptRunObservation {
  const file = join(runDir, "result.json");
  if (!existsSync(file)) throw new Error(`executor result is missing: ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    reward?: unknown;
    tokens?: unknown;
    wall_s?: unknown;
    timed_out?: unknown;
    score_status?: unknown;
    unscored_reason?: unknown;
  };
  const unscored = parsed.score_status === "unscored";
  const reward = typeof parsed.reward === "number" && Number.isFinite(parsed.reward) ? parsed.reward : null;
  return {
    reward: unscored ? null : reward,
    scoreStatus: unscored ? "unscored" : "scored",
    ...(unscored ? { unscoredReason: typeof parsed.unscored_reason === "string" ? parsed.unscored_reason : "unscored" } : {}),
    tokens: typeof parsed.tokens === "number" ? parsed.tokens : 0,
    wallS: typeof parsed.wall_s === "number" ? parsed.wall_s : 0,
    timedOut: parsed.timed_out === true,
    tracePath: join(runDir, "trace.jsonl"),
    outputsDir: join(runDir, "outputs"),
    batchLogPath: join(runDir, "batch.log"),
  };
}

function isPlaceholder(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

function placeholderValue(name: Placeholder, request: OptRunRequest, driver: string | undefined): string {
  if (name === "driver") {
    if (!driver) throw new Error("executor command needs HARNESS_OPT_DRIVER or --driver for {driver}");
    return driver;
  }
  const values: Record<Exclude<Placeholder, "driver">, string> = {
    task: request.task.id,
    taskPath: request.task.path,
    seed: String(request.seed),
    arm: request.arm,
    config: request.configPath,
    runDir: request.runDir,
    model: request.model,
    patchHash: request.patchHash,
    marker: request.marker,
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

function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const secret of [env.API_KEY, env.BOHR_ACCESS_KEY]) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
