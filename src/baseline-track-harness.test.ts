import { describe, expect, test } from "bun:test";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type BaselineRunContext,
  type BaselineTrackResult,
  type ToyAgentRuntime,
  type ToyCompetitionAdapter,
} from "./toy-harness";

const prediction = {
  predictionId: "baseline-prediction",
  hypothesis: "heavy search is gated behind a strong baseline",
  expectedObservation: "baseline-first ordering is enforced",
  expectedObservations: ["baseline-first ordering is enforced"],
  failureModes: ["heavy search runs before the baseline is established"],
} as const;

function runtime(score = "0.9"): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files: { score } }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

/** Tabular-style adapter that declares a vendor-neutral strong-baseline track. */
class BaselineTabularAdapter extends ScoreFileToyCompetitionAdapter {
  constructor(private readonly baseline: () => BaselineTrackResult) {
    super("score");
  }
  baseline_track() {
    return { entry: "lightgbm-quick", success_score: 0.7, min_improvement_delta: 0.05 };
  }
  runBaselineTrack(_context: BaselineRunContext): BaselineTrackResult {
    return this.baseline();
  }
  evaluate(snapshot: Readonly<{ files: Record<string, string> }>): { score: number } {
    return super.evaluate(snapshot as never);
  }
}

async function harnessWith(adapter: ToyCompetitionAdapter, ideaType?: string) {
  const harness = new ToyCompetitionHarness({
    prediction,
    missionId: "baseline-first",
    adapter,
    taskContract: { objective: "beat the tabular baseline", ...(ideaType ? { ideaType } : {}) },
    branchIds: ["heavy"],
    runtime: runtime("0.9"),
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
  });
  return harness;
}

