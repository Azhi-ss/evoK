import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE2_MODEL_ALLOWLIST,
  Phase2PlaygroundAdapter,
  createPhase2JsonStore,
} from "../competition/phase2-playground";
import { FakePhase2Platform, type FakePhase2Script } from "../competition/phase2-fake-platform";
import { Phase2Research, initPhase2Research, isPhase2Eligible } from "./phase2-research";
import { runPhase2Demo } from "../cli/phase2-cli";

function setup(script: FakePhase2Script = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phase2-research-"));
  const statePath = join(dir, "state.json");
  const store = createPhase2JsonStore(statePath);
  initPhase2Research(store, { cap: 100 });
  const platform = new FakePhase2Platform(script);
  const research = new Phase2Research({ store, adapter: new Phase2PlaygroundAdapter({ store, platform }) });
  return { statePath, store, platform, research };
}

function reopen(statePath: string, platform: FakePhase2Platform): Phase2Research {
  const store = createPhase2JsonStore(statePath);
  return new Phase2Research({ store, adapter: new Phase2PlaygroundAdapter({ store, platform }) });
}

function localEvidence(research: Phase2Research, id: string, withheld: number): void {
  research.recordEvidence(id, { kind: "screening", score: withheld - 0.02, cost: 1 });
  research.recordEvidence(id, { kind: "withheld-validation", score: withheld, cost: 2 });
  research.recordEvidence(id, { kind: "noisy-repeat", score: withheld - 0.01, cost: 2 });
}

function releaseEvidence(research: Phase2Research, id: string, cloud = 0.5): void {
  research.recordEvidence(id, { kind: "source-check", passed: true, cost: 0 });
  research.recordEvidence(id, { kind: "public-smoke", passed: true, cost: 0 });
  research.recordEvidence(id, { kind: "cloud-self-test", score: cloud, cost: 5 });
}

