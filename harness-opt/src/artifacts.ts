import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROLE_CONTRACTS, type RoleId } from "./roles";

export function assertRoleWrite(role: RoleId, relativeName: string): void {
  const allowed = ROLE_CONTRACTS[role].writes;
  const ok = allowed.some((entry) =>
    entry.endsWith("/") ? relativeName.startsWith(entry) : relativeName === entry,
  );
  if (!ok) {
    throw new Error(`${role} cannot write ${relativeName}`);
  }
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
