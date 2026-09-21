/**
 * ET-PI-086 / #189 — `user_bash` fail-closed seam.
 *
 * Seams: `resolveUserBash` / `isShellToolName`. A denied command must return
 * a defined `{ result }` (never throw, never `undefined`) so 0.86 cannot fall
 * through to later handlers or local execution.
 */
import { describe, expect, test } from "bun:test";
import { createSandboxSecurityExtension } from "./pi-agent-runtime";
import { SandboxBoundary } from "./security-boundary";
import {
  USER_BASH_DENIED_OUTPUT,
  isShellToolName,
  isUserBashFailClosedResult,
  resolveUserBash,
} from "./user-bash";

describe("user_bash fail-closed (ET-PI-086 / 0.86 handler contract)", () => {
  test("denies without an explicit bash grant and never continues or throws", () => {
    const denied = resolveUserBash({ command: "ls" });
    expect(denied).not.toBeUndefined();
    expect(isUserBashFailClosedResult(denied)).toBe(true);
    expect(denied).toEqual({
      result: {
        output: USER_BASH_DENIED_OUTPUT,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
    expect(() => resolveUserBash({ command: "rm -rf /" }, { allowBash: false })).not.toThrow();
  });

  test("an explicit grant with a clean command continues via undefined (local backend may run)", () => {
    expect(resolveUserBash({ command: "ls" }, { allowBash: true })).toBeUndefined();
  });

  test("an explicit grant still fail-closes when the command violates the sandbox", () => {
    const denied = resolveUserBash(
      { command: "cat /etc/passwd" },
      {
        allowBash: true,
        assertCommand: () => {
          throw new Error("protected data is not accessible from commands");
        },
      },
    );
    expect(isUserBashFailClosedResult(denied)).toBe(true);
    expect(denied).toMatchObject({
      result: {
        output: "protected data is not accessible from commands",
        exitCode: 1,
      },
    });
  });

  test("invalid defined shapes are not treated as a legal continue or grant", () => {
    expect(isUserBashFailClosedResult(undefined)).toBe(false);
    expect(isUserBashFailClosedResult({ block: true })).toBe(false);
    expect(isUserBashFailClosedResult({ result: "nope" })).toBe(false);
    expect(isUserBashFailClosedResult({ result: { output: "x" } })).toBe(false);
    expect(isUserBashFailClosedResult({ operations: {} })).toBe(false);
  });

  test("bash, powershell, and user_bash are shell tools; inspect tools are not", () => {
    expect(isShellToolName("bash")).toBe(true);
    expect(isShellToolName("powershell")).toBe(true);
    expect(isShellToolName("user_bash")).toBe(true);
    expect(isShellToolName("read")).toBe(false);
    expect(isShellToolName("write")).toBe(false);
  });

  test("the sandbox extension fail-closes user_bash unless allowBash is true", () => {
    const handlers: Record<string, (event: { command: string }) => unknown> = {};
    const deniedExt = createSandboxSecurityExtension({
      boundary: new SandboxBoundary({ root: "/tmp/evok-user-bash", allowedTools: ["bash"], allowBash: false }),
    });
    if (!("factory" in deniedExt)) throw new Error("expected named inline extension");
    deniedExt.factory({
      on(event: string, handler: (event: { command: string }) => unknown) {
        handlers[event] = handler;
      },
    } as never);
    const denied = handlers.user_bash?.({ command: "ls" });
    expect(isUserBashFailClosedResult(denied)).toBe(true);

    const grantedHandlers: Record<string, (event: { command: string }) => unknown> = {};
    const grantedExt = createSandboxSecurityExtension({
      boundary: new SandboxBoundary({ root: "/tmp/evok-user-bash", allowedTools: ["bash"], allowBash: true }),
    });
    if (!("factory" in grantedExt)) throw new Error("expected named inline extension");
    grantedExt.factory({
      on(event: string, handler: (event: { command: string }) => unknown) {
        grantedHandlers[event] = handler;
      },
    } as never);
    expect(grantedHandlers.user_bash?.({ command: "ls" })).toBeUndefined();
    const blocked = grantedHandlers.user_bash?.({ command: "cat /etc/passwd" });
    expect(isUserBashFailClosedResult(blocked)).toBe(true);
  });
});
