import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../relay/loop_mode.py", import.meta.url));

export const LOOP_CAPS = {
  maxRounds: 10,
  readOnlyTokenCap: 30_000_000,
  readOnlyWallCapS: 48 * 3600,
  realRunWallCapS: 103 * 3600,
  innovatorCap: 200_000,
} as const;

export interface CapState {
  readonly startedRounds: number;
  readonly readOnlyTokens: number;
  readonly readOnlyWallS: number;
  readonly realRunWallS: number;
}

/** The first cap that is already reached. A clear state returns null. */
export function capHit(state: CapState): "maxRounds" | "readOnlyTokenCap" | "readOnlyWallCap" | "realRunWallCap" | null {
  if (state.startedRounds >= LOOP_CAPS.maxRounds) return "maxRounds";
  if (state.readOnlyTokens >= LOOP_CAPS.readOnlyTokenCap) return "readOnlyTokenCap";
  if (state.readOnlyWallS >= LOOP_CAPS.readOnlyWallCapS) return "readOnlyWallCap";
  if (state.realRunWallS >= LOOP_CAPS.realRunWallCapS) return "realRunWallCap";
  return null;
}

export interface StopReport {
  readonly reason: string | null;
  readonly faultRounds: number;
  readonly reviewerRejectRounds: number;
  readonly calls: readonly string[];
  readonly loggedRuns: readonly number[];
}

export interface DriveRound {
  readonly readOnlyTokens?: number;
  readonly readOnlyWallS?: number;
  readonly realRunWallS?: number;
  readonly hostFault?: boolean;
  readonly reviewerReject?: boolean;
  /** Set when this round's anti-forgery check failed. The next round does not start. */
  readonly antiForgery?: string | boolean;
}

/** Same stop rules as loop_mode.drive. An in-progress real run is logged before the loop stops. */
export function driveCappedLoop(rounds: readonly DriveRound[], initial: Partial<CapState> = {}): StopReport {
  let tokens = initial.readOnlyTokens ?? 0;
  let readWall = initial.readOnlyWallS ?? 0;
  let realWall = initial.realRunWallS ?? 0;
  const calls: string[] = [];
  const logged: number[] = [];
  let reason: string | null = null;
  let faultRounds = 0;
  let reviewerRejectRounds = 0;
  for (let index = 1; index <= rounds.length; index += 1) {
    const hit = capHit({ startedRounds: index - 1, readOnlyTokens: tokens, readOnlyWallS: readWall, realRunWallS: realWall });
    if (hit) {
      reason = hit;
      break;
    }
    const rnd = rounds[index - 1] ?? {};
    calls.push(`role:${index}`);
    tokens = rnd.readOnlyTokens ?? tokens;
    readWall = rnd.readOnlyWallS ?? readWall;
    const beforeReal = capHit({ startedRounds: index - 1, readOnlyTokens: tokens, readOnlyWallS: readWall, realRunWallS: realWall });
    if (beforeReal) {
      reason = beforeReal;
      break;
    }
    calls.push(`real:${index}`);
    realWall = rnd.realRunWallS ?? realWall;
    logged.push(index);
    if (rnd.hostFault) faultRounds += 1;
    if (rnd.reviewerReject) reviewerRejectRounds += 1;
    if (rnd.antiForgery) {
      reason = "anti_forgery";
      break;
    }
    const after = capHit({ startedRounds: index, readOnlyTokens: tokens, readOnlyWallS: readWall, realRunWallS: realWall });
    if (after) {
      reason = after;
      break;
    }
  }
  return { reason, faultRounds, reviewerRejectRounds, calls, loggedRuns: logged };
}

export interface Round0Sign {
  readonly srcPath: string;
  readonly hostCopyPath: string;
}

export function signPreRound1(keyFile: string, ranker: unknown, critic: unknown, round0?: Round0Sign): Record<string, unknown> {
  const proc = spawnSync("python3", [SCRIPT, "pre-round1"], {
    input: JSON.stringify({
      seed: randomBytes(32).toString("hex"),
      ranker,
      critic,
      ...(round0 ? { round0Src: round0.srcPath, hostCopyPath: round0.hostCopyPath } : {}),
    }),
    encoding: "utf8",
    env: { ...process.env, HARNESS_ATTEST_KEY_FILE: keyFile },
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "pre_round1_sign failed").trim());
  return JSON.parse(proc.stdout) as Record<string, unknown>;
}

function loopMode(command: string, payload: unknown): Record<string, unknown> {
  const proc = spawnSync("python3", [SCRIPT, command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || command).trim());
  return JSON.parse(proc.stdout) as Record<string, unknown>;
}

/** Innovator+critic+ranker i+o+cacheRead. A trace argument is ignored by loop_mode. */
export function relayReadOnlyTokens(events: readonly unknown[]): number {
  const parsed = loopMode("read-only-tokens", { events });
  return typeof parsed.tokens === "number" ? parsed.tokens : 0;
}

export function bindRoleCall(
  role: "critic" | "ranker" | "reviewer",
  call: { readonly seq: number; readonly runId: string; readonly outputSha: string },
  events: readonly unknown[],
): { readonly ok: boolean; readonly reason?: string } {
  const parsed = loopMode("bind-role", { role, call, events });
  return { ok: parsed.ok === true, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
}

/** Per-round critic+ranker sub-cap. Independent of the cumulative 30M read-only cap. */
export function rankingBudget(events: readonly unknown[]): { readonly capHit: boolean; readonly reason: string | null } {
  const parsed = loopMode("ranking-budget", { events });
  return {
    capHit: parsed.capHit === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
  };
}

export function rankCandidates(
  candidates: readonly { readonly id: string; readonly changedKeys: number; readonly configSha?: string }[],
  excluded: readonly string[],
): { readonly status: string; readonly winner?: string; readonly reason?: string } {
  const parsed = loopMode("rank", { candidates, excluded });
  return {
    status: String(parsed.status),
    ...(typeof parsed.winner === "string" ? { winner: parsed.winner } : {}),
    ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
  };
}
