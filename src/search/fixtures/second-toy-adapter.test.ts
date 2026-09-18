import { describe, expect, test } from "bun:test";
import {
  BinaryAccuracyToyCompetitionAdapter,
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type CandidateSnapshot,
  type ToyAgentRuntime,
} from "./toy-harness";

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

function binaryRuntime(predictions: Record<string, string>) {
  const counts = new Map<string, number>();
  const runtime: ToyAgentRuntime = {
    selfVerify: () => ({ ok: true }),
    propose: ({ branchId }) => {
      counts.set(branchId, (counts.get(branchId) ?? 0) + 1);
      return { files: { predictions: predictions[branchId] ?? "[]" } };
    },
    falsify: () => ({ ok: true, objections: [] }),
  };
  return { runtime, counts };
}

function snapshot(files: Record<string, string>): CandidateSnapshot {
  return {
    missionId: "adapter-test",
    branchId: "a",
    attempt: 1,
    files,
    contract: { objective: "maximize accuracy" },
    provenance: {
      runId: "adapter-test:a:1",
      candidateId: "a:1",
      fencingToken: 1,
    },
  };
}

describe("BinaryAccuracyToyCompetitionAdapter", () => {
  test("describes independent input/rules/artifact and scoring contracts", () => {
    const binary = new BinaryAccuracyToyCompetitionAdapter([1, 0, 1]);
    const scoreFile = new ScoreFileToyCompetitionAdapter();
    const description = binary.describe();
    const scoreDescription = scoreFile.describe();

    expect(description.name).toBe("binary-accuracy");
    expect(description.metric).toContain("accuracy");
    expect(description.input).toMatchObject({ predictionFile: "predictions", rows: 3 });
    expect(description.rules).toHaveLength(2);
    expect(description.artifacts).toEqual(["predictions"]);
    expect(scoreDescription.metric).not.toBe(description.metric);
    expect(scoreDescription.artifacts).toEqual(["score"]);

    const valid = snapshot({ predictions: "[1, 1, 1]" });
    expect(binary.validateRules(valid)).toEqual({ ok: true, violations: [] });
    expect(binary.evaluate(valid)).toMatchObject({ score: 2 / 3 });
    const artifact = binary.collectArtifacts(valid)[0];
    expect(artifact?.kind).toBe("predictions");
    expect(typeof artifact?.digest).toBe("string");

    const invalid = snapshot({ predictions: "[1, 2]" });
    expect(binary.validateRules(invalid).ok).toBe(false);
    expect(() => binary.evaluate(invalid)).toThrow("rule validation failed");
  });

  test("runs through the shared harness and keeps promotion in the harness", async () => {
    const { runtime } = binaryRuntime({ good: "[1, 0, 1]", weak: "[1, 1, 1]" });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "binary-success",
      taskContract: { objective: "maximize accuracy" },
      branchIds: ["good", "weak"],
      runtime,
      adapter: new BinaryAccuracyToyCompetitionAdapter([1, 0, 1]),
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(result.adapterName).toBe("binary-accuracy");
    expect(result.champion?.branchId).toBe("good");
    expect(result.champion?.score).toBe(1);
    expect(result.champion?.snapshot.provenance).toEqual({
      runId: "binary-success:good:1",
      candidateId: "good:1",
      fencingToken: 1,
    });
    expect(result.champion?.facts).toEqual(expect.arrayContaining([
      { name: "accuracy", value: 1, source: "binary-accuracy" },
    ]));
    expect(harness.events().some((event) => event.type === "PROMOTED_LOCAL")).toBe(true);
  });

  test("shares rule rejection and crash recovery behavior with the first adapter", async () => {
    const invalidRuntime = binaryRuntime({ bad: "[1, 2]" });
    const invalidHarness = new ToyCompetitionHarness({
      prediction,
      missionId: "binary-invalid",
      taskContract: { objective: "maximize accuracy" },
      branchIds: ["bad"],
      runtime: invalidRuntime.runtime,
      adapter: new BinaryAccuracyToyCompetitionAdapter([1, 0]),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const invalidResult = await invalidHarness.run();
    expect(invalidResult.phase).toBe("STOPPED");
    expect(invalidResult.branches.bad.status).toBe("REJECTED");
    expect(invalidResult.champion).toBeUndefined();

    const recovering = binaryRuntime({ first: "[1, 0]", second: "[0, 1]" });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "binary-recovery",
      taskContract: { objective: "maximize accuracy" },
      branchIds: ["first", "second"],
      runtime: recovering.runtime,
      adapter: new BinaryAccuracyToyCompetitionAdapter([1, 0]),
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 1 },
      crashBeforeBranch: "second",
    });

    await expect(harness.run()).rejects.toThrow("simulated crash");
    const result = await harness.resume();

    expect(result.phase).toBe("COMPLETED");
    expect(recovering.counts.get("first")).toBe(1);
    expect(recovering.counts.get("second")).toBe(1);
    expect(harness.events().filter((event) => event.type === "BRANCH_RESERVED")).toHaveLength(2);
  });
});
