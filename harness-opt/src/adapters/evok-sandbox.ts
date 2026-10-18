import { SandboxBoundary } from "../../../src/execution/security-boundary";
import type { SandboxCall, SandboxExec } from "../modules/runner";

/**
 * Thin reuse of evoK's sandbox boundary (`src/execution/security-boundary.ts`).
 *
 * The wrapper denies network and bash. It does not construct `PiAgentRuntime`
 * and does not load the Pi SDK. A real contest run still needs a container
 * exec behind `SandboxExec`; this only enforces the path and tool boundary
 * evoK already owns.
 */
export function createEvokBoundedExec(root: string, exec: SandboxExec): SandboxExec {
  const boundary = new SandboxBoundary({
    root,
    network: "none",
    allowBash: false,
    allowedTools: ["read", "grep", "find", "ls"],
  });
  return (call: SandboxCall) => {
    if (call.task.split !== "dev") throw new Error("sandbox refuses held-out tasks");
    boundary.assertTool(call.tool);
    boundary.assertPath(call.path, "read");
    return exec(call);
  };
}

export function evokBoundaryRejects(root: string, call: SandboxCall): string | null {
  try {
    createEvokBoundedExec(root, () => {
      throw new Error("exec should not run when the boundary rejects");
    })(call);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
