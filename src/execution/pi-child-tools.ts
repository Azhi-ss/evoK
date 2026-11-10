/** Child-side scoped tools and the one tool-turn rule. Physical home: `src/execution/`.
 *
 * A delegated child gets NO tool unless its Task Contract grants one, and only
 * the scoped tools this transport can execute in the child itself are grantable
 * (Evidence reading, workspace reads). The host writes one binding per child
 * under `.evok/` inside that child's own workspace, plus the extension entry
 * that installs it, and `dispatchPiChild` declares both on the wire — so the
 * installer has a production path and an ungranted tool is never registered.
 *
 * Tool turns are counted in one place (`createToolTurnGate`): a tool turn is one
 * model message containing tool calls, a control action is exempt from the
 * budget but must be alone in its batch, and the budget is only spent by the
 * batches that actually ran. Nothing here persists credentials; the transport
 * validates every record through `pi-child-records.ts`.
 *
 * `ChildToolBinding.controls` is for a host that lets its child end the turn by
 * acting (`evok_deliver` and friends). The delegation transport does not: its
 * child answers in text, so it grants no control action and refuses one asked
 * for by a Task Contract.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuleAudienceRole } from "../competition/rule-visibility";
import { assertNoCredentials } from "./pi-child-records";
import {
  controlSchemas,
  hostToolSchemas,
  validateWorkerAction,
  workerTools,
  type ControlAction,
  type WorkerControl,
  type WorkerProfile,
} from "./pi-child-protocol";

/** The child's own state directory, directly inside its workspace: one per delegated child. */
export const CHILD_STATE_DIR = ".evok";
/** Scoped tools this transport executes in the child; anything else is refused, not faked. */
export const CHILD_SCOPED_TOOLS = ["evok_read_evidence", "evok_read_file"] as const;
const BINDING = "binding.json";
const ENTRY = "entry.ts";
const MAX_READ = 262_144;
const isControl = (name: string) => Object.hasOwn(controlSchemas, name);
const isScopedTool = (name: string) => (CHILD_SCOPED_TOOLS as readonly string[]).includes(name);

const PROFILE: Record<RuleAudienceRole, WorkerProfile> = {
  researcher: "research",
  critic: "diagnostic",
  reviewer: "review",
};
export function profileForRole(role: RuleAudienceRole): WorkerProfile {
  return PROFILE[role];
}

/** One evidence reference a granted child may read back. */
export interface ChildEvidence {
  readonly ref: string;
  readonly summary: string;
}

/** Everything the child-side installer needs; it carries no credential. */
export interface ChildToolBinding {
  roleRunId: string;
  profile: WorkerProfile;
  tools: readonly string[];
  /** Control actions the Task Contract grants; never scoped tools. */
  controls?: readonly ControlAction[];
  depth?: number;
  /** Non-control tool turns this child may still spend. */
  remainingToolTurns: number;
  evidence: readonly ChildEvidence[];
}

/**
 * The Task Contract's tool grants, narrowed to what this transport executes.
 * A grant it cannot honour is refused outright, so a child is never told it has
 * a tool that no one installed. Default is no tools.
 */
export function childToolGrants(role: RuleAudienceRole, exposed: readonly string[] = []): string[] {
  const controls = exposed.filter((name) => Object.hasOwn(controlSchemas, name));
  if (controls.length)
    throw Error(
      "a delegated child cannot be granted " +
        controls.join(", ") +
        ": it answers in text, so a control action has no host to record it",
    );
  const declared = workerTools(PROFILE[role], exposed).filter((name) => !isControl(name));
  const unsupported = declared.filter((name) => !isScopedTool(name));
  if (unsupported.length)
    throw Error(
      "a delegated child cannot be granted " +
        unsupported.join(", ") +
        ": this transport executes only " +
        CHILD_SCOPED_TOOLS.join(", "),
    );
  return declared;
}

export interface ToolTurnGate {
  /** Record one assistant message: the tool names it called. */
  turn(calls: readonly string[]): void;
  /** Decide one call in the current batch. */
  call(name: string): { block: true; terminate: true; reason: string } | undefined;
  /** Non-control tool turns spent so far. */
  readonly used: number;
  /** The batch that just ran exceeded the budget or mixed in a control action. */
  overBudget(): boolean;
}

/**
 * C7, in one rule. A tool turn is a model message containing tool calls; only
 * non-control turns spend the budget, so the last allowed batch always executes
 * and the terminal control action still runs alone afterwards. The batch after
 * the budget is blocked and ends the turn — never before.
 */
export function createToolTurnGate(
  remainingToolTurns: number,
  granted: readonly string[],
  isControl: (name: string) => boolean,
): ToolTurnGate {
  if (!Number.isSafeInteger(remainingToolTurns) || remainingToolTurns < 0)
    throw Error("remaining tool turns must be a non-negative integer");
  let used = 0;
  let mixed = false;
  let spending = false;
  let refused = false;
  const blocked = (reason: string) => {
    refused = true;
    return { block: true, terminate: true, reason } as const;
  };
  return {
    turn(calls) {
      const controls = calls.filter(isControl).length;
      // A control action must be alone in its batch, including next to another one.
      mixed = controls > 0 && calls.length > 1;
      // A batch the budget already refuses never runs, so it never spends a turn.
      spending = calls.length > controls && !mixed && used < remainingToolTurns;
      if (spending) used++;
    },
    call(name) {
      if (!granted.includes(name)) return blocked("This child was not granted " + name + ".");
      if (mixed) return blocked("A control action must be the only call in its batch.");
      if (!isControl(name) && !spending && used >= remainingToolTurns)
        return blocked("The child has used its " + remainingToolTurns + " tool turns.");
      return undefined;
    },
    get used() {
      return used;
    },
    overBudget: () => mixed || refused,
  };
}

