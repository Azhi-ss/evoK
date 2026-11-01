import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE2_MODEL_ALLOWLIST,
  PHASE2_SUBMISSION_PLACEHOLDERS,
  Phase2PlaygroundAdapter,
  buildPhase2SubmissionJson,
  createPhase2JsonStore,
  emptyPhase2State,
  parsePhase2OfficialStatus,
  phase2Spent,
  type Phase2State,
} from "./phase2-playground";
import { FakePhase2Platform, type FakePhase2Script } from "./phase2-fake-platform";
import { digestPhase2Directory } from "./phase2-cli-platform";

function setup(script: FakePhase2Script = {}, withEvidence = true) {
  const dir = mkdtempSync(join(tmpdir(), "phase2-adapter-"));
  const store = createPhase2JsonStore(join(dir, "state.json"));
  const state = emptyPhase2State(100);
  const revision = {
    id: "rev-test",
    summary: "candidate",
    change: { runtime: "v1" },
    contentDigest: "digest-test",
    createdAt: "2026-11-01T00:00:00Z",
    evidence: withEvidence
      ? [
          { kind: "source-check" as const, at: "2026-11-01T00:01:00Z", passed: true },
          { kind: "public-smoke" as const, at: "2026-11-01T00:02:00Z", passed: true },
          { kind: "cloud-self-test" as const, at: "2026-11-01T00:03:00Z", score: 0.5, cost: 5 },
        ]
      : [],
  };
  store.save({ ...state, revisions: [revision] });
  const platform = new FakePhase2Platform(script);
  const adapter = new Phase2PlaygroundAdapter({ store, platform, now: () => "2026-11-01T12:00:00Z" });
  return { store, platform, adapter };
}

describe("phase2 submission.json", () => {
  test("exact placeholders and allowlisted model only", () => {
    const text = buildPhase2SubmissionJson({ datasetId: "harness-source-abc", modelName: PHASE2_MODEL_ALLOWLIST[0] });
    const parsed = JSON.parse(text);
    expect(parsed.source_url).toBe("https://wenyon.dp.tech/app/console/datasets/harness-source-abc");
    expect(parsed.envs).toEqual({ OPENAI_BASE_URL: PHASE2_SUBMISSION_PLACEHOLDERS.baseUrl, OPENAI_API_KEY: PHASE2_SUBMISSION_PLACEHOLDERS.apiKey });
    expect(() => buildPhase2SubmissionJson({ datasetId: "x", modelName: "kimi-k3.1-pro" })).toThrow("allowlist");
    expect(() => buildPhase2SubmissionJson({ datasetId: "x", modelName: PHASE2_MODEL_ALLOWLIST[0], baseUrlEnv: "PATH" })).toThrow("env var");
  });
});

describe("phase2 release readiness", () => {
  test("missing kit and missing evidence produce actionable waiting, never green", async () => {
    const { adapter } = setup({ kitStatus: "missing" }, false);
    const checks = await adapter.checkRelease("rev-test");
    expect(checks.every((check) => check.status === "waiting")).toBe(true);
    expect(checks.map((check) => check.id)).toEqual(["harbor-kit", "source-check", "public-smoke", "real-validation"]);
    for (const check of checks) expect(check.action).toBeTruthy();
  });

  test("kit mismatch is not a pass", async () => {
    const { adapter } = setup({ kitStatus: "mismatch" });
    const checks = await adapter.checkRelease("rev-test");
    expect(checks.find((check) => check.id === "harbor-kit")?.status).toBe("waiting");
    expect(checks.filter((check) => check.status === "green").map((check) => check.id)).toEqual(["source-check", "public-smoke", "real-validation"]);
  });
});

