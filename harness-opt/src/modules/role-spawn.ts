import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** Replace the session bytes and HMAC the ledger with the attest key. */
export function hostWriteSession(config: RoleSpawnConfig, text: string, key: Buffer): void {
  mkdirSync(resolve(config.sessionPath, ".."), { recursive: true });
  mkdirSync(resolve(config.ledgerPath, ".."), { recursive: true });
  writeFileSync(config.sessionPath, text);
  const ledger = readLedger(config.ledgerPath);
  ledger.sessions[config.role] = { sha256: sha256(text) };
  const mac = ledgerMac(key, ledger.sessions);
  writeFileSync(config.ledgerPath, `${JSON.stringify({ sessions: ledger.sessions, hmacSha256: mac }, null, 2)}\n`);
}

export function recordedSessionSha(ledgerPath: string, role: string, key: Buffer): string | null {
  const ledger = readLedger(ledgerPath);
  if (ledgerMac(key, ledger.sessions) !== ledger.hmacSha256) return null;
  const recorded = ledger.sessions[role]?.sha256;
  return typeof recorded === "string" && recorded !== "" ? recorded : null;
}

/** Real Pi argv. Evidence roles get `--tools read` and never a role run id. */
export function rolePiArgv(piBin: string, config: RoleSpawnConfig): string[] {
  if (config.role === "innovator") return [piBin, "--tools", "read", "--tools", "write"];
  return [piBin, "--tools", "read"];
}

export function launchRolePi(piBin: string, config: RoleSpawnConfig): { readonly status: number | null; readonly argv: readonly string[] } {
  const argv = rolePiArgv(piBin, config);
  const [bin, ...args] = argv;
  if (!bin) throw new Error("pi binary is empty");
  const child = spawnSync(bin, args, { encoding: "utf8" });
  return { status: child.status, argv };
}

function isEvidenceRole(role: string): role is EvidenceRole {
  return (EVIDENCE_ROLES as readonly string[]).includes(role);
}

function inside(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}

function readLedger(file: string): { sessions: Record<string, { sha256?: string }>; hmacSha256: string } {
  if (!existsSync(file)) return { sessions: {}, hmacSha256: "" };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Record<string, { sha256?: string }>; hmacSha256?: string };
  return { sessions: parsed.sessions ?? {}, hmacSha256: parsed.hmacSha256 ?? "" };
}

function ledgerMac(key: Buffer, sessions: Record<string, { sha256?: string }>): string {
  const ordered: Record<string, { sha256: string }> = {};
  for (const name of Object.keys(sessions).sort()) {
    const sha = sessions[name]?.sha256;
    if (typeof sha === "string") ordered[name] = { sha256: sha };
  }
  return createHmac("sha256", key).update(JSON.stringify(ordered)).digest("hex");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
