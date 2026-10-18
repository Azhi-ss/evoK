import { isAbsolute, relative, resolve, sep } from "node:path";
import { join } from "node:path";
import { assertRoleRead, assertRoleTool, assertRoleWrite } from "./artifacts";
import { Lineage } from "./lineage";
import { ROLE_IDS } from "./roles";

/**
 * Child-tool gate. Pi's built-in read/write/edit run only after this check.
 * A violation is appended to lineage and then thrown.
 */

const SUBAGENT_ROLES = ["gap-finder", "innovator", "reviewer-gate"] as const;
type SubagentRole = (typeof SUBAGENT_ROLES)[number];

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

/** Refuse the call, record it, and throw. Allowed calls return without a log line. */
export function guardSubagentToolCall(call: SubagentToolCall): void {
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
    const forbidden = forbiddenSegment(raw);
    if (forbidden) throw new Error(`${role} cannot access forbidden path ${raw}`);
    const rel = runRelative(call.root, raw);
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
  const forbidden = forbiddenSegment(`${command}\n${outputPath}`);
  if (forbidden) throw new Error(`${role} cannot access forbidden path ${command || outputPath}`);
  if (outputPath) runRelative(root, outputPath);
  assertRoleTool(role, tool);
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

/** Path relative to the run root. `..` and a path outside the root throw. */
export function runRelative(root: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed === ".") return ".";
  const rootAbs = resolve(root);
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootAbs, trimmed);
  const rel = relative(rootAbs, abs);
  if (rel === "") return ".";
  const portable = rel.split(sep).join("/");
  if (portable === ".." || portable.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`path escapes the run root: ${rawPath}`);
  }
  return portable;
}

function clip(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}
