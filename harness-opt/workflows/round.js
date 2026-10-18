/**
 * Fixed round once pi-subagents workflow resources are verified:
 * gap-finder → innovator with typed gate `bun bin/eval.ts --cand <id> --split dev` → reviewer-gate.
 *
 * TODO(harness-opt/design/2026-10-18-pi-subagents-setup.md §7): a bare script
 * must not call `runs.host`. Whether `gate.command` may splice `args`, and
 * whether `import 'pi-subagents/workflow-resources'` resolves from this
 * package, are both unverified. The deterministic loop that tests run is
 * `src/orchestrator.ts`. Do not execute this file.
 */
throw new Error(
  "TODO(harness-opt/design/2026-10-18-pi-subagents-setup.md §7): workflows/round.js is not executed until pi-subagents workflow resources are verified",
);
