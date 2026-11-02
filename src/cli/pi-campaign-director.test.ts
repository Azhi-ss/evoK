import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCampaignDirector, type CampaignDispatch } from "./pi-campaign-director";

test("the main Pi session stays available while its named child runs and can read persisted status", async () => {
  const tools = new Map<string, any>(),
    events = new Map<string, any>();
  const notices: any[] = [];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(event: string, hook: any) {
      events.set(event, hook);
    },
    sendMessage(message: any, options: any) {
      notices.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const seen: CampaignDispatch[] = [];
  type Receipt = { job: { state: string } };
  let finish!: (result: Receipt) => void;
  const done = new Promise<Receipt>((resolve) => {
    finish = resolve;
  });
  registerCampaignDirector(pi, {
    async status() {
      return { pending: { id: "exp-03", state: "pending" } };
    },
    async dispatch(input) {
      seen.push(input);
      return input.role === "reviewer" ? { job: { state: "completed" } } : done;
    },
    async retry() {
      throw Error("unexpected retry");
    },
    async stop() {
      throw Error("unexpected stop");
    },
  });
  const ctx = { sessionManager: { getSessionId: () => "main-A" } };
  const call = (name: string, args: object) =>
    tools.get(name).execute("call", args, undefined, undefined, ctx);
  const experiment = {
    role: "researcher",
    jobId: "exp-03",
    objective: "Test early delivery",
    sourcePaths: ["runtime/agent.py"],
    reviewRequested: true,
    collaborators: [
      {
        role_name: "timer",
        capability_profile: "diagnostic",
        task_goal: "Locate the deadline failure",
        evidence_refs: ["screening"],
        deliverable_spec: "An observation",
      },
    ],
  };
  const receipt = await call("evok_dispatch", experiment);
  expect(receipt.details).toMatchObject({ jobId: "exp-03", state: "starting" });
  expect((await call("evok_status", {})).details.pending.id).toBe("exp-03");
  await expect(call("evok_dispatch", experiment)).rejects.toThrow(/active/);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ ...experiment, sessionId: "main-A" });
  finish({ job: { state: "review-pending" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.map((x) => x.role)).toEqual(["researcher", "reviewer"]);
  expect(seen[1].sourcePaths).toBeUndefined();
  expect(seen[1].collaborators).toBeUndefined();
  expect(seen[1].sessionId).toBe("main-A");
  expect(notices.at(-1).message.content).toContain("completed");
  expect(notices[0].options).toEqual({ triggerTurn: false });
});
