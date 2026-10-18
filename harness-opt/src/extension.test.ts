import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarnessOptExtension, resolveRoundWorkflow, ROUND_TOKEN_HARD } from "../extensions/harness-opt/index";

const here = dirname(fileURLToPath(import.meta.url));

describe("pi extension skeleton", () => {
  test("resolveRoundWorkflow is synchronous and only authorises the dev eval command", () => {
    expect(() => resolveRoundWorkflow({ cand: "../x" })).toThrow(/relative id/);
    expect(() => resolveRoundWorkflow({ cand: "/tmp/x" })).toThrow(/relative id/);
    const round = resolveRoundWorkflow({ cand: "abc" });
    expect(round.gateCommand).toBe("bun bin/eval.ts --cand abc --split dev");
    expect(round.hostCommands).toEqual([round.gateCommand]);
    expect(round.usageBudget.tokens.hard).toBe(ROUND_TOKEN_HARD);
    expect(round).not.toHaveProperty("outputSchema");
  });

  test("session_start does not import pi-subagents or throw", async () => {
    const events = new Map<string, () => Promise<void> | void>();
    const names: string[] = [];
    const pi = {
      registerCommand(name: string) {
        names.push(name);
      },
      on(event: string, handler: () => Promise<void> | void) {
        events.set(event, handler);
        return () => {};
      },
    };
    createHarnessOptExtension()(pi as never);
    await events.get("session_start")?.();
    await events.get("session_shutdown")?.();
    expect(names).toEqual(["harnessopt_select", "harnessopt_record", "harnessopt_submit_gate"]);
    const source = readFileSync(join(here, "../extensions/harness-opt/index.ts"), "utf8");
    expect(source).not.toContain("from \"pi-subagents");
    const workflow = readFileSync(join(here, "../workflows/round.js"), "utf8");
    expect(workflow).toContain("gap-finder");
    expect(workflow).toContain("reviewer-gate");
    const ran = spawnSync(process.execPath, ["-e", "import('./harness-opt/workflows/round.js')"], {
      cwd: join(here, "../.."),
      encoding: "utf8",
    });
    expect(ran.status).not.toBe(0);
    expect(`${ran.stderr}${ran.stdout}`).toContain("TODO");
  });
});
