import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childToolGrants,
  installPiWorkerTools,
  writeChildToolPackage,
  type ChildToolBinding,
} from "./pi-child-tools";

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const active: string[][] = [];
  let aborted = 0;
  const ctx = { abort: () => void aborted++ };
  return {
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
      registerTool(definition: any) {
        tools.set(definition.name, definition);
      },
      setActiveTools(names: string[]) {
        active.push(names);
      },
    } as any,
    tools,
    active,
    aborted: () => aborted,
    fire: (event: string, payload: any) => (handlers.get(event) ?? []).map((handler) => handler(payload, ctx)),
    call: (name: string) => {
      const handler = (handlers.get("tool_call") ?? [])[0];
      return handler ? handler({ toolName: name }, ctx) : undefined;
    },
  };
}
const message = (...names: string[]) => ({ message: { role: "assistant", content: names.map((name) => ({ type: "toolCall", name })) } });
const evidence = [{ ref: "case-1", summary: "Baseline reward was 0.41." }];
const binding = (overrides: Partial<ChildToolBinding> = {}): ChildToolBinding => ({
  roleRunId: "role-run-1",
  profile: "research",
  tools: ["evok_read_evidence"],
  remainingToolTurns: 2,
  evidence,
  ...overrides,
});

test("a granted scoped tool is installed and answers from its own binding; an ungranted tool is absent and blocked", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-child-tools-"));
  const child = fakePi();
  try {
    await writeChildToolPackage(state, binding());
    installPiWorkerTools(child.pi, state);
    expect([...child.tools.keys()]).toEqual(["evok_read_evidence"]);
    child.fire("session_start", {});
    expect(child.active.at(-1)).toEqual(["evok_read_evidence"]);

    const result: any = await child.tools.get("evok_read_evidence").execute("call-1", { ref: "case-1" });
    expect(result.content[0].text).toContain("0.41");
    await expect(child.tools.get("evok_read_evidence").execute("call-2", { ref: "case-9" })).rejects.toThrow(
      /no such evidence/,
    );

    expect(child.tools.has("evok_write_file")).toBe(false);
    expect(child.call("evok_write_file")).toMatchObject({ block: true });
    expect(child.call("evok_read_evidence")).toBeUndefined();
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("no granted tool means no scoped tool at all", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-child-none-"));
  const child = fakePi();
  try {
    await writeChildToolPackage(state, binding({ tools: [], evidence: [] }));
    installPiWorkerTools(child.pi, state);
    expect([...child.tools.keys()]).toEqual([]);
    child.fire("session_start", {});
    expect(child.active.at(-1)).toEqual([]);
    for (const name of ["evok_read_evidence", "evok_read_file", "evok_write_file"]) {
      expect(child.call(name)).toMatchObject({ block: true, terminate: true });
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("one tool-turn rule: the last allowed batch runs, and only the batch after it ends the turn", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-child-turns-"));
  const child = fakePi();
  try {
    await writeChildToolPackage(state, binding({ remainingToolTurns: 1 }));
    installPiWorkerTools(child.pi, state);
    child.fire("message_end", message("evok_read_evidence"));
    expect(await readFile(join(state, "role-run-1.turns.json"), "utf8")).toBe("1");
    expect(child.call("evok_read_evidence")).toBeUndefined();
    child.fire("turn_end", {});
    expect(child.aborted()).toBe(0);

    child.fire("message_end", message("evok_read_evidence"));
    expect(child.call("evok_read_evidence")).toMatchObject({ block: true, terminate: true });
    child.fire("turn_end", {});
    expect(child.aborted()).toBe(1);
    // A batch the budget refuses never ran, so it never spends a turn.
    expect(await readFile(join(state, "role-run-1.turns.json"), "utf8")).toBe("1");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("the terminal control action is exempt from the budget but must be alone in its batch", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-child-control-"));
  const child = fakePi();
  try {
    await writeChildToolPackage(
      state,
      binding({
        remainingToolTurns: 1,
        controls: ["evok_deliver", "evok_communicate"],
        roleRunId: "role-run-2",
      }),
    );
    installPiWorkerTools(child.pi, state);
    child.fire("message_end", message("evok_read_evidence"));
    // Budget spent: the control action still runs, alone, and keeps its own turn.
    child.fire("message_end", message("evok_deliver"));
    expect(child.call("evok_deliver")).toBeUndefined();
    const delivered: any = await child.tools.get("evok_deliver").execute("call-3", {
      decision_tag: "阶段发现就绪",
      summary: "finding",
      modified_files: [],
      evidence_refs: [],
    });
    expect(delivered.terminate).toBe(true);
    child.fire("turn_end", {});
    expect(child.aborted()).toBe(0);
    expect(await readFile(join(state, "role-run-2.action.json"), "utf8")).toContain("finding");

    for (const batch of [["evok_deliver", "evok_read_evidence"], ["evok_deliver", "evok_communicate"]]) {
      const mixed = fakePi();
      installPiWorkerTools(mixed.pi, state);
      mixed.fire("message_end", message(...batch));
      for (const name of batch) expect(mixed.call(name)).toMatchObject({ block: true });
      mixed.fire("turn_end", {});
      expect(mixed.aborted()).toBe(1);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("grants follow the Task Contract and refuse what this transport cannot execute", async () => {
  expect(childToolGrants("researcher", [])).toEqual([]);
  expect(childToolGrants("researcher", ["evok_read_evidence", "evok_read_file"])).toEqual([
    "evok_read_evidence",
    "evok_read_file",
  ]);
  expect(childToolGrants("reviewer", ["evok_read_evidence"])).toEqual(["evok_read_evidence"]);
  // A profile that does not hold the capability cannot be granted it.
  expect(childToolGrants("critic", ["evok_write_file"])).toEqual([]);
  // A control action has no host in a text-answering child, so asking is refused, not dropped.
  expect(() => childToolGrants("researcher", ["evok_deliver"])).toThrow(/has no host/);
  // A capability the profile holds but this transport cannot execute is refused, never faked.
  expect(() => childToolGrants("researcher", ["evok_experiment"])).toThrow(/cannot be granted/);
  expect(() => childToolGrants("reviewer", ["evok_check"])).toThrow(/cannot be granted/);
});

test("the launch binding is written with its extension entry and refuses a credential-shaped record", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-child-entry-"));
  try {
    const entry = await writeChildToolPackage(state, binding({ tools: ["evok_read_file"] }));
    expect(entry).toBe(join(state, "entry.ts"));
    expect(await readFile(join(state, "binding.json"), "utf8")).toContain("evok_read_file");
    await expect(
      writeChildToolPackage(join(state, "secret"), {
        ...binding(),
        evidence: [{ ref: "case-1", summary: "key sk-live-0123456789abcdef0123456789" }],
      }),
    ).rejects.toThrow(/credential/i);
    await expect(
      writeChildToolPackage(join(state, "provider"), { ...binding(), provider: { apiKey: "x" } } as any),
    ).rejects.toThrow(/credential/i);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
