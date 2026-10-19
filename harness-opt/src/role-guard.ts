import { assertRoleRead, assertRoleTool, assertRoleWrite } from "./artifacts";
import { ensureRealDir, runRelative } from "./containment";
import { Lineage } from "./lineage";
import { ROLE_IDS } from "./roles";

/**
 * Child-tool gate for filesystem tools only.
 * A violation is appended to lineage and then thrown.
 *
 * The check runs before Pi opens the file. Pi's read/write do not take
 * O_NOFOLLOW, and this hook cannot hold the fd they later open, so a symlink
 * can still be swapped in that gap. See the README note.
 */

const SUBAGENT_ROLES = ["gap-finder", "innovator", "reviewer-gate"] as const;
type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/** Tools that read or write files. These are the only calls this gate judges. */
export const FILE_IO_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash", "powershell"] as const;

/**
 * pi-subagents protocol tools. They hand a structured result back or talk to
 * the parent. They are allowed by name, including when a schema field happens
 * to be called `path`.
 */
export const FRAMEWORK_TOOLS = [
  "structured_output",
  "contact_supervisor",
  "intercom",
  "subagent",
  "subagents_enable",
  "subagent_supervisor",
  "bg_wait",
  "source_check",
  "watchdog_diff",
] as const;

const FILE_IO_TOOL_SET = new Set<string>(FILE_IO_TOOLS);
const FRAMEWORK_TOOL_SET = new Set<string>(FRAMEWORK_TOOLS);
const PATH_ARGUMENT_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filePath",
  "full_output_path",
  "directory",
  "dir",
  "cwd",
  "target",
  "location",
  "locations",
  "command",
]);

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const FORBIDDEN_SEGMENT = /^(tests|solution|private)(\..+)?$/i;

export interface SubagentToolCall {
  readonly root: string;
  readonly prompt: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export function activeAgentName(prompt: string): string | null {
  const match = prompt.match(/<active_agent\b[^>]*\bname="([^"]+)"/);
  return match?.[1] ?? null;
}

/** Refuse a filesystem call, record it, and throw. Non-file tools return without a log line. */
export function guardSubagentToolCall(call: SubagentToolCall): void {
  if (isUngatedTool(call.tool, call.input)) return;
  const roleName = activeAgentName(call.prompt);
  const loggedPath = clip(pathForLog(call.tool, call.input));
  try {
    const role = requireSubagentRole(roleName, call.tool);
    if (COMMAND_TOOLS.has(call.tool)) {
      guardCommand(call.root, role, call.tool, call.input);
      return;
    }
    const raws = filesystemPaths(call.tool, call.input);
    const resolved: string[] = [];
    for (const raw of raws) resolved.push(canonicalRelative(call.root, role, raw));
    assertRoleTool(role, call.tool);
    for (const rel of resolved) {
      if (WRITE_TOOLS.has(call.tool)) assertRoleWrite(role, rel);
      else assertRoleRead(role, rel);
    }
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    try {
      new Lineage(ensureRealDir(call.root, "state")).log("contract", {
        role: roleName ?? "unknown",
        tool: call.tool,
        path: loggedPath,
        err,
      });
    } catch {
      // The tool stays refused even when the lineage append fails.
    }
    throw error instanceof Error ? error : new Error(err);
  }
}

function isUngatedTool(tool: string, input: Record<string, unknown>): boolean {
  if (FRAMEWORK_TOOL_SET.has(tool)) return true;
  if (FILE_IO_TOOL_SET.has(tool)) return false;
  return !hasFilePathArgument(input);
}

function hasFilePathArgument(input: Record<string, unknown>): boolean {
  return collectPathValues(input).length > 0
    || (typeof input.command === "string" && input.command.trim() !== "");
}

function requireSubagentRole(roleName: string | null, tool: string): SubagentRole {
  if (isSubagentRole(roleName)) return roleName;
  throw new Error(`subagent role is missing; refusing tool ${tool}`);
}

function isSubagentRole(value: string | null): value is SubagentRole {
  return value !== null
    && (SUBAGENT_ROLES as readonly string[]).includes(value)
    && (ROLE_IDS as readonly string[]).includes(value);
}

function guardCommand(root: string, role: SubagentRole, tool: string, input: Record<string, unknown>): void {
  const command = typeof input.command === "string" ? input.command : "";
  const outputPath = typeof input.full_output_path === "string" ? input.full_output_path : "";
  const mentioned = `${command}\n${outputPath}`;
  if (forbiddenSegment(mentioned)) {
    throw new Error(`${role} cannot access forbidden path ${command || outputPath}`);
  }
  for (const token of pathTokens(command, outputPath)) {
    const rel = canonicalRelative(root, role, token);
    assertCommandTarget(role, rel);
  }
  for (const raw of collectPathValues(input)) {
    const rel = canonicalRelative(root, role, raw);
    assertCommandTarget(role, rel);
  }
  assertRoleTool(role, tool);
}

/** Real path, then the contest denylist. The caller applies the role allowlist. */
function canonicalRelative(root: string, role: SubagentRole, raw: string): string {
  const rel = runRelative(root, raw);
  if (forbiddenSegment(rel) || forbiddenSegment(raw)) {
    throw new Error(`${role} cannot access forbidden path ${raw}`);
  }
  return rel;
}

function assertCommandTarget(role: SubagentRole, rel: string): void {
  let readError: unknown;
  try {
    assertRoleRead(role, rel);
    return;
  } catch (error) {
    readError = error;
  }
  try {
    assertRoleWrite(role, rel);
  } catch {
    throw readError;
  }
}

function pathTokens(command: string, outputPath: string): string[] {
  const tokens = command.split(/[\s"'`|&;<>()]+/).filter((token) =>
    token === "." || token.startsWith("./") || token.startsWith("../") || token.startsWith("/") || token.includes("/"),
  );
  if (outputPath.trim() !== "") tokens.push(outputPath.trim());
  return tokens;
}

function filesystemPaths(tool: string, input: Record<string, unknown>): string[] {
  const found = collectPathValues(input);
  if (found.length === 0) {
    if (READ_TOOLS.has(tool)) return ["."];
    if (WRITE_TOOLS.has(tool)) throw new Error(`${tool} is missing a path`);
  }
  return found;
}

/** Every path-like argument, including `file_path` and a `paths` array. `command` stays with the shell check. */
function collectPathValues(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "command" || !PATH_ARGUMENT_KEYS.has(key)) continue;
    pushPathValues(found, value);
  }
  return found;
}

function pushPathValues(found: string[], value: unknown): void {
  if (typeof value === "string") {
    if (value.trim() !== "") found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) pushPathValues(found, entry);
  }
}

function pathForLog(tool: string, input: Record<string, unknown>): string {
  if (COMMAND_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    const outputPath = typeof input.full_output_path === "string" ? input.full_output_path : "";
    return [command, outputPath, ...collectPathValues(input)].filter(Boolean).join(" ");
  }
  const paths = collectPathValues(input);
  return paths.length > 0 ? paths.join(" ") : "";
}

/** Contest denylist: tests/, solution, private, including solution.* / private.* / tests.*. */
export function forbiddenSegment(raw: string): string | null {
  const pieces = raw.split(/[^A-Za-z0-9._-]+/);
  for (const piece of pieces) {
    for (const segment of piece.split(/[\\/]/)) {
      if (FORBIDDEN_SEGMENT.test(segment)) return segment;
    }
  }
  return null;
}

export { runRelative } from "./containment";

function clip(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}
