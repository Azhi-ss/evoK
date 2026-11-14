/**
 * The controller's EXECUTE stage (PRD §4 Stage 4; #253/#257).
 *
 * One authorized attempt becomes one bounded candidate Run: a fresh
 * runtime/session/workspace per attempt (ADR-0001) → the brokered role context
 * → the execution intent → the Pi call → the immutable snapshot adoption → the
 * independent measurement → raw-usage pricing → the per-Run ledger events.
 *
 * What is NOT here, by design:
 *
 * - **No research judgement.** The Director decides what to try and the
 *   controller decides whether to keep going; this module never picks an
 *   action, an objective or a direction.
 * - **No finalization.** It returns an `AttemptOutcome` plus the record that
 *   proves what happened; `run-finalization.ts` is what adopts a measured
 *   outcome into Mission state (baseline record, Experiment trail, state
 *   version, derived memory).
 * - **No terminal decision.** Budget exhaustion, unknown cost, evaluator
 *   failure and abort still persist + release the lock before throwing, exactly
 *   as before the extraction; the recovery tests pin each of those commit
 *   points (PRD §6).
 *
 * Boundary owners are unchanged: the harness collects, validates and
 * content-addresses the workspace and issues the receipt (`commitSnapshot`'s
 * B2 seam); the Mission adopts it, attributes usage and settles the budget
 * (B3). This stage INVOKES the independent evaluator port on the immutable
 * snapshot; it never scores anything itself and never judges a result.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime, type AgentRuntimeResult } from "../execution/pi-agent-runtime";
import type { DraftPlanTask } from "./mission-draft";
import { createTaskArtifactEvaluator } from "./task-evaluator";
import type { ContextBroker } from "../execution/context-broker";
import type { ResourceRequest } from "../execution/resource-lease";
import type { SandboxPolicy } from "../execution/security-boundary";
import {
  BudgetExhaustedError,
  EvaluatorFailureError,
  atomicWriteJson,
  baselineResultPath,
  commitSnapshot,
  withEvent,
  type BaselineMeasurement,
  type BaselineResultRecord,
  type MissionRecord,
  type StartMissionOptions,
  type UsageLine,
} from "./mission-start";

const RUNS_DIRNAME = "runs";
const RESULT_FILENAME = "result.json";

/** Outcome of one candidate dispatch (shared by baseline and each Experiment). */
export type AttemptOutcome =
  | { readonly kind: "run-failed"; readonly runId: string; readonly attempt: number; readonly error: string }
  | {
      readonly kind: "measured";
      readonly runId: string;
      readonly attempt: number;
      readonly measurement: BaselineMeasurement;
      readonly budgetCrossed: boolean;
      readonly evidenceRefs: readonly string[];
      readonly candidateId: string;
      readonly snapshotDigest: string;
      readonly evaluator: { readonly id: string; readonly version: string };
    };

/** Everything one dispatch must not re-derive from the live options. */
export interface RunDispatchPorts {
  readonly options: StartMissionOptions;
  readonly missionId: string;
  readonly broker?: ContextBroker;
  readonly roleTools: readonly string[];
  readonly allowBash: boolean;
  /** Resource request of the prepared competition context, if any. */
  readonly competitionResourceRequest?: ResourceRequest;
  /** The controller's single abort owner (`unknown` is never success). */
  readonly signal?: AbortSignal;
  readonly aborted: () => boolean;
  readonly abortError: (label: string) => Error;
  readonly now: () => string;
  readonly persist: (projectRoot: string, record: MissionRecord) => Promise<void>;
  readonly releaseLock: () => Promise<void>;
}

export interface DispatchAttemptArgs {
  readonly current: MissionRecord;
  readonly runId: string;
  readonly attempt: number;
  readonly taskId: string;
  readonly branchId: string;
  readonly roleName: string;
  readonly instructions: string;
  readonly objective: string;
  readonly expectedOutputs: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly reserve: number;
  readonly kind: "baseline" | "experiment";
  readonly task: DraftPlanTask;
}

