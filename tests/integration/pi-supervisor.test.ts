import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCampaignDirector } from "../../src/cli/pi-campaign-director";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = fileURLToPath(new URL("./fixtures/phase2-supervisor", import.meta.url));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "supervisor-integration-"));
  roots.push(root);
  const directory = join(root, "campaign");
  await cp(fixture, directory, { recursive: true });
  let session = SessionManager.create(root, join(root, "sessions"));
  const original = { provider: "current-provider", id: "current-model" };
  const metered = { provider: "evok-meter-director-fixture", id: original.id };
  const answer = (provider: string) => session.appendMessage({ role: "assistant", provider,
    model: original.id, content: [{ type: "text", text: "advise: inspect the failed artifact" }],
    stopReason: "stop", timestamp: Date.now() } as never);
  answer(original.provider); // Pi persists sessions after the first assistant turn.
  let now = new Date("2026-11-08T12:00:00Z"), opened = 0, closed = 0;
  const messages: any[] = [], selections: unknown[] = [];
  function start() {
    const hooks = new Map<string, ((...args: any[]) => any)[]>();
    let notify = () => {}, idle = true, model = original;
    const ctx = { sessionManager: session, get model() { return model; }, isIdle: () => idle,
      hasPendingMessages: () => false,
      modelRegistry: { find: (provider: string) => provider === original.provider ? original : metered } };
    const pi = {
      registerTool() {},
      on: (name: string, fn: any) => hooks.set(name, [...hooks.get(name) ?? [], fn]),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      getThinkingLevel: () => "low", setThinkingLevel() {},
      async setModel(next: typeof model) { model = next; session.appendModelChange(next.provider, next.id); return true; },
      sendMessage(message: any, options: any) {
        messages.push(message);
        session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        if (options.triggerTurn) idle = false;
      },
    } as unknown as ExtensionAPI;
    registerCampaignDirector(pi, {
      supervision: { directory, now: () => now, pollIntervalMs: 10 },
      status: async () => ({ budget: { remaining: 100, settledEstimate: 20, heldUnverified: 0 } }),
      dispatch: async () => { throw Error("watchers cannot dispatch"); },
      retry: async () => { throw Error("watchers cannot retry"); },
      stop: async () => { throw Error("watchers cannot stop"); },
      rounds: {
        subscribe: fn => { notify = fn; return () => { notify = () => {}; }; },
        report: async () => null,
        acknowledge: async () => { throw Error("watchers cannot mutate a campaign job"); },
        openDirector: async (_report, selection) => {
          selections.push(selection); opened++;
          return { provider: metered.provider, model: metered.id, close: async () => { closed++; } };
        },
      },
    });
    const emit = async (name: string) => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); };
    return { emit, notify: () => notify(), answer: async () => { answer(metered.provider); idle = true; await emit("agent_settled"); } };
  }
  return { directory, messages, selections, start, counts: () => ({ opened, closed }),
    time: (value: string) => { now = new Date(value); },
    reopen: () => { session = SessionManager.open(session.getSessionFile()!); } };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  expect(predicate()).toBe(true);
}

test("official state fixture delivers score/cost/deviation through the current metered Director once across disk restart", async () => {
  const w = await setup();
  const official = await readFile(join(fixture, "state.json"), "utf8");
  const pending = JSON.parse(official);
  delete pending.attempts[0].official;
  await writeFile(join(w.directory, "state.json"), JSON.stringify(pending));
  let app = w.start();
  try {
    await app.emit("session_start");
    await delay(30);
    expect(w.counts().opened).toBe(0);
    await writeFile(join(w.directory, "state.json"), official);
    await until(() => w.messages.length === 1);
    expect(w.counts().opened).toBe(1);
    expect(w.selections).toEqual([{ provider: "current-provider", model: "current-model" }]);
    const content = w.messages[0].content;
    for (const text of ['"score":0.25', '"cost":2.5', '"deviation":-0.5', "advise", "submit", "reconfigure",
      "PHASE2_RELEASE_COST_BOUND_CNY", "operator", "account quota", "no artifact", "contract", "scientific"])
      expect(content).toContain(text);
    // Crash after delivery, before an assistant answer: do not buy a duplicate wake.
    await app.emit("session_shutdown");
    w.reopen(); app = w.start();
    await app.emit("session_start");
    app.notify();
    await delay(40);
    expect(w.messages).toHaveLength(1);
    expect(w.counts()).toEqual({ opened: 1, closed: 1 });
    expect(await readFile(join(w.directory, "state.json"), "utf8")).toBe(official);
  } finally { await app.emit("session_shutdown"); }
});

test("clock-only deadline changes propose submission once per local day and survive a persisted session restart", async () => {
  const w = await setup();
  const state = JSON.parse(await readFile(join(w.directory, "state.json"), "utf8"));
  state.attempts = [];
  await writeFile(join(w.directory, "state.json"), JSON.stringify(state));
  w.time("2026-11-08T12:59:59Z");
  let app = w.start();
  try {
    await app.emit("session_start");
    await delay(30);
    expect(w.messages).toHaveLength(0);
    w.time("2026-11-08T13:00:00Z");
    await until(() => w.messages.length === 1);
    expect(w.messages[0].content).toContain('"submitDue":true');
    expect(w.messages[0].content).toContain('"revisionId":"rev-validated"');
    await app.answer();
    await app.emit("session_shutdown");
    w.reopen(); app = w.start();
    await app.emit("session_start");
    await delay(30);
    expect(w.messages).toHaveLength(1);
    w.time("2026-11-09T13:00:00Z");
    await until(() => w.messages.length === 2);
    expect(w.messages[1].content).toContain('"localDate":"2026-11-09"');
    await app.answer();
    await delay(30);
    expect(w.counts()).toEqual({ opened: 2, closed: 2 });
  } finally { await app.emit("session_shutdown"); }
});
