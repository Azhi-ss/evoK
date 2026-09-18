/**
 * `evok` foreground entrypoint core (#109, T1). Thin CLI shell — see
 * `src/cli/evok.ts` / `bin/evok.ts` for the executable wrapper.
 *
 * Physical home: `src/cli/` (ET-A3 / #123). This module parses argv and
 * calls the mission API. It is not a second control plane: authorize /
 * continue / repair / stop live in `src/mission/`.
 *
 * Bounded request/response through the existing Pi execution path:
 *   - models and auth are Pi SDK-resolved stores (no copied credentials,
 *     no second login system);
 *   - the resolved default/tier model is the model that actually executes;
 *   - missing model/auth configuration fails clearly before dispatch;
 *   - each one-shot request is a fresh Run (fresh session/attempt identity,
 *     runtime policy keeps hidden SDK retry/compaction disabled);
 *   - a tty with no request and no Mission flag launches Pi native TUI
 *     (`InteractiveMode`); evoK does not intercept `/model` / `/new`.
 *   - one-shot Ctrl+C / SIGINT cancels the in-flight request. No Mission-pause
 *     meaning is bound to Ctrl+C. TUI keybindings stay on Pi.
 *
 * Mission authorize / continue / repair / stop live in `src/mission/`.
 */
import { realpath, rm } from "node:fs/promises";
import { isatty } from "node:tty";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentRuntime } from "../pi-agent-runtime";
import { launchPiNativeTui, type NativeTuiLaunch } from "./pi-native-tui";
import { calculateCost } from "@earendil-works/pi-ai";
import type { SessionModelResolver } from "../evok-model";
import { discoverEvokResources, EvokResourceError, type EvokResources } from "../evok-resources";
import { MissionDraftCorruptionError } from "../mission-draft";
import { runIntakeTurn } from "../mission-intake";
import {
  isExplicitStartRequest,
  loadMissionRecord,
  startAuthorizedMission,
  resumeAuthorizedMission,
  summarizeMission,
  BudgetExhaustedError,
  DirectorBlockedError,
  EvaluatorFailureError,
  MissionControllerConflictError,
  MissionRecordCorruptionError,
  MissionStartRejectedError,
  MissionResumeRejectedError,
  ReconciliationBlockedError,
  isExplicitResumeRequest,
  listUnfinishedMissions,
  type BaselineEvaluator,
  type StartMissionOutcome,
  DEFAULT_MAX_EXPERIMENTS,
} from "../mission-start";
import { createPiMissionDirector, DirectorDecisionFailedError, type MissionDirector } from "../mission-director";
import { EvaluationContractError, loadEvaluationContract, createFileMetricEvaluator } from "../local-file-evaluator";
import { loadMissionDraft, missionsDir } from "../mission-draft";

export const EVOK_VERSION = "0.1.0-t6";

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
const DEFAULT_RESERVE_COST = 0.01;
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
  /** #111: skill-led Mission intake/drafting path (ends at draft review). */
  readonly intake?: boolean;
  /** Reopen an existing Mission draft during intake. */
  readonly mission?: string;
  /** #112: start the displayed (or --mission) Mission's bounded baseline. */
  readonly start?: boolean;
  /** #112: print the durable Mission/draft status and stop. */
  readonly status?: boolean;
  /** #112: cost reserved before the baseline Run is dispatched (model-USD). */
  readonly reserveCost?: number;
  /** #113: run only the measured baseline (no autonomous continuation). */
  readonly baselineOnly?: boolean;
  /** #113: bound on Experiments after the baseline in one start. */
  readonly maxExperiments?: number;
  /** #114: explicitly resume an unfinished Mission without repeating intake. */
  readonly resume?: boolean;
  /** #114: list unfinished Missions (progress/stop/remaining budget) and stop. */
  readonly missions?: boolean;
  readonly help?: boolean;
  readonly error?: string;
}

export const EVOK_USAGE = `evok — bounded foreground research requests on the Pi SDK execution path

usage:
  evok [request text] [options]     one-shot request
  evok [options]                    Pi native TUI on a tty; one request from stdin when piped

options:
  --project <dir>   research project directory (default: current directory)
  --tier <tier>     model tier: default | fast | deep | mid (default: default)
  --orchestra <f>   JSON file binding {fast?, deep?, mid?} to Pi catalog refs
  --timeout-ms <n>  bound one Run to n milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --intake          Mission intake: turn the request into a saved, reviewable
                    Mission draft + initial plan via the mission-intake skill.
                    Ends at draft review; it never starts or dispatches work.
                    Requires request text (one-shot or piped); not a TUI command.
  --mission <id>    reopen an existing Mission draft during --intake, or name
                    the target Mission for --start/--status
  --start           start the authorized baseline for the displayed Mission
                    (\`evok --start\` or \`evok /start\`). Requires a reviewed draft,
                    explicit authorization, an enforceable model-USD budget,
                    and an evaluator contract.
  --reserve-cost <n>  cost (model-USD) reserved before baseline dispatch
                    (default: ${DEFAULT_RESERVE_COST}); an unboundable Run is refused
  --baseline-only   run only the measured baseline; do not continue autonomously
  --max-experiments <n>  bound Experiments after the baseline (default: ${DEFAULT_MAX_EXPERIMENTS})
  --status          print the durable Mission/draft state and stop
  --missions        list unfinished Missions: progress, stop/blocker, remaining
                    budget; resumable Missions are marked. Nothing is dispatched.
  --resume          explicitly RESUME the named (or displayed) unfinished
                    Mission from durable records and remaining budget. No intake
                    is repeated, no spent budget is restored; unconfirmed
                    pre-interrupt work is reconciled from evidence first.
                    Use \`evok --resume\` or \`evok /resume\`. Status questions
                    and negations never resume.
  -h, --help        show this help

On a tty with no request and no Mission flag, evok launches the Pi SDK native
TUI. Native slash commands (\`/model\`, \`/new\`, …) are handled by Pi, not evoK.
Mission entrypoints stay the thin flags above. Models and credentials come from
Pi (~/.pi/agent); evok never copies or displays credentials.
`;

