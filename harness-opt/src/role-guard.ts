import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertRoleRead, assertRoleTool, assertRoleWrite } from "./artifacts";
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
const PATH_ARGUMENT_KEYS = new Set(["path", "file", "file_path", "filePath", "full_output_path", "command"]);

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
    const raw = filesystemPath(call.tool, call.input);
    if (raw === undefined) {
      assertRoleTool(role, call.tool);
      return;
    }
    const rel = canonicalRelative(call.root, role, raw);
    assertRoleTool(role, call.tool);
    if (WRITE_TOOLS.has(call.tool)) assertRoleWrite(role, rel);
    else assertRoleRead(role, rel);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    try {
      new Lineage(join(call.root, "state")).log("contract", {
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
  return Object.entries(input).some(([key, value]) => PATH_ARGUMENT_KEYS.has(key) && typeof value === "string" && value.trim() !== "");
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

function filesystemPath(tool: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.path === "string" && input.path.trim() !== "") return input.path;
  if (READ_TOOLS.has(tool)) return ".";
  if (WRITE_TOOLS.has(tool)) throw new Error(`${tool} is missing a path`);
  return undefined;
}

function pathForLog(tool: string, input: Record<string, unknown>): string {
  if (COMMAND_TOOLS.has(tool)) {
    const command = typeof input.command === "string" ? input.command : "";
    const outputPath = typeof input.full_output_path === "string" ? input.full_output_path : "";
    return [command, outputPath].filter(Boolean).join(" ");
  }
  return typeof input.path === "string" ? input.path : "";
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

/**
 * Path relative to the real run root. Every existing component is resolved
 * through symlinks, including links in the middle of the path. A link or
 * lexical step that lands outside the root throws.
 */
export function runRelative(root: string, rawPath: string): string {
  const rootReal = realpathSync(resolve(root));
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed === ".") return ".";
  const lexical = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootReal, trimmed);
  if (!isInside(rootReal, lexical)) throw new Error(`path escapes the run root: ${rawPath}`);
  const segments = relative(rootReal, lexical).split(sep).filter(Boolean);
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "..") throw new Error(`path escapes the run root: ${rawPath}`);
    const next = join(current, segment);
    let linked = false;
    try {
      const info = lstatSync(next);
      if (info.isSymbolicLink()) {
        linked = true;
        current = resolveLink(next, rootReal, rawPath);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const rest = segments.slice(index);
      if (rest.some((part) => part === "..")) throw new Error(`path escapes the run root: ${rawPath}`);
      return finish(rootReal, join(current, ...rest), rawPath);
    }
    if (!linked) current = next;
  }
  return finish(rootReal, current, rawPath);
}

function resolveLink(linkPath: string, rootReal: string, rawPath: string): string {
  const seen = new Set<string>();
  let current = linkPath;
  for (let hop = 0; hop < 32; hop += 1) {
    if (seen.has(current)) throw new Error(`path escapes the run root: ${rawPath}`);
    seen.add(current);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (isEnoent(error)) return finishAbsolute(rootReal, current, rawPath);
      throw error;
    }
    if (!info.isSymbolicLink()) return finishAbsolute(rootReal, current, rawPath);
    const target = readlinkSync(current);
    const next = isAbsolute(target) ? resolve(target) : resolve(dirname(current), target);
    if (!isInside(rootReal, next)) throw new Error(`path escapes the run root: ${rawPath}`);
    current = next;
  }
  throw new Error(`path escapes the run root: ${rawPath}`);
}

function finish(rootReal: string, abs: string, rawPath: string): string {
  const real = finishAbsolute(rootReal, abs, rawPath);
  const rel = relative(rootReal, real);
  return rel.split(sep).join("/") || ".";
}

function finishAbsolute(rootReal: string, abs: string, rawPath: string): string {
  if (!isInside(rootReal, abs)) throw new Error(`path escapes the run root: ${rawPath}`);
  return abs;
}

function isInside(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function clip(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}
