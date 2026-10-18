import { readdirSync } from "node:fs";
import { join } from "node:path";

const CANDIDATE = /(?:^|\/)candidates\/([^/]+)\//;

/** `candidates/base/config.json` and task `dev-1` become `traces/base/dev-1.json`. */
export function traceRelPath(configPath: string, taskId: string): string {
  const owner = CANDIDATE.exec(configPath.replace(/\\/g, "/"))?.[1];
  if (!owner || owner === "." || owner === "..") throw new Error(`trace path has no candidate: ${configPath}`);
  if (taskId.trim() === "" || taskId.includes("/") || taskId.includes("\\") || taskId.includes("..")) {
    throw new Error(`trace path has no task: ${taskId}`);
  }
  return `traces/${owner}/${taskId}.json`;
}

/** Trace JSON files under `traces/`, including one directory per candidate. Symlinks are skipped. */
export function listTraceFiles(tracesDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(rel);
    }
  };
  walk(tracesDir, "");
  return found.sort();
}
