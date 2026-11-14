#!/usr/bin/env bun
/**
 * Portable Auto-Research Arena (`entry_type: "cli"`) launcher for evoK.
 *
 * Bridges AutoArena's `AUTOARENA_CONTEXT` handoff to evoK's standard Mission
 * mainline (`runEvok` `--start` / `--resume` + `project-evaluator.ts`), strips
 * `AUTOARENA_CONTEXT` from `process.env` before spawning any candidate session,
 * emits a machine-readable `evok-autoarena-summary.json`, and calls AutoArena
 * `finish` only when the Mission reaches a settled terminal state.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EVOK_EXIT, parseEvokArgs, runEvok } from "../src/cli/evok-cli";
import {
  defaultAutoArenaCommandRunner,
  stageAutoArenaMissionProject,
} from "../src/competition/auto-research-arena";
import { createEvokModelResolver, type OrchestraConfig } from "../src/evok-model";
import { recordRetainedState } from "../src/mission/mission-director";
import { loadMissionRecord } from "../src/mission/mission-start";

interface AdapterSettings {
  readonly maxExperiments?: number;
  readonly modelBudgetUsd?: number;
  readonly reserveCost?: number;
  readonly tier?: string;
  readonly directorTier?: string;
  readonly thinking?: string;
  readonly orchestra?: string;
}

function parseAdapterCli(argv: readonly string[]): {
  readonly check: boolean;
  readonly resume: boolean;
  readonly contextPath?: string;
  readonly settingsPath?: string;
  readonly maxExperiments?: number;
} {
  let check = false;
  let resume = false;
  let contextPath: string | undefined;
  let settingsPath: string | undefined;
  let maxExperiments: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--check") check = true;
    else if (arg === "--resume") resume = true;
    else if (arg === "--context") contextPath = argv[++i];
    else if (arg === "--settings") settingsPath = argv[++i];
    else if (arg === "--max-experiments") maxExperiments = Number(argv[++i]);
  }
  return {
    check,
    resume,
    ...(contextPath ? { contextPath } : {}),
    ...(settingsPath ? { settingsPath } : {}),
    ...(maxExperiments !== undefined && Number.isFinite(maxExperiments) ? { maxExperiments } : {}),
  };
}

async function loadSettings(path: string | undefined): Promise<AdapterSettings> {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as AdapterSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function loadOrchestra(path: string | undefined): Promise<OrchestraConfig | null> {
  if (!path) return null;
  return JSON.parse(await readFile(resolve(path), "utf8")) as OrchestraConfig;
}

const cli = parseAdapterCli(process.argv.slice(2));

if (cli.check) {
  process.stdout.write("evoK Auto-Research Arena adapter ready\n");
  process.exit(0);
}

const contextPath = cli.contextPath ?? process.env.AUTOARENA_CONTEXT;
delete process.env.AUTOARENA_CONTEXT;
delete process.env.PYTHONPATH;
if (process.env.PATH) {
  process.env.PATH = process.env.PATH
    .split(":")
    .filter((entry) => !entry.includes(".local/environments/"))
    .join(":");
}

if (!contextPath) {
  process.stderr.write("evok-autoarena: missing AUTOARENA_CONTEXT or --context <path>\n");
  process.exit(EVOK_EXIT.usage);
}

const settings = await loadSettings(cli.settingsPath);
const staged = await stageAutoArenaMissionProject({
  contextPath: resolve(contextPath),
  ...(settings.modelBudgetUsd !== undefined ? { modelBudgetUsd: settings.modelBudgetUsd } : {}),
});

const missionJsonExists = await readFile(
  join(staged.projectRoot, ".evok", "missions", staged.missionId, "mission.json"),
  "utf8",
).then(() => true, () => false);

const shouldResume = cli.resume || missionJsonExists;
const defaultMaxExperiments = Math.max(1, staged.task.budget.max_launches - 1);
const maxExperiments = cli.maxExperiments ?? settings.maxExperiments ?? defaultMaxExperiments;

const evokArgv: string[] = [
  shouldResume ? "--resume" : "--start",
  "--project", staged.projectRoot,
  "--mission", staged.missionId,
  "--max-experiments", String(maxExperiments),
  ...(settings.tier ? ["--tier", settings.tier] : []),
  ...(settings.directorTier ? ["--director-tier", settings.directorTier] : []),
  ...(settings.thinking ? ["--thinking", settings.thinking] : []),
  ...(settings.reserveCost !== undefined ? ["--reserve-cost", String(settings.reserveCost)] : []),
  ...(settings.orchestra ? ["--orchestra", resolve(settings.orchestra)] : []),
];

const parsedArgs = parseEvokArgs(evokArgv);
const exitCode = await runEvok({
  args: parsedArgs,
  createResolver: async (parsed) =>
    createEvokModelResolver({ orchestra: await loadOrchestra(parsed.orchestra) }),
});

const record = await loadMissionRecord(staged.projectRoot, staged.missionId).catch(() => undefined);
const retained = record ? recordRetainedState(record) : undefined;
const summaryPath = join(staged.context.workspace, "evok-autoarena-summary.json");
await mkdir(dirname(summaryPath), { recursive: true });
await writeFile(
  summaryPath,
  `${JSON.stringify({
    schema: "evok/autoarena-run-summary/1",
    missionId: staged.missionId,
    taskId: staged.task.task_id,
    targetMetric: staged.task.objective.target.metric,
    targetDirection: staged.task.objective.target.direction,
    exitCode,
    status: record?.status ?? "unstarted",
    stopReason: record?.stopReason ?? null,
    bestRelativeImprovement: retained?.currentBest?.score ?? null,
    bestRunId: retained?.currentBest?.runId ?? null,
    scoreboard: retained?.scoreboard ?? [],
    experimentsTotal: record?.experiments?.length ?? 0,
    budget: record?.budget ?? null,
    usage: record?.usage ?? null,
  }, null, 2)}\n`,
  "utf8",
);

if (exitCode === EVOK_EXIT.ok && record) {
  const finishRes = await defaultAutoArenaCommandRunner({
    command: [
      ...staged.context.finish,
      "--reason",
      `evoK Mission ${staged.missionId} finished (${record.status}): ${record.stopReason ?? record.status}`,
    ],
    cwd: staged.context.runner_root,
  });
  if (finishRes.exitCode !== 0) {
    process.stderr.write(`evok-autoarena: finish failed: ${finishRes.stderr.trim()}\n`);
    process.exitCode = EVOK_EXIT.runtimeError;
  }
} else {
  process.exitCode = exitCode;
}
