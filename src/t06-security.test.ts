import { describe, expect, test } from "bun:test";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type ToyAgentRuntime,
} from "./toy-harness";
import { createTrustedSnapshot } from "./security-boundary";

const prediction = {
  predictionId: "toy-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

const contract = { objective: "maximize" };
const policy = { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 3, quorum: 1 };

function baseRuntime(files: Record<string, string> = { score: "4" }): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

describe("T06 sandbox, trust, and verification gates", () => {
  test("runs self-verification before proposal and never starts expensive evaluation after failure", async () => {
    const calls: string[] = [];
    const runtime: ToyAgentRuntime = {
      selfVerify: () => { calls.push("self"); return { ok: false, objections: ["missing output"] }; },
      propose: () => { calls.push("propose"); return { files: { score: "9" } }; },
      falsify: () => { calls.push("falsify"); return { ok: true, objections: [] }; },
    };
    let evaluated = false;
    const result = await new ToyCompetitionHarness({
      prediction,
      missionId: "t06-preflight",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      adapter: { evaluate: () => { evaluated = true; return { score: 9 }; } },
      policy,
    }).run();

    expect(result.phase).toBe("STOPPED");
    expect(result.branches.a.status).toBe("REJECTED");
    expect(calls).toEqual(["self"]);
    expect(evaluated).toBe(false);
  });

  test("keeps verification roles separate and non-authoritative", async () => {
    const calls: string[] = [];
    const runtime: ToyAgentRuntime = {
      selfVerify: () => { calls.push("self"); return { ok: true }; },
      propose: () => { calls.push("propose"); return { files: { score: "4" } }; },
      falsify: () => { calls.push("falsifier"); return { ok: true, objections: [] }; },
      critic: () => { calls.push("critic"); return { ok: true, objections: [] }; },
      challenger: () => { calls.push("challenger"); return { ok: true, objections: [] }; },
      auditor: () => { calls.push("auditor"); return { ok: true, objections: [] }; },
      successAuditor: () => { calls.push("success-auditor"); return { ok: true, objections: [] }; },
    };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-roles",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy,
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(calls).toEqual(["self", "propose", "falsifier", "critic", "challenger", "auditor", "success-auditor"]);
    expect(harness.events().map((event) => event.type)).toEqual(expect.arrayContaining([
      "FALSIFIER_COMPLETED", "CRITIC_COMPLETED", "CHALLENGER_COMPLETED", "AUDITOR_COMPLETED", "SUCCESS_AUDITOR_COMPLETED",
      "EVALUATOR_SUCCEEDED", "PROMOTED_LOCAL",
    ]));
    expect(result.humanAcceptance).toBeUndefined();
  });

  test("quarantines candidate path attacks without retrying", async () => {
    let proposals = 0;
    let evaluations = 0;
    const runtime = baseRuntime();
    runtime.propose = () => { proposals++; return { files: { "../escape": "owned" } }; };
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-path-attack",
      taskContract: contract,
      branchIds: ["a"],
      runtime,
      adapter: { evaluate: () => { evaluations++; return { score: 1 }; } },
      policy,
    });

    const result = await harness.run();

    expect(result.branches.a.status).toBe("QUARANTINED");
    expect(proposals).toBe(1);
    expect(evaluations).toBe(0);
    expect(harness.events().filter((event) => event.type === "RETRY_SCHEDULED")).toHaveLength(0);
    expect(harness.events().at(-2)?.type).toBe("BRANCH_QUARANTINED");
  });

  test("quarantines evaluator tampering and forged results", async () => {
    const mutating = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-evaluator-mutation",
      taskContract: contract,
      branchIds: ["a"],
      runtime: baseRuntime(),
      adapter: {
        evaluate(snapshot) {
          (snapshot.files as Record<string, string>).score = "99";
          return { score: 99 };
        },
      },
      policy,
    });
    const mutationResult = await mutating.run();
    expect(mutationResult.branches.a.status).toBe("QUARANTINED");
    expect(mutationResult.champion).toBeUndefined();

    const forged = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-forged-evaluation",
      taskContract: contract,
      branchIds: ["a"],
      runtime: baseRuntime(),
      adapter: { evaluate: () => ({ score: Number.NaN }) },
      policy,
    });
    const forgedResult = await forged.run();
    expect(forgedResult.branches.a.status).toBe("QUARANTINED");
    expect(forged.events().some((event) => event.type === "BRANCH_QUARANTINED")).toBe(true);
  });

  test("rejects forged promotion snapshots and incomplete evaluator evidence during replay", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-replay-integrity",
      taskContract: contract,
      branchIds: ["a"],
      runtime: baseRuntime(),
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy,
    });
    await harness.run();
    const events = [...harness.events()];
    const promotionIndex = events.findIndex((event) => event.type === "PROMOTED_LOCAL");
    const prefix = events.slice(0, promotionIndex);
    const baseline = harness.state();
    const snapshot = baseline.branches.a.snapshot!;
    const forged = createTrustedSnapshot({ ...snapshot, files: { score: "99" } });
    prefix.push({
      sequence: prefix.length + 1,
      type: "PROMOTED_LOCAL",
      payload: {
        branchId: "a",
        fencingToken: snapshot.provenance.fencingToken,
        score: baseline.branches.a.score,
        facts: baseline.branches.a.facts,
        snapshot: forged,
        snapshotDigest: forged.digest,
        contractDigest: forged.contractDigest,
      },
    });
    expect(ToyCompetitionHarness.replay(prefix).champion).toBeUndefined();

    const incomplete = events.slice(0, promotionIndex);
    incomplete.push({
      sequence: incomplete.length + 1,
      type: "PROMOTED_LOCAL",
      payload: { branchId: "a", fencingToken: snapshot.provenance.fencingToken, score: baseline.branches.a.score, facts: baseline.branches.a.facts, snapshot },
    });
    expect(ToyCompetitionHarness.replay(incomplete).champion).toBeUndefined();
  });

  test("does not let a higher-fence replay reservation reopen a scored branch", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-replay-fence",
      taskContract: contract,
      branchIds: ["a"],
      runtime: baseRuntime(),
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy,
    });
    await harness.run();
    const events = [...harness.events()];
    const promotionIndex = events.findIndex((event) => event.type === "PROMOTED_LOCAL");
    const prefix = events.slice(0, promotionIndex);
    const branch = harness.state().branches.a;
    prefix.push({ sequence: prefix.length + 1, type: "BRANCH_RESERVED", payload: { branchId: "a", attempt: 2, fencingToken: 2 } });
    const replayed = ToyCompetitionHarness.replay(prefix);
    expect(replayed.branches.a.status).toBe("SCORED");
    expect(replayed.branches.a.attempt).toBe(1);
    expect(branch.status).toBe("PROMOTED_LOCAL");
  });

  test("requires the current local champion digest for explicit human acceptance", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "t06-human-gate",
      taskContract: contract,
      branchIds: ["a"],
      runtime: baseRuntime(),
      adapter: new ScoreFileToyCompetitionAdapter(),
      policy,
    });
    await harness.run();
    const champion = harness.state().champion!;

    await expect(Promise.resolve().then(() => harness.acceptChampion({ acceptedBy: "operator", championDigest: "wrong" }))).rejects.toThrow();
    const decision = harness.acceptChampion({ acceptedBy: "operator", championDigest: champion.snapshot.digest, decisionId: "human-1" });
    expect(harness.state().humanAcceptance).toEqual(decision);
    expect(harness.events().at(-1)?.type).toBe("HUMAN_ACCEPTED");
  });
});
