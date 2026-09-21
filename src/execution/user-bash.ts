/**
 * Pi 0.86 `user_bash` fail-closed seam.
 *
 * `!` / `!!` / RPC bash go through extension `user_bash` handlers. From 0.86,
 * a throw or an invalid defined result aborts the command and does **not**
 * fall through to later handlers or local execution. The only legal returns
 * are `undefined` (continue) or `{ operations }` / `{ result }` (stop).
 *
 * evoK never throws from this handler: deny is a defined `{ result }` so a
 * denied command cannot execute locally. Grant + a clean command returns
 * `undefined` so Pi's local backend may run.
 */

export interface UserBashCommand {
  readonly command: string;
}

export interface UserBashDeniedResult {
  readonly output: string;
  readonly exitCode: 1;
  readonly cancelled: false;
  readonly truncated: false;
}

/** 0.86-legal handler return: continue, or stop with a defined result. */
export type UserBashHandlerResult =
  | undefined
  | { readonly result: UserBashDeniedResult };

export const USER_BASH_DENIED_OUTPUT =
  "user_bash requires an explicitly enabled sandbox policy";

export function isShellToolName(tool: string): boolean {
  return tool === "bash" || tool === "powershell" || tool === "user_bash";
}

function denied(output: string): UserBashHandlerResult {
  return {
    result: {
      output,
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  };
}

/**
 * Resolve a `user_bash` event. Always returns a 0.86-legal value; never throws.
 */
export function resolveUserBash(
  event: UserBashCommand,
  options: {
    readonly allowBash?: boolean;
    readonly assertCommand?: (command: string) => void;
  } = {},
): UserBashHandlerResult {
  const command = typeof event.command === "string" ? event.command : "";
  if (options.allowBash !== true) {
    return denied(USER_BASH_DENIED_OUTPUT);
  }
  try {
    options.assertCommand?.(command);
  } catch (error) {
    const output = error instanceof Error ? error.message : USER_BASH_DENIED_OUTPUT;
    return denied(output);
  }
  return undefined;
}

/** True when the value is a 0.86-legal defined stop (not continue, not invalid). */
export function isUserBashFailClosedResult(value: unknown): value is { result: UserBashDeniedResult } {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return typeof record.output === "string"
    && record.exitCode === 1
    && record.cancelled === false
    && record.truncated === false;
}
