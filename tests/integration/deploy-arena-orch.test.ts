/**
 * ET-DEPLOY-ORCH / #182 — cross-pack smoke: competition graph + mission hang
 * + evidence auto-submit. Not a commercial OS. Not a second control plane.
 */
import { describe, expect, test } from "bun:test";
import {
  DEPLOY_ARENA_COMPETITION_ID,
  DEPLOY_ARENA_SMOKE_GRAPH,
} from "../../src/competition";
import { BudgetLedger } from "../../src/evidence/budget-gate";
import { InMemoryContestAutoSubmitLedger } from "../../src/evidence/contest-auto-submit";
import { evaluateExperimentValidity } from "../../src/evidence/experiment-validity";
import { HypothesisLedger, T48MappedCatalog } from "../../src/evidence/hypothesis-ledger";
import { EvidenceMemory, runDeployArenaOrch } from "../../src/mission";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../../src/search";

describe("DeployArena thick-orchestration smoke", () => {
  test("multi-worker graph + local aggregation + COI dry-run auto-submit", async () => {
    const memory = new EvidenceMemory();
    memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
    memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
    const catalog = T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
    const hangLedger = new HypothesisLedger({ catalog });
    hangLedger.createHypothesis({
      hypothesisId: "h-deploy",
      statement: "serving knobs survive the predeclared kill-test",
      evidenceRefs: ["ev-holdout"],
    });
    hangLedger.planKillTest({
      planId: "kt-deploy-arena",
      hypothesisId: "h-deploy",
      predicate: "protected hold-out must not move after removing the shared step",
      evidenceRefs: ["ev-holdout"],
    });
    const budget = new BudgetLedger({ total: 1, units: "model-USD" });
    budget.reserve({
      reservationId: "deploy-arena-smoke",
      amount: 0.2,
      kind: "research",
      action: "continue",
    });
    const ledger = new InMemoryContestAutoSubmitLedger();

    const result = await runDeployArenaOrch({
      competitionId: DEPLOY_ARENA_COMPETITION_ID,
      graph: DEPLOY_ARENA_SMOKE_GRAPH,
      knobs: {
        image: "registry.example/serving:v1",
        command: "python -m serve",
        env: { CONCURRENCY: "4" },
      },
      gates: {
        champion: {
          missionId: "deploy-arena-smoke",
          competition: DEPLOY_ARENA_COMPETITION_ID,
          branchId: "serving",
          championDigest: "sha256:deploy-arena-smoke",
          artifactDigest: "sha256:deploy-arena-smoke",
          evaluatorSucceeded: true,
          successAuditorPassed: true,
          promotionApproved: true,
        },
        hang: {
          outcome: "pass",
          evidenceRefs: ["ev-kill"],
          catalog,
          ledger: hangLedger,
          planId: "kt-deploy-arena",
        },
        admission: {
          validity: evaluateExperimentValidity({
            slices: [
              { kind: "official_samples", present: true, outcome: "pass" },
              { kind: "adversarial_labeled", present: true, outcome: "pass" },
              { kind: "protected_holdout", present: true, outcome: "pass" },
            ],
          }),
          slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
        },
        budget: { action: "continue", snapshot: budget.snapshot() },
      },
      ledger,
    });

    expect(result.kind).toBe("deploy-arena-orch");
    expect(result.graph.workers.map((worker) => worker.machine)).toEqual(["host-a", "host-b"]);
    expect(result.aggregation.capability.passed).toBe(true);
    expect(result.submission.image).toBe("registry.example/serving:v1");
    expect(result.autoSubmit.submitted).toBe(true);
    expect(result.autoSubmit.submission?.status).toBe("DRY_RUN");
    expect(ledger.events().some((event) => event.type === "CONTEST_AUTO_SUBMIT_SUBMITTED")).toBe(true);
    expect(SELECTION_POLICY_40).toBe("off");
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
  });
});
