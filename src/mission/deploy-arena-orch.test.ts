/**
 * ET-DEPLOY-ORCH / #182 — control-plane DeployArena hang + COI→auto-submit.
 *
 * Seams: runDeployArenaOrch / attemptContestAutoSubmit /
 * createPlaygroundContestSubmitSeam / runDeployArenaGraph.
 *
 * Explicit `competitionId=deploy-arena` only. Env alone never opens live.
 * Reuses #179 contest-arm auto-submit; does not bypass fail-closed.
 */
import { describe, expect, test } from "bun:test";
import { BudgetLedger } from "../evidence/budget-gate";
import {
  InMemoryContestAutoSubmitLedger,
  type ContestAutoSubmitInput,
  type ContestSubmitSeam,
} from "../evidence/contest-auto-submit";
import { evaluateExperimentValidity } from "../evidence/experiment-validity";
import { HypothesisLedger, T48MappedCatalog, type KillTestOutcome } from "../evidence/hypothesis-ledger";
import { type KillTestHangInput } from "../evidence/kill-test-hang";
import { type MethodAdmissionInput } from "../evidence/method-admission";
import { type SubmissionChampion } from "../evidence/submission-broker";
import { DEFAULT_SEARCH_SELECTION_ID, SELECTION_POLICY_40 } from "../search/search-selection-port";
import { DEPLOY_ARENA_COMPETITION_ID } from "../competition/deploy-arena";
import { EvidenceMemory } from "./research-loop";
import { runDeployArenaOrch } from "./deploy-arena-orch";

function catalogWithMappedIds(): T48MappedCatalog {
  const memory = new EvidenceMemory();
  memory.addEvidence({ id: "ev-holdout", kind: "observation", summary: "hold-out split is isolated", verified: true });
  memory.addEvidence({ id: "ev-kill", kind: "experiment", summary: "kill-test observation", verified: true, refs: ["ev-holdout"] });
  return T48MappedCatalog.fromMemory(memory, [{ artifactId: "art-score" }]);
}

function admissionPass(): MethodAdmissionInput {
  return {
    validity: evaluateExperimentValidity({
      slices: [
        { kind: "official_samples", present: true, outcome: "pass" },
        { kind: "adversarial_labeled", present: true, outcome: "pass" },
        { kind: "protected_holdout", present: true, outcome: "pass" },
      ],
    }),
    slices: { officialSamples: true, adversarialLabeled: true, protectedHoldout: true },
  };
}

function budgetPassInput() {
  const ledger = new BudgetLedger({ total: 1, units: "model-USD" });
  ledger.reserve({
    reservationId: "deploy-arena-auto-submit",
    amount: 0.2,
    kind: "research",
    action: "continue",
  });
  return { action: "continue" as const, snapshot: ledger.snapshot() };
}

function championPass(): SubmissionChampion {
  return {
    missionId: "deploy-arena-orch",
    competition: DEPLOY_ARENA_COMPETITION_ID,
    branchId: "serving",
    championDigest: "sha256:deploy-arena-champion",
    artifactDigest: "sha256:deploy-arena-champion",
    evaluatorSucceeded: true,
    successAuditorPassed: true,
    promotionApproved: true,
  };
}

function ledgerBoundHang(overrides: Partial<KillTestHangInput> & { outcome?: KillTestOutcome } = {}): KillTestHangInput {
  const catalog = overrides.catalog ?? catalogWithMappedIds();
  const ledger = overrides.ledger instanceof HypothesisLedger
    ? overrides.ledger
    : new HypothesisLedger({ catalog });
  const planId = overrides.planId ?? "kt-deploy-arena";
  if (ledger.state().hypotheses["h-deploy"] === undefined) {
    ledger.createHypothesis({
      hypothesisId: "h-deploy",
      statement: "serving knobs survive the predeclared kill-test",
      evidenceRefs: ["ev-holdout"],
    });
  }
  if (ledger.state().plans[planId] === undefined) {
    ledger.planKillTest({
      planId,
      hypothesisId: "h-deploy",
      predicate: "protected hold-out must not move after removing the shared step",
      evidenceRefs: ["ev-holdout"],
    });
  }
  return {
    outcome: "pass",
    evidenceRefs: ["ev-kill"],
    ...overrides,
    catalog,
    ledger,
    planId,
  };
}

