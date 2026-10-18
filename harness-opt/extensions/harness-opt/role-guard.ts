import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardSubagentToolCall } from "../../src/role-guard";

/**
 * Child-only extension. Foreground subagents do not load the parent extension,
 * so this file is registered with `registerRequiredChildExtensions` and listed
 * on each agent as `subagentOnlyExtensions`. Every read and write is checked
 * before Pi's built-in tool runs.
 */
export function roleGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    try {
      guardSubagentToolCall({
        root: ctx.cwd,
        prompt: ctx.getSystemPrompt(),
        tool: event.toolName,
        input: event.input as Record<string, unknown>,
      });
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export default roleGuardExtension;