describe("phase2 dry run vs real readiness vs receipt", () => {
  test("dry run validates the exact bundle without any real submit", async () => {
    const { adapter, platform } = setup();
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0] });
    expect(result.kind).toBe("dry-run");
    expect(platform.submitCalls).toBe(0);
    expect(platform.grants.length).toBe(1);
  });

  test("unconfirmed quota waits instead of assuming a free slot", async () => {
    const { adapter, platform, store } = setup({ quota: [null] });
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 });
    expect(result.kind).toBe("waiting");
    expect(platform.submitCalls).toBe(0);
    expect(store.load().attempts.length).toBe(0);
    expect(store.load().quota?.remainingToday).toBeNull();
  });

  test("exhausted daily quota waits and records the checked quota", async () => {
    const { adapter, platform, store } = setup({ quota: [0] });
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 });
    expect(result.kind).toBe("waiting");
    expect(platform.submitCalls).toBe(0);
    expect(store.load().quota?.remainingToday).toBe(0);
  });

  test("real submit returns a receipt, reserves budget and never duplicates", async () => {
    const { adapter, platform, store } = setup({ quota: [1, 1] });
    const first = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 10 });
    expect(first.kind).toBe("receipt");
    expect(store.load().attempts[0]?.state).toBe("accepted");
    expect(phase2Spent(store.load())).toBe(10);
    const second = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 10 });
    expect(second.kind).toBe("receipt");
    if (second.kind === "receipt") expect(second.duplicate).toBe(true);
    expect(platform.submitCalls).toBe(1);
  });

  test("submission estimate beyond the shared cap waits", async () => {
    const { adapter, platform } = setup({ quota: [1] });
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 101 });
    expect(result.kind).toBe("waiting");
    expect(platform.submitCalls).toBe(0);
  });

  test("a downloaded tree mismatch refuses before any submit", async () => {
    const { adapter, platform } = setup({ failDownload: true });
    await expect(adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0] })).rejects.toThrow("downloaded tree mismatch");
    expect(platform.submitCalls).toBe(0);
  });

  test("a self-consistent echoed digest cannot launder a tampered upload", async () => {
    const { adapter, platform } = setup({ tamperUpload: true });
    await expect(adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0] })).rejects.toThrow("downloaded tree mismatch");
    expect(platform.submitCalls).toBe(0);
  });

  test("a real submit without an estimated cost is refused, never defaulted to 0", async () => {
    const { adapter, platform } = setup({ quota: [1] });
    await expect(adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true })).rejects.toThrow("estimated-cost");
    expect(platform.submitCalls).toBe(0);
  });

  test("a malformed platform quota never passes the pre-side-effect gate", async () => {
    const { adapter, platform } = setup({ quota: [Number.NaN] });
    await expect(adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 })).rejects.toThrow("malformed");
    expect(platform.submitCalls).toBe(0);
    expect(platform.createSourceCalls).toBe(0);
  });

  test("an unconfirmed attempt on another revision blocks a new real submit", async () => {
    const { adapter, platform, store } = setup({ quota: [1] });
    const state = store.load();
    const other = { ...state.revisions[0], id: "rev-other", contentDigest: "digest-other" };
    store.save({
      ...state,
      revisions: [...state.revisions, other],
      attempts: [{
        id: "attempt-other",
        revisionId: "rev-other",
        idempotencyKey: "key-other",
        real: true,
        state: "uncertain",
        history: [],
      }],
    });
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 });
    expect(result.kind).toBe("uncertain");
    expect(platform.submitCalls).toBe(0);
    expect(store.load().attempts.length).toBe(1);
  });

  test("concurrent submit/reconcile processes are excluded by the store lock", async () => {
    const { adapter, store, platform } = setup({ quota: [1] });
    await store.withLock(async () => {
      await expect(adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 })).rejects.toThrow("lock");
      await expect(adapter.reconcile()).rejects.toThrow("lock");
    });
    expect(platform.submitCalls).toBe(0);
    // After the holder releases, the same call goes through.
    const result = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 1 });
    expect(result.kind).toBe("receipt");
  });
});

