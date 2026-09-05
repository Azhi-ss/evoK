import { describe, expect, test } from "bun:test";
import {
  OrchestraValidationError,
  type ModelCatalog,
  type ModelConfig,
  type OrchestraConfig,
} from "../../src/model-orchestra";
import { ToyCompetitionHarness, type ToyAgentRuntime, type ToyMissionOptions } from "../../src/toy-harness";

/**
 * Mission main seam (#30): a fake AgentRuntime records which ModelConfig/tier
 * each RoleSession used, and the mission ledger stores tier, mix, gate,
 * reason, and forced so model economics are replayable.
 *
 * Cross-module integration: ToyCompetitionHarness seam + ModelOrchestra +
 * fake runtime.
 */

const FLASH: ModelConfig = Object.freeze({ provider: "acme", model: "flash-2", id: "acme/flash-2" });
const PRO: ModelConfig = Object.freeze({ provider: "acme", model: "pro-2", id: "acme/pro-2" });

function fakeCatalog(defaultRef?: string): ModelCatalog {
  const byId = new Map([FLASH, PRO].map((m) => [m.id, m]));
  return {
    findModel(ref) {
      return byId.get(ref);
    },
    defaultModel() {
      return defaultRef ? byId.get(defaultRef) : FLASH;
    },
  };
}

