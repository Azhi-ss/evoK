import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

/** Gap and reviewer evidence roles. They do not get write, edit, or bash. */
export const EVIDENCE_ROLES = ["gap-finder", "reviewer-gate"] as const;

export const READ_ONLY_ROLE_TOOLS = ["read", "grep", "find", "ls"] as const;

const FORBIDDEN_ROLE_TOOLS = ["write", "edit", "bash", "powershell"] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type OptRoleName = EvidenceRole | "innovator";

export interface RoleSpawnConfig {
  readonly role: OptRoleName;
  readonly cwd: string;
  /** Files this role may read. The session file is not one of them. */
  readonly allowedPaths: readonly string[];
  readonly tools: readonly string[];
  /** Host-owned Pi session. Outside `cwd` and outside `allowedPaths`. */
  readonly sessionPath: string;
  /** Host ledger of the session sha. The role cannot write this file. */
  readonly ledgerPath: string;
}

export function evidenceRoleTools(): readonly string[] {
  return ["read"];
}

export function buildRoleSpawn(input: {
  readonly role: OptRoleName;
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly sessionPath: string;
  readonly ledgerPath: string;
}): RoleSpawnConfig {
  const tools = input.role === "innovator" ? ["read", "write"] : evidenceRoleTools();
  const config: RoleSpawnConfig = { ...input, tools };
  assertRoleSpawn(config);
  return config;
}

/** Refuse a spawn that could let an evidence role write its own session. */
export function assertRoleSpawn(config: RoleSpawnConfig): void {
  if (isEvidenceRole(config.role)) {
    if (config.tools.length === 0) throw new Error(`role ${config.role} tools are empty`);
    for (const tool of config.tools) {
      if ((FORBIDDEN_ROLE_TOOLS as readonly string[]).includes(tool) || !(READ_ONLY_ROLE_TOOLS as readonly string[]).includes(tool)) {
        throw new Error(`role ${config.role} cannot use tool ${tool}`);
      }
    }
  }
  const session = resolve(config.sessionPath);
  const cwd = resolve(config.cwd);
  if (inside(session, cwd)) throw new Error("role session must be outside the role cwd");
  const ledger = resolve(config.ledgerPath);
  if (inside(ledger, cwd) || ledger === session) throw new Error("role session ledger must be outside the role cwd");
  for (const allowed of config.allowedPaths) {
    const root = resolve(allowed);
    if (overlaps(session, root) || overlaps(ledger, root) || overlaps(resolve(config.sessionPath, ".."), root)) {
      throw new Error("role session overlaps an allowed path");
    }
  }
}

/**
 * The only write entry a role is given.
 * Evidence roles have no write tool, so this returns false and does not touch the file.
 * A session path, the ledger, and anything outside the role cwd are refused for every role.
 */
export function roleWrite(config: RoleSpawnConfig, path: string, body: string): boolean {
  if (!config.tools.includes("write")) return false;
  const target = isAbsolute(path) ? resolve(path) : resolve(config.cwd, path);
  const session = resolve(config.sessionPath);
  const ledger = resolve(config.ledgerPath);
  const sessionDir = resolve(session, "..");
  if (target === session || target === ledger || inside(target, sessionDir) || sessionDir === target) return false;
  let realTarget = target;
  try {
    realTarget = realpathSync(target);
  } catch {
    realTarget = target;
  }
  if (realTarget === session || realTarget === ledger || inside(realTarget, sessionDir)) return false;
  const cwd = resolve(config.cwd);
  if (!inside(target, cwd)) return false;
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, body);
  return true;
}

/** Host append of one successful read. The role does not write this exchange. */
export function hostRecordRead(config: RoleSpawnConfig, file: string): void {
  if (!allowedRead(config, file)) throw new Error("role read is outside the allowed paths");
  const prior = existsSync(config.sessionPath) ? readFileSync(config.sessionPath, "utf8") : "";
  const index = prior.split("\n").filter((line) => line.includes("\"name\":\"read\"")).length;
  hostWriteSession(config, `${prior}${toolExchange(file, index)}`);
}

/** Replace the session bytes and record the sha the citation check will require. */
export function hostWriteSession(config: RoleSpawnConfig, text: string): void {
  mkdirSync(resolve(config.sessionPath, ".."), { recursive: true });
  mkdirSync(resolve(config.ledgerPath, ".."), { recursive: true });
  writeFileSync(config.sessionPath, text);
  const ledger = readLedger(config.ledgerPath);
  ledger.sessions[config.role] = { sha256: sha256(text) };
  writeFileSync(config.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function recordedSessionSha(ledgerPath: string, role: string): string | null {
  const recorded = readLedger(ledgerPath).sessions[role]?.sha256;
  return typeof recorded === "string" && recorded !== "" ? recorded : null;
}

function isEvidenceRole(role: string): role is EvidenceRole {
  return (EVIDENCE_ROLES as readonly string[]).includes(role);
}

function allowedRead(config: RoleSpawnConfig, file: string): boolean {
  const target = resolve(file);
  return config.allowedPaths.some((allowed) => {
    const root = resolve(allowed);
    if (target === root) return true;
    try {
      return realpathSync(target) === realpathSync(root);
    } catch {
      return false;
    }
  });
}

function inside(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}

function readLedger(file: string): { sessions: Record<string, { sha256?: string }> } {
  if (!existsSync(file)) return { sessions: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Record<string, { sha256?: string }> };
  return { sessions: parsed.sessions ?? {} };
}

function toolExchange(file: string, index: number): string {
  const text = readFileSync(file, "utf8");
  const callId = `c${index}`;
  const call = {
    type: "message",
    id: `r${index}`,
    parentId: null,
    timestamp: "2026-10-21T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: file } }],
      timestamp: 0,
    },
  };
  const result = {
    type: "message",
    id: `t${index}`,
    parentId: `r${index}`,
    timestamp: "2026-10-21T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(result)}\n`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
