/**
 * `evok` foreground entrypoint core (#109, T1). See bin/evok.ts for the
 * executable wrapper.
 *
 * Bounded request/response through the existing Pi execution path:
 *   - models and auth are Pi SDK-resolved stores (no copied credentials,
 *     no second login system);
 *   - the resolved default/tier model is the model that actually executes;
 *   - missing model/auth configuration fails clearly before dispatch;
 *   - each request is a fresh Run (fresh session/attempt identity, runtime
 *     policy keeps hidden SDK retry/compaction disabled);
 *   - Ctrl+C / SIGINT cancels the in-flight request; idle Ctrl+C and Ctrl+D
 *     exit. No Mission-pause meaning is bound to Ctrl+C.
 *
 * Later slices add approved evoK prompts/skills, Mission intake, persistence,
 * and the autonomous loop. This slice performs none of those.
 */
import { realpath, rm } from "node:fs/promises";
import { isatty } from "node:tty";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { PiAgentRuntime } from "./pi-agent-runtime";
import type { SessionModelResolver } from "./evok-model";

export const EVOK_VERSION = "0.1.0-t1";

/** Exit codes distinguish the visible failure classes the spec calls out. */
export const EVOK_EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  configError: 3,
  authError: 4,
  runtimeError: 5,
  cancelled: 130,
});

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const TIERS = new Set(["default", "fast", "deep", "mid"]);

function parseTimeout(raw: string | undefined): number | string {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : `--timeout-ms must be a positive integer (got "${raw}")`;
}

export interface ParsedEvokArgs {
  readonly request?: string;
  readonly project?: string;
  readonly tier: string;
  readonly orchestra?: string;
  readonly timeoutMs: number;
  readonly help?: boolean;
  readonly error?: string;
}

export const EVOK_USAGE = `evok — bounded foreground research requests on the Pi SDK execution path

usage:
  evok [request text] [options]     one-shot request
  evok [options]                    read one request from stdin (piped) or REPL (tty)

options:
  --project <dir>   research project directory (default: current directory)
  --tier <tier>     model tier: default | fast | deep | mid (default: default)
  --orchestra <f>   JSON file binding {fast?, deep?, mid?} to Pi catalog refs
  --timeout-ms <n>  bound one Run to n milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help        show this help

ctrl+c cancels the in-flight request (second/interrupted idle press exits);
ctrl+d or "exit" ends the REPL. Models and credentials come from Pi (~/.pi/agent);
evok never copies or displays credentials.
`;

export function parseEvokArgs(argv: readonly string[]): ParsedEvokArgs {
  let request: string | undefined;
  let project: string | undefined;
  let tier = "default";
  let orchestra: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { tier, timeoutMs, help: true };
    if (arg === "--project") {
      project = argv[++i];
      if (!project) return { tier, timeoutMs, error: "--project requires a directory" };
    } else if (arg === "--tier") {
      tier = argv[++i] ?? "";
      if (!TIERS.has(tier)) return { tier, timeoutMs, error: `--tier must be one of ${[...TIERS].join(", ")} (got "${tier}")` };
    } else if (arg === "--orchestra") {
      orchestra = argv[++i];
      if (!orchestra) return { tier, timeoutMs, error: "--orchestra requires a JSON file path" };
    } else if (arg === "--timeout-ms") {
      const parsed = parseTimeout(argv[++i]);
      if (typeof parsed === "string") return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, error: parsed };
      timeoutMs = parsed;
    } else if (arg.startsWith("--timeout-ms=")) {
      const parsed = parseTimeout(arg.slice("--timeout-ms=".length));
      if (typeof parsed === "string") return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, error: parsed };
      timeoutMs = parsed;
    } else if (arg.startsWith("--")) {
      return { tier, timeoutMs, error: `unknown option "${arg}"` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 0) request = positionals.join(" ");
  return { request, project, tier, orchestra, timeoutMs };
}

