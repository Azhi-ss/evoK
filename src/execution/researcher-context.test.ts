/**
 * Researcher Task Contract assembly: the agent gets the objective, current
 * hypothesis, evidence refs, allowed scope, tools, and a resource summary —
 * never full rules, credentials, hidden data, the global budget, or another
 * agent's history. The assembler whitelists; sensitive input keys are
 * dropped and named in `redacted`.
 */
import { describe, expect, test } from "bun:test";
import { probeHostInventory } from "./host-inventory";
import { grantResourceLease } from "./resource-lease";
import {
  RESEARCHER_CONTEXT_FORBIDDEN_FIELDS,
  ResearcherContextError,
  buildResearcherContext,
  summarizeLeaseResources,
} from "./researcher-context";

async function lease() {
  const inventory = await probeHostInventory({
    exec: async () => ({ code: 0, stdout: "0, NVIDIA A100-SXM4-80GB, GPU-secret-uuid, 81920\n" }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  });
  return grantResourceLease({
    inventory,
    taskId: "task-1",
    request: { cpus: 4, memoryBytes: 4096, gpus: 1, timeLimitMs: 60_000 },
    now: () => new Date("2026-10-24T01:00:00Z"),
  });
}

describe("researcher context", () => {
  test("assembles only the minimal task contract fields", async () => {
    const context = buildResearcherContext({
      objective: "Improve the feature pipeline.",
      hypothesis: "Target encoding reduces overfit.",
      evidenceRefs: ["ledger:exp-1", "ledger:exp-2"],
      allowedPaths: ["src/features/**"],
      tools: ["read", "edit", "bash"],
      competition: { competitionId: "toy", version: "2026.1", metric: "rmse", direction: "minimize" },
      lease: await lease(),
    });
    expect(context.schema).toBe("evok.researcher-context/v1");
    expect(context.objective).toContain("feature pipeline");
    expect(context.hypothesis).toContain("Target encoding");
    expect(context.evidenceRefs).toEqual(["ledger:exp-1", "ledger:exp-2"]);
    expect(context.allowedPaths).toEqual(["src/features/**"]);
    expect(context.competition).toEqual({ competitionId: "toy", version: "2026.1", metric: "rmse", direction: "minimize" });
    expect(context.redacted).toEqual([]);
    expect(Object.isFrozen(context)).toBe(true);
  });

  test("redacts credentials, full rules, hidden data, global budget, and history", () => {
    const context = buildResearcherContext({
      objective: "Tune the model.",
      credentials: { apiKey: "sk-live-secret" },
      apiKey: "sk-live-secret",
      competitionRules: "the complete competition rules document...",
      hiddenData: "s3://bucket/hidden-test.csv",
      globalBudget: { usd: 10_000 },
      agentHistory: ["other agent transcript..."],
      unexpectedField: 123,
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("complete competition rules");
    expect(serialized).not.toContain("hidden-test.csv");
    expect(serialized).not.toContain("10000");
    expect(serialized).not.toContain("transcript");
    // The redacted audit list names dropped keys; their values never appear.
    for (const key of ["credentials", "apiKey", "competitionRules", "hiddenData", "globalBudget", "agentHistory", "unexpectedField"]) {
      expect(context.redacted).toContain(key);
    }
  });

  test("every forbidden field name is redacted when supplied", () => {
    const input: Record<string, unknown> = { objective: "x" };
    for (const key of RESEARCHER_CONTEXT_FORBIDDEN_FIELDS) input[key] = "sensitive";
    const context = buildResearcherContext(input);
    for (const key of RESEARCHER_CONTEXT_FORBIDDEN_FIELDS) {
      expect(context.redacted).toContain(key);
      expect(JSON.stringify(context)).not.toContain("sensitive");
    }
  });

  test("resource summary carries capacities, not device uuids", async () => {
    const granted = await lease();
    const summary = summarizeLeaseResources(granted);
    expect(summary.cpus).toBe(4);
    expect(summary.memoryBytes).toBe(4096);
    expect(summary.gpuCount).toBe(1);
    expect(summary.gpuNames).toEqual(["NVIDIA A100-SXM4-80GB"]);
    expect(summary.deadlineAt).toBe("2026-10-24T01:01:00.000Z");
    expect(JSON.stringify(summary)).not.toContain("GPU-secret-uuid");
  });

  test("competition resource requirements never reach the researcher summary", () => {
    const context = buildResearcherContext({
      objective: "Tune the model.",
      competition: {
        competitionId: "toy",
        version: "2026.1",
        metric: "rmse",
        direction: "minimize",
        resources: { cpus: 8, memoryBytes: 32 * 1024 ** 3, gpu: { backend: "cuda", count: 2, minMemoryBytes: 40 * 1024 ** 3 }, maxConcurrency: 4 },
      },
    });
    expect(Object.keys(context.competition!).sort()).toEqual(["competitionId", "direction", "metric", "version"]);
    expect(JSON.stringify(context.competition)).not.toContain("resources");
    expect(JSON.stringify(context.competition)).not.toContain("cuda");
  });

  test("requires an objective and validates list shapes", () => {
    expect(() => buildResearcherContext({})).toThrow(ResearcherContextError);
    expect(() => buildResearcherContext({ objective: "x", tools: ["read", 7] })).toThrow(/tools/);
    expect(() => buildResearcherContext("nope")).toThrow(ResearcherContextError);
  });
});
