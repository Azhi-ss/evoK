/**
 * Unit checks for trusted intake helpers that deserve a direct test without a
 * full model Run (#111 review follow-ups): private-content query guard and
 * ready-for-review completeness.
 */
import { describe, expect, test } from "bun:test";
import { assertPublicQuery, draftReadyForReview } from "./mission-intake";
import { MISSION_DRAFT_SCHEMA_VERSION, type MissionDraft } from "./mission-draft";

const baseDraft: MissionDraft = {
  schemaVersion: MISSION_DRAFT_SCHEMA_VERSION,
  id: "m-0123456789ab",
  status: "draft",
  objective: "Improve ranking.",
  successCriteria: ["+0.02"],
  data: { description: "train.csv" },
  evaluation: { method: "group CV", metric: "NDCG@10" },
  constraints: { permissions: ["read"] },
  budget: { total: 20, units: "model-USD" },
  outputs: ["report"],
  stopConditions: ["budget"],
  unresolvedPrerequisites: [],
  decisions: [],
  sources: [],
  plan: { baselineHypothesis: "gbm", tasks: [{ taskId: "t1", objective: "reproduce" }] },
  usage: { tokens: { input: 1, output: 1, total: 2 }, cost: { total: 0, units: "model-USD" } },
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

describe("assertPublicQuery (#111 AC4)", () => {
  test("public factual questions pass", () => {
    expect(() => assertPublicQuery("NDCG@10 grouped validation current practice")).not.toThrow();
  });

  const privateQueries = [
    "compare against /home/dministrator/project/evoK/data/train.csv",
    "search for /Users/alice/.ssh/id_rsa",
    "the api_key is sk-live-ABCDEF123456",
    "my password is hunter2 what does this metric mean",
    "bearer token ghp_0123456789abcdef",
  ];
  for (const query of privateQueries) {
    test(`rejects a query carrying private content: ${query}`, () => {
      expect(() => assertPublicQuery(query)).toThrow(/private content/);
    });
  }
});

describe("draftReadyForReview (#111 AC5)", () => {
  test("a complete draft with no unresolved prerequisites is reviewable", () => {
    expect(draftReadyForReview(baseDraft)).toBe(true);
  });

  const incompleteCases: Array<[string, Partial<MissionDraft>]> = [
    ["empty objective", { objective: " " }],
    ["no success criteria", { successCriteria: [] }],
    ["empty data description", { data: { description: "" } }],
    ["empty evaluation method", { evaluation: { method: "" } }],
    ["zero budget", { budget: { total: 0, units: "model-USD" } }],
    ["no outputs", { outputs: [] }],
    ["no stop conditions", { stopConditions: [] }],
    ["an unresolved prerequisite", { unresolvedPrerequisites: ["data access"] }],
    ["no initial task", { plan: { baselineHypothesis: "gbm", tasks: [] } }],
  ];
  for (const [label, patch] of incompleteCases) {
    test(`an incomplete draft is not reviewable: ${label}`, () => {
      expect(draftReadyForReview({ ...baseDraft, ...patch } as MissionDraft)).toBe(false);
    });
  }
});
