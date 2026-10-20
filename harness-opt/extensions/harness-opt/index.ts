import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  registerRequiredChildExtensions,
  type RequiredChildExtensionRegistration,
} from "pi-subagents/required-child-extensions";
import { registerWorkflowResource, type WorkflowResourceRegistration } from "pi-subagents/workflow-resources";
import { flag, splitArgsPreservingJson } from "../../src/args";
import { DEFAULT_DELEGATION_TIMEOUT_MS } from "../../src/pi/delegate";
import { selectParent } from "../../bin/select";
import { recordEvent } from "../../bin/record";
import { handleSubmitGate } from "../../src/submit-gate";
import { dispatchHarnessCommand, formatCommandResult, type CommandResult } from "../../src/session";
import { HARNESSOPT_ROUND_NAME, HARNESSOPT_ROUND_SCRIPT } from "../../workflows/round.js";

/**
 * Pi extension. One slash command and one LLM tool share `harness-opt`.
 * `session_start` registers the named workflow `harnessopt.round`.
 * Delegation is emitted on `pi.events`. This file does not attach the
 * sample bridge; pi-subagents is the listener. A missing listener times out
 * and the UI names that failure.
 */

/** Historical per-round token cap from setup §6. The run's real cap is `thresholds.json`. */
export const ROUND_TOKEN_HARD = 200_000;

export interface RoundWorkflow {
  readonly name: typeof HARNESSOPT_ROUND_NAME;
  readonly cand: string;
  readonly script: string;
  readonly hostCommands: readonly { readonly key: string; readonly command: string }[];
  readonly usageBudget: { readonly tokens: { readonly hard: number } };
}

/**
 * Synchronous check-and-string for the named workflow resource.
 * No filesystem and no child process. `outputSchema` is not set.
 */
export function resolveRoundWorkflow(args: { readonly cand?: string }): RoundWorkflow {
  const cand = args.cand ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(cand)) {
    throw new Error("cand must be a single relative id");
  }
  const gateCommand = `bun bin/eval.ts --cand ${cand} --split dev`;
  return {
    name: HARNESSOPT_ROUND_NAME,
    cand,
    script: HARNESSOPT_ROUND_SCRIPT,
    hostCommands: [{ key: "eval", command: gateCommand }],
    usageBudget: { tokens: { hard: ROUND_TOKEN_HARD } },
  };
}

const HARNESS_OPT_DESCRIPTION = "Required subcommand: start | step | status | gate | stop. start requires --min-delta --tts-baseline --held-out-floor --token-budget --max-local-runs --max-wall-s --max-submits --heldout-score unless thresholds.json and sealed/heldout-score.json already exist. Default run directory is .harness-opt/.";

type Ui = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget?(key: string, content: string[] | undefined): void;
  setStatus?(key: string, text: string | undefined): void;
};

function echo(ui: Ui, commandResult: CommandResult): void {
  ui.notify(formatCommandResult(commandResult), commandResult.ok ? "info" : "error");
  const panel = commandResult.panel.length > 0 ? [...commandResult.panel] : [formatCommandResult(commandResult)];
  ui.setWidget?.("harness-opt", panel);
  ui.setStatus?.("harness-opt", panel[0]);
}

async function runHarnessOpt(args: string, ctx: { readonly cwd: string; readonly ui: Ui }, events: ExtensionAPI["events"]): Promise<CommandResult> {
  const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
  const commandResult = await dispatchHarnessCommand(argv, {
    cwd: ctx.cwd,
    events,
    sampleBridge: false,
    timeoutMs: DEFAULT_DELEGATION_TIMEOUT_MS,
  });
  echo(ctx.ui, commandResult);
  return commandResult;
}

const ROLE_GUARD_EXTENSION = fileURLToPath(new URL("./role-guard.ts", import.meta.url));

