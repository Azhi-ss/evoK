/**
 * LLM.3 before-promotion named AC (control-plane).
 *
 * Consumes L2 `assembleLlmCompArmSetup` (mock default; LP1 `{ live: true }`
 * product path) and wires the existing Outer E2 / `createKillTestHangHook`
 * into `ToyCompetitionHarness.verification.killTestHang`. Does not invent a
 * gate, wrap T48 / Broker, thaw #40, or treat `EVOK_NEWAPI_LIVE` as live.
 */
import {
  assembleLlmCompArmSetup,
  type AssembleLlmCompArmSetupInput,
  type LlmCompArmSetup,
} from "./llm-propose-outer-min";
import { createLlmCompetitionRuntime } from "./llm-competition-runtime";
import type { PredictionArtifact } from "./predict-reconcile";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type MissionState,
} from "./toy-harness";

export interface RunLlmCompArmBeforePromotionInput extends AssembleLlmCompArmSetupInput {
  readonly missionId?: string;
  readonly prediction?: PredictionArtifact;
}

export interface LlmCompArmBeforePromotionRun {
  readonly arm: LlmCompArmSetup;
  readonly harness: ToyCompetitionHarness;
  readonly state: MissionState;
}

/**
 * One-call AC runner: L2 assembly + existing Kill-test hang → harness.
 * Stack stays T48 → Kill-test → before PROMOTED_LOCAL / acceptChampion.
 */
export async function runLlmCompArmBeforePromotion(
  input: RunLlmCompArmBeforePromotionInput = {},
): Promise<LlmCompArmBeforePromotionRun> {
  const { missionId = "llm-comp-arm-before-promotion", prediction, ...setupInput } = input;
  const runtime = input.runtime ?? createLlmCompetitionRuntime({
    live: input.live === true,
    model: input.model,
    fetch: input.fetch,
    emitMethodologyManifest: input.emitMethodologyManifest,
  });
  let arm: LlmCompArmSetup | undefined;
  const harness = new ToyCompetitionHarness({
    missionId,
    prediction: prediction ?? {
      predictionId: `${missionId}:prediction`,
      hypothesis: input.statement ?? "the proposed candidate satisfies the before-promotion checks",
      expectedObservation: "an independent evaluator returns the candidate score before KillTester checks",
      failureModes: ["invalid candidate", "methodology mismatch", "failed or inconclusive kill-test"],
    },
    taskContract: input.proposeInput?.taskContract ?? { objective: "llm-comp-arm before-promotion AC" },
    branchIds: ["candidate"],
    runtime: {
      selfVerify: runtime.selfVerify.bind(runtime),
      // Assemble only inside the prediction-guarded propose call; the mapped
      // artifact and evaluated snapshot now contain the SAME candidate files.
      propose: async (proposeInput) => {
        arm = await assembleLlmCompArmSetup({ ...setupInput, runtime, proposeInput });
        return arm.proposal;
      },
      falsify: runtime.falsify.bind(runtime),
      critic: runtime.critic?.bind(runtime),
      challenger: runtime.challenger?.bind(runtime),
      auditor: runtime.auditor?.bind(runtime),
      successAuditor: runtime.successAuditor?.bind(runtime),
      crossModelCheck: runtime.crossModelCheck?.bind(runtime),
    },
    adapter: new ScoreFileToyCompetitionAdapter(),
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    verification: {
      killTestHang: (context) => {
        if (!arm) return { ok: false, objections: ["LLM proposal was not assembled"] };
        return arm.killTestHang(context);
      },
    },
  });
  const state = await harness.run();
  if (!arm) throw new Error(state.branches.candidate?.rejectionReason ?? "LLM proposal was not assembled");
  return Object.freeze({ arm, harness, state }) as LlmCompArmBeforePromotionRun;
}
