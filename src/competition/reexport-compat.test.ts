/**
 * ET-A5 compatibility seam: `src/competition/` implementations and the flat
 * `src/*.ts` re-exports must stay isomorphic. Live / allowlist / no-submit
 * literals here are independent of the moved module bodies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as armFlat from "../llm-comp-arm-before-promotion";
import * as armPacked from "./llm-comp-arm-before-promotion";
import * as competitionPacked from "./index";
import * as runtimeFlat from "../llm-competition-runtime";
import * as runtimePacked from "./llm-competition-runtime";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
} from "../newapi-client";

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
  if (savedDefaultModel === undefined) delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
  else process.env[NEWAPI_DEFAULT_MODEL_ENV] = savedDefaultModel;
});

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

describe("competition pack re-export isomorphism", () => {
  test("flat src/*.ts re-exports the same runtime bindings as src/competition/", () => {
    expectSameRuntimeSurface(runtimeFlat, runtimePacked);
    expectSameRuntimeSurface(armFlat, armPacked);
    expect(competitionPacked.createLlmCompetitionRuntime).toBe(runtimePacked.createLlmCompetitionRuntime);
    expect(competitionPacked.runLlmCompArmBeforePromotion).toBe(armPacked.runLlmCompArmBeforePromotion);
  });

  test("src/competition/ is importable; live stays explicit; GPT* stay banned", async () => {
    delete process.env[NEWAPI_API_KEY_ENV];
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    delete process.env[NEWAPI_LIVE_ENV];

    expect(competitionPacked.createLlmCompetitionRuntime()).toBeInstanceOf(
      competitionPacked.MockLlmCompetitionRuntime,
    );
    expect(competitionPacked.createLlmCompetitionRuntime()).not.toBeInstanceOf(
      competitionPacked.LiveLlmCompetitionRuntime,
    );

    process.env[NEWAPI_LIVE_ENV] = "1";
    const envOnly = await competitionPacked.runLlmCompArmBeforePromotion({
      missionId: "p5-env-must-not-open-product-arm",
    });
    expect(envOnly.arm.runtime).toBeInstanceOf(competitionPacked.MockLlmCompetitionRuntime);

    await expect(
      competitionPacked.runLlmCompArmBeforePromotion({
        live: true,
        missionId: "p5-explicit-live-fail-closed",
      }),
    ).rejects.toBeInstanceOf(LiveLlmKeyMissingError);

    delete process.env[NEWAPI_LIVE_ENV];
    expect(() => competitionPacked.createLlmCompetitionRuntime({ model: "gpt-4" })).toThrow(
      /allowlist|not allowlisted/i,
    );
    expect(() => competitionPacked.createLlmCompetitionRuntime({ model: "GPT-4o" })).toThrow(
      /allowlist|not allowlisted/i,
    );
    expect(() => competitionPacked.createLlmCompetitionRuntime({ model: "DeepSeek-V3" })).not.toThrow();
    expect(() => competitionPacked.createLlmCompetitionRuntime({ model: "Gemini-2.5-pro" })).not.toThrow();

    expect(runtimeFlat.createLlmCompetitionRuntime).toBe(competitionPacked.createLlmCompetitionRuntime);
    expect(armFlat.runLlmCompArmBeforePromotion).toBe(competitionPacked.runLlmCompArmBeforePromotion);
  });

  test("competition pack does not swallow evidence gates or grow a true submit path", () => {
    const keys = runtimeKeys(competitionPacked);
    expect(keys).not.toContain("SubmissionBroker");
    expect(keys).not.toContain("submitContest");
    expect(keys).not.toContain("submitToCompetition");
    expect(keys).not.toContain("createKillTestHangHook");
    expect(keys).not.toContain("runKillTestHang");
    expect(keys).not.toContain("auditMethodology");
    expect(keys).not.toContain("oofEnsembleGate");
    expect(keys).not.toContain("verificationRoleContract");
    expect(keys).not.toContain("SELECTION_POLICY_40");
    expect("SubmissionBroker" in competitionPacked).toBe(false);
    expect("submitContest" in competitionPacked).toBe(false);
    expect("createKillTestHangHook" in competitionPacked).toBe(false);
    expect("SELECTION_POLICY_40" in competitionPacked).toBe(false);
  });
});
