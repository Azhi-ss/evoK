import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildRecordSecretError } from "./pi-child-records";
import { commitWorkerReceipt, recoverWorkerReceipt, turnsLeft, type WorkerAttempt } from "./pi-child-recovery";

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

test("a receipt carrying a credential is refused before it is written", async () => {
  const state = await mkdtemp(join(tmpdir(), "evok-records-"));
  const data = (name: string, value: unknown) => writeFile(join(state, name), JSON.stringify(value));
  const secret = "sk-live-0123456789abcdef0123456789";
  const roleRunId = randomUUID();
  const attempt: WorkerAttempt = {
    identity: "identity",
    ownerPid: 2147483647,
    taskRunId: "round-1",
    roleRunId,
    remainingToolTurns: 8,
    profile: "research",
    tools: ["evok_deliver"],
  };
  const args = { decision_tag: "阶段发现就绪", summary: "finding", modified_files: [], evidence_refs: [] };
  try {
    await data("active.json", attempt);
    await data(roleRunId + ".turns.json", 1);
    await data(roleRunId + ".action.json", { name: "evok_deliver", args: { ...args, summary: "finding " + secret } });
    await expect(commitWorkerReceipt(state, attempt, randomUUID())).rejects.toThrow(ChildRecordSecretError);
    await expect(readFile(join(state, "native-history.json"), "utf8")).rejects.toThrow(/ENOENT/);

    await data(roleRunId + ".action.json", { name: "evok_deliver", args });
    const nativeRunId = randomUUID();
    expect(await commitWorkerReceipt(state, attempt, nativeRunId)).toMatchObject({ nativeRunId, toolTurns: 1 });
    expect(await readFile(join(state, "native-history.json"), "utf8")).not.toContain(secret);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