export interface EvokRunOptions {
  readonly args: ParsedEvokArgs;
  /** Builds the Pi-backed resolver (overridable in tests / for faux providers). */
  readonly createResolver: (args: ParsedEvokArgs) => Promise<SessionModelResolver>;
  /** Workspace root for isolated per-Run workspaces (default: OS tmpdir). */
  readonly workspaceRoot?: string;
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly stdin?: NodeJS.ReadStream;
  readonly signal?: AbortSignal;
}

type Out = { write(chunk: string): boolean };

function asOut(stream: { write(chunk: string): boolean } | undefined): Out {
  return (stream ?? (process.stdout as unknown as { write(chunk: string): boolean })) as Out;
}

/**
 * Runs one evok foreground session. Returns the process exit code; never
 * throws for user-visible configuration/auth/runtime failures.
 */
export async function runEvok(options: EvokRunOptions): Promise<number> {
  const { args } = options;
  const stdout = asOut(options.stdout);
  const stderr = asOut(options.stderr);

  if (args.help) {
    stdout.write(EVOK_USAGE);
    return EVOK_EXIT.ok;
  }
  if (args.error) {
    stderr.write(`evok: ${args.error}\n\n${EVOK_USAGE}`);
    return EVOK_EXIT.usage;
  }

  const project = resolve(args.project ?? process.cwd());
  let projectReal: string;
  try {
    projectReal = await realpath(project);
  } catch {
    stderr.write(`evok: research project directory not found: ${project}\n`);
    return EVOK_EXIT.usage;
  }

  let resolver: SessionModelResolver;
  try {
    resolver = await options.createResolver(args);
  } catch (error) {
    stderr.write(`evok: model configuration error: ${(error as Error).message}\n`);
    return EVOK_EXIT.configError;
  }

  // Preflight the requested tier before any Run is constructed: missing
  // model/auth configuration must fail before work is dispatched.
  // A fresh runtime per request keeps every REPL line a fresh Run with its
  // own session, attempt identity, workspace, and intent store (ADR-0001) —
  // identical requests never replay a stored Run result.
  const createRuntime = (): PiAgentRuntime =>
    new PiAgentRuntime({
      workspaceRoot: options.workspaceRoot ?? tmpdir(),
      modelResolver: resolver,
    });
  try {
    const probe = await resolver.resolve(args.tier);
    const preflight = await resolver.preflight(probe.model);
    if (!preflight.ok) {
      stderr.write(`evok: ${preflight.error}\n`);
      return EVOK_EXIT.authError;
    }
    stdout.write(`evok ${EVOK_VERSION}\n`);
    stdout.write(`project: ${projectReal}\n`);
    stdout.write(`model:   ${probe.model.id} (tier ${probe.tier})\n`);
    stdout.write(`tools:   read-only (read, grep, find, ls) on the project; writes stay in the isolated Run workspace\n`);
    stdout.write(`         personal Pi prompts/skills/extensions/history are not loaded\n`);
  } catch (error) {
    stderr.write(`evok: model configuration error: ${(error as Error).message}\n`);
    return EVOK_EXIT.configError;
  }

  if (args.request !== undefined) {
    return runOne(createRuntime, args, args.request, options, stdout, stderr, projectReal);
  }

  const stdin = (options.stdin ?? process.stdin) as NodeJS.ReadStream;
  if (isatty((stdin as { fd?: number }).fd ?? 0)) {
    return runRepl(createRuntime, args, options, stdin, stdout, stderr, projectReal);
  }
  const piped = await readAll(stdin);
  const request = piped.trim();
  if (!request) {
    stderr.write("evok: no request text provided\n");
    return EVOK_EXIT.usage;
  }
  return runOne(createRuntime, args, request, options, stdout, stderr, projectReal);
}

