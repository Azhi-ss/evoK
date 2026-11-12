/**
 * Ledger trace equivalence (#254 / PRD §6).
 *
 * The Stage 1 extraction moved authorization → lock → reservation → freeze →
 * snapshot into `mission/run-preparation.ts`. This test proves it is a MOVE and
 * nothing more: for one fixed simulated input, the whole observable trace —
 * event sequence, key payloads, digests, artifact provenance, usage
 * attribution, published Research Memory and final Mission state, timestamps
 * normalized — is still exactly the one the review base `89dfd35` produced.
 *
 * The pinned literals below were computed at `89dfd35` BEFORE the extraction
 * (by running this same harness against a worktree at that commit). They must
 * never be updated to match new code: a changed pin is a behaviour change and
 * has to be justified as one, not edited green.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureResumeTrace, captureStartTrace, traceDigest, normalizeTraceValue, type TraceScenario } from "./ledger-trace";

/** Computed at review base `89dfd35`, never updated to match new code. */
const PINNED = {
  traceDigest: "bf096b578716b95d31b8e49346e5307846244df7ab1839cb9a907d1368d4fbcc",
  baselineSnapshotDigest: "afae04ece5b79438d5a7a81d96535f02c55ec24f8333ddc690afea211326842e",
  experimentSnapshotDigest: "780682e4997c24ed273f49d85420f2fb0705d23e0fe3677da2007a3b3ec1e875",
  memorySnapshotDigest: "17f39ce3976de240adcb77ea0197e0ab60abf2545aa9a067442ba0e2e8b476eb",
  resumeTraceDigest: "29d1bbc89db260f9f22a7b224764971babd7ee33680efbd7b607eeb5146a7e7d",
  resumeEventSequence: [
    "RECOVERY_COMPLETED",
    "MISSION_RESUMED",
    "DIRECTOR_CALLED",
    "DIRECTOR_CALLED",
    "PROPOSAL_APPLIED",
    "EXECUTION_INTENT_PERSISTED",
    "RUN_DISPATCHED",
    "SNAPSHOT_COMMITTED",
    "EVALUATION_MEASURED",
    "DIRECTOR_CALLED",
    "DIRECTOR_CALLED",
    "PROPOSAL_APPLIED",
    "EXECUTION_INTENT_PERSISTED",
    "RUN_DISPATCHED",
    "SNAPSHOT_COMMITTED",
    "EVALUATION_MEASURED",
    "DIRECTOR_CALLED",
    "DIRECTOR_CALLED",
    "DIRECTOR_STOPPED",
  ],
  eventSequence: [
    "MISSION_ACCEPTED",
    "EXECUTION_INTENT_PERSISTED",
    "BUDGET_RESERVED",
    "EXECUTION_INTENT_PERSISTED",
    "RUN_DISPATCHED",
    "SNAPSHOT_COMMITTED",
    "EVALUATION_MEASURED",
    "BASELINE_COMPLETED",
    "DIRECTOR_CALLED",
    "DIRECTOR_CALLED",
    "PROPOSAL_APPLIED",
    "EXECUTION_INTENT_PERSISTED",
    "RUN_DISPATCHED",
    "SNAPSHOT_COMMITTED",
    "EVALUATION_MEASURED",
    "DIRECTOR_CALLED",
    "DIRECTOR_CALLED",
    "DIRECTOR_STOPPED",
  ],
} as const;

const SCENARIO: TraceScenario = { missionId: "trace-equivalence", values: [0.4, 0.6] };