export function parseEvokArgs(argv: readonly string[]): ParsedEvokArgs {
  let request: string | undefined;
  let project: string | undefined;
  let tier = "default";
  let orchestra: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let intake = false;
  let start = false;
  let status = false;
  let baselineOnly = false;
  let resume = false;
  let missions = false;
  let maxExperiments: number | undefined;
  let mission: string | undefined;
  let reserveCost = DEFAULT_RESERVE_COST;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { tier, timeoutMs, reserveCost, help: true };
    if (arg === "--project") {
      project = argv[++i];
      if (!project) return { tier, timeoutMs, reserveCost, error: "--project requires a directory" };
    } else if (arg === "--tier") {
      tier = argv[++i] ?? "";
      if (!TIERS.has(tier)) return { tier, timeoutMs, reserveCost, error: `--tier must be one of ${[...TIERS].join(", ")} (got "${tier}")` };
    } else if (arg === "--orchestra") {
      orchestra = argv[++i];
      if (!orchestra) return { tier, timeoutMs, reserveCost, error: "--orchestra requires a JSON file path" };
    } else if (arg === "--timeout-ms") {
      const parsed = parseTimeout(argv[++i]);
      if (typeof parsed === "string") return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, reserveCost, error: parsed };
      timeoutMs = parsed;
    } else if (arg.startsWith("--timeout-ms=")) {
      const parsed = parseTimeout(arg.slice("--timeout-ms=".length));
      if (typeof parsed === "string") return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, reserveCost, error: parsed };
      timeoutMs = parsed;
    } else if (arg === "--intake") {
      intake = true;
    } else if (arg === "--baseline-only") {
      baselineOnly = true;
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--missions") {
      missions = true;
    } else if (arg === "--max-experiments") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, reserveCost, error: `--max-experiments must be a non-negative integer (got "${raw}")` };
      maxExperiments = parsed;
    } else if (arg === "--start") {
      start = true;
    } else if (arg === "--status") {
      status = true;
    } else if (arg === "--reserve-cost") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, reserveCost, error: `--reserve-cost must be a finite non-negative number (got "${raw}")` };
      reserveCost = parsed;
    } else if (arg === "--mission") {
      mission = argv[++i];
      if (!mission) return { tier, timeoutMs: DEFAULT_TIMEOUT_MS, reserveCost, error: "--mission requires a mission id" };
    } else if (arg.startsWith("--")) {
      return { tier, timeoutMs, reserveCost, error: `unknown option "${arg}"` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 0) request = positionals.join(" ");
  return {
    request, project, tier, orchestra, timeoutMs,
    ...(intake ? { intake: true } : {}),
    ...(start ? { start: true } : {}),
    ...(status ? { status: true } : {}),
    ...(baselineOnly ? { baselineOnly: true } : {}),
    ...(resume ? { resume: true } : {}),
    ...(missions ? { missions: true } : {}),
    ...(typeof maxExperiments === "number" ? { maxExperiments } : {}),
    reserveCost,
    ...(mission ? { mission } : {}),
  };
}

export interface EvokRunOptions {
  readonly args: ParsedEvokArgs;
  /** Builds the Pi-backed resolver (overridable in tests / for faux providers). */
  readonly createResolver: (args: ParsedEvokArgs) => Promise<SessionModelResolver>;
  /** Workspace root for isolated per-Run workspaces (default: OS tmpdir). */
  readonly workspaceRoot?: string;
  /** #111: operator-configured retrieval capability for intake (default: none). */
  readonly retrieval?: import("../mission-intake").RetrievalCapability;
  /** Override the intake turn runner (tests); defaults to the skill-led runtime. */
  readonly intakeRunner?: typeof runIntakeTurn;
  /** Independent evaluator contract for the declared Competition (#112). */
  readonly evaluator?: BaselineEvaluator;
  /** Override the start runner (tests); defaults to mission-start. */
  readonly startRunner?: typeof startAuthorizedMission;
  /** Cost reserved before the baseline Run (model-USD); defaults to parser value. */
  readonly reserveCost?: number;
  /** #113: inject the decision boundary (tests); default is the Pi director. */
  readonly director?: MissionDirector;
  /** #114: override the resume runner (tests); defaults to mission-start. */
  readonly resumeRunner?: typeof resumeAuthorizedMission;
  /** #113: disable autonomous continuation (baseline Run only). */
  readonly baselineOnly?: boolean;
  /** #113: bound Experiments after the baseline (defaults to parser value). */
  readonly maxExperiments?: number;
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly stdin?: NodeJS.ReadStream;
  readonly signal?: AbortSignal;
  /** Override tty detection (tests). Production uses `isatty` on stdin. */
  readonly isTty?: (stdin: NodeJS.ReadStream) => boolean;
  /**
   * Override the Pi native TUI launcher (tests). Production starts SDK
   * `InteractiveMode` — not an evoK command table.
   */
  readonly launchNativeTui?: (launch: NativeTuiLaunch) => Promise<void>;
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

