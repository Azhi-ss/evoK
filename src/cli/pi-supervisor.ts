// Read-only Pi supervision. Campaign state and accounting remain owned by the host.
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { strongestPhase2Revision, type Phase2State } from "../competition/phase2-playground";
import type { RoundReport, RoundWakeHost } from "./pi-round-wake";

export interface SupervisorEvent {
  id: string;
  watcher: "result" | "deadline" | "budget" | "stall";
  rule: string;
  evidence: Record<string, unknown>;
  submitDue?: boolean;
}

export interface SupervisorOptions {
  directory: string;
  status(): Promise<unknown>;
  now?: () => Date;
  stallMinutes?: number;
  zeroScoreCount?: number;
  pollIntervalMs?: number;
}

type Campaign = { revisions?: Record<string, { id: string; phases?: Record<string, number>;
  screening?: { score?: number; task?: string }[] }> };
type Limits = { deadline?: string; budgetFloorCNY?: number; submitBestDaily?: boolean };
type Status = { limits?: Limits; event?: string; at?: string; phase?: string; task?: string; sourceDigest?: string };
type Budget = { remaining: number; settledEstimate: number; heldUnverified: number;
  dailySpend?: Record<string, number>; undatedSpendCNY?: number };
type CampaignView = { budget?: Budget; quota?: { remaining: number | null } };
type BudgetCheckpoint = {
  directory: string;
  previous?: Budget;
  floorEpisode: number;
  floor?: SupervisorEvent;
  pending: SupervisorEvent[];
};

async function read<T>(directory: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(directory, name + ".json"), "utf8"));
  } catch (error) {
    // An absent/partially replaced file is not evidence of a state change.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function event(directory: string, watcher: SupervisorEvent["watcher"], key: unknown, rule: string,
  evidence: SupervisorEvent["evidence"]): SupervisorEvent {
  const digest = createHash("sha256").update(JSON.stringify([directory, watcher, key])).digest("hex");
  return { id: `supervisor-${watcher}-${digest}`, watcher, rule, evidence };
}

function results(directory: string, state: Phase2State | null, campaign: Campaign | null): SupervisorEvent[] {
  return (state?.attempts ?? []).flatMap(attempt => {
    const score = attempt.official?.score;
    if (typeof score !== "number" || !Number.isFinite(score)) return [];
    const local = Object.entries(campaign?.revisions ?? {}).find(([, row]) => row.id === attempt.revisionId);
    const screeningMean = local?.[1].phases?.screening ?? null;
    return [event(directory, "result", [attempt.id, score], "official-score", {
      attemptId: attempt.id, revisionId: attempt.revisionId, candidateDigest: local?.[0] ?? null,
      score, cost: attempt.official?.cost ?? null, screeningMean,
      deviation: screeningMean === null ? null : Number((score - screeningMean).toFixed(4)),
    })];
  });
}

function localTime(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60_000).toISOString();
}

function deadline(directory: string, state: Phase2State | null, campaign: Campaign | null,
  limits: Limits, now: Date, quota: CampaignView["quota"]): SupervisorEvent[] {
  if (!state) return [];
  const local = localTime(now), localDate = local.slice(0, 10);
  const used = state.attempts.some(attempt => {
    if (!attempt.real || attempt.state === "not-received") return false;
    // A retried attempt can append "submitting" twice; the latest one is today's slot.
    const at = attempt.history.findLast(item => item.state === "submitting")?.at;
    return at && Number.isFinite(Date.parse(at)) && localTime(new Date(at)).slice(0, 10) === localDate;
  });
  const accountRemaining = typeof quota?.remaining === "number" && Number.isSafeInteger(quota.remaining) && quota.remaining >= 0
    ? quota.remaining : null;
  const remaining = used ? 0 : Math.min(1, accountRemaining ?? 1);
  const expired = !!limits.deadline && now.getTime() >= Date.parse(limits.deadline);
  const daily = remaining > 0 && limits.submitBestDaily !== false && Number(local.slice(11, 13)) >= 21;
  if (!expired && !daily) return [];
  const best = strongestPhase2Revision(state.revisions ?? []);
  const strongest = best ? { revisionId: best.id,
    candidateDigest: Object.entries(campaign?.revisions ?? {}).find(([, row]) => row.id === best.id)?.[0]
      ?? best.change?.treeDigest ?? best.contentDigest } : null;
  return [{ ...event(directory, "deadline", localDate, expired ? "internal-deadline" : "daily-21:00", {
    localDate, localTime: local.slice(11, 19) + "+08:00", remaining, accountRemaining,
    deadline: limits.deadline ?? null, strongest,
  }), submitDue: remaining > 0 }];
}