describe("phase2 revisions and evidence", () => {
  test("revisions are immutable and content-addressed", () => {
    const { research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    const again = research.proposeRevision({ summary: "ignored", change: { runtime: "v1" } });
    const b = research.proposeRevision({ summary: "two", change: { runtime: "v2" } });
    expect(again.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
    expect(research.directorView().revisions.length).toBe(2);
  });

  test("eligibility needs screening, withheld validation and a noisy-case repeat", () => {
    const { research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    research.recordEvidence(a.id, { kind: "screening", score: 0.4 });
    research.recordEvidence(a.id, { kind: "withheld-validation", score: 0.5 });
    const before = research.directorView().revisions[0];
    expect(isPhase2Eligible({ ...research.proposeRevision({ summary: "x", change: { runtime: "v1" } }), evidence: [] })).toBe(false);
    expect(before.eligible).toBe(false);
    expect(research.nominate().nomineeId).toBeNull();
    research.recordEvidence(a.id, { kind: "noisy-repeat", score: 0.45 });
    expect(research.nominate().nomineeId).toBe(a.id);
  });

  test("researcher cannot write official evidence and scores must be finite", () => {
    const { research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    expect(() => research.recordEvidence(a.id, { kind: "official", score: 0.9 })).toThrow("reconciliation");
    expect(() => research.recordEvidence(a.id, { kind: "screening", score: Number.NaN })).toThrow("finite");
  });
});

describe("phase2 director nomination", () => {
  test("strongest eligible wins and replaces an unsubmitted nominee", () => {
    const { research } = setup();
    const weak = research.proposeRevision({ summary: "weak", change: { runtime: "v1" } });
    const strong = research.proposeRevision({ summary: "strong", change: { runtime: "v2" } });
    localEvidence(research, weak.id, 0.4);
    expect(research.nominate().nomineeId).toBe(weak.id);
    localEvidence(research, strong.id, 0.6);
    const result = research.nominate();
    expect(result.nomineeId).toBe(strong.id);
    expect(result.replaced).toBe(true);
    expect(research.nominate().replaced).toBe(false);
  });

  test("an unconfirmed attempt pins the nominee until reconciled", async () => {
    const { research } = setup({ quota: [1], submitOutcomes: ["timeout"] });
    const weak = research.proposeRevision({ summary: "weak", change: { runtime: "v1" } });
    localEvidence(research, weak.id, 0.4);
    releaseEvidence(research, weak.id);
    research.nominate();
    const result = await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    expect(result.kind).toBe("uncertain");
    const strong = research.proposeRevision({ summary: "strong", change: { runtime: "v2" } });
    localEvidence(research, strong.id, 0.9);
    const nomination = research.nominate();
    expect(nomination.nomineeId).toBe(weak.id);
    expect(nomination.replaced).toBe(false);
    expect(nomination.reason).toContain("unconfirmed");
  });

  test("B can become the NEW nominee while A is evaluating and after A is scored", async () => {
    const { research } = setup({ quota: [1, 1, 1, 1], officialScore: 0.62, officialCost: 4, evaluationSteps: 0 });
    const a = research.proposeRevision({ summary: "A", change: { runtime: "v1" } });
    localEvidence(research, a.id, 0.4);
    releaseEvidence(research, a.id);
    research.nominate();
    const receipt = await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    expect(receipt.kind).toBe("receipt");
    const b = research.proposeRevision({ summary: "B", change: { runtime: "v2" } });
    localEvidence(research, b.id, 0.9);
    releaseEvidence(research, b.id, 0.8);
    const whilePending = research.nominate();
    expect(whilePending.nomineeId).toBe(b.id);
    expect(whilePending.replaced).toBe(true);
    await research.reconcile();
    const afterScored = research.nominate();
    expect(afterScored.nomineeId).toBe(b.id);
    // A is immutable: same id, its verified official result intact.
    const director = research.directorView();
    const aScore = director.revisions.find((entry) => entry.revisionId === a.id);
    expect(aScore?.official).toBe(0.62);
    expect(research.proposeRevision({ summary: "A again", change: { runtime: "v1" } }).id).toBe(a.id);
    // B can submit on a fresh platform-confirmed slot even while A is scored.
    const bReceipt = await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    expect(bReceipt.kind).toBe("receipt");
  });

  test("submit is limited to the current nominee", async () => {
    const { research } = setup();
    const weak = research.proposeRevision({ summary: "weak", change: { runtime: "v1" } });
    const strong = research.proposeRevision({ summary: "strong", change: { runtime: "v2" } });
    localEvidence(research, weak.id, 0.4);
    localEvidence(research, strong.id, 0.6);
    research.nominate();
    const result = await research.submit({ revisionId: weak.id, modelName: PHASE2_MODEL_ALLOWLIST[0] });
    expect(result.kind).toBe("waiting");
  });
});

describe("phase2 shared research budget", () => {
  test("local and cloud self-test spend survives restarts and days", () => {
    const { statePath, platform, research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    research.recordEvidence(a.id, { kind: "screening", score: 0.4, cost: 3, at: "2026-11-01T23:00:00Z" });
    research.recordEvidence(a.id, { kind: "cloud-self-test", score: 0.5, cost: 12, at: "2026-11-02T08:00:00Z" });
    const restored = reopen(statePath, platform);
    const view = restored.directorView();
    expect(view.budget.spent).toBe(15);
    expect(view.budget.remaining).toBe(85);
    expect(() => restored.recordEvidence(a.id, { kind: "cloud-self-test", score: 0.6, cost: 90 })).toThrow("budget exhausted");
    expect(restored.directorView().budget.spent).toBe(15);
  });
});

describe("phase2 director and researcher views", () => {
  test("local, cloud self-test and official channels stay separate; researcher sees no release internals", async () => {
    const { research } = setup({ quota: [1], officialScore: 0.62, officialCost: 4, evaluationSteps: 0 });
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    localEvidence(research, a.id, 0.5);
    releaseEvidence(research, a.id, 0.55);
    research.nominate();
    await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 6 });
    await research.reconcile();
    const director = research.directorView();
    const score = director.revisions[0];
    expect(score.local.withheldValidation).toBe(0.5);
    expect(score.cloudSelfTest).toBe(0.55);
    expect(score.official).toBe(0.62);
    expect(director.budget.spent).toBe(5 + 5 + 4);
    const researcher = research.researcherView();
    const serialized = JSON.stringify(researcher);
    expect(serialized).not.toContain("fake-source");
    expect(serialized).not.toContain("attempt");
    expect(serialized).not.toContain("budget");
    expect(serialized).not.toContain("quota");
    expect(serialized).not.toContain("withheldValidation");
    expect(serialized).not.toContain("noisyRepeat");
    expect(researcher.revisions[0].local.screening).toBe(0.48);
    expect(researcher.revisions[0].official).toBe(0.62);
    expect(Object.keys(researcher)).toEqual(["nomineeId", "revisions"]);
  });
});

describe("phase2 next action", () => {
  test("propose → research → submit → research while official is pending", async () => {
    const empty = setup();
    expect((await empty.research.nextAction()).action).toBe("propose");

    const { research } = setup({ quota: [1], evaluationSteps: 1 });
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    localEvidence(research, a.id, 0.5);
    expect((await research.nextAction()).action).toBe("research");
    releaseEvidence(research, a.id);
    research.nominate();
    const ready = await research.nextAction();
    expect(ready.action).toBe("submit");
    await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    const pending = await research.nextAction();
    expect(pending.action).toBe("research");
    expect(pending.reason).toContain("official evaluation");
  });

  test("quota exhaustion keeps research going", async () => {
    const { research } = setup({ quota: [0] });
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    localEvidence(research, a.id, 0.5);
    releaseEvidence(research, a.id);
    research.nominate();
    const result = await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    expect(result.kind).toBe("waiting");
    const next = await research.nextAction();
    expect(next.action).toBe("research");
    expect(next.reason).toContain("quota exhausted");
  });
});

describe("phase2 idempotent init and external booking", () => {
  test("re-initializing never resets revisions, spend or the cap", () => {
    const { store, research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    research.recordEvidence(a.id, { kind: "screening", score: 0.4, cost: 3 });
    const again = initPhase2Research(store, { cap: 999 });
    expect(again.budget.cap).toBe(100);
    expect(again.revisions.length).toBe(1);
    expect(research.directorView().budget.spent).toBe(3);
  });

  test("cloud self-test evidence requires an explicit cost", () => {
    const { research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    expect(() => research.recordEvidence(a.id, { kind: "cloud-self-test", score: 0.5 })).toThrow("explicit cost");
    research.recordEvidence(a.id, { kind: "cloud-self-test", score: 0.5, cost: 0 });
    expect(research.directorView().revisions[0].cloudSelfTest).toBe(0.5);
  });

  test("S1-metered workspace charges are not booked twice", () => {
    const { research } = setup();
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    research.recordEvidence(a.id, { kind: "screening", score: 0.4, cost: 12, externalBooking: true, note: "S1 ledger" });
    expect(research.directorView().budget.spent).toBe(0);
    expect(research.directorView().revisions[0].local.screening).toBe(0.4);
    // A huge S1 charge does not trip the Phase 2 cap either; S1 enforces it.
    research.recordEvidence(a.id, { kind: "cloud-self-test", score: 0.5, cost: 500, externalBooking: true });
    expect(research.directorView().budget.spent).toBe(0);
  });
});

describe("phase2 quota refresh across days", () => {
  test("a cached exhausted quota is refreshed on a later tick", async () => {
    const { research, platform } = setup({ quota: [0, 1] });
    const a = research.proposeRevision({ summary: "one", change: { runtime: "v1" } });
    localEvidence(research, a.id, 0.5);
    releaseEvidence(research, a.id);
    research.nominate();
    const blocked = await research.submit({ modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 5 });
    expect(blocked.kind).toBe("waiting");
    // Next day the platform reports a free slot; no manual cache clearing.
    const next = await research.nextAction();
    expect(next.action).toBe("submit");
    expect(platform.submitCalls).toBe(0);
  });
});

describe("phase2 tick invokes real research", () => {
  test("the wired hook runs, produces a revision and nomination follows", async () => {
    const { research } = setup();
    let calls = 0;
    const result = await research.tick(async (inner) => {
      calls += 1;
      const a = inner.proposeRevision({ summary: "from hook", change: { runtime: "v9" } });
      localEvidence(inner, a.id, 0.7);
      releaseEvidence(inner, a.id);
      return { revisionId: a.id };
    });
    expect(calls).toBe(1);
    expect(result.nomination.nomineeId).not.toBeNull();
    expect(result.action.action).toBe("submit");
    expect(research.directorView().revisions[0].summary).toBe("from hook");
  });
});

describe("phase2 offline normal path (installed entry)", () => {
  test("two revisions, replacement, quota out, timeout/restart, official result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-demo-"));
    const result = await runPhase2Demo(join(dir, "state.json"));
    expect(result.ok).toBe(true);
    const steps = result.steps as { step: string }[];
    expect(steps.map((entry) => entry.step)).toEqual([
      "two-competing-revisions",
      "nominate-strongest",
      "dry-run",
      "quota-exhausted",
      "timeout-restart",
      "official-result",
    ]);
  });
});