const SEAM_PREDICTION = {
  predictionId: "seam-prediction",
  hypothesis: "the candidate improves the score",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

interface RecordedSession {
  role: string;
  model?: ModelConfig;
}

function recordingRuntime(): { runtime: ToyAgentRuntime; sessions: RecordedSession[] } {
  const sessions: RecordedSession[] = [];
  const record = (role: string, model?: ModelConfig) => sessions.push({ role, model });
  return {
    sessions,
    runtime: {
      selfVerify(input) { record("SelfVerifier", input.model); return { ok: true }; },
      propose(input) { record("Worker", input.model); return { files: { score: "5" } }; },
      falsify(input) { record("Falsifier", input.model); return { ok: true, objections: [] }; },
      successAuditor(input) { record("SuccessAuditor", input.model); return { ok: true, objections: [] }; },
    },
  };
}

function seamMission(options: Partial<ToyMissionOptions> & { runtime: ToyAgentRuntime }): ToyCompetitionHarness {
  return new ToyCompetitionHarness({
    missionId: "seam-mission",
    taskContract: { objective: "maximize the score" },
    branchIds: ["a", "b"],
    prediction: SEAM_PREDICTION,
    evaluate: () => ({ score: 5 }),
    policy: { maxBranches: 2, maxParallelBranches: 2, quorum: 1 },
    ...options,
  });
}

function modelResolvedEvents(harness: ToyCompetitionHarness): Array<Record<string, unknown>> {
  return harness.events().filter((event) => event.type === "MODEL_RESOLVED").map((event) => event.payload);
}

const SEAM_ROLES = ["SelfVerifier", "Worker", "Falsifier", "SuccessAuditor"] as const;
const SEAM_CATALOG = () => fakeCatalog();
const DUAL_TIERS: OrchestraConfig = Object.freeze({ fast: FLASH.id, deep: PRO.id });

describe("mission seam: fake AgentRuntime tier distribution + ledger", () => {
  test("unconfigured mission: every recorded session shares one default tier/config identity", async () => {
    const { runtime, sessions } = recordingRuntime();
    const harness = seamMission({ runtime, modelCatalog: SEAM_CATALOG() });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    const resolved = modelResolvedEvents(harness);
    expect(resolved).toHaveLength(2 * SEAM_ROLES.length);
    for (const event of resolved) {
      expect(event.branchId).toBeTruthy();
      expect(event.fencingToken).toBeTruthy();
      expect(event.tier).toBe("default");
      expect(event.mix).toBe("flash_primary");
      // the gate under which the session ran is still recorded, even though
      // the unconfigured orchestra never consults it
      expect(event.gate).toBe(event.role === "SuccessAuditor" ? "success_audit" : null);
      expect(event.reason).toBe("unconfigured");
      expect(event.forced).toBe(false);
      expect((event.model as ModelConfig).id).toBe(FLASH.id);
    }
    expect(new Set(sessions.map((session) => session.model?.id))).toEqual(new Set([FLASH.id]));
    expect(new Set(sessions.map((session) => session.role))).toEqual(new Set(SEAM_ROLES));
  });

  test("flash_primary fixture: Workers/Explorers stay fast; configured deep gate resolves deep", async () => {
    const { runtime, sessions } = recordingRuntime();
    const harness = seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary", deepGates: ["success_audit"] },
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    for (const event of modelResolvedEvents(harness)) {
      expect(event.mix).toBe("flash_primary");
      if (event.role === "SuccessAuditor") {
        expect(event.tier).toBe("deep");
        expect(event.gate).toBe("success_audit");
        expect(event.reason).toBe("gate");
        expect((event.model as ModelConfig).id).toBe(PRO.id);
      } else {
        expect(event.tier).toBe("fast");
        expect(event.gate).toBeNull();
        expect(event.reason).toBe("role");
      }
    }
    for (const session of sessions.filter((session) => session.role === "Worker")) {
      expect(session.model?.id).toBe(FLASH.id);
    }
    for (const session of sessions.filter((session) => session.role === "SuccessAuditor")) {
      expect(session.model?.id).toBe(PRO.id);
    }
  });

  test("long_proof-like flash_deep_mix fixture: deep only at declared deep gates; volume branches stay fast", async () => {
    const { runtime, sessions } = recordingRuntime();
    const harness = seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_deep_mix", deepGates: ["success_audit"] },
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    for (const event of modelResolvedEvents(harness)) {
      expect(event.mix).toBe("flash_deep_mix");
      if (event.role === "SuccessAuditor") {
        expect(event.tier).toBe("deep");
        expect(event.gate).toBe("success_audit");
        expect(event.reason).toBe("gate");
        expect((event.model as ModelConfig).id).toBe(PRO.id);
      } else {
        expect(event.tier).toBe("fast");
        expect(event.gate).toBeNull();
        expect(event.reason).toBe("role");
      }
    }
    // every volume branch's worker stayed fast even under a deep-mix pattern
    const branchIds = new Set(modelResolvedEvents(harness).map((event) => event.branchId as string));
    expect(branchIds).toEqual(new Set(["a", "b"]));
    expect(sessions.filter((session) => session.role === "Worker" && session.model?.id === FLASH.id)).toHaveLength(2);
    expect(sessions.filter((session) => session.role === "SuccessAuditor" && session.model?.id === PRO.id)).toHaveLength(2);
  });

  test("forced_tier overrides resolution and is recorded with forced=true", async () => {
    const { runtime } = recordingRuntime();
    const harness = seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary" },
      forcedTier: "deep",
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    for (const event of modelResolvedEvents(harness)) {
      expect(event.tier).toBe("deep");
      expect(event.reason).toBe("forced");
      expect(event.forced).toBe(true);
    }
  });

  test("orchestra cannot start agents or change mission objective/budget", async () => {
    const { runtime, sessions } = recordingRuntime();
    const harness = seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary", deepGates: ["success_audit"] },
    });

    await harness.run();

    const events = harness.events();
    expect(events.filter((event) => event.type === "MISSION_CREATED")).toHaveLength(1);
    expect(events.filter((event) => event.type === "MISSION_STARTED")).toHaveLength(1);
    const created = events.find((event) => event.type === "MISSION_CREATED")!;
    expect(created.payload.objective).toBe("maximize the score");
    const declaredBudget = created.payload.budget;
    expect(declaredBudget).toEqual({ maxCandidates: 2 });
    // the recording fake runtime got exactly the declared role sessions — the seam starts no extra agents
    expect(sessions).toHaveLength(2 * SEAM_ROLES.length);
    for (const role of SEAM_ROLES) expect(sessions.filter((session) => session.role === role)).toHaveLength(2);
    // replay preserves economics without moving objective/budget
    const replayed = ToyCompetitionHarness.replay(events);
    expect(replayed.phase).toBe("COMPLETED");
    expect(replayed.objective).toBe("maximize the score");
    expect(replayed.budget).toEqual(declaredBudget);
  });

  test("unknown deep gate fails closed before the mission starts", () => {
    const { runtime } = recordingRuntime();
    expect(() => seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary", deepGates: ["made_up_gate"] },
    })).toThrow(OrchestraValidationError);
    expect(() => seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary", deepGates: ["made_up_gate"] },
    })).toThrow(/made_up_gate/);
  });

  test("hook-executed roles consume no model and emit no resolution event", async () => {
    const { runtime, sessions } = recordingRuntime();
    const harness = seamMission({
      runtime,
      modelCatalog: SEAM_CATALOG(),
      orchestra: DUAL_TIERS,
      pattern: { modelMix: "flash_primary" },
      verification: {
        selfVerifier: () => ({ ok: true, objections: [] }),
        falsifier: () => ({ ok: true, objections: [] }),
      },
    });

    const result = await harness.run();

    expect(result.phase).toBe("COMPLETED");
    expect(sessions.filter((session) => session.role === "SelfVerifier")).toHaveLength(0);
    expect(sessions.filter((session) => session.role === "Falsifier")).toHaveLength(0);
    const roles = modelResolvedEvents(harness).map((event) => event.role as string);
    expect(roles).not.toContain("SelfVerifier");
    expect(roles).not.toContain("Falsifier");
    expect(roles).toContain("Worker");
  });
});