function budgetEvents(checkpoint: BudgetCheckpoint, current: Budget | undefined, limits: Limits,
  delivered: Set<string | undefined>): BudgetCheckpoint {
  if (!current || ![current.remaining, current.settledEstimate, current.heldUnverified].every(Number.isFinite))
    return checkpoint;
  const { directory, previous } = checkpoint;
  const floor = limits.budgetFloorCNY ?? 40;
  const next = { ...checkpoint, previous: current, pending: checkpoint.pending.filter(item => !delivered.has(item.id)) };
  const evidence = { remaining: current.remaining, settled: current.settledEstimate,
    held: current.heldUnverified, dailySpend: current.dailySpend ?? null, undatedSpendCNY: current.undatedSpendCNY ?? null };
  if (current.remaining >= floor) next.floor = undefined;
  else if (!next.floor) {
    next.floorEpisode++;
    next.floor = event(directory, "budget", ["floor", next.floorEpisode], "budget-floor", { ...evidence, floor });
  }
  if (previous) {
    const heldDelta = current.heldUnverified - previous.heldUnverified;
    const settledDelta = current.settledEstimate - previous.settledEstimate;
    if (heldDelta > 0 && heldDelta > settledDelta) {
      const growing = event(directory, "budget", ["growth", previous.settledEstimate, previous.heldUnverified,
        current.settledEstimate, current.heldUnverified], "held-growing-faster", { ...evidence, heldDelta, settledDelta });
      if (!delivered.has(growing.id) && !next.pending.some(item => item.id === growing.id)) next.pending.push(growing);
    }
  }
  return next;
}

function stalls(directory: string, status: Status | null, campaign: Campaign | null, now: Date,
  options: SupervisorOptions): SupervisorEvent[] {
  const events: SupervisorEvent[] = [];
  const minutes = (now.getTime() - Date.parse(status?.at ?? "")) / 60_000;
  if (status?.event === "evaluating" && status.sourceDigest && status.task && minutes > (options.stallMinutes ?? 90)) {
    events.push(event(directory, "stall", [status.sourceDigest, status.phase, status.task, status.at],
      "evaluating-timeout", { task: status.task, phase: status.phase, minutes: Math.floor(minutes),
        candidateDigest: status.sourceDigest, startedAt: status.at }));
  }
  for (const [digest, row] of Object.entries(campaign?.revisions ?? {})) {
    const screening = row.screening ?? [];
    let consecutiveZeros = 0;
    for (let i = screening.length - 1; i >= 0 && screening[i].score === 0; i--) consecutiveZeros++;
    if (consecutiveZeros >= (options.zeroScoreCount ?? 2)) events.push(event(directory, "stall", [digest, "zeros"],
      "consecutive-zero-scores", { candidateDigest: digest, revisionId: row.id, consecutiveZeros,
        task: screening.at(-1)?.task ?? "screening", minutes: null }));
  }
  return events;
}

