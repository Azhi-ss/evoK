import { randomUUID } from "node:crypto";
import { open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRoleContext } from "./role-context";
import { validateMemorySlice } from "./memory-slice";
import { validateWorkerAction, type WorkerAction, type WorkerProfile } from "./pi-child-protocol";

export interface WorkerReceipt {
  nativeRunId: string;
  action: WorkerAction;
  toolTurns: number;
  remainingToolTurns: number;
}

export async function readWorkerJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function optionalJson(path: string) {
  try {
    return await readWorkerJson(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
function isDeadOwner(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
async function observedRun(
  stateDir: string,
  roleRunId: string,
  expectedRunId?: string,
): Promise<string | undefined> {
  const started = await optionalJson(join(stateDir, roleRunId + ".started.json"));
  if (!started || (expectedRunId && started.nativeRunId !== expectedRunId)) return undefined;
  if (!/^[a-f0-9-]{36}$/.test(started.nativeRunId)) throw Error("invalid native run identity");
  const expected = join(stateDir, "native/async-subagent-runs", started.nativeRunId);
  // macOS can report /var and /private/var for the same durable run.
  const canonical = await realpath(started.asyncDir);
  if (canonical !== (await realpath(expected))) throw Error("unexpected native evidence directory");
  const status = await optionalJson(join(canonical, "status.json"));
  const proof = status?.processTerminal;
  if (
    status?.runId !== started.nativeRunId ||
    status.state !== "complete" ||
    proof?.state !== "observed" ||
    proof.runId !== started.nativeRunId ||
    !proof.instances?.some(
      (exit: { kind: string; processInstanceId: string }) =>
        exit.kind === "runner" && exit.processInstanceId === proof.runnerProcessInstanceId,
    )
  )
    return undefined;
  return started.nativeRunId;
}
export async function turnsLeft(stateDir: string): Promise<number> {
  const rounds = (await readdir(stateDir)).filter((name) => name.endsWith(".turns.json"));
  const counts = await Promise.all(rounds.map((name) => readWorkerJson(join(stateDir, name))));
  if (counts.some((n) => !Number.isInteger(n) || n < 0 || n > 8))
    throw Error("invalid worker tool-turn receipt");
  return Math.max(0, 8 - counts.reduce((sum, n) => sum + n, 0));
}
export interface WorkerAttempt {
  identity: string;
  ownerPid: number;
  taskRunId: string;
  roleRunId: string;
  remainingToolTurns: number;
  profile: WorkerProfile;
  tools: string[];
}
async function readAction(
  stateDir: string,
  attempt: WorkerAttempt,
  nativeRunId: string,
): Promise<WorkerReceipt> {
  const raw = await readWorkerJson(join(stateDir, attempt.roleRunId + ".action.json"));
  const action = validateWorkerAction(raw.name, raw.args, attempt.profile, attempt.tools);
  const toolTurns = await readWorkerJson(join(stateDir, attempt.roleRunId + ".turns.json"));
  if (!Number.isInteger(toolTurns) || toolTurns < 1 || toolTurns > attempt.remainingToolTurns)
    throw Error("invalid worker tool-turn receipt");
  return { nativeRunId, action, toolTurns, remainingToolTurns: attempt.remainingToolTurns - toolTurns };
}
export async function commitWorkerReceipt(
  stateDir: string,
  attempt: WorkerAttempt,
  nativeRunId: string,
): Promise<WorkerReceipt> {
  const receipt = await readAction(stateDir, attempt, nativeRunId);
  const target = join(stateDir, "native-history.json"),
    tmp = target + "." + randomUUID();
  await writeFile(
    tmp,
    JSON.stringify({ identity: attempt.identity, taskRunId: attempt.taskRunId, ...receipt }),
    {
      mode: 0o600,
    },
  );
  await rename(tmp, target);
  return receipt;
}

/** Return the exact completed turn after a host crash. No model call occurs on this path. */
export async function recoverWorkerReceipt(
  stateDir: string,
  identity: string,
  taskRunId: string,
  resumeRunId?: string,
): Promise<WorkerReceipt | undefined> {
  const active = join(stateDir, "active.json");
  const attempt: WorkerAttempt | undefined = await optionalJson(active);
  if (!attempt) {
    const last = await optionalJson(join(stateDir, "native-history.json"));
    if (last?.identity !== identity || last.taskRunId !== taskRunId) return undefined;
    const { nativeRunId, action, toolTurns, remainingToolTurns } = last;
    return { nativeRunId, action, toolTurns, remainingToolTurns };
  }
  const replay = attempt.taskRunId === taskRunId;
  if (attempt.identity !== identity || (!replay && !resumeRunId) || !isDeadOwner(attempt.ownerPid))
    throw Error("another or unverified worker turn still owns this node");
  const lockPath = join(stateDir, attempt.roleRunId + ".recovering");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    if ((await readWorkerJson(active)).roleRunId !== attempt.roleRunId)
      throw Error("worker ownership changed");
    const nativeRunId = await observedRun(stateDir, attempt.roleRunId, replay ? undefined : resumeRunId);
    if (!nativeRunId) throw Error("worker termination or delivery is unconfirmed");
    const result = await commitWorkerReceipt(stateDir, attempt, nativeRunId);
    await rm(active);
    return replay ? result : undefined;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export interface InspectWorkerRequest {
  stateDir: string;
  nodeId: string;
  taskRunId: string;
  nativeRunId?: string;
}

/** Scheduler recovery probe. Only inspect the original paid turn; no launch, lease, or journal writes. */
export async function inspectPiWorkerReceipt({
  stateDir,
  nodeId,
  taskRunId,
  nativeRunId,
}: InspectWorkerRequest): Promise<WorkerReceipt | undefined> {
  const files = await readdir(stateDir).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const active = await optionalJson(join(stateDir, "active.json"));
  if (active && (active.nodeId !== nodeId || active.taskRunId !== taskRunId || !isDeadOwner(active.ownerPid)))
    return undefined;
  let found: WorkerReceipt | undefined;
  for (const file of files.filter((f) => f.endsWith(".launch.json"))) {
    const launch = await readWorkerJson(join(stateDir, file));
    const attempt = launch.attempt;
    if (!attempt || attempt.nodeId !== nodeId || attempt.taskRunId !== taskRunId) continue;
    if (file !== attempt.roleRunId + ".launch.json" || !/^[a-f0-9-]{36}$/.test(attempt.roleRunId))
      throw Error("worker attempt identity mismatch");
    const payload = JSON.parse(launch.params.task ?? launch.params.message);
    const memory = validateMemorySlice(payload.memorySlice),
      context = validateRoleContext(payload.roleContext);
    const binding = context.audit;
    if (
      binding.targetAgentId !== nodeId ||
      memory.targetAgentId !== nodeId ||
      binding.runId !== taskRunId ||
      memory.runId !== taskRunId ||
      binding.memoryDigest !== memory.digest ||
      binding.taskId !== memory.taskId ||
      binding.missionId !== memory.missionId ||
      JSON.stringify(launch.registration.definition.tools) !== JSON.stringify(attempt.tools) ||
      (context.role === "reviewer") !== (attempt.profile === "review")
    )
      throw Error("native receipt has a different origin or authority");
    const proved = await observedRun(stateDir, attempt.roleRunId, nativeRunId);
    if (!proved) continue;
    if (found) throw Error("multiple native deliveries claim this turn");
    found = await readAction(stateDir, attempt, proved);
  }
  return found;
}
