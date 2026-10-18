import type { RoleId } from "../roles";

/**
 * Host port for pi-subagents. The empty run does not import that package.
 *
 * TODO(harness-opt/design/2026-10-18-pi-subagents-setup.md §7): unverified,
 * leave as comments, do not invent a call. Do not install pi-intercom.
 *   1. Bare-script `gate.command` splicing `args`.
 *   2. `import 'pi-subagents/workflow-resources'` when this package is
 *      installed separately from pi-subagents.
 *   3. Structured delegation from a `registerCommand` handler.
 *   4. Default blocking timeout of `contact_supervisor`.
 *   5. `pi install -l ./` reading `pi.subagents.agents`.
 *
 * Node on this VM is below Pi's 22.19 line, so the loop under test is
 * `src/orchestrator.ts`.
 */

export const PI_SUBAGENTS_UNVERIFIED = [
  "bare-script gate.command args concatenation",
  "import pi-subagents/workflow-resources",
  "structured delegation from registerCommand",
  "contact_supervisor blocking timeout",
  "pi install -l reading pi.subagents.agents",
] as const;

export interface RoleScheduler {
  schedule<T>(role: RoleId, task: string, run: () => T): T;
}

export class RecordingScheduler implements RoleScheduler {
  readonly visits: RoleId[] = [];

  schedule<T>(role: RoleId, _task: string, run: () => T): T {
    this.visits.push(role);
    return run();
  }
}

export class UnverifiedPiSubagentsDelegator implements RoleScheduler {
  schedule<T>(_role: RoleId, _task: string, _run: () => T): T {
    throw new Error(
      `TODO(pi-subagents): unverified ${PI_SUBAGENTS_UNVERIFIED.join("; ")}. See harness-opt/design/2026-10-18-pi-subagents-setup.md. Do not install pi-intercom.`,
    );
  }
}