/** Wrap the existing host so all notifications share one metered Director queue. */
export function createSupervisorRoundHost(pi: ExtensionAPI, rounds: RoundWakeHost, options: SupervisorOptions): RoundWakeHost {
  const directory = resolve(options.directory);
  let ctx: ExtensionContext | undefined;
  pi.on("session_start", (_event, context) => { ctx = context; });
  pi.on("session_shutdown", () => { ctx = undefined; });
  return {
    subscribe(notify) {
      const stopRounds = rounds.subscribe?.(notify);
      const timer = setInterval(notify, options.pollIntervalMs ?? 30_000);
      timer.unref(); // Clock thresholds must work even when no file changes.
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let watcher: ReturnType<typeof watch> | undefined;
      try {
        watcher = watch(directory, { persistent: false }, (_event, file) => {
          if (!["status.json", "state.json", "campaign.json", "limits.json"].includes(String(file))) return;
          clearTimeout(debounce);
          debounce = setTimeout(notify, 75);
          debounce.unref();
        });
        watcher.on("error", () => watcher?.close()); // Polling also covers replaced/missing directories.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          clearInterval(timer);
          stopRounds?.();
          throw error;
        }
      }
      return () => { clearInterval(timer); clearTimeout(debounce); watcher?.close(); stopRounds?.(); };
    },
    async report(sessionId) {
      if (!ctx || ctx.sessionManager.getSessionId() !== sessionId) return null;
      const context = ctx;
      const branch = ctx.sessionManager.getBranch();
      const delivered = new Set(branch.flatMap(entry =>
        entry.type === "custom_message" && entry.customType === "evok-round"
          ? [(entry.details as { id?: string })?.id] : []));
      const [state, campaign, status, configured, view] = await Promise.all([
        read<Phase2State>(directory, "state"), read<Campaign>(directory, "campaign"),
        read<Status>(directory, "status"), read<Limits>(directory, "limits"),
        options.status().catch(() => null) as Promise<CampaignView | null>,
      ]);
      if (ctx !== context || ctx.sessionManager.getSessionId() !== sessionId) return null;
      const limits = { ...status?.limits, ...configured };
      const saved = branch.findLast(entry => entry.type === "custom" && entry.customType === "evok-supervisor-budget"
        && (entry.data as BudgetCheckpoint)?.directory === directory);
      const checkpoint = saved?.type === "custom" ? saved.data as BudgetCheckpoint
        : { directory, floorEpisode: 0, pending: [] };
      const next = budgetEvents(checkpoint, view?.budget, limits, delivered);
      if (JSON.stringify(next) !== JSON.stringify(checkpoint)) pi.appendEntry("evok-supervisor-budget", next);
      const now = options.now?.() ?? new Date();
      const events = [...results(directory, state, campaign),
        ...deadline(directory, state, campaign, limits, now, view?.quota),
        ...(next.floor ? [next.floor] : []), ...next.pending,
        ...stalls(directory, status, campaign, now, options)];
      const hit = events.find(item => !delivered.has(item.id));
      if (!hit) return rounds.report(sessionId);
      return {
        id: hit.id, jobId: "supervisor", sessionId, summary: hit.rule, state: "supervision",
        costCNY: 0, evidenceRefs: ["state.json", "campaign.json", "status.json", "limits.json"].map(name => join(directory, name)),
        supervisor: hit,
      } satisfies RoundReport;
    },
    async acknowledge(report) {
      // Delivery lives in the Pi branch; never ack a synthetic campaign job.
      if (!report.supervisor) await rounds.acknowledge(report);
    },
    openDirector: rounds.openDirector.bind(rounds),
  };
}

export const SUPERVISOR_DECISIONS = `Read evok_status and the cited evidence. Choose exactly one decision:
1. advise: put the post-mortem and next change only in the next research handoff. For a result, distinguish no artifact, contract mismatch, and scientific error; a score alone does not establish the cause.
2. submit: only for a deadline notification with submitDue=true. Stop deep research, re-check the strongest validated candidate and run the existing workspace scripts/release-candidate path. PHASE2_RELEASE_COST_BOUND_CNY, fresh account quota and all existing release checks still apply. A suggested local slot is not account quota authorization.
3. reconfigure: change limits.json (floor/deadline) or pause/resume only after recording the operator's explicit decision. If none is recorded, ask the operator and make no change.
For budget alerts, reduce or pause further measurements to preserve one release; for stalls, inspect the trial before stopping or changing direction. Never release reservations, rebase charges, or adjudicate accounting autonomously.`;