  // Reopening a project reads durable records only and must work with no model
  // or auth configuration (AC2): handle --missions before resolver/preflight.
  if (args.missions) {
    return runMissionsList(stdout, stderr, projectReal);
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
  // A fresh runtime per one-shot request keeps every Run with its own session,
  // attempt identity, workspace, and intent store (ADR-0001) — identical
  // requests never replay a stored Run result.
  // Approved evoK prompts/skills are discovered ONCE here against the research
  // project (#110); they are read in place, never copied into Run workspaces.
  let resources: EvokResources;
  try {
    resources = await discoverEvokResources({ projectRoot: projectReal });
  } catch (error) {
    if (error instanceof EvokResourceError) {
      stderr.write(`evok: resource configuration error: ${error.message}\n`);
      return EVOK_EXIT.configError;
    }
    throw error;
  }
  const createRuntime = (): PiAgentRuntime =>
    new PiAgentRuntime({
      workspaceRoot: options.workspaceRoot ?? tmpdir(),
      modelResolver: resolver,
      resources,
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
    const nativeTuiCandidate = args.request === undefined && !args.start && !args.resume && !args.intake && !args.status;
    stdout.write(`tools:   ${args.intake
      ? "intake: read-only project inspection plus the trusted draft-record tool"
      : args.start || (args.request !== undefined && isExplicitStartRequest(args.request))
        ? "baseline: read/grep/find/ls + write/edit in the approved isolated Run workspace (bash only when granted); the project .evok tree is controller-owned"
        : nativeTuiCandidate
          ? "Pi native TUI on a tty (SDK slash commands including /model /new); piped stdin is one headless request"
          : "read-only (read, grep, find, ls) on the project; writes stay in the isolated Run workspace"}\n`);
    stdout.write(nativeTuiCandidate
      ? `         TUI uses Pi defaults at the project root; credentials stay in ~/.pi/agent\n`
      : `         personal Pi prompts/skills/extensions/history and global shared skills are not loaded\n`);
    writeResourceReport(stdout, resources);
  } catch (error) {
    stderr.write(`evok: model configuration error: ${(error as Error).message}\n`);
    return EVOK_EXIT.configError;
  }

  if (args.status) {
    return runMissionStatus(args, stdout, stderr, projectReal);
  }

  if (args.request !== undefined) {
    if (args.resume || (!args.intake && !args.start && isExplicitResumeRequest(args.request).resume)) {
      return runMissionResume(resolver, { ...args, mission: args.mission ?? isExplicitResumeRequest(args.request).missionId }, options, stdout, stderr, projectReal, resources);
    }
    if (args.start || (!args.intake && isExplicitStartRequest(args.request))) {
      return runMissionStart(resolver, args, options, stdout, stderr, projectReal, resources);
    }
    return args.intake
      ? runIntake(resolver, args, args.request, options, stdout, stderr, projectReal, resources)
      : runOne(createRuntime, args, args.request, options, stdout, stderr, projectReal, resources);
  }

  // Mission flags are thin-shell entrypoints, not TUI / Pi slash commands.
  if (args.resume) {
    return runMissionResume(resolver, { ...args, request: "/resume" }, options, stdout, stderr, projectReal, resources);
  }
  if (args.start) {
    return runMissionStart(resolver, { ...args, request: "/start" }, options, stdout, stderr, projectReal, resources);
  }

  const stdin = (options.stdin ?? process.stdin) as NodeJS.ReadStream;
  if ((options.isTty ?? defaultIsTty)(stdin)) {
    if (args.intake) {
      stderr.write("evok: --intake requires request text (one-shot; the native TUI is not a Mission control plane)\n");
      return EVOK_EXIT.usage;
    }
    return runNativeTui(resolver, args, options, stdout, stderr, projectReal);
  }
  const piped = await readAll(stdin);
  const request = piped.trim();
  if (!request) {
    stderr.write("evok: no request text provided\n");
    return EVOK_EXIT.usage;
  }
  if (args.resume || (!args.intake && !args.start && isExplicitResumeRequest(request).resume)) {
    return runMissionResume(resolver, { ...args, request, mission: args.mission ?? isExplicitResumeRequest(request).missionId }, options, stdout, stderr, projectReal, resources);
  }
  if (args.start || (!args.intake && isExplicitStartRequest(request))) {
    return runMissionStart(resolver, { ...args, request }, options, stdout, stderr, projectReal, resources);
  }
  return args.intake
    ? runIntake(resolver, args, request, options, stdout, stderr, projectReal, resources)
    : runOne(createRuntime, args, request, options, stdout, stderr, projectReal, resources);
}

function defaultIsTty(stdin: NodeJS.ReadStream): boolean {
  return isatty((stdin as { fd?: number }).fd ?? 0);
}

/**
 * Tty foreground: Pi SDK native TUI. No evoK slash-command table — `/model`
 * and `/new` stay on InteractiveMode.
 */
async function runNativeTui(
  resolver: SessionModelResolver,
  args: ParsedEvokArgs,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
): Promise<number> {
  if (options.signal?.aborted) {
    stderr.write("evok: interactive session cancelled before the native TUI started\n");
    return EVOK_EXIT.cancelled;
  }
  try {
    const resolved = await resolver.resolve(args.tier);
    stdout.write("interactive: Pi native TUI (SDK slash commands including /model /new; no evoK intercept)\n");
    stdout.write("         session uses Pi defaults at the project root; credentials stay in ~/.pi/agent\n");
    await (options.launchNativeTui ?? launchPiNativeTui)({
      projectRoot,
      tier: args.tier,
      modelRuntime: resolved.modelRuntime,
      model: resolved.modelId,
    });
    return EVOK_EXIT.ok;
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === "AbortError") {
      stderr.write("\nevok: native TUI cancelled\n");
      return EVOK_EXIT.cancelled;
    }
    stderr.write(`evok: native TUI failed: ${(error as Error).message}\n`);
    return EVOK_EXIT.runtimeError;
  }
}

/**
 * Shared Run bound (#111): the same AbortController + --timeout-ms timer +
 * SIGINT wiring runOne uses, so an intake Run is no less cancellable than a
 * foreground request. Returns cleanup the caller runs in finally.
 */
function boundSignal(args: ParsedEvokArgs, external?: AbortSignal): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  const boundMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`Run exceeded bound of ${boundMs}ms`)), boundMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * #111: one skill-led Mission intake turn. The draft is saved under
 * <project>/.evok/missions and presented for review; this path constructs its
 * own runtime with the trusted draft/retrieval tools and reports discussion
 * cost as ordinary model usage. It returns a non-zero code on corruption or
 * runtime failure, but it never dispatches an Experiment (no such tool exists).
 */