/** Write the child's binding and the extension entry that installs it in that child. */
export async function writeChildToolPackage(stateDir: string, binding: ChildToolBinding): Promise<string> {
  assertNoCredentials(binding, join(stateDir, BINDING));
  await mkdir(stateDir, { recursive: true });
  const entry = join(stateDir, ENTRY);
  // The entry is the only way to hand per-child configuration to a child
  // extension: a path-loaded extension sees no cwd and no per-child env.
  const specifier = fileURLToPath(new URL("./pi-child-tools.ts", import.meta.url));
  await writeFile(join(stateDir, BINDING), JSON.stringify(binding), { mode: 0o600 });
  await writeFile(
    entry,
    "import { installPiWorkerTools } from " +
      JSON.stringify(specifier) +
      ";\n" +
      "export default (pi) => installPiWorkerTools(pi, " +
      JSON.stringify(stateDir) +
      ");\n",
  );
  return entry;
}

/** Reads the granted tools, validates each call, and answers them from the binding only. */
export function installPiWorkerTools(pi: ExtensionAPI, stateDir: string) {
  const binding: ChildToolBinding = JSON.parse(readFileSync(join(stateDir, BINDING), "utf8"));
  const controlNames = (binding.controls ?? []).filter(isControl);
  const scoped = binding.tools.filter((name) => Object.hasOwn(hostToolSchemas, name) && isScopedTool(name));
  // `evok_deliver` ends the turn, so it is validated as a control action but
  // never reaches workerTools, which only grants in-turn controls.
  const inTurn = controlNames.filter((name): name is WorkerControl => name !== "evok_deliver");
  const allowed = workerTools(binding.profile, scoped, inTurn, binding.depth ?? 1);
  const gate = createToolTurnGate(binding.remainingToolTurns, allowed, isControl);
  let delivered = false;
  const activate = () => pi.setActiveTools([...scoped, ...controlNames]);
  pi.on("before_agent_start", activate);
  pi.on("session_start", activate);
  // Invalid arguments can bypass tool execution, so the turn also ends here when
  // the batch was over budget or mixed, before another provider request.
  pi.on("turn_end", (_event, ctx) => {
    if (!delivered && gate.overBudget()) ctx.abort();
  });
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant") return;
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (calls.length) {
      gate.turn(calls.map((part) => part.name));
      writeFileSync(join(stateDir, binding.roleRunId + ".turns.json"), JSON.stringify(gate.used), {
        mode: 0o600,
      });
    }
    // Native runners require visible terminal output. Render the model's own
    // control call as a tagged text projection; the separate tool receipt is authoritative.
    if (
      calls.length === 1 &&
      isControl(calls[0].name) &&
      !message.content.some((part) => part.type === "text" && part.text.trim())
    ) {
      return {
        message: {
          ...message,
          content: [{ type: "text", text: "[EvoK control call: " + calls[0].name + "]" }, ...message.content],
        },
      };
    }
  });
  pi.on("tool_call", ({ toolName }) => gate.call(toolName));
  for (const name of [...scoped, ...controlNames]) {
    const control = isControl(name);
    pi.registerTool({
      name,
      label: name,
      parameters: control ? controlSchemas[name] : hostToolSchemas[name],
      description: control
        ? "Record one EvoK control action and finish this turn. Call this tool alone."
        : "Run the named operation on this node's scoped inputs.",
      async execute(_id, args, signal) {
        if (control) {
          const action = validateWorkerAction(name, args, binding.profile, allowed);
          const file = join(stateDir, binding.roleRunId + ".action.json");
          assertNoCredentials(action, file);
          writeFileSync(file, JSON.stringify(action), { flag: "wx", mode: 0o600 });
          delivered = true;
          return { content: [{ type: "text", text: "Recorded." }], details: {}, terminate: true };
        }
        // The declared reads stay inside the child's own workspace, the state dir's parent.
        const text = await scopedResult(name, args as Record<string, unknown>, dirname(stateDir), binding, signal);
        return { content: [{ type: "text", text }], details: {}, terminate: false };
      },
    });
  }
}

/** The granted reads. Both answer from the child's own binding and its own workspace. */
async function scopedResult(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  binding: ChildToolBinding,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (name === "evok_read_evidence") {
    const found = binding.evidence.find((item) => item.ref === args.ref);
    if (!found) throw Error("no such evidence reference in this child's slice: " + String(args.ref));
    return found.summary;
  }
  if (name === "evok_read_file") {
    const target = join(workspace, String(args.path ?? ""));
    if (!target.startsWith(workspace + sep)) throw Error("a scoped read stays inside the child workspace");
    const text = await readFile(target, "utf8").catch((error) => {
      throw Error("scoped read failed: " + (error as NodeJS.ErrnoException).code);
    });
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n[truncated]" : text;
  }
  throw Error("unsupported scoped tool " + name);
}