describe("phase2 timeout, restart and reconciliation", () => {
  test("timeout stays uncertain across restart, reconciles once, settles the official cost", async () => {
    const { adapter, platform, store } = setup({ quota: [1, 1], submitOutcomes: ["timeout"], officialScore: 0.62, officialCost: 7.5, evaluationSteps: 1 });
    const timedOut = await adapter.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 10 });
    expect(timedOut.kind).toBe("uncertain");
    // Restart: a new adapter over the same store must not resubmit.
    const restarted = new Phase2PlaygroundAdapter({ store, platform });
    const again = await restarted.submit({ revisionId: "rev-test", modelName: PHASE2_MODEL_ALLOWLIST[0], real: true, estimatedCost: 10 });
    expect(again.kind).toBe("uncertain");
    expect(platform.submitCalls).toBe(1);

    const pending = await restarted.reconcile();
    expect(pending[0]?.state).toBe("evaluating");
    const final = await restarted.reconcile();
    expect(final[0]?.state).toBe("scored");
    expect(final[0]?.official?.score).toBe(0.62);
    expect(final[0]?.official?.cost).toBe(7.5);
    const state: Phase2State = store.load();
    const official = state.revisions[0].evidence.filter((entry) => entry.kind === "official");
    expect(official.length).toBe(1);
    expect(official[0].score).toBe(0.62);
    expect(official[0].ref).toBe("attempt:fake-attempt-1");
    expect(phase2Spent(state)).toBe(7.5);
  });
});

describe("phase2 official status ingestion (real playground schema)", () => {
  const gradedZero = {
    id: 62146,
    challengeId: "harness-45c4688b",
    execStatus: "completed",
    outcome: "failed",
    resultsJson: { harbor_reward: 0, tasks: [{ secret: "task-level detail" }] },
    harness2_eval_status: "succeeded",
    harness2_raw_result: { score_complete: true },
    score_status: "complete",
    cost: 0,
  };

  test("a graded zero is a score, not pending or missing; task details stay out", () => {
    const parsed = parsePhase2OfficialStatus(gradedZero, { attemptId: "62146", challengeId: "harness-45c4688b" });
    expect(parsed.state).toBe("scored");
    expect(parsed.score).toBe(0);
    expect(parsed.cost).toBe(0);
    expect(JSON.stringify(parsed)).not.toContain("tasks");
    expect(JSON.stringify(parsed)).not.toContain("task-level detail");
  });

  test("only the acknowledged own attempt is ingested", () => {
    expect(() => parsePhase2OfficialStatus(gradedZero, { attemptId: "99999", challengeId: "harness-45c4688b" })).toThrow("does not match");
    expect(() => parsePhase2OfficialStatus(gradedZero, { attemptId: "62146", challengeId: "other-challenge" })).toThrow("challenge");
    expect(() => parsePhase2OfficialStatus({ ...gradedZero, challengeId: undefined }, { attemptId: "62146", challengeId: "harness-45c4688b" })).toThrow("challenge");
  });

  test("receipt, pending and error stay distinct from graded", () => {
    const pending = parsePhase2OfficialStatus({ ...gradedZero, execStatus: "running", outcome: "", score_status: "incomplete", harness2_raw_result: {}, resultsJson: {} }, { attemptId: "62146" });
    expect(pending.state).toBe("evaluating");
    expect(pending.score).toBeUndefined();
    const receipt = parsePhase2OfficialStatus({ id: "62146" }, { attemptId: "62146" });
    expect(receipt.state).toBe("accepted");
    const failed = parsePhase2OfficialStatus({ ...gradedZero, score_status: "incomplete", harness2_raw_result: {} }, { attemptId: "62146" });
    expect(failed.state).toBe("failed");
    expect(failed.score).toBeUndefined();
    expect(() => parsePhase2OfficialStatus({ ...gradedZero, resultsJson: {} }, { attemptId: "62146" })).toThrow("harbor_reward");
  });
});

describe("phase2 source tree digest", () => {
  test("digest is deterministic over relative paths and file contents", () => {
    const { store } = setup();
    void store;
    const dir = mkdtempSync(join(tmpdir(), "phase2-tree-"));
    const first = digestPhase2Directory(new URL(".", import.meta.url).pathname);
    const second = digestPhase2Directory(new URL(".", import.meta.url).pathname);
    expect(first).toBe(second);
    expect(() => digestPhase2Directory(join(dir, "missing"))).toThrow();
  });
});
