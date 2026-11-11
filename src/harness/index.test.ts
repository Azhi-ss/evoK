/**
 * `src/harness/index.ts` is the harness's only public export surface, following
 * the `src/memory/` precedent: the names are listed explicitly, so a new file
 * cannot become public by existing and a module-private helper cannot leak. The
 * surface is pinned here, and the old paths keep their public names.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeUsage as MissionStartRuntimeUsage } from "../mission-start";
import type { RuntimeUsage } from "../pi-agent-runtime";
import * as harness from "./index";
import type { RawUsage } from "./index";

const HARNESS = dirname(fileURLToPath(import.meta.url));

describe("harness public surface", () => {
  test("the runtime surface is exactly the explicitly listed names", () => {
    expect(Object.keys(harness).sort()).toEqual([
      "addUsage",
      "assertArtifactReceipt",
      "assertEnvironmentRefs",
      "closeHarnessExecution",
      "collectArtifactCollection",
      "collectArtifacts",
      "createEnvironmentSnapshot",
      "digestArtifacts",
      "environmentRefsOf",
      "measureResponseUsage",
      "measureUsage",
    ]);
  });

  test("the directory holds the six named capabilities and no second surface", async () => {
    const files = (await readdir(HARNESS)).filter((name) => /^[^.].*\.ts$/.test(name) && !name.endsWith(".test.ts"));
    expect(files.sort()).toEqual(["artifacts.ts", "contracts.ts", "execution.ts", "index.ts", "metering.ts", "snapshot.ts"]);
  });

  test("old paths keep their public names and their meaning", () => {
    // `RuntimeUsage` was public from the runtime path, then from the Mission's
    // flat shim; both still name the harness's measured shape (a type error here
    // means a consumer of the old path broke).
    const raw: RawUsage = {
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const fromRuntime: RuntimeUsage = raw;
    const fromMissionStart: MissionStartRuntimeUsage = fromRuntime;
    expect(fromMissionStart).toEqual(raw);
  });
});