async function runOne(
  createRuntime: () => PiAgentRuntime,
  args: ParsedEvokArgs,
  requestText: string,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
): Promise<number> {
  if (options.signal?.aborted) {
    stderr.write("evok: request cancelled before completion; no retry was attempted\n");
    return EVOK_EXIT.cancelled;
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const onSigint = () => {
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  const boundMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`Run exceeded bound of ${boundMs}ms`)), boundMs);
  // ponytail: unref so the bound timer never keeps the process alive by itself
  timer.unref?.();

  const workspaceParent = uniqueWorkspace(options.workspaceRoot);
  try {
    const runtime = createRuntime();
    const result = await runtime.execute(
      {
        task: { objective: requestText },
        role: { name: "evok-foreground", tools: ["read", "grep", "find", "ls"] },
        workspace: { path: workspaceParent, isolated: true, approved: true, readRoots: [projectRoot] },
        tier: args.tier,
      },
      controller.signal,
    );
    stdout.write(`\n${result.text ?? "(no text response)"}\n`);
    stdout.write(
      `\n-- model ${result.model?.id ?? args.tier} · session ${result.sessionId} · stop ${result.stopReason}\n`
      + `   tokens in ${result.usage.tokens.input} out ${result.usage.tokens.output} total ${result.usage.tokens.total}`
      + ` · cost ${result.usage.cost.total.toFixed(6)}\n`,
    );
    return EVOK_EXIT.ok;
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === "AbortError") {
      stderr.write("\nevok: request cancelled before completion; no retry was attempted\n");
      return EVOK_EXIT.cancelled;
    }
    if ((error as Error).name === "MissingAuthenticationError") {
      stderr.write(`\nevok: ${(error as Error).message}\n`);
      return EVOK_EXIT.authError;
    }
    stderr.write(`\nevok: run failed: ${(error as Error).message}\n`);
    return EVOK_EXIT.runtimeError;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onExternalAbort);
    // Run workspaces are disposable per ADR-0001; remove the empty parent too.
    await rm(workspaceParent, { recursive: true, force: true }).catch(() => {});
  }
}

async function runRepl(
  createRuntime: () => PiAgentRuntime,
  args: ParsedEvokArgs,
  options: EvokRunOptions,
  stdin: NodeJS.ReadStream,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
): Promise<number> {
  const rl = createInterface({ input: stdin, terminal: Boolean(stdin.isTTY) });

  stdout.write("\nforeground REPL — type a request; ctrl+c cancels the in-flight Run (idle press exits), ctrl+d exits\n\n> ");

  let lastCode: number = EVOK_EXIT.ok;
  let busy = false;
  let closed = false;
  rl.on("close", () => { closed = true; });

  // Readline owns raw-mode key handling in a real tty; its SIGINT event is
  // the only ctrl+c path. It never gains a Mission-pause meaning (#109).
  rl.on("SIGINT", () => {
    if (busy) {
      process.emit("SIGINT" as NodeJS.Signals);
    } else {
      stdout.write("\n");
      rl.close();
    }
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolveLine) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) { settled = true; resolveLine(value); }
      };
      rl.question("", (answer) => finish(answer));
      rl.once("close", () => finish(null));
    });

  while (true) {
    const line = await ask();
    if (line === null) break;
    if (line.trim() === "exit" || line.trim() === "quit") break;
    const text = line.trim();
    if (!text) {
      stdout.write("> ");
      continue;
    }
    busy = true;
    lastCode = await runOne(createRuntime, args, text, options, stdout, stderr, projectRoot);
    busy = false;
    if (closed) break;
    stdout.write("\n> ");
  }
  if (!closed) rl.close();
  return lastCode;
}

function uniqueWorkspace(workspaceRoot?: string): string {
  // PiAgentRuntime creates the per-Run isolated workspace itself under its
  // workspaceRoot; the request workspace parent only needs to be unique.
  return join(workspaceRoot ?? tmpdir(), `evok-foreground-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}
