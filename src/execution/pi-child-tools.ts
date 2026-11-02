/** Explicitly loaded by the native child, including in the detached revival runner. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { controlSchemas, hostToolSchemas, validateWorkerAction, workerTools, type WorkerProfile, type WorkerControl } from "./pi-child-protocol";

export interface WorkerBinding {
  nodeId: string; controls: readonly WorkerControl[]; depth: number; remainingToolTurns: number; profile: WorkerProfile; tools: string[]; roleRunId: string;
  provider: {alias: string; config: ProviderConfig}; toolServer?: {url: string; key: string};
}
export function installPiWorkerTools(pi: ExtensionAPI, stateDir: string) {
  const binding: WorkerBinding = JSON.parse(readFileSync(join(stateDir, "active.json"), "utf8"));
  const allowed = workerTools(binding.profile, binding.tools, binding.controls, binding.depth);
  pi.registerProvider(binding.provider.alias, binding.provider.config);
  pi.on("before_agent_start", () => {pi.setActiveTools(allowed);});
  pi.on("session_start", () => {pi.setActiveTools(allowed);});
  // Pi continues after a mixed tool batch unless every result requests termination.
  // Require a control action to be the only call in its batch, before any side effects.
  let mixedControlBatch = false;
  let toolTurns = 0;
  pi.on("message_end", ({message}) => {
    if (message.role !== "assistant") return;
    const calls = message.content.filter(part => part.type === "toolCall");
    if (calls.length) {
      toolTurns++;
      writeFileSync(join(stateDir, binding.roleRunId + ".turns.json"), JSON.stringify(toolTurns), {mode:0o600});
    }
    mixedControlBatch = calls.length > 1 && calls.some(part => Object.hasOwn(controlSchemas, part.name));
    // Native runners require visible terminal output. Render the model's own
    // control call as a tagged text projection; the separate tool receipt is authoritative.
    if (calls.length === 1 && Object.hasOwn(controlSchemas, calls[0].name) &&
        !message.content.some(part => part.type === "text" && part.text.trim())) {
      return {message: {...message, content: [{type: "text", text: "[EvoK control call: " + calls[0].name + "]"}, ...message.content]}};
    }
  });
  pi.on("tool_call", e => mixedControlBatch || !allowed.includes(e.toolName) || toolTurns > binding.remainingToolTurns ? {block: true, terminate: true, reason: "A control action must be the only call in its batch."} : undefined);
  for (const name of allowed) {
    const isControl = Object.hasOwn(controlSchemas, name);
    pi.registerTool({ name, label: name, parameters: isControl ? controlSchemas[name] : hostToolSchemas[name],
      description: isControl ? "Record one EvoK control action and finish this turn. Call this tool alone." : "Run the named operation on this node's scoped inputs.",
      async execute(_id, args, signal) {
        if (isControl) {
          const action = validateWorkerAction(name, args, binding.profile, allowed);
          writeFileSync(join(stateDir, binding.roleRunId + ".action.json"), JSON.stringify(action), {flag: "wx", mode: 0o600});
          return {content: [{type: "text", text: "Recorded."}], details: {}, terminate: true};
        }
        if (!binding.toolServer) throw Error("scoped tool host unavailable");
        const res = await fetch(binding.toolServer.url, {method: "POST", redirect: "error", signal,
          headers: {Authorization: "Bearer " + binding.toolServer.key, "Content-Type": "application/json"}, body: JSON.stringify({name, args})});
        const text = res.ok ? await res.text() : "Scoped tool request rejected: " + res.status;
        return {content: [{type: "text", text}], details: {}, terminate: toolTurns >= binding.remainingToolTurns};
      },
    });
  }
}
