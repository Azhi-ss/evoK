import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskRef } from "../types";

export interface TraceStep {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly ok: boolean;
  readonly error?: string;
}

/** One task execution. Steps, tool calls, and errors are part of the record. */
export interface ExecutionTrace {
  readonly taskId: string;
  readonly steps: readonly TraceStep[];
  readonly reward: number;
  readonly tokens: number;
  readonly failed: boolean;
  readonly labels: readonly string[];
  readonly executor: string;
}

/**
 * Real execution seam. A Bohrium sandbox or the pi-bio-harness image implements
 * this. This environment has neither, so the sample executor is what the loop runs.
 */
export interface HarnessExecutor {
  readonly name: string;
  run(task: TaskRef, configPath: string): Promise<ExecutionTrace>;
}

export class ExecutorUnavailable extends Error {
  constructor(name: string, detail: string) {
    super(`${name} is not available: ${detail}`);
    this.name = "ExecutorUnavailable";
  }
}

/** Refuses instead of pretending a fixture score is a sandbox run. */
export class BohrSandboxExecutor implements HarnessExecutor {
  readonly name = "bohr-sandbox";

  async run(_task: TaskRef, _configPath: string): Promise<ExecutionTrace> {
    throw new ExecutorUnavailable(this.name, "no local bohr sandbox or pi-bio-harness image is configured");
  }
}

const samplePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/sample-trace.json");

/**
 * Replays `fixtures/sample-trace.json` onto the requested task.
 * The baseline config scores 0.4. A later candidate scores 0.8.
 * Both keep the sample's steps, including the failing tool call.
 */
export class SampleTraceExecutor implements HarnessExecutor {
  readonly name = "sample-trace";

  async run(task: TaskRef, configPath: string): Promise<ExecutionTrace> {
    const sample = JSON.parse(readFileSync(samplePath, "utf8")) as ExecutionTrace;
    if (!Array.isArray(sample.steps) || sample.steps.length === 0) {
      throw new Error("sample trace has no steps");
    }
    const baseline = configPath.includes("/base/");
    return {
      taskId: task.id,
      steps: sample.steps,
      reward: baseline ? 0.4 : 0.8,
      tokens: baseline ? 40 : sample.tokens,
      failed: false,
      labels: sample.labels,
      executor: this.name,
    };
  }
}

export function createExecutor(kind: "sample" | "bohr" = "sample"): HarnessExecutor {
  if (kind === "bohr") return new BohrSandboxExecutor();
  return new SampleTraceExecutor();
}
