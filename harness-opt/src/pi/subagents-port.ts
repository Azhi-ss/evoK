import type { RoleId } from "../roles";

/**
 * Retired scheduler. The product path is `src/pi/delegate.ts`: it emits
 * pi-subagents delegation events and waits for the correlated response.
 * This class still throws so an old caller cannot pretend the call ran.
 * Do not install pi-intercom.
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
