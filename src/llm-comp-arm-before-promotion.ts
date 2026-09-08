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
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type MissionState,
} from "./toy-harness";

export interface RunLlmCompArmBeforePromotionInput extends AssembleLlmCompArmSetupInput {
  readonly missionId?: string;
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
  const { missionId, ...setupInput } = input;
  const arm = await assembleLlmCompArmSetup(setupInput);
  const harness = new ToyCompetitionHarness({
    missionId: missionId ?? "llm-comp-arm-before-promotion",
    taskContract: { objective: "llm-comp-arm before-promotion AC" },
    branchIds: ["candidate"],
    runtime: arm.runtime,
    adapter: new ScoreFileToyCompetitionAdapter(),
    policy: { maxBranches: 1, maxParallelBranches: 1, quorum: 1 },
    verification: {
      killTestHang: arm.killTestHang,
    },
  });
  const state = await harness.run();
  return Object.freeze({ arm, harness, state }) as LlmCompArmBeforePromotionRun;
}
