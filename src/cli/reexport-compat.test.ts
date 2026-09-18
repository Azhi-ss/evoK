/**
 * ET-A3 / P6 compatibility seam: `src/cli/` is a thin Mission CLI shell.
 * The dead flat `src/evok-cli.ts` shim is gone (P6). The pack barrel stays
 * isomorphic with `evok-cli` and must not grow a second control plane.
 */
import { describe, expect, test } from "bun:test";
import * as cliPacked from "./evok-cli";
import * as cliIndex from "./index";

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(left: object, right: object): void {
  expect(runtimeKeys(left)).toEqual(runtimeKeys(right));
  for (const key of runtimeKeys(left)) {
    expect((right as Record<string, unknown>)[key]).toBe((left as Record<string, unknown>)[key]);
  }
}

describe("cli pack re-export isomorphism", () => {
  test("src/cli/ barrel re-exports the same runtime bindings as evok-cli", () => {
    expectSameRuntimeSurface(cliPacked, cliIndex);
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
    expect("startAuthorizedMission" in cliIndex).toBe(false);
    expect("runGoldenPath" in cliIndex).toBe(false);
  });
});
