/**
 * ET-A3 compatibility seam: `src/cli/` is a thin Mission CLI shell.
 * Flat `src/evok-cli.ts` must re-export the same runtime bindings.
 * CLI must not grow a second control plane.
 */
import { describe, expect, test } from "bun:test";
import * as cliFlat from "../evok-cli";
import * as cliPacked from "./evok-cli";
import * as cliIndex from "./index";

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

describe("cli pack re-export isomorphism", () => {
  test("flat src/evok-cli.ts re-exports the same runtime bindings as src/cli/", () => {
    expectSameRuntimeSurface(cliFlat, cliPacked);
    expectSameRuntimeSurface(cliFlat, cliIndex);
  });

  test("CLI stays a thin shell: parse/run/exit only; no Mission authority exports", () => {
    expect(cliPacked.EVOK_EXIT).toEqual({
      ok: 0,
      usage: 2,
      configError: 3,
      authError: 4,
      runtimeError: 5,
      cancelled: 130,
    });
    expect(typeof cliPacked.parseEvokArgs).toBe("function");
    expect(typeof cliPacked.runEvok).toBe("function");
    expect(cliPacked.parseEvokArgs(["--help"]).help).toBe(true);

    const keys = runtimeKeys(cliPacked);
    expect(keys).not.toContain("startAuthorizedMission");
    expect(keys).not.toContain("resumeAuthorizedMission");
    expect(keys).not.toContain("runGoldenPath");
    expect(keys).not.toContain("MissionDirector");
    expect(keys).not.toContain("runKillTestHang");
    expect(cliIndex.startAuthorizedMission).toBeUndefined();
    expect(cliIndex.runGoldenPath).toBeUndefined();
  });
});
