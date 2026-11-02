import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface RoundReport {
  id: string;
  jobId: string;
  sessionId: string;
  summary: string;
  state: string;
  costCNY: number;
  evidenceRefs: string[];
  budget?: { remaining?: number };
  quota?: { mode: string; remaining: number | null };
  hold?: string;
}

export interface RoundWakeHost {
  subscribe?(notify: () => void): () => void;
  report(sessionId: string): Promise<RoundReport | null>;
  acknowledge(report: RoundReport): Promise<void>;
  openDirector(
    report: RoundReport,
  ): Promise<{ provider: string; model: string; close(): Promise<void> }>;
}

type Selection = {
  id: string;
  alias: string;
  provider: string;
  model: string;
  level: ReturnType<ExtensionAPI["getThinkingLevel"]>;
};

function delivered(ctx: ExtensionContext, id: string) {
  const entries = ctx.sessionManager.getBranch();
  const i = entries.findLastIndex(
    (e) =>
      e.type === "custom_message" &&
      e.customType === "evok-round" &&
      (e.details as { id?: string })?.id === id,
  );
  if (i < 0) return { seen: false, answered: false };
  const details = (entries[i] as { details?: { provider?: string } }).details;
  const answered = entries
    .slice(i + 1)
    .some(
      (e) =>
        e.type === "message" &&
        e.message.role === "assistant" &&
        (details?.provider
          ? e.message.provider === details.provider
          : e.message.provider.startsWith("evok-meter-director-")) &&
        e.message.stopReason !== "error" &&
        e.message.stopReason !== "aborted",
    );
  return { seen: true, answered };
}

export function registerRoundWake(pi: ExtensionAPI, host: RoundWakeHost) {
  let generation = 0;
  let closed = false;
  let checking = false;
  let suppressed: string | undefined;
  let active: { report: RoundReport; finish(): Promise<void> } | undefined;
  let lastHold = "";
  let unsubscribe: (() => void) | undefined;

  // Pi records setModel as a persistent model_change, even for a short-lived proxy.
  const recoverSelection = async (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast(
      (e) => e.type === "custom" && e.customType === "evok-wake-selection",
    );
    if (entry?.type !== "custom") return;
    const saved = entry.data as Selection | null;
    if (!saved) return;
    const last = branch.findLast((e) => e.type === "model_change");
    if (
      ctx.model?.provider === saved.alias ||
      (last?.type === "model_change" && last.provider === saved.alias)
    ) {
      const original = ctx.modelRegistry.find(saved.provider, saved.model);
      if (!original || !(await pi.setModel(original)))
        throw Error("cannot restore the session's original model");
      pi.setThinkingLevel(saved.level);
    }
    pi.appendEntry("evok-wake-selection", null);
  };

  const pump = async (ctx: ExtensionContext) => {
    if (
      checking ||
      active ||
      closed ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      return;
    checking = true;
    const sessionId = ctx.sessionManager.getSessionId(),
      epoch = generation;
    const current = () =>
      !closed &&
      generation === epoch &&
      ctx.sessionManager.getSessionId() === sessionId;
    let report: RoundReport | null = null;
    try {
      report = await host.report(sessionId);
      if (!report || !current() || report.sessionId !== sessionId) return;
      const prior = delivered(ctx, report.id);
      if (prior.answered) {
        await host.acknowledge(report);
        return;
      }
      if (report.hold) throw Error(report.hold);
      if (
        suppressed === report.id ||
        !ctx.model ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages()
      )
        return;
      const previous = ctx.model;
      const meter = await host.openDirector(report);
      const selection = {
        id: report.id,
        alias: meter.provider,
        provider: previous.provider,
        model: previous.id,
        level: pi.getThinkingLevel(),
      };
      let changed = false,
        finished = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = async () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        try {
          if (changed && ctx.sessionManager.getSessionId() === sessionId)
            await recoverSelection(ctx);
        } finally {
          await meter.close();
        }
      };
      try {
        if (!current() || !ctx.isIdle() || ctx.hasPendingMessages()) {
          await finish();
          return;
        }
        const model = ctx.modelRegistry.find(meter.provider, meter.model);
        if (!model) throw Error("metered Director model unavailable");
        pi.appendEntry("evok-wake-selection", selection);
        changed = true;
        if (!(await pi.setModel(model)))
          throw Error("metered Director model unavailable");
        if (
          !current() ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages() ||
          ctx.model?.provider !== meter.provider
        ) {
          await finish();
          return;
        }
        pi.setThinkingLevel("max");
        active = { report, finish };
        pi.sendMessage(
          {
            customType: "evok-round",
            details: { id: report.id, provider: meter.provider },
            display: !prior.seen,
            content:
              "EvoK research round delivered. " +
              JSON.stringify(report) +
              "\nRead evok_status. Choose the next testable hypothesis, continue local research if submissions are unavailable, or stop if the evidence warrants it.",
          },
          { triggerTurn: true },
        );
        // The SDK dispatches this asynchronously. An immediate SDK rejection can leave
        // the session idle without an agent_settled event; retain the report for recovery.
        watchdog = setTimeout(() => {
          if (active?.finish === finish && ctx.isIdle()) {
            suppressed = active.report.id;
            active = undefined;
            void finish().catch(() => {});
          }
        }, 1500);
        watchdog.unref();
        lastHold = "";
      } catch (error) {
        if (active?.finish === finish) active = undefined;
        await finish();
        throw error;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastHold && current())
        pi.sendMessage(
          {
            customType: "evok-waiting",
            content: "EvoK · " + reason,
            display: true,
          },
          { triggerTurn: false },
        );
      lastHold = reason;
    } finally {
      checking = false;
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    generation++;
    closed = false;
    suppressed = undefined;
    unsubscribe?.();
    await recoverSelection(ctx);
    unsubscribe = host.subscribe?.(() => {
      void pump(ctx);
    });
    void pump(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const turn = active;
    if (turn && turn.report.sessionId === ctx.sessionManager.getSessionId()) {
      active = undefined;
      suppressed = turn.report.id;
      await turn.finish();
      if (delivered(ctx, turn.report.id).answered)
        await host.acknowledge(turn.report);
    } else {
      suppressed = undefined;
    }
    if (!closed) void pump(ctx);
  });
  pi.on("session_shutdown", async () => {
    generation++;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    const turn = active;
    active = undefined;
    await turn?.finish();
  });
  return pump;
}
