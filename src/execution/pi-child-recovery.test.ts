import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverWorkerReceipt, turnsLeft } from "./pi-child-recovery";

test("a dead owner's completed tool delivery is replayed exactly once without relaunch; a missing proof keeps ownership", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-replay-"));
  const data = (name: string, value: unknown) => writeFile(join(state, name), JSON.stringify(value));
  const nativeRunId = randomUUID(),
    roleRunId = randomUUID();
  const asyncDir = join(state, "native/async-subagent-runs", nativeRunId);
  const attempt = {
    identity: "identity",
    taskRunId: "round-1",
    ownerPid: 2147483647,
    roleRunId,
    remainingToolTurns: 8,
    profile: "research",
    tools: ["evok_deliver"],
  };
  const action = {
    name: "evok_deliver",
    args: { decision_tag: "阶段发现就绪", summary: "finding", modified_files: [], evidence_refs: [] },
  };
  try {
    await mkdir(asyncDir, { recursive: true });
    await data("active.json", attempt);
    await data(roleRunId + ".started.json", { nativeRunId, asyncDir });
    await data(roleRunId + ".action.json", action);
    await data(roleRunId + ".turns.json", 2);
    await writeFile(
      join(asyncDir, "status.json"),
      JSON.stringify({ runId: nativeRunId, state: "complete", processTerminal: { state: "unknown" } }),
    );
    await expect(recoverWorkerReceipt(state, "identity", "round-1")).rejects.toThrow(/unconfirmed/);
    await writeFile(
      join(asyncDir, "status.json"),
      JSON.stringify({
        runId: nativeRunId,
        state: "complete",
        processTerminal: {
          state: "observed",
          runId: nativeRunId,
          runnerProcessInstanceId: "runner-instance",
          instances: [{ kind: "runner", processInstanceId: "runner-instance" }],
        },
      }),
    );
    const receipt = { nativeRunId, action, toolTurns: 2, remainingToolTurns: 6 };
    expect(await recoverWorkerReceipt(state, "identity", "round-1")).toMatchObject(receipt);
    expect(await recoverWorkerReceipt(state, "identity", "round-1")).toMatchObject(receipt);
    expect(await recoverWorkerReceipt(state, "identity", "new-round")).toBeUndefined();
    expect(await turnsLeft(state)).toBe(6);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
