import type { RoleId } from "../roles";

/**
 * Host port for pi-subagents.
 *
 * The skeleton schedules roles through this interface. The empty run uses
 * `RecordingScheduler`, which only records the fixed order and then runs
 * the deterministic handler. It does not import pi-subagents.
 *
 * TODO(harness-opt/design/2026-10-18-pi-subagents-intercom-setup.md):
 * these points were unverified when the skeleton was written. Do not
 * invent a call and do not install pi-intercom. pi-subagents already
 * ships `contact_supervisor`.
 *   1. Plugin import path (package export vs Pi `additionalExtensionPaths`).
 *   2. Workflow script evaluation command (clarify → scout → worker → review
 *      is only a guessed host for the product machine below).
 *   3. Structured delegation payload (`subagent` action shape).
 *   4. Mounting `harness-opt/agents/*.md` as child role files.
 *
 * Product machine (PRD §5.3), owned by deterministic code:
 *   gap-finder → innovator → runner → reviewer → report-writer → submitter
 * Node on this VM is below the Pi 22.19 line, so this port stays a stub.
 */

export const PI_SUBAGENTS_UNVERIFIED = [
  "plugin import path",
  "workflow evaluation command",
  "structured delegation payload",
  "local role-file mount",
] as const;

export interface ScheduledStep<T> {
  readonly role: RoleId;
  readonly task: string;
  readonly value: T;
}

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
      `TODO(pi-subagents): unverified ${PI_SUBAGENTS_UNVERIFIED.join("; ")}. See harness-opt/design/2026-10-18-pi-subagents-intercom-setup.md. Do not install pi-intercom.`,
    );
  }
}
