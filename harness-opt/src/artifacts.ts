import { ensureRealDir, readContained, writeContained } from "./containment";
import { Lineage } from "./lineage";
import { ROLE_CONTRACTS, type RoleId } from "./roles";

export function assertRoleTool(role: RoleId, tool: string): void {
  const allowed = ROLE_CONTRACTS[role].tools;
  if (!allowed.includes(tool)) {
    throw new Error(`${role} cannot use tool ${tool}`);
  }
}

export function assertRoleRead(role: RoleId, relativeName: string): void {
  const rel = normalizeRelative(relativeName);
  if (isGateLog(rel) && role !== "orchestrator") {
    throw new Error(`${role} cannot read the gate log at ${rel}`);
  }
  if (isHeldOutPath(rel) && role !== "runner" && role !== "orchestrator") {
    throw new Error(`${role} cannot read held-out at ${rel}`);
  }
  if (!covers(ROLE_CONTRACTS[role].reads, rel)) {
    throw new Error(`${role} cannot read ${rel}`);
  }
}

export function assertRoleWrite(role: RoleId, relativeName: string): void {
  const rel = normalizeRelative(relativeName);
  if (isHeldOutPath(rel)) {
    throw new Error(`${role} cannot write held-out at ${rel}`);
  }
  if (role === "innovator" && isBaselinePath(rel)) {
    throw new Error(`${role} cannot write the baseline at ${rel}`);
  }
  if (!covers(ROLE_CONTRACTS[role].writes, rel)) {
    throw new Error(`${role} cannot write ${rel}`);
  }
}

/**
 * A directory entry `traces/` covers the directory itself (`traces`, `traces/`)
 * and everything under it. A file entry covers that file only.
 * `traces-other` does not match `traces/`.
 */
function covers(allowed: readonly string[], relativeName: string): boolean {
  const name = relativeName.replace(/\/+$/, "");
  return allowed.some((entry) => {
    if (entry.endsWith("/")) {
      const dir = entry.replace(/\/+$/, "");
      return name === dir || name.startsWith(`${dir}/`);
    }
    return name === entry.replace(/\/+$/, "");
  });
}

function isBaselinePath(relativeName: string): boolean {
  const name = relativeName.replace(/\/+$/, "");
  return name === "candidates/base" || name.startsWith("candidates/base/");
}

function isGateLog(relativeName: string): boolean {
  return relativeName === "gate.jsonl" || relativeName.endsWith("/gate.jsonl");
}

function isHeldOutPath(relativeName: string): boolean {
  return relativeName === "sealed" || relativeName.startsWith("sealed/")
    || relativeName.includes("held-out") || relativeName.includes("heldout")
    || isGateLog(relativeName);
}

function normalizeRelative(relativeName: string): string {
  const rel = relativeName.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new Error(`path escapes the run root: ${relativeName}`);
  }
  return rel;
}

export function writeRoleFile(root: string, role: RoleId, relativeName: string, body: string): string {
  try {
    assertRoleWrite(role, relativeName);
    const text = body.endsWith("\n") ? body : `${body}\n`;
    return writeContained(root, relativeName, text);
  } catch (error) {
    recordContract(root, role, relativeName, error, "write");
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Host write. The resolved path must stay at `relativeName` inside the run root. */
export function writeHostFile(root: string, relativeName: string, body: string): string {
  try {
    return writeContained(root, relativeName, body);
  } catch (error) {
    recordContract(root, "orchestrator", relativeName, error, "write");
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Host read. The resolved path must stay at `relativeName` inside the run root.
 * A missing file is not a contract event. A symlink or any other escape is.
 */
export function readHostFile(root: string, relativeName: string): string {
  try {
    return readContained(root, relativeName);
  } catch (error) {
    if (!isEnoent(error)) recordContract(root, "orchestrator", relativeName, error, "read");
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function recordContract(root: string, role: string, relativeName: string, error: unknown, tool: string): void {
  const err = error instanceof Error ? error.message : String(error);
  try {
    const state = ensureRealDir(root, "state");
    new Lineage(state).log("contract", {
      role,
      tool,
      path: relativeName.length > 500 ? `${relativeName.slice(0, 500)}…` : relativeName,
      err,
    });
  } catch {
    // The operation stays refused when the contract line itself cannot be stored.
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

export function writeRoleJson(root: string, role: RoleId, relativeName: string, value: unknown): string {
  return writeRoleFile(root, role, relativeName, JSON.stringify(value, null, 2));
}