export function createHarnessOptExtension(): (pi: ExtensionAPI) => void {
  return (pi) => {
    let registration: WorkflowResourceRegistration | undefined;
    let childExtensions: RequiredChildExtensionRegistration | undefined;
    pi.registerCommand("harness-opt", {
      description: HARNESS_OPT_DESCRIPTION,
      handler: async (args, ctx) => {
        await runHarnessOpt(args, ctx, pi.events);
      },
    });
    pi.registerTool(defineTool({
      name: "harness-opt",
      label: "harness-opt",
      description: HARNESS_OPT_DESCRIPTION,
      parameters: Type.Object({
        command: Type.String({ description: "start | step | status | gate | stop" }),
        args: Type.Optional(Type.String({ description: "Flags. start needs the threshold flags and --heldout-score unless those files already exist." })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const commandResult = await runHarnessOpt(
          `${params.command}${params.args ? ` ${params.args}` : ""}`,
          ctx,
          pi.events,
        );
        return {
          content: [{ type: "text", text: formatCommandResult(commandResult) }],
          details: commandResult,
          isError: !commandResult.ok,
        };
      },
    }));
    pi.registerCommand("harnessopt-select", {
      description: "Pick the next parent. Required: --root <lineage dir>. Optional: --selector greedy|softmax-mix|uct. Unimplemented selectors fail closed.",
      handler: async (args, ctx) => {
        await selectCommand(args, ctx);
      },
    });
    pi.registerCommand("harnessopt-record", {
      description: "Append a lineage event. Required: --root <lineage dir> and --kind <event>. Optional: --json '{...}'.",
      handler: async (args, ctx) => {
        await recordCommand(args, ctx);
      },
    });
    pi.registerCommand("harnessopt-submit-gate", {
      description: "Evidence gate for one run directory. Required: --root <run dir>. Live playground submit stays off.",
      handler: async (args, ctx) => {
        await gateCommand(args, ctx);
      },
    });
    pi.on("session_start", (_event, ctx) => {
      registration?.dispose();
      registration = undefined;
      childExtensions?.dispose();
      childExtensions = undefined;
      registration = registerWorkflow(ctx);
      childExtensions = registerRequiredChildExtensions({
        sessionId: ctx.sessionManager.getSessionId(),
        extensions: [{ id: "harness-opt.role-guard", path: ROLE_GUARD_EXTENSION }],
        requireForAllRunners: true,
      });
    });
    pi.on("session_shutdown", () => {
      registration?.dispose();
      registration = undefined;
      childExtensions?.dispose();
      childExtensions = undefined;
    });
  };
}

function registerWorkflow(ctx: ExtensionContext): WorkflowResourceRegistration {
  return registerWorkflowResource({
    sessionId: ctx.sessionManager.getSessionId(),
    definition: {
      name: HARNESSOPT_ROUND_NAME,
      version: 1,
      resolve(args) {
        try {
          const cand = typeof args.cand === "string" ? args.cand : "";
          const round = resolveRoundWorkflow({ cand });
          return { script: round.script, hostCommands: round.hostCommands };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  });
}

async function selectCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
  const root = flag(argv, "--root");
  if (!root) {
    ctx.ui.notify("harnessopt-select missing: --root", "error");
    return;
  }
  try {
    const parent = selectParent(root, flag(argv, "--selector") ?? "greedy");
    ctx.ui.notify(JSON.stringify(parent), "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function recordCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const argv = splitArgsPreservingJson(args);
  const root = flag(argv, "--root");
  const kind = flag(argv, "--kind");
  const missing = [root ? "" : "--root", kind ? "" : "--kind"].filter(Boolean);
  if (missing.length > 0) {
    ctx.ui.notify(`harnessopt-record missing: ${missing.join(", ")}`, "error");
    return;
  }
  const raw = flag(argv, "--json");
  let fields: Record<string, unknown> = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`harnessopt-record --json is not valid JSON: ${detail}`, "error");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.ui.notify("harnessopt-record --json must be an object", "error");
      return;
    }
    fields = parsed as Record<string, unknown>;
  }
  recordEvent(root as string, kind as string, fields);
  ctx.ui.notify(`recorded ${kind} in ${root}`, "info");
}

async function gateCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const gate = await handleSubmitGate(args);
    const failed = gate.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`);
    const text = `gate node ${gate.node} submit ${gate.submit}${failed.length > 0 ? `\nfailed: ${failed.join("; ")}` : ""}`;
    ctx.ui.notify(text, gate.submit ? "info" : "error");
    ctx.ui.setWidget?.("harness-opt", failed.length > 0 ? failed : [text]);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export default function harnessOptExtension(pi: ExtensionAPI): void {
  createHarnessOptExtension()(pi);
}