const projects: string[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function capture(scenario: TraceScenario = SCENARIO) {
  const project = await mkdtemp(join(tmpdir(), "evok-ledger-trace-"));
  projects.push(project);
  return captureStartTrace(project, scenario);
}

describe("ledger trace equivalence across the Stage 1 extraction (#254)", () => {
  test("the whole trace, timestamps normalized, is the review base's trace", async () => {
    const trace = await capture();

    expect(traceDigest(trace)).toBe(PINNED.traceDigest);
    expect(trace.events.map((event) => event.type)).toEqual([...PINNED.eventSequence]);

    // Key payloads the ordering guarantee rests on.
    const reserved = trace.events.find((event) => event.type === "BUDGET_RESERVED")!;
    expect(reserved.detail).toEqual({ reserveCost: 0.0001 });
    const accepted = trace.events.find((event) => event.type === "MISSION_ACCEPTED")!;
    expect(accepted.detail).toEqual({ authorizationToken: "/start", source: "user" });
    expect(trace.events.filter((event) => event.type === "PROPOSAL_APPLIED")).toHaveLength(1);

    // Artifact provenance and content addressing.
    expect(trace.artifacts.map((artifact) => [artifact.runId, Object.keys(artifact.files), artifact.result?.snapshotDigest])).toEqual([
      [SCENARIO.missionId + ":baseline:1", ["answer.txt"], PINNED.baselineSnapshotDigest],
      [SCENARIO.missionId + ":exp:2", ["answer.txt"], PINNED.experimentSnapshotDigest],
    ]);
    expect(trace.runs.map((run) => [run.runId, run.attempt, run.status, run.snapshotRef, run.resultRef])).toEqual([
      [`${SCENARIO.missionId}:baseline:1`, 1, "measured", `runs/${SCENARIO.missionId}:baseline:1/snapshot`, `runs/${SCENARIO.missionId}:baseline:1/result.json`],
      [`${SCENARIO.missionId}:exp:2`, 2, "measured", `runs/${SCENARIO.missionId}:exp:2/snapshot`, `runs/${SCENARIO.missionId}:exp:2/result.json`],
    ]);

    // Usage attribution: one priced line per Run, one per decision call, and
    // the same consumed/remaining arithmetic (B3: attribution stays in Mission).
    const usage = trace.usage as { reads?: unknown; runs: { sessionId: string }[]; decisions?: { sessionId: string }[] };
    expect(usage.runs.map((line) => line.sessionId)).toEqual(["trace-session-1", "trace-session-2"]);
    expect(usage.decisions?.map((line) => line.sessionId)).toEqual([
      "trace-director-1",
      "trace-director-1",
      "trace-director-2",
      "trace-director-2",
    ]);
    expect(trace.budget).toEqual({ consumed: 0.0012000000000000001, remaining: 0.9988, total: 1, units: "model-USD" });
    expect(trace.reserved).toBe(0.0001);

    // Final Mission state and the published Research Memory digest.
    expect(trace.final).toMatchObject({
      status: "director-stopped",
      stopReason: "bounded trace scenario complete",
      stateVersion: 2,
      baselineRunId: `${SCENARIO.missionId}:baseline:1`,
      researchMemoryMode: "real",
      modelTier: "default",
    });
    expect(trace.memory).toMatchObject({
      digest: PINNED.memorySnapshotDigest,
      snapshotId: `research-memory:${PINNED.memorySnapshotDigest}`,
      cardIds: [`finding:${SCENARIO.missionId}:baseline:1`, `finding:${SCENARIO.missionId}:exp:2`],
    });
  });

  test("the harness is deterministic: timestamps and temp paths are the only differences between two runs", async () => {
    const [first, second] = await Promise.all([capture(), capture()]);
    expect(traceDigest(second)).toBe(traceDigest(first));
    // The normalization itself is the guarantee, so it is asserted directly:
    // a timestamp or a per-attempt temp path never reaches the comparison.
    expect(normalizeTraceValue({ at: "2026-11-11T08:00:00.000Z", workspace: "/tmp/evok-baseline-x-17-ab12/baseline" })).toEqual({
      workspace: "<workspace>",
    });
  });

  test("the resume entry point has the review base's trace too", async () => {
    const project = await mkdtemp(join(tmpdir(), "evok-ledger-trace-"));
    projects.push(project);
    const trace = await captureResumeTrace(project, { missionId: "trace-resume", values: [0.4, 0.6] });

    expect(traceDigest(trace)).toBe(PINNED.resumeTraceDigest);
    // Recovery → its own preparation event → the same decision/Experiment loop.
    expect(trace.events.map((event) => event.type)).toEqual([...PINNED.resumeEventSequence]);
    expect(trace.runs.map((run) => [run.runId, run.attempt, run.status])).toEqual([
      ["trace-resume:exp:2", 2, "measured"],
      ["trace-resume:exp:3", 3, "measured"],
    ]);
    expect(trace.artifacts.map((artifact) => [artifact.runId, artifact.result?.snapshotDigest])).toEqual([
      ["trace-resume:exp:2", PINNED.baselineSnapshotDigest],
      ["trace-resume:exp:3", PINNED.experimentSnapshotDigest],
    ]);
    // A resume keeps the accepted arm and never restores spent budget.
    expect(trace.final).toMatchObject({ status: "director-stopped", stateVersion: 3, researchMemoryMode: "real" });
    expect(trace.budget).toEqual({ consumed: 0.0012000000000000001, remaining: 0.9988, total: 1, units: "model-USD" });
    const memory = trace.memory as { digest: string; cardIds: string[] };
    expect(memory).toMatchObject({
      digest: "271a7581ac97671d596459b06d4e4cb726293b18d0e5b9717766b18b66e399fa",
      cardIds: ["finding:trace-resume:exp:2", "finding:trace-resume:exp:3"],
    });
  });

  test("the harness detects a changed input, so a green pin means something", async () => {
    const changed = await capture({ missionId: "trace-equivalence", values: [0.4, 0.5] });
    expect(traceDigest(changed)).not.toBe(PINNED.traceDigest);
  });
});