async function runIntake(
  resolver: SessionModelResolver,
  args: ParsedEvokArgs,
  message: string,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
  resources: EvokResources,
): Promise<number> {
  if (options.signal?.aborted) {
    stderr.write("evok: intake cancelled before completion; no retry was attempted\n");
    return EVOK_EXIT.cancelled;
  }
  const bound = boundSignal(args, options.signal);
  const workspaceRoot = uniqueWorkspace(options.workspaceRoot);
  try {
    const result = await (options.intakeRunner ?? runIntakeTurn)({
      resolver,
      resources,
      projectRoot,
      message,
      workspaceRoot,
      missionId: args.mission,
      tier: args.tier,
      signal: bound.signal,
      tools: { ...(options.retrieval ? { retrieval: options.retrieval } : {}) },
    });
    stdout.write(`\n${result.text}\n`);
    if (result.draft) {
      const d = result.draft;
      stdout.write(
        `\n-- mission ${d.id} · status draft (unstarted; nothing dispatched) · ready for review: ${result.readyForReview}\n`
        + `   saved: .evok/missions/${d.id}/draft.json\n`
        + `   objective: ${d.objective}\n`
        + `   data: ${d.data.description} · evaluation: ${d.evaluation.method}${d.evaluation.metric ? ` (${d.evaluation.metric})` : ""}\n`
        + `   budget: ${d.budget.total} ${d.budget.units} · outputs: ${d.outputs.join(", ") || "(none yet)"}\n`
        + `   stop: ${d.stopConditions.join(", ") || "(none yet)"}\n`
        + (d.unresolvedPrerequisites.length ? `   unresolved: ${d.unresolvedPrerequisites.join("; ")}\n` : "")
        + `   plan: ${d.plan.baselineHypothesis}\n`
        + `         ${d.plan.tasks.map((t) => t.taskId).join(" → ") || "(no task contracts yet)"}\n`,
      );
    } else {
      stderr.write("evok: no Mission draft was saved; continue the conversation and record the current draft\n");
    }
    stdout.write(
      `-- model usage · tokens ${result.usage.tokens.total} (in ${result.usage.tokens.input} out ${result.usage.tokens.output})`
      + ` · cost ${result.usage.cost.total.toFixed(6)} — discussion is ordinary model usage, not free\n`,
    );
    return EVOK_EXIT.ok;
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === "AbortError" || bound.signal.aborted) {
      stderr.write("\nevok: intake cancelled before completion; no retry was attempted\n");
      return EVOK_EXIT.cancelled;
    }
    if (error instanceof MissionDraftCorruptionError) {
      stderr.write(`evok: mission storage is corrupted and was not overwritten: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if ((error as Error).name === "MissingAuthenticationError") {
      stderr.write(`\nevok: ${(error as Error).message}\n`);
      return EVOK_EXIT.authError;
    }
    stderr.write(`\nevok: intake run failed: ${(error as Error).message}\n`);
    return EVOK_EXIT.runtimeError;
  } finally {
    bound.cleanup();
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** #112: display/reopen the durable Mission state from project-local records. */
async function runMissionStatus(
  args: ParsedEvokArgs,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
): Promise<number> {
  if (!args.mission) {
    stderr.write("evok: --status requires --mission <id>\n");
    return EVOK_EXIT.usage;
  }
  const record = await loadMissionRecord(projectRoot, args.mission).catch(async (error: unknown) => {
    if (error instanceof MissionStartRejectedError) {
      // No accepted Mission yet: fall back to the durable draft for display.
      return { draft: await loadMissionDraft(projectRoot, args.mission!) } as const;
    }
    if (error instanceof MissionRecordCorruptionError) {
      stderr.write(`evok: ${error.message}; the damaged record was not overwritten\n`);
      return { corrupted: true as const };
    }
    throw error;
  });
  if ("corrupted" in record) return EVOK_EXIT.runtimeError;
  if ("draft" in record) {
    const draft = record.draft;
    stdout.write(`-- mission ${draft.id} · status draft (unstarted)\n`);
    stdout.write(`   objective: ${draft.objective}\n`);
    stdout.write(`   budget: ${draft.budget.total} ${draft.budget.units} (declared; nothing consumed by an Experiment)\n`);
    stdout.write(`   intake usage: tokens ${draft.usage.tokens.total} · cost ${draft.usage.cost.total} ${draft.usage.cost.units}\n`);
    return EVOK_EXIT.ok;
  }
  const view = summarizeMission(record);
  stdout.write(`-- mission ${view.id} · status ${view.status}\n`);
  if (view.stopReason) stdout.write(`   stop reason: ${view.stopReason}\n`);
  stdout.write(`   budget: ${view.budget.consumed.toFixed(6)} / ${view.budget.total} ${view.budget.units} consumed · ${view.budget.remaining.toFixed(6)} remaining\n`);
  if (view.experiments > 0) {
    stdout.write(`   experiments after baseline: ${view.experiments} · negative evidence: ${view.negativeEvidence} · director decisions: ${view.decisions}\n`);
  }
  for (const experiment of record.experiments ?? []) {
    const score = typeof experiment.evaluation?.score === "number" ? ` score=${experiment.evaluation!.score}` : "";
    const why = experiment.error ? ` error=${experiment.error}` : experiment.ruleViolations?.length ? ` rules=${experiment.ruleViolations.join(";")}` : "";
    stdout.write(`     - ${experiment.runId} [${experiment.action}] ok=${experiment.ok}${score}${why}\n`);
  }
  if (record.baseline) {
    const run = record.runs[record.baselineRunId!];
    stdout.write(`   baseline run ${record.baselineRunId} · model ${view.model ?? run?.model?.id ?? "unknown"}\n`);
    stdout.write(`   measurement: ok=${record.baseline.evaluation.ok}${typeof record.baseline.evaluation.score === "number" ? ` score=${record.baseline.evaluation.score}` : ""}\n`);
    stdout.write(`   evidence: ${view.evidenceRefs.join(", ")}\n`);
    const runUsage = run?.sessionId ? record.usage.runs.find((line) => line.sessionId === run.sessionId) : undefined;
    if (runUsage) stdout.write(`   run usage: tokens ${runUsage.tokens.total} · cost ${runUsage.cost.total.toFixed(6)} ${record.budget.units}\n`);
  }
  // Intake/discussion usage stays a visible line item across execution (US31).
  stdout.write(`   intake usage: tokens ${record.usage.intake.tokens.total} · cost ${record.usage.intake.cost.total.toFixed(6)} ${record.usage.intake.cost.units}\n`);
  return EVOK_EXIT.ok;
}

/**
 * #112: the single validated start action. Natural-language "/start" and
 * --start share this path; it resolves the displayed Mission (--mission or
 * the only draft under .evok/missions) and dispatches one bounded baseline
 * through the existing Pi runtime with an independent evaluator.
 */
async function runMissionStart(
  resolver: SessionModelResolver,
  args: ParsedEvokArgs,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
  resources: EvokResources,
): Promise<number> {
  let evaluator: BaselineEvaluator | undefined = options.evaluator;
  if (!evaluator) {
    // Production default: the project's declared local evaluation contract
    // (<project>/.evok/evaluation.json). No contract => no measurable baseline.
    const contract = await loadEvaluationContract(projectRoot).catch((error: unknown) => {
      if (error instanceof EvaluationContractError) {
        stderr.write(`evok: ${error.message}\n`);
        return undefined;
      }
      throw error;
    });
    if (!contract) return EVOK_EXIT.configError;
    evaluator = createFileMetricEvaluator(contract);
  }
  let missionId: string | undefined = args.mission;
  if (!missionId) {
    // "Displayed Mission": the single saved draft under the project is the
    // current display target; ambiguity (0 or >1 drafts) must stay a conversation.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(missionsDir(projectRoot), { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => String(entry.name));
    if (ids.length === 0) {
      stderr.write("evok: no reviewed Mission draft in this project; run --intake before /start\n");
      return EVOK_EXIT.usage;
    }
    if (ids.length > 1) {
      stderr.write(`evok: multiple saved Missions (${ids.join(", ")}); name one with --mission <id>\n`);
      return EVOK_EXIT.usage;
    }
    missionId = ids[0]!;
  }

  const bound = boundSignal(args, options.signal);
  // Trusted-side metering is needed ONLY on the real path; an injected
  // startRunner (tests/adapters) brings its own accounting.
  const resolved = options.startRunner ? undefined : await resolver.resolve(args.tier).catch(() => undefined);
  const priceModelCost = resolved
    ? () => (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
        const rates = (resolved.modelId as unknown as { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).cost;
        if (!rates || typeof rates.input !== "number") return undefined; // unknown cost, never a verified zero
        const cost = calculateCost(resolved.modelId, {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } as Parameters<typeof calculateCost>[1]);
        return Number.isFinite(cost?.total) ? cost!.total : undefined;
      }
    : undefined;
  // #113: unless --baseline-only (or an injected test director opts out), the
  // real path continues autonomously via a fresh read-only Pi director per
  // decision. Injected startRunner tests that want baseline behavior omit it.
  const baselineOnly = options.baselineOnly ?? args.baselineOnly ?? false;
  const maxExperiments = options.maxExperiments ?? args.maxExperiments;
  let director: MissionDirector | undefined = options.director;
  if (!options.startRunner && !baselineOnly && director === undefined) {
    director = createPiMissionDirector({
      resources,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources }),
      tier: args.tier,
    });
  }
  try {
    const outcome: StartMissionOutcome = await (options.startRunner ?? startAuthorizedMission)({
      projectRoot,
      missionId,
      authorization: { requested: true, token: args.request ?? "/start", missionSelector: "displayed" },
      resolver,
      resources,
      evaluator,
      tier: args.tier,
      signal: bound.signal,
      reserveCost: options.reserveCost ?? args.reserveCost ?? DEFAULT_RESERVE_COST,
      ...(priceModelCost ? { priceModelCost } : {}),
      ...(director ? { director } : {}),
      ...(typeof maxExperiments === "number" ? { maxExperiments } : {}),
    });
    stdout.write(`\n-- mission ${missionId} run ${outcome.runId} · stop: ${outcome.status}\n`);
    if (outcome.stopReason && outcome.stopReason !== outcome.status) stdout.write(`   reason: ${outcome.stopReason}\n`);
    stdout.write(`   model: ${outcome.model.id}\n`);
    stdout.write(`   measurement: ok=${outcome.evaluation.ok}${typeof outcome.evaluation.score === "number" ? ` score=${outcome.evaluation.score}` : ""}\n`);
    if (outcome.evaluation.ruleViolations?.length) stdout.write(`   rule violations: ${outcome.evaluation.ruleViolations.join("; ")}\n`);
    if (outcome.experiments.length) {
      stdout.write(`   experiments after baseline: ${outcome.experiments.length} (${outcome.experiments.filter((e) => !e.ok).length} negative evidence)\n`);
      for (const experiment of outcome.experiments) {
        stdout.write(`     - ${experiment.runId} [${experiment.action}] ok=${experiment.ok}${typeof experiment.evaluation?.score === "number" ? ` score=${experiment.evaluation!.score}` : ""}\n`);
      }
    }
    stdout.write(`   evidence: .evok/missions/${missionId}/runs/\n`);
    stdout.write(`   budget: ${outcome.budget.consumed.toFixed(6)} / ${outcome.budget.total} ${outcome.budget.units} consumed · ${outcome.budget.remaining.toFixed(6)} remaining\n`);
    const decisionCalls = outcome.record?.usage?.decisions?.length ?? 0;
    const meteredRun = outcome.record?.usage?.runs?.[outcome.record.usage.runs.length - 1]?.cost.total;
    stdout.write(`   usage: tokens ${outcome.usage.tokens.total} · metered cost ${(meteredRun ?? outcome.usage.cost.total).toFixed(6)} · ${decisionCalls} decision call(s) (intake usage stays visible via --status)\n`);
    return EVOK_EXIT.ok;
  } catch (error) {
    if (bound.signal.aborted || (error as Error).name === "AbortError") {
      stderr.write("\nevok: baseline interrupted; the Mission is recorded as interrupted and stays blocked until recovery\n");
      return EVOK_EXIT.cancelled;
    }
    if (error instanceof MissionStartRejectedError) {
      stderr.write(`evok: start refused: ${error.message}\n`);
      return EVOK_EXIT.usage;
    }
    if (error instanceof MissionControllerConflictError) {
      stderr.write(`evok: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof BudgetExhaustedError) {
      stderr.write(`evok: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof DirectorDecisionFailedError) {
      stderr.write(`evok: the decision-model run failed: ${(error as Error).message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof DirectorBlockedError) {
      stderr.write(`evok: autonomous continuation stopped (no invalid proposal was executed): ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof EvaluatorFailureError) {
      stderr.write(`evok: independent evaluator failed; no score was produced: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof MissionRecordCorruptionError || error instanceof EvaluationContractError) {
      stderr.write(`evok: mission storage or evaluation contract is corrupted and was not overwritten: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if ((error as Error).name === "MissingAuthenticationError") {
      stderr.write(`\nevok: ${(error as Error).message}\n`);
      return EVOK_EXIT.authError;
    }
    stderr.write(`\nevok: baseline failed: ${(error as Error).message}\n`);
    return EVOK_EXIT.runtimeError;
  } finally {
    bound.cleanup();
  }
}

/** #114: reopen a project — list unfinished Missions and unstarted drafts. */
async function runMissionsList(stdout: Out, stderr: Out, projectRoot: string): Promise<number> {
  const view = await listUnfinishedMissions(projectRoot).catch((error: unknown) => {
    stderr.write(`evok: ${(error as Error).message}; the damaged record was not overwritten\n`);
    return { failed: true as const };
  });
  if ("failed" in view) return EVOK_EXIT.runtimeError;
  if (view.missions.length === 0 && view.drafts.length === 0) {
    stdout.write(`-- no Missions in this project (run --intake to draft one)\n`);
    return EVOK_EXIT.ok;
  }
  if (view.missions.length > 0) {
    stdout.write(`-- Missions (newest activity first)\n`);
    for (const m of view.missions) {
      const tag = m.resumable ? "resumable" : "stopped (not resumable)";
      stdout.write(`   ${m.id} · ${m.status} · ${tag}\n`);
      stdout.write(`     progress: baseline ${m.hasBaseline ? "measured" : "not measured"} · ${m.experiments} experiment(s) · ${m.negativeEvidence} negative evidence\n`);
      stdout.write(`     budget: ${m.consumedBudget.toFixed(6)} / ${m.totalBudget} ${m.units} consumed · ${m.remainingBudget.toFixed(6)} remaining\n`);
      if (m.stopReason) stdout.write(`     stop/blocker: ${m.stopReason}\n`);
    }
  }
  if (view.drafts.length > 0) {
    stdout.write(`-- unstarted drafts (intake resumes the conversation, not a Run): ${view.drafts.map((d) => d.id).join(", ")}\n`);
  }
  stdout.write(`-- resume explicitly with: evok /resume --mission <id> (status questions never resume)\n`);
  return EVOK_EXIT.ok;
}

/**
 * #114: the validated RESUME action. Natural-language "resume mission <id>"
 * and /resume share this path; it reconstructs from durable records, reuses
 * confirmed results, reconciles unconfirmed work, and continues autonomously
 * with remaining budget — no intake repeat, no budget restore.
 */
async function runMissionResume(
  resolver: SessionModelResolver,
  args: ParsedEvokArgs,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
  resources: EvokResources,
): Promise<number> {
  let evaluator: BaselineEvaluator | undefined = options.evaluator;
  if (!evaluator) {
    const contract = await loadEvaluationContract(projectRoot).catch((error: unknown) => {
      if (error instanceof EvaluationContractError) {
        stderr.write(`evok: ${error.message}\n`);
        return undefined;
      }
      throw error;
    });
    if (!contract) return EVOK_EXIT.configError;
    evaluator = createFileMetricEvaluator(contract);
  }
  let missionId: string | undefined = args.mission;
  if (!missionId) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(missionsDir(projectRoot), { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => String(entry.name));
    if (ids.length === 0) {
      stderr.write("evok: no Mission in this project to resume; run --intake then /start first\n");
      return EVOK_EXIT.usage;
    }
    if (ids.length > 1) {
      stderr.write(`evok: multiple saved Missions (${ids.join(", ")}); name one with --mission <id>\n`);
      return EVOK_EXIT.usage;
    }
    missionId = ids[0]!;
  }

  const bound = boundSignal(args, options.signal);
  const resolved = options.resumeRunner ? undefined : await resolver.resolve(args.tier).catch(() => undefined);
  const priceModelCost = resolved
    ? () => (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
        const rates = (resolved.modelId as unknown as { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).cost;
        if (!rates || typeof rates.input !== "number") return undefined;
        const cost = calculateCost(resolved.modelId, {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } as Parameters<typeof calculateCost>[1]);
        return Number.isFinite(cost?.total) ? cost!.total : undefined;
      }
    : undefined;
  // A resume ALWAYS needs the autonomous director; --baseline-only is a start
  // option and does not apply. The Pi-backed director is the real default.
  let director: MissionDirector | undefined = options.director;
  if (!options.resumeRunner && director === undefined) {
    director = createPiMissionDirector({
      resources,
      runtimeFactory: (workspaceRoot) => new PiAgentRuntime({ workspaceRoot, modelResolver: resolver, resources }),
      tier: args.tier,
    });
  }
  try {
    const outcome = await (options.resumeRunner ?? resumeAuthorizedMission)({
      projectRoot,
      missionId,
      authorization: { requested: true, token: args.request ?? "/resume", missionSelector: "displayed" },
      resolver,
      resources,
      evaluator,
      tier: args.tier,
      signal: bound.signal,
      reserveCost: options.reserveCost ?? args.reserveCost ?? DEFAULT_RESERVE_COST,
      ...(priceModelCost ? { priceModelCost } : {}),
      director,
      ...(typeof options.maxExperiments === "number" ? { maxExperiments: options.maxExperiments }
        : typeof args.maxExperiments === "number" ? { maxExperiments: args.maxExperiments } : {}),
    });
    const reconciliation = (outcome as unknown as { reconciliation?: { adoptedRunIds: readonly string[]; remeasuredRunIds: readonly string[]; abandonedIntents: readonly { runId: string }[] } }).reconciliation;
    if (reconciliation) {
      stdout.write(`\n-- mission ${missionId} resumed from durable records\n`);
      stdout.write(`   adopted confirmed runs (no duplicate work): ${reconciliation.adoptedRunIds.join(", ") || "(none)"}\n`);
      stdout.write(`   independently re-measured from durable snapshots: ${reconciliation.remeasuredRunIds.join(", ") || "(none)"}\n`);
      stdout.write(`   unconfirmed intents abandoned as Negative Evidence: ${reconciliation.abandonedIntents.map((a) => a.runId).join(", ") || "(none)"}\n`);
    }
    stdout.write(`-- run ${outcome.runId} · stop: ${outcome.status}\n`);
    if (outcome.stopReason && outcome.stopReason !== outcome.status) stdout.write(`   reason: ${outcome.stopReason}\n`);
    stdout.write(`   model: ${outcome.model.id}\n`);
    stdout.write(`   measurement: ok=${outcome.evaluation.ok}${typeof outcome.evaluation.score === "number" ? ` score=${outcome.evaluation.score}` : ""}\n`);
    if (outcome.experiments.length) {
      stdout.write(`   experiments on record: ${outcome.experiments.length} (${outcome.experiments.filter((e) => !e.ok).length} negative evidence)\n`);
    }
    stdout.write(`   evidence: .evok/missions/${missionId}/runs/\n`);
    stdout.write(`   budget: ${outcome.budget.consumed.toFixed(6)} / ${outcome.budget.total} ${outcome.budget.units} consumed · ${outcome.budget.remaining.toFixed(6)} remaining\n`);
    return EVOK_EXIT.ok;
  } catch (error) {
    if (bound.signal.aborted || (error as Error).name === "AbortError") {
      stderr.write("\nevok: resume interrupted; confirmed results are retained and unconfirmed work is marked for the next reconciliation\n");
      return EVOK_EXIT.cancelled;
    }
    if (error instanceof MissionResumeRejectedError || error instanceof MissionStartRejectedError) {
      stderr.write(`evok: resume refused: ${(error as Error).message}\n`);
      return EVOK_EXIT.usage;
    }
    if (error instanceof MissionControllerConflictError) {
      stderr.write(`evok: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof ReconciliationBlockedError || error instanceof MissionRecordCorruptionError) {
      stderr.write(`evok: recovery blocked on damaged state; nothing was replayed or overwritten: ${(error as Error).message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof BudgetExhaustedError) {
      stderr.write(`evok: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof DirectorBlockedError) {
      stderr.write(`evok: autonomous continuation stopped (no invalid proposal was executed): ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof DirectorDecisionFailedError) {
      stderr.write(`evok: the decision-model run failed: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if (error instanceof EvaluatorFailureError) {
      stderr.write(`evok: independent evaluator failed; no score was produced: ${error.message}\n`);
      return EVOK_EXIT.runtimeError;
    }
    if ((error as Error).name === "MissingAuthenticationError") {
      stderr.write(`\nevok: ${(error as Error).message}\n`);
      return EVOK_EXIT.authError;
    }
    stderr.write(`\nevok: resume failed: ${(error as Error).message}\n`);
    return EVOK_EXIT.runtimeError;
  } finally {
    bound.cleanup();
  }
}

async function runOne(
  createRuntime: () => PiAgentRuntime,
  args: ParsedEvokArgs,
  requestText: string,
  options: EvokRunOptions,
  stdout: Out,
  stderr: Out,
  projectRoot: string,
  resources: EvokResources,
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
        workspace: { path: workspaceParent, isolated: true, approved: true, readRoots: [projectRoot, ...resources.readRoots] },
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

const SCOPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  project: "project .evok",
  "project-shared": "project .agents",
  user: "user ~/.evok",
  bundled: "evok bundled",
});

/**
 * Startup resource report (#110, US21/US23): which prompt sources won and the
 * name/description/location of every discovered skill. Metadata only — skill
 * bodies are never printed — plus every SDK collision/invalid-skill diagnostic.
 */
function writeResourceReport(stdout: Out, resources: EvokResources): void {
  const system = resources.systemPromptPath ? resources.systemPromptPath : "(SDK built-in default)";
  const append = resources.appendSystemPromptPaths[0] ?? "(none)";
  stdout.write(`system:  ${system}\n`);
  stdout.write(`append:  ${append} (project before user; only one copy)\n`);
  if (resources.skills.length === 0) {
    stdout.write("skills:  none discovered\n");
  } else {
    stdout.write("skills:  metadata only (bodies are read on demand, in place)\n");
    for (const entry of resources.skills) {
      stdout.write(`         - ${entry.skill.name} [${SCOPE_LABEL[entry.scope] ?? entry.scope}]\n`);
      stdout.write(`             ${entry.skill.description}\n`);
      stdout.write(`             ${entry.skill.filePath}\n`);
    }
  }
  for (const diagnostic of resources.diagnostics) {
    const target = diagnostic.collision
      ? `${diagnostic.message}: ${diagnostic.collision.winnerPath} wins over ${diagnostic.collision.loserPath}`
      : `${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`;
    stdout.write(`resource ${diagnostic.type}: ${target}\n`);
  }
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
