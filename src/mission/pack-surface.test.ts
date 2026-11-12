/**
 * ET-A3 pack surface seam: `src/mission/` is importable and keeps the
 * golden-path mock-default / explicit-live split.
 */
import { describe, expect, test } from "bun:test";
import * as goldenPacked from "./v1-golden-path";
import * as missionPacked from "./index";
import * as outerE2ePacked from "./outer-e2e-min-path";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_LIVE_ENV,
} from "../newapi-client";
import { MockLlmCompetitionRuntime } from "../competition/llm-competition-runtime";

describe("mission pack surface", () => {

  test("src/mission/ is importable and keeps mock default / explicit live", async () => {
    expect(typeof missionPacked.runGoldenPath).toBe("function");
    expect(typeof missionPacked.assembleV1GoldenPath).toBe("function");
    expect(typeof missionPacked.startAuthorizedMission).toBe("function");
    expect(missionPacked.V1_GOLDEN_HYPOTHESIS_ID).toBe("h-v1-golden");
    expect(missionPacked.V1_GOLDEN_PLAN_ID).toBe("kt-v1-golden");

    const savedKey = process.env[NEWAPI_API_KEY_ENV];
    const savedLive = process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    process.env[NEWAPI_LIVE_ENV] = "1";
    try {
      const path = await missionPacked.runGoldenPath({
        statement: "compat: mock default must ignore EVOK_NEWAPI_LIVE",
      });
      expect(path.arm.runtime).toBeInstanceOf(MockLlmCompetitionRuntime);
      await expect(missionPacked.runGoldenPath({ live: true, statement: "compat live" })).rejects.toBeInstanceOf(
        LiveLlmKeyMissingError,
      );
      await expect(goldenPacked.runGoldenPath({ live: true, statement: "compat live flat" })).rejects.toBeInstanceOf(
        LiveLlmKeyMissingError,
      );
    } finally {
      if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
      else process.env[NEWAPI_API_KEY_ENV] = savedKey;
      if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
      else process.env[NEWAPI_LIVE_ENV] = savedLive;
    }
  });
});