describe("T43 forced strong-baseline track (toy adapter fixture)", () => {
  test("heavy (open-search) candidate is refused before any baseline is established", async () => {
    // Adapter declares a baseline entry, but the baseline run fails the success predicate.
    const adapter = new BaselineTabularAdapter(() => ({ ok: true, score: 0.6 }));
    const harness = await harnessWith(adapter, "open-search");
    const result = await harness.run();

    expect(result.phase).toBe("STOPPED");
    expect(result.branches.heavy.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(true);
    expect(harness.events().some((e) => e.type === "BASELINE_TRACK_FAILED")).toBe(true);
    // The heavy candidate never generated a candidate/snapshot.
    expect(harness.events().some((e) => e.type === "CANDIDATE_GENERATED")).toBe(false);
  });

  test("heavy search proceeds after the baseline clears its success predicate", async () => {
    const adapter = new BaselineTabularAdapter(() => ({ ok: true, score: 0.72 }));
    const harness = await harnessWith(adapter, "open-search");
    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(result.branches.heavy.status).toBe("PROMOTED_LOCAL");
    expect(harness.events().some((e) => e.type === "BASELINE_TRACK_PASSED")).toBe(true);
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(false);
    expect(result.baseline?.ok).toBe(true);
    expect(result.baseline?.score).toBe(0.72);
  });

  test("cheap (systems) work is not gated even when the baseline has not passed", async () => {
    const adapter = new BaselineTabularAdapter(() => ({ ok: true, score: 0.6 }));
    const harness = await harnessWith(adapter, "systems");
    const result = await harness.run();

    // Cheap branch still cannot promote (no baseline + δ), but it is not refused as heavy:
    // it runs and is rejected at promotion, not at the heavy-search guard.
    expect(result.branches.heavy.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(false);
    expect(harness.events().some((e) => e.type === "CANDIDATE_GENERATED")).toBe(true);
  });

  test("candidate below baseline + δ is denied promotion even after a passing baseline", async () => {
    const adapter = new BaselineTabularAdapter(() => ({ ok: true, score: 0.72 }));
    // Candidate scores 0.73: baseline 0.72 + δ 0.05 = 0.77 required → denied.
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "below-delta",
      adapter,
      taskContract: { objective: "beat baseline", ideaType: "open-search" },
      branchIds: ["weak"],
      runtime: runtime("0.73"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    expect(result.phase).toBe("STOPPED");
    expect(result.branches.weak.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(false);
    expect(harness.events().filter((e) => e.type === "BRANCH_REJECTED").at(-1)?.payload.reason).toContain("baseline + δ");
  });

  test("no baseline track declared → gate inactive (back-compatible)", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "no-baseline",
      adapter: new ScoreFileToyCompetitionAdapter("score"),
      taskContract: { objective: "maximize", ideaType: "open-search" },
      branchIds: ["a"],
      runtime: runtime("1"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    expect(result.phase).toBe("COMPLETED");
    expect(result.baselineTrack).toBeUndefined();
    expect(harness.events().some((e) => e.type === "BASELINE_TRACK_PASSED")).toBe(false);
  });

  test("a baseline port that throws fails closed: heavy search refused, error recorded as redacted evidence", async () => {
    class ThrowingAdapter extends ScoreFileToyCompetitionAdapter {
      baseline_track() { return { entry: "automl-cli", success_score: 0.5 }; }
      runBaselineTrack(): BaselineTrackResult {
        throw new Error("boom-automl-down");
      }
    }
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "baseline-throws",
      adapter: new ThrowingAdapter("score"),
      taskContract: { objective: "win", ideaType: "open-search" },
      branchIds: ["a"],
      runtime: runtime("0.9"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    expect(result.branches.a.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "BASELINE_TRACK_FAILED")).toBe(true);
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(true);
    const failed = harness.events().filter((e) => e.type === "BASELINE_TRACK_FAILED").at(-1);
    expect(failed?.payload.evidence).toContain("boom-automl-down");
  });

  test("a declared track with no runnable port fails safe and keeps the gate closed", async () => {
    class DeclOnlyAdapter extends ScoreFileToyCompetitionAdapter {
      baseline_track() { return { entry: "automl-cli", success_score: 0.5 }; }
    }
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "baseline-no-port",
      adapter: new DeclOnlyAdapter("score"),
      taskContract: { objective: "win", ideaType: "open-search" },
      branchIds: ["a"],
      runtime: runtime("0.9"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    expect(result.branches.a.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(true);
    expect(result.baseline?.ok).toBe(false);
    expect(result.baseline?.evidence).toContain("runBaselineTrack");
  });

  test("a baseline established before a crash is not re-run on resume and heavy work proceeds", async () => {
    let baselineCalls = 0;
    class CrashAdapter extends ScoreFileToyCompetitionAdapter {
      baseline_track() { return { entry: "lightgbm", success_score: 0.7 }; }
      runBaselineTrack(): BaselineTrackResult {
        baselineCalls += 1;
        return { ok: true, score: 0.72 };
      }
    }
    const makeOptions = () => ({
      prediction,
      missionId: "baseline-resume",
      adapter: new CrashAdapter("score"),
      taskContract: { objective: "win", ideaType: "open-search" },
      branchIds: ["a"],
      runtime: runtime("0.9"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    // Pre-crash ledger: baseline established, verdict on the ledger.
    const first = new ToyCompetitionHarness(makeOptions());
    await first.establishBaseline();
    expect(baselineCalls).toBe(1);

    // A fresh harness replaying the ledger must not re-run the baseline and must proceed.
    const replay = ToyCompetitionHarness.fromEvents(makeOptions(), first.events());
    const result = await replay.run();
    expect(baselineCalls).toBe(1); // baseline verdict replayed, not re-run
    expect(result.phase).toBe("COMPLETED");
    expect(result.branches.a.status).toBe("PROMOTED_LOCAL");
    expect(result.baseline?.ok).toBe(true);
  });

  test("a baseline track declared as a mission option (not on the adapter) is enforced", async () => {
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "option-baseline",
      adapter: new ScoreFileToyCompetitionAdapter("score"),
      baselineTrack: { entry: "automl", success_score: 0.95 },
      taskContract: { objective: "win", ideaType: "open-search" },
      branchIds: ["a"],
      runtime: runtime("0.9"),
      policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    });
    const result = await harness.run();
    // Declared via option but no adapter port to run it: fails safe, heavy search refused.
    expect(result.branches.a.status).toBe("REJECTED");
    expect(harness.events().some((e) => e.type === "HEAVY_SEARCH_REFUSED")).toBe(true);
    expect(result.baselineTrack?.entry).toBe("automl");
  });
});
