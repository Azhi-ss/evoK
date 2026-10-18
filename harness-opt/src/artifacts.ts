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

function covers(allowed: readonly string[], relativeName: string): boolean {
  return allowed.some((entry) =>
    entry.endsWith("/") ? relativeName.startsWith(entry) : relativeName === entry,
  );
}

function isHeldOutPath(relativeName: string): boolean {
  return relativeName === "sealed" || relativeName.startsWith("sealed/")
    || relativeName.includes("held-out") || relativeName.includes("heldout");
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
