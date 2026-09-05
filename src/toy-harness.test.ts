import { describe, expect, test } from "bun:test";
import {
  InfrastructureError,
  ToyCompetitionHarness,
  type MissionEvent,
  type PromotionPolicy,
  type ToyAgentRuntime,
} from "./toy-harness";

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

const contract = { objective: "maximize the score" };

function runtimeFor(scores: Record<string, number>, falsified = new Set<string>()) {
  const workspaces = new Map<string, Record<string, string>>();
  const falsifierCalls: string[] = [];
  const counts = new Map<string, number>();

  const runtime: ToyAgentRuntime = {
    selfVerify(input) {
      input.context.checked = true;
      return { ok: true };
    },
    propose(input) {
      counts.set(input.branchId, (counts.get(input.branchId) ?? 0) + 1);
      workspaces.set(input.branchId, input.workspace);
      input.workspace.approach = input.branchId;
      return { files: { score: String(scores[input.branchId]) } };
    },
    falsify(input) {
      falsifierCalls.push(input.branchId);
      return falsified.has(input.branchId)
        ? { ok: false, objections: ["counterexample"] }
        : { ok: true, objections: [] };
    },
  };

  return { runtime, workspaces, falsifierCalls, counts };
}

describe("ToyCompetitionHarness", () => {
  test("contains branch preparation failures in branch state and mission events", async () => {
    const runtime: ToyAgentRuntime = {
      selfVerify: () => { throw new Error("preflight failed"); },
      propose: () => ({ files: { score: "1" } }),
      falsify: () => ({ ok: true, objections: [] }),
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "preflight-failure",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: () => ({ score: 1 }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();

    expect(result.phase).toBe("STOPPED");
    expect(result.branches.a.status).toBe("REJECTED");
    expect(result.branches.a.rejectionReason).toBe("preflight failed");
    expect(harness.events().some((event) => event.type === "BRANCH_REJECTED")).toBe(true);
    expect(harness.events().at(-1)?.type).toBe("MISSION_STOPPED");
  });

  test("isolates competitive branches, runs dedicated falsifiers, and fans in the best result", async () => {
    const { runtime, workspaces, falsifierCalls } = runtimeFor(
      { a: 4, b: 7, bad: 100 },
      new Set(["bad"]),
    );
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "mission-1",
      taskContract: contract,
      branchIds: ["a", "b", "bad"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 3, maxParallelBranches: 3, quorum: 2 },
    });

    const result = await harness.run();
    const state = harness.state();
    const types = harness.events().map((event) => event.type);

    expect(result.phase).toBe("COMPLETED");
    expect(result.champion?.branchId).toBe("b");
    expect(state.branches.bad.status).toBe("REJECTED");
    expect(falsifierCalls).toEqual(expect.arrayContaining(["a", "b", "bad"]));
    expect(workspaces.get("a")).not.toBe(workspaces.get("b"));
    expect(workspaces.get("a")?.approach).toBe("a");
    expect(workspaces.get("b")?.approach).toBe("b");
    expect(types).toContain("PREFLIGHT_SELF_CHECK_PASSED");
    expect(types).toContain("SNAPSHOT_COMMITTED");
    expect(types).toContain("PROMOTED_LOCAL");
  });

  test("bounds the number of active competitive branches", async () => {
    let active = 0;
    let maxActive = 0;
    const runtime: ToyAgentRuntime = {
      selfVerify: () => ({ ok: true }),
      async propose(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { files: { score: input.branchId.length.toString() } };
      },
      falsify: () => ({ ok: true, objections: [] }),
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "bounded",
      taskContract: contract,
      branchIds: ["a", "bb", "ccc", "dddd"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 4, maxParallelBranches: 2, quorum: 1 },
    });

    await harness.run();

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("resumes after a crash without rerunning a completed branch", async () => {
    const { runtime, counts } = runtimeFor({ a: 1, b: 2 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "resume",
      taskContract: contract,
      branchIds: ["a", "b"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 1 },
      crashBeforeBranch: "b",
    });

    await expect(harness.run()).rejects.toThrow("simulated crash");
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b") ?? 0).toBe(0);

    const result = await harness.resume();

    expect(result.champion?.branchId).toBe("b");
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
  });

  test("enforces task-contract-only candidate and attempt budgets", async () => {
    const { runtime, counts } = runtimeFor({ a: 1, b: 2 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "contract-budget",
      taskContract: { objective: "maximize", budget: { maxCandidates: 1, maxAttempts: 1 } },
      branchIds: ["a", "b"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b") ?? 0).toBe(0);
    expect(harness.state().branches.b.status).toBe("QUEUED");
    expect(harness.state().budget).toMatchObject({ maxCandidates: 1, maxAttempts: 1 });
  });

  test("treats contract budgets as hard ceilings over top-level and policy limits", async () => {
    const { runtime, counts } = runtimeFor({ a: 1, b: 2, c: 3, d: 4 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "conflicting-budgets",
      taskContract: { objective: "maximize", budget: { maxCandidates: 2, maxAttempts: 1 } },
      budget: { maxCandidates: 3, maxAttempts: 2 },
      branchIds: ["a", "b", "c", "d"],
      runtime,
      evaluate: () => { throw new InfrastructureError("evaluator unavailable"); },
      policy: { maxBranches: 4, maxParallelBranches: 1, maxAttempts: 3, quorum: 1 },
    });

    await harness.run();

    expect(harness.state().budget).toMatchObject({ maxCandidates: 2, maxAttempts: 1 });
    expect([...counts.values()]).toEqual([1, 1]);
    expect(harness.events().filter((event) => event.type === "BRANCH_RESERVED")).toHaveLength(2);
    expect(harness.state().branches.c.status).toBe("QUEUED");
  });

  test("resumes an incomplete reservation without exceeding one attempt", async () => {
    const { runtime, counts } = runtimeFor({ a: 1 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "resume-one-attempt",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 1, quorum: 1 },
      crashBeforeBranch: "a",
    });

    await expect(harness.run()).rejects.toThrow("simulated crash");
    const result = await harness.resume();

    expect(result.phase).toBe("COMPLETED");
    expect(counts.get("a")).toBe(1);
    expect(harness.events().filter((event) => event.type === "BRANCH_RESERVED")).toHaveLength(1);
  });

  test("retries infrastructure failure with a new fence and rejects a late old-run event", async () => {
    const { runtime } = runtimeFor({ a: 5 });
    let evaluations = 0;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "fencing",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: (snapshot) => {
        evaluations += 1;
        if (evaluations === 1) throw new InfrastructureError("evaluator timeout");
        return { score: Number(snapshot.files.score) };
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 2, quorum: 1 },
    });

    const result = await harness.run();
    const reservations = harness
      .events()
      .filter((event) => event.type === "BRANCH_RESERVED")
      .map((event) => Number(event.payload.fencingToken));

    expect(reservations).toEqual([1, 2]);
    expect(result.champion?.score).toBe(5);
    expect(result.branches.a.snapshot?.attempt).toBe(2);
    expect(result.branches.a.snapshot?.provenance.fencingToken).toBe(2);
    expect(harness.injectLateCompletion("a", reservations[0], 999)).toBe(false);
    expect(harness.state().champion?.score).toBe(5);
    expect(harness.events().at(-1)?.type).toBe("LATE_EVENT_REJECTED");
  });

  test("rejects stale branch results during replay", async () => {
    const { runtime } = runtimeFor({ a: 5 });
    let evaluations = 0;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "stale-replay",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: () => {
        evaluations += 1;
        if (evaluations === 1) throw new InfrastructureError("evaluator timeout");
        return { score: 5 };
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 2, quorum: 1 },
    });

    await harness.run();
    const events = [...harness.events()];
    const current = events.findLast((event) => event.type === "BRANCH_RESERVED");
    const stale = Number(current?.payload.fencingToken) - 1;
    events.push(
      { sequence: events.length + 1, type: "EVALUATION_STARTED", payload: { branchId: "a", fencingToken: stale } },
      { sequence: events.length + 2, type: "EVALUATOR_SUCCEEDED", payload: { branchId: "a", fencingToken: stale, score: 999 } },
      { sequence: events.length + 3, type: "PROMOTED_LOCAL", payload: { branchId: "a", fencingToken: stale, score: 999, facts: [], snapshot: harness.state().branches.a.snapshot } },
    );

    const replayed = ToyCompetitionHarness.replay(events);

    expect(replayed.champion?.score).toBe(5);
    expect(replayed.branches.a.score).toBe(5);
    expect(replayed.branches.a.status).toBe("PROMOTED_LOCAL");
  });

  test("rejects missing and non-finite fencing tokens during replay", async () => {
    const invalidFences: Array<{ name: string; value?: number }> = [
      { name: "missing" },
      { name: "stale", value: 0 },
      { name: "NaN", value: Number.NaN },
      { name: "Infinity", value: Number.POSITIVE_INFINITY },
      { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
    ];
    for (const invalidFence of invalidFences) {
      const { runtime } = runtimeFor({ a: 5 });
      const harness = new ToyCompetitionHarness({
      prediction,
        missionId: `invalid-fence-${invalidFence.name}`,
        taskContract: contract,
        branchIds: ["a"],
        runtime,
        evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
        policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
      });

      await harness.run();
      const baseline = harness.state();
      const events = [...harness.events()];
      const fencePayload = invalidFence.value === undefined ? {} : { fencingToken: invalidFence.value };
      events.push(
        { sequence: events.length + 1, type: "EVALUATION_STARTED", payload: { branchId: "a", ...fencePayload } },
        { sequence: events.length + 2, type: "EVALUATOR_SUCCEEDED", payload: { branchId: "a", ...fencePayload, score: 999 } },
        { sequence: events.length + 3, type: "PROMOTED_LOCAL", payload: { branchId: "a", ...fencePayload, score: 999, facts: [], snapshot: baseline.branches.a.snapshot } },
      );

      const replayed = ToyCompetitionHarness.replay(events);

      expect(replayed.branches.a).toEqual(baseline.branches.a);
      expect(replayed.champion).toEqual(baseline.champion);
    }
  });

  test("rejects branch replay events without an explicit fencing token", async () => {
    const { runtime } = runtimeFor({ a: 5 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "missing-fence-replay",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    await harness.run();
    const baseline = harness.state();
    const events = [...harness.events()];
    events.push(
      { sequence: events.length + 1, type: "EVALUATION_STARTED", payload: { branchId: "a" } },
      { sequence: events.length + 2, type: "EVALUATOR_SUCCEEDED", payload: { branchId: "a", score: 999 } },
      { sequence: events.length + 3, type: "PROMOTED_LOCAL", payload: { branchId: "a", score: 999, facts: [], snapshot: baseline.branches.a.snapshot } },
    );

    const replayed = ToyCompetitionHarness.replay(events);

    expect(replayed.branches.a).toEqual(baseline.branches.a);
    expect(replayed.champion).toEqual(baseline.champion);
  });

  test("rejects snapshots with mismatched identity or embedded provenance", async () => {
    const { runtime } = runtimeFor({ a: 5 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "snapshot-replay",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    await harness.run();
    const baseline = harness.state();
    const snapshot = baseline.branches.a.snapshot!;
    const fencingToken = baseline.branches.a.fencingToken!;
    const malformedSnapshots = [
      { ...snapshot, missionId: "other-mission" },
      { ...snapshot, branchId: "other-branch" },
      { ...snapshot, attempt: snapshot.attempt + 1 },
      { ...snapshot, provenance: { ...snapshot.provenance, fencingToken: fencingToken + 1 } },
      { ...snapshot, provenance: { ...snapshot.provenance, runId: "forged-run" } },
      { ...snapshot, provenance: { ...snapshot.provenance, candidateId: "forged-candidate" } },
    ];
    const events = [...harness.events()];
    for (const malformed of malformedSnapshots) {
      events.push({ sequence: events.length + 1, type: "SNAPSHOT_COMMITTED", payload: { branchId: "a", fencingToken, snapshot: malformed } });
      events.push({ sequence: events.length + 1, type: "PROMOTED_LOCAL", payload: { branchId: "a", fencingToken, score: 999, facts: [], snapshot: malformed } });
    }

    const replayed = ToyCompetitionHarness.replay(events);

    expect(replayed.branches.a).toEqual(baseline.branches.a);
    expect(replayed.champion).toEqual(baseline.champion);
  });

  test("recovers each durable execution stage without repeating completed work", async () => {
    const stages = [
      { event: "SNAPSHOT_COMMITTED", expectedEvaluations: 1, expectedProposals: 0, expectedFalsifications: 1 },
      { event: "EVALUATION_STARTED", expectedEvaluations: 1, expectedProposals: 0, expectedFalsifications: 1 },
      { event: "EVALUATOR_SUCCEEDED", expectedEvaluations: 0, expectedProposals: 0, expectedFalsifications: 1 },
    ] as const;

    for (const stage of stages) {
      const first = runtimeFor({ a: 5 });
      const source = new ToyCompetitionHarness({
      prediction,
        missionId: `durable-${stage.event}`,
        taskContract: contract,
        branchIds: ["a"],
        runtime: first.runtime,
        evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
        policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 1, quorum: 1 },
      });
      await source.run();
      const sourceEvents = [...source.events()];
      const cutoff = sourceEvents.findIndex((event) => event.type === stage.event);
      const recovery = runtimeFor({ a: 5 });
      let evaluations = 0;
      const resumed = ToyCompetitionHarness.fromEvents({
      prediction,
        missionId: `durable-${stage.event}`,
        taskContract: contract,
        branchIds: ["a"],
        runtime: recovery.runtime,
        evaluate: (snapshot) => { evaluations += 1; return { score: Number(snapshot.files.score) }; },
        policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 1, quorum: 1 },
      }, sourceEvents.slice(0, cutoff + 1) as MissionEvent[]);

      const result = await resumed.resume();

      expect(result.phase).toBe("COMPLETED");
      expect(result.champion?.branchId).toBe("a");
      expect(recovery.counts.get("a") ?? 0).toBe(stage.expectedProposals);
      expect(evaluations).toBe(stage.expectedEvaluations);
      expect(recovery.falsifierCalls).toHaveLength(stage.expectedFalsifications);
      expect(resumed.events().filter((event) => event.type === "BRANCH_RESERVED")).toHaveLength(1);
      expect(resumed.events().filter((event) => event.type === "SNAPSHOT_COMMITTED")).toHaveLength(1);
      expect(resumed.events().filter((event) => event.type === "EVALUATION_STARTED")).toHaveLength(1);
    }
  });

  test("settles sibling branches before exposing a failed run", async () => {
    let releaseSibling!: () => void;
    const siblingSettled = new Promise<void>((resolve) => { releaseSibling = resolve; });
    let siblingFinished = false;
    const runtime: ToyAgentRuntime = {
      selfVerify: () => ({ ok: true }),
      propose: async ({ branchId }) => {
        await siblingSettled;
        siblingFinished = true;
        return { files: { score: "1" } };
      },
      falsify: () => ({ ok: true, objections: [] }),
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "settle-siblings",
      taskContract: contract,
      branchIds: ["crash", "sibling"],
      runtime,
      evaluate: () => ({ score: 1 }),
      policy: { maxBranches: 2, maxParallelBranches: 2, quorum: 1 },
      crashBeforeBranch: "crash",
    });

    let rejected = false;
    const observedRejection = harness.run().catch((error: unknown) => {
      rejected = true;
      return error;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(false);
    expect(siblingFinished).toBe(false);
    releaseSibling();
    await expect(observedRejection).resolves.toMatchObject({ message: "simulated crash" });

    expect(siblingFinished).toBe(true);
  });

  test("passes candidate and optional champion together to promotion callbacks", async () => {
    const seen: Array<{ candidate: string; champion?: string }> = [];
    const { runtime } = runtimeFor({ a: 1, b: 2 });
    const promotionPolicy: PromotionPolicy = ({ candidate, champion }) => {
      seen.push({ candidate: candidate.branchId, champion: champion?.branchId });
      return !champion || candidate.score > champion.score;
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "promotion-object",
      taskContract: contract,
      branchIds: ["a", "b"],
      runtime,
      evaluate: (snapshot) => ({ score: Number(snapshot.files.score) }),
      promotionPolicy,
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 1 },
    });

    await harness.run();

    expect(seen).toEqual([{ candidate: "a" }, { candidate: "b", champion: "a" }]);
  });

  test("rejects malformed public branch and policy limits", () => {
    const base = { missionId: "invalid", taskContract: contract, runtime: runtimeFor({ a: 1 }).runtime };

    expect(() => new ToyCompetitionHarness({ ...base, branchIds: ["a", "a"] })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, branchIds: [""] })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, budget: { maxAttempts: -1 } })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, policy: { maxBranches: 0, maxParallelBranches: 1, quorum: 1 } })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, policy: { maxBranches: 1, maxParallelBranches: 0, quorum: 1 } })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, policy: { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 0, quorum: 1 } })).toThrow();
    expect(() => new ToyCompetitionHarness({ ...base, policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 0 } })).toThrow();
  });

  test("creates a bounded mission, gates execution, records distinct outcomes, and replays the ledger", async () => {
    const calls: string[] = [];
    const runtime: ToyAgentRuntime = {
      selfVerify: () => { calls.push("preflight"); return { ok: true }; },
      propose: () => { calls.push("propose"); return { files: { score: "8" } }; },
      falsify: () => { calls.push("falsify"); return { ok: true, objections: [] }; },
    };
    let snapshotWasFrozen = false;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "operator-created",
      taskContract: { objective: "maximize", constraints: { language: "ts" }, budget: { maxCandidates: 1 } },
      runtime,
      adapter: {
        name: "toy-score",
        evaluate(snapshot) {
          snapshotWasFrozen = Object.isFrozen(snapshot) && Object.isFrozen(snapshot.files);
          return { score: Number(snapshot.files.score), facts: [{ name: "score", value: 8, source: "toy" }] };
        },
      },
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });

    const result = await harness.run();
    const replayed = ToyCompetitionHarness.replay(harness.events());
    const types = harness.events().map((event) => event.type);

    expect(harness.state().objective).toBe("maximize");
    expect(harness.state().constraints).toEqual({ language: "ts" });
    expect(harness.state().budget).toEqual({ maxCandidates: 1 });
    expect(calls).toEqual(["preflight", "propose", "falsify"]);
    expect(snapshotWasFrozen).toBe(true);
    expect(types).toEqual(expect.arrayContaining(["AGENT_COMPLETED", "CANDIDATE_GENERATED", "EVALUATOR_SUCCEEDED"]));
    expect(result.champion?.facts[0]).toEqual({ name: "score", value: 8, source: "toy" });
    expect(replayed).toEqual(harness.state());
  });

  test("evaluates an immutable snapshot and enforces join quorum", async () => {
    const { runtime } = runtimeFor({ a: 3, b: 4 }, new Set(["b"]));
    let mutationBlocked = false;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "quorum",
      taskContract: contract,
      branchIds: ["a", "b"],
      runtime,
      evaluate: (snapshot) => {
        expect(Object.isFrozen(snapshot)).toBe(true);
        try {
          (snapshot.files as Record<string, string>).score = "999";
        } catch {
          mutationBlocked = true;
        }
        return { score: Number(snapshot.files.score) };
      },
      policy: { maxBranches: 2, maxParallelBranches: 1, quorum: 2 },
    });

    const result = await harness.run();

    expect(result.phase).toBe("STOPPED");
    expect(result.stopReason).toBe("join quorum not met");
    expect(mutationBlocked).toBe(true);
  });

  test("task contract idea type must be registered and is carried onto the candidate snapshot", async () => {
    expect(() => new ToyCompetitionHarness({
      prediction,
      missionId: "typed-contract",
      taskContract: { objective: "maximize", ideaType: "not-a-kind" },
      branchIds: ["a"],
      runtime: runtimeFor({ a: 5 }).runtime,
      evaluate: () => ({ score: 1 }),
    })).toThrow(/registered idea type/);

    const { runtime } = runtimeFor({ a: 7 });
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "typed-contract-2",
      taskContract: { objective: "maximize", ideaType: "algorithmic" },
      branchIds: ["a"],
      runtime,
      evaluate: () => ({ score: 1 }),
    });
    await harness.run();
    expect(harness.state().branches.a.snapshot?.ideaType).toBe("algorithmic");
  });
});
