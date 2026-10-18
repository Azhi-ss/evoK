import { spawnSync } from "node:child_process";

/**
 * PRD §9: `playground submit --dry-run` must succeed when the CLI supports it.
 * When the binary or the flag is missing, mark the check not-run and fail closed.
 * This never performs a live submit.
 */

export type DryRunStatus = "passed" | "failed" | "unsupported";

export interface DryRunProbe {
  readonly status: DryRunStatus;
  readonly detail: string;
}

export function probePlaygroundDryRun(): DryRunProbe {
  const found = spawnSync("bash", ["-lc", "command -v playground"], { encoding: "utf8", timeout: 2000 });
  const bin = found.stdout.trim();
  if (found.status !== 0 || bin === "") {
    return {
      status: "unsupported",
      detail: "not-run: playground CLI is not installed; playground submit --dry-run was not executed",
    };
  }
  const help = spawnSync(bin, ["submit", "--help"], { encoding: "utf8", timeout: 5000 });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  if (!text.includes("--dry-run")) {
    return {
      status: "unsupported",
      detail: "not-run: playground submit has no --dry-run flag",
    };
  }
  const ran = spawnSync(bin, ["submit", "--dry-run"], { encoding: "utf8", timeout: 15000 });
  if (ran.status === 0) {
    return { status: "passed", detail: "playground submit --dry-run succeeded" };
  }
  const tail = `${ran.stderr ?? ran.stdout ?? ""}`.trim().slice(0, 400);
  return {
    status: "failed",
    detail: `playground submit --dry-run failed (exit ${ran.status ?? "signal"})${tail ? `: ${tail}` : ""}`,
  };
}
