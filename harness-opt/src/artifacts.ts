import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  assertRoleWrite(role, relativeName);
  const target = join(root, relativeName);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body.endsWith("\n") ? body : `${body}\n`);
  return target;
}

export function writeRoleJson(root: string, role: RoleId, relativeName: string, value: unknown): string {
  return writeRoleFile(root, role, relativeName, JSON.stringify(value, null, 2));
}
