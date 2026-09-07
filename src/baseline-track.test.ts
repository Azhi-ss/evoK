import { describe, expect, test } from "bun:test";
import {
  authorizeHeavySearch,
  baselineSatisfied,
  resolveBaselineTrack,
  directorAuthorizeHeavyTask,
  type BaselineTrackInput,
  type BaselineTrackProvider,
  type HeavySearchAuthorization,
} from "./baseline-track";

describe("resolveBaselineTrack", () => {
  test("resolves a snake-case declaration, defaulting delta to 0 and heavy kinds to open-search", () => {
    const contract = resolveBaselineTrack({
      entry: "bash run_lightgbm.sh",
      success_score: 0.7,
    } as BaselineTrackInput)!;
    expect(contract.entry).toBe("bash run_lightgbm.sh");
    expect(contract.successScore).toBe(0.7);
    expect(contract.minImprovementDelta).toBe(0);
    expect(contract.heavyIdeaKinds).toEqual(["open-search"]);
  });

  test("accepts camel-case fields and a configured delta", () => {
    const contract = resolveBaselineTrack({
      entry: "autogluon --quick",
      successScore: 0.6,
      minImprovementDelta: 0.02,
      heavyIdeaKinds: ["open-search", "systems"],
    } as BaselineTrackInput)!;
    expect(contract.entry).toBe("autogluon --quick");
    expect(contract.successScore).toBe(0.6);
    expect(contract.minImprovementDelta).toBe(0.02);
    expect(contract.heavyIdeaKinds).toEqual(["open-search", "systems"]);
  });

  test("resolves through an adapter-style provider accessor and is vendor-neutral", () => {
    const provider: BaselineTrackProvider = {
      baseline_track() {
        return { entry: "lightgbm-baseline", success_score: 0.5 };
      },
    };
    const contract = resolveBaselineTrack(provider)!;
    expect(contract.entry).toBe("lightgbm-baseline");
  });

  test("absent declaration means the gate is inactive", () => {
    expect(resolveBaselineTrack(undefined)).toBeUndefined();
    expect(resolveBaselineTrack({})).toBeUndefined();
    expect(resolveBaselineTrack({ baseline_track: () => undefined } as BaselineTrackProvider)).toBeUndefined();
  });

  test("fails closed on a bad declaration", () => {
    expect(() => resolveBaselineTrack({ successScore: 0.5 } as BaselineTrackInput)).toThrow();
    expect(() => resolveBaselineTrack({ entry: "x", minImprovementDelta: -0.1 } as BaselineTrackInput)).toThrow();
    expect(() => resolveBaselineTrack({ entry: "x", successScore: 0.8, heavyIdeaKinds: ["bogus"] } as BaselineTrackInput)).toThrow();
  });
});

describe("authorizeHeavySearch", () => {
  const contract = resolveBaselineTrack({ entry: "baseline", successScore: 0.7, minImprovementDelta: 0.05 })!;

  test("no baseline record yet → heavy search refused, cheap work allowed", () => {
    const decision = authorizeHeavySearch(contract, undefined, "open-search");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("baseline");

    const cheap = authorizeHeavySearch(contract, undefined, "systems");
    expect(cheap.allowed).toBe(true);
  });

  test("baseline below its success predicate → refused", () => {
    const failed: HeavySearchAuthorization["baseline"] = { ok: false, score: 0.6 };
    expect(authorizeHeavySearch(contract, failed, "open-search").allowed).toBe(false);
  });

  test("baseline passing its predicate unlocks heavy search", () => {
    const passed = { ok: true, score: 0.72 };
    expect(authorizeHeavySearch(contract, passed, "open-search").allowed).toBe(true);
  });

  test("inactive gate (no contract) allows everything", () => {
    expect(authorizeHeavySearch(undefined, undefined, "open-search").allowed).toBe(true);
  });
});

describe("baselineSatisfied (promotion ≥ baseline + δ)", () => {
  const contract = resolveBaselineTrack({ entry: "baseline", successScore: 0.7, minImprovementDelta: 0.05 })!;

  test("candidate must beat the baseline by at least δ", () => {
    expect(baselineSatisfied(contract, { ok: true, score: 0.7 }, 0.75).allowed).toBe(true);
    expect(baselineSatisfied(contract, { ok: true, score: 0.7 }, 0.74).allowed).toBe(false);
    expect(baselineSatisfied(contract, { ok: true, score: 0.7 }, 0.69).allowed).toBe(false);
  });

  test("no passing baseline → no candidate may promote", () => {
    expect(baselineSatisfied(contract, undefined, 0.99).allowed).toBe(false);
    expect(baselineSatisfied(contract, { ok: false, score: 0.7 }, 0.99).allowed).toBe(false);
  });

  test("default δ of 0 only requires reaching the baseline score", () => {
    const zero = resolveBaselineTrack({ entry: "baseline", successScore: 0.6 })!;
    expect(baselineSatisfied(zero, { ok: true, score: 0.61 }, 0.61).allowed).toBe(true);
  });
});

describe("director task selection accounts for baseline-first ordering", () => {
  const contract = resolveBaselineTrack({ entry: "baseline", successScore: 0.5, heavyIdeaKinds: ["open-search"] })!;

  test("heavy tasks are ineligible while the baseline task is unfinished; the baseline task stays eligible", () => {
    const baselineDone = false;
    expect(directorAuthorizeHeavyTask(contract, "open-search", baselineDone).allowed).toBe(false);
    expect(directorAuthorizeHeavyTask(contract, "systems", baselineDone).allowed).toBe(true);
  });

  test("heavy tasks become eligible once the baseline is established", () => {
    expect(directorAuthorizeHeavyTask(contract, "open-search", true).allowed).toBe(true);
  });

  test("tasks tagged baseline_track are always cheap/eligible regardless of kind", () => {
    expect(directorAuthorizeHeavyTask(contract, "open-search", false, ["baseline_track"]).allowed).toBe(true);
  });
});
