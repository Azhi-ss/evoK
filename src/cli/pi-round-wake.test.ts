import { expect, test } from "bun:test";
import { registerRoundWake, type RoundReport } from "./pi-round-wake";

test("shutdown during model switch restores the session without dispatching or acknowledging a wake", async () => {
  const events = new Map<string, (...args: any[]) => any>();
  const entries: any[] = [],
    sent: boolean[] = [];
  const original = { provider: "user", id: "old" },
    metered = { provider: "evok-meter-director-test", id: "kimi" };
  let model = original,
    level = "low",
    closed = 0,
    ack = 0;
  let markSwitch!: () => void, resumeSwitch!: () => void;
  const switching = new Promise<void>(resolve => { markSwitch = resolve; });
  const resumed = new Promise<void>(resolve => { resumeSwitch = resolve; });
  const ctx = {
    get model() {
      return model;
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "pi-1", getBranch: () => entries },
    modelRegistry: {
      find: (p: string) => (p === metered.provider ? metered : original),
    },
  };
  const pi = {
    on: (name: string, fn: any) => events.set(name, fn),
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", customType, data }),
    getThinkingLevel: () => level,
    setThinkingLevel: (v: string) => {
      level = v;
    },
    setModel: async (next: typeof model) => {
      if (next === metered) {
        markSwitch();
        await resumed;
      }
      entries.push({ type: "model_change", provider: next.provider });
      model = next;
      return true;
    },
    sendMessage: (_msg: any, opts: any) => sent.push(opts.triggerTurn),
  };
  const report: RoundReport = {
    id: "d",
    jobId: "j",
    sessionId: "pi-1",
    summary: "done",
    state: "completed",
    costCNY: 1,
    evidenceRefs: ["r"],
  };
  const pump = registerRoundWake(pi as never, {
    report: async () => report,
    acknowledge: async () => {
      ack++;
    },
    openDirector: async () => ({
      provider: metered.provider,
      model: metered.id,
      close: async () => {
        closed++;
      },
    }),
  });
  const running = pump(ctx as never);
  await switching;
  await events.get("session_shutdown")!();
  resumeSwitch();
  await running;
  expect(model).toEqual(original);
  expect(level).toBe("low");
  expect(closed).toBe(1);
  expect(sent).toEqual([]);
  expect(ack).toBe(0);
});
