import { realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-subagents scans this PATH-style list on every discovery, including when
 * the delegation cwd is an `--out` directory outside the Pi project.
 * Package `pi.subagents.agents` is only consulted from that cwd's project.
 */
export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

/** Absolute `harness-opt/agents`. Relative `subagentOnlyExtensions` resolve from these files. */
export const PACKAGE_AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");

export function splitExtraAgentDirs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function sameDirectory(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
  } catch {
    return false;
  }
}

/**
 * Append the package agents directory so gap-finder, innovator, critic,
 * ranker, and reviewer-gate resolve without a manual export. An entry that
 * is already present is left untouched, including its original spelling.
 */
export function pinPackageAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const current = splitExtraAgentDirs(env[EXTRA_AGENT_DIRS_ENV]);
  if (!current.some((entry) => sameDirectory(entry, PACKAGE_AGENT_DIR))) {
    env[EXTRA_AGENT_DIRS_ENV] = [...current, PACKAGE_AGENT_DIR].join(delimiter);
  }
  return PACKAGE_AGENT_DIR;
}
