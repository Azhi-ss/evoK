/**
 * ET-A3 compatibility seam: `src/mission/` implementations and the flat
 * `src/*.ts` re-exports must stay isomorphic. Golden-path mock-default /
 * explicit-live literals here are independent of the moved module bodies.
 */
import { describe, expect, test } from "bun:test";
import * as baselineFlat from "../baseline-track";
import * as baselinePacked from "./baseline-track";
import * as branchFlat from "../branch-recovery";
import * as branchPacked from "./branch-recovery";
import * as draftFlat from "../mission-draft";
import * as draftPacked from "./mission-draft";
import * as directorFlat from "../mission-director";
import * as directorPacked from "./mission-director";
import * as fileFlat from "../file-blueprint";
import * as filePacked from "./file-blueprint";
import * as goldenFlat from "../v1-golden-path";
import * as goldenPacked from "./v1-golden-path";
import * as intakeFlat from "../mission-intake";
import * as intakePacked from "./mission-intake";
import * as loopFlat from "../research-loop";
import * as loopPacked from "./research-loop";
import * as missionPacked from "./index";
import * as outerE2eFlat from "../outer-e2e-min-path";
import * as outerE2ePacked from "./outer-e2e-min-path";
import * as outerMinFlat from "../outer-min-path";
import * as outerMinPacked from "./outer-min-path";
import * as proposeFlat from "../llm-propose-outer-min";
import * as proposePacked from "./llm-propose-outer-min";
import * as resumeFlat from "../mission-resume";
import * as resumePacked from "./mission-resume";
import * as startFlat from "../mission-start";
import * as startPacked from "./mission-start";
import {
  LiveLlmKeyMissingError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_LIVE_ENV,
} from "../newapi-client";
import { MockLlmCompetitionRuntime } from "../llm-competition-runtime";

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

describe("mission pack re-export isomorphism", () => {
  test("flat src/*.ts re-exports the same runtime bindings as src/mission/", () => {
    expectSameRuntimeSurface(loopFlat, loopPacked);
    expectSameRuntimeSurface(directorFlat, directorPacked);
    expectSameRuntimeSurface(startFlat, startPacked);
    expectSameRuntimeSurface(draftFlat, draftPacked);
    expectSameRuntimeSurface(intakeFlat, intakePacked);
    expectSameRuntimeSurface(resumeFlat, resumePacked);
    expectSameRuntimeSurface(baselineFlat, baselinePacked);
    expectSameRuntimeSurface(fileFlat, filePacked);
    expectSameRuntimeSurface(branchFlat, branchPacked);
    expectSameRuntimeSurface(goldenFlat, goldenPacked);
    expectSameRuntimeSurface(outerMinFlat, outerMinPacked);
    expectSameRuntimeSurface(outerE2eFlat, outerE2ePacked);
    expectSameRuntimeSurface(proposeFlat, proposePacked);
  });

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
      await expect(goldenFlat.runGoldenPath({ live: true, statement: "compat live flat" })).rejects.toBeInstanceOf(
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
