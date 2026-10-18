import type { HarnessConfig, Scorecard, TaskRef, TraceRecord } from "../types";
import { scoreTraces } from "./scoring";

export interface SandboxCall {
  readonly config: HarnessConfig;
  readonly task: TaskRef;
  readonly tool: "read";
  readonly path: string;
  readonly mode: "sample" | "self-check";
  readonly sampleIndex: number;
}

export interface SandboxResult {
  readonly trace: TraceRecord;
}

export type SandboxExec = (call: SandboxCall) => SandboxResult;

export interface RunObservation {
  readonly qualified: boolean;
  readonly reason: string;
  readonly traces: readonly TraceRecord[];
  readonly score: Scorecard;
  readonly samplesPlanned: number;
  readonly selfChecksPlanned: number;
  readonly retriesPlanned: number;
}

/**
 * Tool runner. It executes the candidate on dev tasks only.
 * `samples` / `selfChecks` / `retries` come from the candidate config so
 * they can be searched as TTS genes.
 */
export function runDev(input: {
  readonly config: HarnessConfig;
  readonly tasks: readonly TaskRef[];
  readonly exec: SandboxExec;
}): RunObservation {
  if (input.tasks.length === 0) throw new Error("runner needs at least one dev task");
  if (input.tasks.some((task) => task.split !== "dev")) {
    throw new Error("runner refuses held-out tasks");
  }
  const samples = input.config.search.samples;
  const retries = input.config.search.retries;
  const selfChecks = input.config.search.selfChecks;
  const traces: TraceRecord[] = [];

  for (const task of input.tasks) {
    let collected = 0;
    let attempts = 0;
    let lastError = "no attempt";
    const attemptBudget = samples * (retries + 1);
    while (collected < samples && attempts < attemptBudget) {
      attempts += 1;
      try {
        const result = input.exec({
          config: input.config,
          task,
          tool: "read",
          path: task.path,
          mode: "sample",
          sampleIndex: collected,
        });
        traces.push(result.trace);
        collected += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (collected < samples) {
      throw new Error(`runner exhausted retries for ${task.id}: ${lastError}`);
    }
  }

  for (let i = 0; i < selfChecks; i += 1) {
    const task = input.tasks[0];
    if (!task) break;
    const result = input.exec({
      config: input.config,
      task,
      tool: "read",
      path: task.path,
      mode: "self-check",
      sampleIndex: i,
    });
    if (result.trace.failed) {
      const score = scoreTraces(traces);
      return {
        qualified: false,
        reason: "self-check failed",
        traces,
        score,
        samplesPlanned: samples,
        selfChecksPlanned: selfChecks,
        retriesPlanned: retries,
      };
    }
  }

  const score = scoreTraces(traces);
  return {
    qualified: score.attributionComplete && Number.isFinite(score.devScore),
    reason: score.attributionComplete ? "dev run finished" : "attribution coverage is incomplete",
    traces,
    score,
    samplesPlanned: samples,
    selfChecksPlanned: selfChecks,
    retriesPlanned: retries,
  };
}
