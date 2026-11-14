import { isAbsolute } from "node:path";
import type { BaselineEvaluator } from "../mission-start";
import type { DraftPlanTask } from "./mission-draft";
import { MISSION_TASK_KINDS, type MissionTaskKind } from "./mission-draft";

export function missionTaskKind(task: Pick<DraftPlanTask, "kind">): MissionTaskKind {
  return task.kind ?? "measure";
}

/** Contract errors are protocol failures, never scientific refutations. */
export function taskContractErrors(task: Pick<DraftPlanTask, "kind" | "artifacts">): string[] {
  const kind = missionTaskKind(task);
  if (!MISSION_TASK_KINDS.includes(kind)) return [`protocol: unsupported task kind ${JSON.stringify(kind)}`];
  const artifacts = task.artifacts ?? [];
  const errors = artifacts.flatMap((path) =>
    typeof path !== "string" || path.trim() === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")
      ? [`protocol: artifact must be a relative workspace path: ${JSON.stringify(path)}`]
      : []);
  if (kind !== "measure" && artifacts.length === 0) {
    errors.push(`protocol: ${kind} task requires at least one declared artifact`);
  }
  return errors;
}

/**
 * Non-measure tasks are evaluated on durable artifacts, not a numeric metric.
 * This keeps investigation/repair out of the scientific hill-climbing loop.
 */
export function createTaskArtifactEvaluator(task: DraftPlanTask): BaselineEvaluator | undefined {
  const kind = missionTaskKind(task);
  if (kind === "measure") return undefined;
  return {
    id: `task-${kind}-artifacts`,
    version: "1",
    evaluate(snapshot) {
      const contractErrors = taskContractErrors(task);
      if (contractErrors.length > 0) return { ok: false, ruleViolations: contractErrors };
      const missing = (task.artifacts ?? []).filter((path) => (snapshot[path] ?? "").trim() === "");
      if (missing.length > 0) {
        return { ok: false, ruleViolations: missing.map((path) => `protocol: required artifact ${path} is missing or empty`) };
      }
      return {
        ok: true,
        facts: (task.artifacts ?? []).map((path) => ({ name: "artifact", value: path, source: path })),
      };
    },
  };
}
