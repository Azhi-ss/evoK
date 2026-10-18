import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSubmitGate } from "../../src/submit-gate";

/**
 * Pi extension factory. Same shape as evoK `createEvokTuiMirrorExtension`:
 * a function of `ExtensionAPI` that registers commands. Nothing is started
 * in the factory. `session_start` does not import pi-subagents.
 *
 * TODO(harness-opt/design/2026-10-18-pi-subagents-setup.md §7):
 *   - `import 'pi-subagents/workflow-resources'` may not resolve when the
 *     package is installed separately. Do not add that import here.
 *   - Starting a structured `subagent({workflow})` call from a
 *     `registerCommand` handler is unverified.
 *   - `pi install -l ./` reading `pi.subagents.agents` is unverified.
 *   - `contact_supervisor` blocking timeout default is unverified.
 */

/** Hard token cap for one named round. Setup §6, per-round `usageBudget.tokens.hard`. */
export const ROUND_TOKEN_HARD = 200_000;

export interface RoundWorkflow {
  readonly name: "harnessopt.round";
  readonly cand: string;
  readonly gateCommand: string;
  readonly hostCommands: readonly string[];
  readonly usageBudget: { readonly tokens: { readonly hard: number } };
}

/**
 * Synchronous check-and-string for the named workflow resource.
 * No filesystem and no child process. `gate` is set; `outputSchema` is not.
 */
export function resolveRoundWorkflow(args: { readonly cand?: string }): RoundWorkflow {
  const cand = args.cand ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(cand)) {
    throw new Error("cand must be a single relative id");
  }
  const gateCommand = `bun bin/eval.ts --cand ${cand} --split dev`;
  return {
    name: "harnessopt.round",
    cand,
    gateCommand,
    hostCommands: [gateCommand],
    usageBudget: { tokens: { hard: ROUND_TOKEN_HARD } },
  };
}

export function createHarnessOptExtension(): (pi: Pick<ExtensionAPI, "registerCommand" | "on">) => void {
  return (pi) => {
    pi.registerCommand("harnessopt_select", {
      description: "Pick the next parent from the lineage",
      handler: async () => {
        // Local entry is `bin/select.ts`. Delegating via subagent() is a §7 TODO.
      },
    });
    pi.registerCommand("harnessopt_record", {
      description: "Append a lineage event and refresh run_state.json",
      handler: async () => {
        // Local entry is `bin/record.ts`.
      },
    });
    pi.registerCommand("harnessopt_submit_gate", {
      description: "Evidence gate: pinned model, held-out, traces, change note, budget, TTS, and dry-run. Live submit stays off.",
      handler: async (args) => {
        await handleSubmitGate(args);
      },
    });
    pi.on("session_start", async () => {
      // Named resource `harnessopt.round` is `resolveRoundWorkflow`.
      // Registering it through pi-subagents stays a §7 TODO.
    });
    pi.on("session_shutdown", async () => {
      // The factory starts no process, socket, or timer.
    });
  };
}

export default function harnessOptExtension(pi: ExtensionAPI): void {
  createHarnessOptExtension()(pi);
}