/**
 * Dispatch ONE bounded candidate Run through the existing Pi execution path.
 * Run failures and non-ok measurements are RETURNED (the loop retains them as
 * evidence); budget/unknown-cost/evaluator/abort conditions are terminal and
 * persist + release the lock before throwing.
 */
export async function dispatchCandidateAttempt(
  ports: RunDispatchPorts,
  args: DispatchAttemptArgs,
): Promise<{ record: MissionRecord; outcome: AttemptOutcome; result?: AgentRuntimeResult }> {
  const { options, missionId, broker, roleTools, allowBash, competitionResourceRequest, signal, aborted, abortError, now, persist, releaseLock } = ports;

  let r = args.current;
  if (aborted()) {
    r = withEvent(r, { type: "RUN_INTERRUPTED", at: now(), detail: { runId: args.runId } }, {
      status: "interrupted",
      stopReason: `user interruption before the ${args.kind} Run; result unconfirmed until recovery`,
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "interrupted", finishedAt: now() } },
    });
    await persist(options.projectRoot, r);
    await releaseLock();
    throw abortError(args.kind);
  }

  const available = r.budget.remaining - r.reserved;
  if (available + 1e-12 < args.reserve) {
    r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { runId: args.runId, available, requested: args.reserve } }, {
      status: "budget-exhausted",
      stopReason: `budget exhausted before ${args.kind} dispatch: ${available} ${r.budget.units} available, ${args.reserve} reserved; no further dispatch`,
    });
    await persist(options.projectRoot, r);
    await releaseLock();
    throw new BudgetExhaustedError(r.stopReason!);
  }

  // Assemble the injectable context BEFORE any durable dispatch: rules for
  // THIS competition and this agent's audience, bound to this Run/agent, plus
  // the optional memory slice. A tampered/foreign context fails closed here,
  // leaving no persisted intent behind.
  const targetAgentId = `${args.roleName}@${args.runId}`;
  const brokered = broker
    ? await broker.assemble({
        missionId: missionId,
        taskId: args.taskId,
        runId: args.runId,
        targetAgentId,
        role: "researcher",
        objective: args.objective,
        ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
        ...(competitionResourceRequest ? { resourceRequest: competitionResourceRequest } : {}),
        allowedPaths: ["."],
        tools: roleTools,
      })
    : undefined;
  const roleContext = brokered?.context.kind === "role" ? brokered.context.roleContext : undefined;
  const consumedResearchMemory = brokered?.memorySlice?.research
    ? {
        snapshotId: brokered.memorySlice.research.snapshotId,
        snapshotDigest: brokered.memorySlice.research.digest,
        sliceDigest: brokered.memorySlice.digest,
        ledgerRevision: brokered.memorySlice.research.ledgerRevision,
      }
    : undefined;

  r = { ...r, reserved: r.reserved + args.reserve };
  const intentId = `${args.runId}:intent`;
  r = withEvent(r, { type: "EXECUTION_INTENT_PERSISTED", at: now(), detail: { runId: args.runId, intentId, attempt: args.attempt } }, {
    runs: { ...r.runs, [args.runId]: {
      runId: args.runId, intentId, attempt: args.attempt, taskId: args.task.taskId, status: "dispatched", workspace: "", dispatchedAt: now(),
      ...(consumedResearchMemory ? { researchMemory: consumedResearchMemory } : {}),
    } },
  });
  await persist(options.projectRoot, r);

  const workspaceParent = join(
    options.workspaceRoot ?? tmpdir(),
    `evok-${args.kind}-${missionId.replace(/[^a-z0-9._-]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const disposeWorkspace = () => rm(workspaceParent, { recursive: true, force: true }).catch(() => {});

  // A fresh runtime per attempt: no reused session, workspace, or attempt id.
  const sandbox: SandboxPolicy = { allowBash, network: options.network ?? "none" };
  const runtime = (options.runtimeFactory ?? ((workspaceRoot: string, sandbox: SandboxPolicy) => new PiAgentRuntime({
    workspaceRoot,
    modelResolver: options.resolver,
    resources: options.resources,
    sandbox,
  })))(workspaceParent, sandbox);

  let result: AgentRuntimeResult;
  try {
    result = await runtime.execute(
      {
        task: {
          objective: args.objective,
          // Non-sensitive task identity only. Rules and execution constraints
          // reach the agent through the brokered role context or the sandbox
          // — never as a broadcast array on the generic task.
          constraints: { missionId: missionId, runId: args.runId, taskId: args.taskId },
          expectedOutputs: args.expectedOutputs,
        },
        role: {
          name: args.roleName,
          instructions: args.instructions,
          tools: roleTools,
          allowCodingTools: true,
          ...(broker ? { audience: "researcher" as const } : {}),
          ...(allowBash ? { allowTestExecution: true } : {}),
        },
        ...(roleContext !== undefined
          ? {
              targetAgentId: targetAgentId,
              roleContext,
              ...(brokered?.memorySlice ? { memorySlice: brokered.memorySlice } : {}),
            }
          : {}),
        workspace: {
          path: join(workspaceParent, args.kind),
          isolated: true,
          approved: true,
          readRoots: [options.projectRoot, ...options.resources.readRoots],
          sandbox: {
            allowBash,
            network: options.network ?? "none",
            allowedTools: roleTools,
            protectedPaths: [
              join(options.projectRoot, ".evok"),
              join(options.projectRoot, ".agents"),
              getAgentDir(),
            ],
            ...(options.resources.userRoot
              ? { credentialPaths: [options.resources.userRoot, getAgentDir()] }
              : { credentialPaths: [getAgentDir()] }),
          },
        },
        tier: options.tier ?? "default",
        intentId,
        identity: { branchId: args.branchId, runId: args.runId, attempt: args.attempt, workspaceId: workspaceParent, fencingToken: args.attempt },
      },
      signal,
    );
  } catch (error) {
    await disposeWorkspace();
    if ((error as Error).name === "AbortError" || aborted()) {
      r = withEvent(r, { type: "RUN_INTERRUPTED", at: now(), detail: { runId: args.runId } }, {
        status: "interrupted",
        stopReason: `user interruption during the ${args.kind} Run; result unconfirmed until recovery`,
        runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "interrupted", finishedAt: now() } },
      });
      await persist(options.projectRoot, r);
      await releaseLock();
      throw abortError(args.kind);
    }
    const message = error instanceof Error ? error.message : String(error);
    r = withEvent(r, { type: "RUN_FAILED", at: now(), detail: { runId: args.runId, error: message } }, {
      reserved: Math.max(0, r.reserved - args.reserve),
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "failed", error: message, finishedAt: now() } },
    });
    return { record: r, outcome: { kind: "run-failed", runId: args.runId, attempt: args.attempt, error: message } };
  }

  // M-d (#245): every served-card read of a confirmed Run is a Mission ledger
  // event, so an on-demand read is auditable and countable per arm instead of
  // becoming invisible extra context. Refused attempts are recorded too: an
  // attempt to read outside the served packet is exactly what a reviewer must
  // see.
  // shortcut: reads made by a Run that fails before returning are not Mission
  // history events; they stay auditable in that Run's durable tool-intent
  // record. Emit them through a read sink when failed-Run reads matter.
  for (const read of result.memoryReads ?? []) {
    r = withEvent(r, { type: "MEMORY_READ", at: now(), detail: {
      runId: args.runId, cardId: read.cardId, snapshotId: read.snapshotId, snapshotDigest: read.snapshotDigest,
      outcome: read.outcome, ...(read.reason === undefined ? {} : { reason: read.reason }),
    } });
  }

  const modelCost = result.model && options.priceModelCost ? options.priceModelCost(result.model) : undefined;
  let runCost = result.usage.cost.total;
  if (!Number.isFinite(runCost) || runCost === 0) {
    const priced = modelCost ? modelCost(result.usage.tokens) : undefined;
    if (result.usage.tokens.total > 0 && (priced === undefined || !Number.isFinite(priced))) {
      r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { runId: args.runId, reason: "observed model usage without meterable cost" } }, {
        status: "budget-exhausted",
        stopReason: "model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
        runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], sessionId: result.sessionId, model: result.model, workspace: result.workspace, status: "failed", finishedAt: now() } },
      });
      await persist(options.projectRoot, r);
      await releaseLock();
      await disposeWorkspace();
      throw new BudgetExhaustedError(r.stopReason!);
    }
    if (priced !== undefined && Number.isFinite(priced)) runCost = priced;
  }
  const consumed = r.budget.consumed + runCost;
  const runLine: UsageLine = { at: now(), sessionId: result.sessionId, tokens: { ...result.usage.tokens }, cost: { ...result.usage.cost, total: runCost } };
  r = {
    ...r,
    reserved: Math.max(0, r.reserved - args.reserve),
    budget: { ...r.budget, consumed, remaining: r.budget.total - consumed },
    usage: { ...r.usage, runs: [...r.usage.runs, runLine] },
    runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "dispatched", sessionId: result.sessionId, model: result.model, workspace: result.workspace } },
  };
  r = withEvent(r, { type: "RUN_DISPATCHED", at: now(), detail: { runId: args.runId, sessionId: result.sessionId, model: result.model?.id, cost: runCost } });

  const snapshot = await commitSnapshot(options.projectRoot, missionId, args.runId, intentId, result.workspace);
  await disposeWorkspace();
  r = withEvent(r, { type: "SNAPSHOT_COMMITTED", at: now(), detail: { runId: args.runId, snapshotDigest: snapshot.digest, files: Object.keys(snapshot.files).length } }, {
    runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], snapshotRef: snapshot.ref } },
  });

  let measurement: BaselineMeasurement;
  const evaluator = createTaskArtifactEvaluator(args.task) ?? options.evaluator;
  try {
    measurement = await evaluator.evaluate(snapshot.files, {
      missionId: missionId, runId: args.runId, snapshotDigest: snapshot.digest, contract: r.contract,
    });
  } catch (error) {
    r = withEvent(r, { type: "EVALUATOR_FAILED", at: now(), detail: { runId: args.runId, error: (error as Error).message, snapshotDigest: snapshot.digest } }, {
      status: "evaluator-failed",
      stopReason: `independent evaluator failed: ${(error as Error).message}`,
      ...(args.kind === "baseline" ? { baselineRunId: args.runId } : {}),
      runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "failed", snapshotRef: snapshot.ref, finishedAt: now() } },
    });
    await persist(options.projectRoot, r);
    await releaseLock();
    throw new EvaluatorFailureError((error as Error).message);
  }

  const evidenceRefs = [snapshot.ref, join(RUNS_DIRNAME, args.runId, RESULT_FILENAME)];
  const resultRecord: BaselineResultRecord = {
    runId: args.runId,
    candidateId: `candidate:${snapshot.digest.slice(0, 16)}`,
    snapshotDigest: snapshot.digest,
    evaluator: { id: evaluator.id, version: evaluator.version },
    evaluation: measurement,
    evidenceRefs,
    measuredAt: now(),
  };
  await atomicWriteJson(baselineResultPath(options.projectRoot, missionId, args.runId), resultRecord);
  r = withEvent(r, { type: "EVALUATION_MEASURED", at: now(), detail: { runId: args.runId, ok: measurement.ok, score: measurement.score } }, {
    runs: { ...r.runs, [args.runId]: { ...r.runs[args.runId], status: "measured", resultRef: join(RUNS_DIRNAME, args.runId, RESULT_FILENAME), finishedAt: now() } },
  });

  const budgetCrossed = consumed > r.budget.total + 1e-12;
  if (budgetCrossed) {
    r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { consumed, total: r.budget.total, runId: args.runId } }, {
      status: "budget-exhausted",
      stopReason: `declared budget ${r.budget.total} ${r.budget.units} exceeded by observed cost ${consumed}; no further dispatch`,
    });
  }
  return {
    record: r,
    result,
    outcome: {
      kind: "measured", runId: args.runId, attempt: args.attempt, measurement, budgetCrossed,
      evidenceRefs, candidateId: resultRecord.candidateId, snapshotDigest: resultRecord.snapshotDigest, evaluator: resultRecord.evaluator,
    },
  };
}