function greenGates(overrides: Partial<ContestAutoSubmitInput> = {}): ContestAutoSubmitInput {
  return {
    champion: championPass(),
    hang: ledgerBoundHang(),
    admission: admissionPass(),
    budget: budgetPassInput(),
    ...overrides,
  };
}

function recordingSubmit(calls: unknown[]): ContestSubmitSeam {
  return (input) => {
    calls.push(input);
    return { status: input.live === true ? "SUCCEEDED" : "DRY_RUN", submissionId: "deploy-1" };
  };
}

function withEnv(vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("runDeployArenaOrch hangs the DeployArena arm only when asked", () => {
  test("wrong or missing competitionId fails closed and does not open the arm", async () => {
    await expect(runDeployArenaOrch({
      knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
    })).rejects.toThrow(/deploy-arena/i);

    await expect(runDeployArenaOrch({
      competitionId: "atcoder",
      knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
    })).rejects.toThrow(/deploy-arena/i);
  });

  test("explicit deploy-arena runs the multi-worker smoke graph, aggregates, and assembles submission.json", async () => {
    const calls: unknown[] = [];
    const ledger = new InMemoryContestAutoSubmitLedger();
    const result = await runDeployArenaOrch({
      competitionId: DEPLOY_ARENA_COMPETITION_ID,
      knobs: {
        image: "registry.example/serving:v1",
        command: "python -m serve",
        env: { CONCURRENCY: "4" },
      },
      gates: greenGates(),
      submit: recordingSubmit(calls),
      ledger,
    });

    expect(result.competitionId).toBe("deploy-arena");
    expect(result.graph.ok).toBe(true);
    expect(result.graph.workers).toHaveLength(2);
    expect(result.aggregation.capability.passed).toBe(true);
    expect(result.aggregation.capability.aime26).toBe(97);
    expect(result.aggregation.capability.gpqaDiamond).toBe(97);
    expect(result.submission).toEqual({
      image: "registry.example/serving:v1",
      command: "python -m serve",
      env: { CONCURRENCY: "4" },
    });
    expect(result.autoSubmit?.submitted).toBe(true);
    expect(result.autoSubmit?.reason).toBe("gates-green");
    expect(calls).toHaveLength(1);
    expect(ledger.events().map((event) => event.type)).toEqual([
      "CONTEST_AUTO_SUBMIT_ATTEMPTED",
      "CONTEST_AUTO_SUBMIT_SUBMITTED",
    ]);
    expect(SELECTION_POLICY_40).toBe("off");
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
  });

  test("reuses contest-arm auto-submit: a red gate never calls the playground seam", async () => {
    const calls: unknown[] = [];
    const result = await runDeployArenaOrch({
      competitionId: "deploy-arena",
      knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
      gates: greenGates({ champion: undefined }),
      submit: recordingSubmit(calls),
    });
    expect(result.autoSubmit?.submitted).toBe(false);
    expect(result.autoSubmit?.reason).toBe("gates-not-green");
    expect(result.autoSubmit?.refusedGates.some((gate) => gate.id === "promotion")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("live playground without credentials fails closed and does not exec", async () => {
    const argvCalls: string[][] = [];
    const result = await runDeployArenaOrch({
      competitionId: "deploy-arena",
      knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
      gates: greenGates(),
      live: true,
      credentials: { playground: false, bohr: false },
      exec: async (argv) => {
        argvCalls.push([...argv]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.autoSubmit?.submitted).toBe(true);
    expect(result.autoSubmit?.submission?.status).toBe("FAILED");
    expect(result.autoSubmit?.submission?.response).toMatchObject({ reason: "credentials-missing" });
    expect(argvCalls).toEqual([]);
  });

  test("EVOK_DEPLOY_ARENA_LIVE alone does not open live submit", async () => {
    await withEnv({ EVOK_DEPLOY_ARENA_LIVE: "1" }, async () => {
      const calls: unknown[] = [];
      const result = await runDeployArenaOrch({
        competitionId: "deploy-arena",
        knobs: { image: "registry.example/serving:v1", command: "python -m serve" },
        gates: greenGates(),
        submit: recordingSubmit(calls),
      });
      expect(result.live).toBe(false);
      expect(calls[0]).toMatchObject({ live: false });
      expect(result.autoSubmit?.submission?.status).toBe("DRY_RUN");
    });
  });
});
