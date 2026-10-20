import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { emptyParts, type HarnessConfig } from "./types";
import { applyPatch } from "./modules/proposer";
import {
  CONFIG_PATHS,
  HARNESS_LEAF_CONSUMPTION,
  SEARCH_LEAF_CONSUMPTION,
} from "./config-paths";

const base: HarnessConfig = {
  id: "base",
  modelId: "qwen-test",
  parts: emptyParts(),
  search: { samples: 1, selfChecks: 0, retries: 0 },
};

describe("config leaf whitelist", () => {
  test("removed leaves are rejected and the new leaves are stored", () => {
    const removed = applyPatch(base, {
      part: "skills",
      motivation: "drop the unread trigger",
      expectedFailureClass: "skill-not-triggered",
      changes: { trigger: "format", maxChars: 1000 },
    });
    expect(removed.config.parts.skills).toEqual({ maxChars: 1000 });
    expect(removed.rejected.map((item) => item.key)).toEqual(["trigger"]);
    const check = applyPatch(base, {
      part: "toolchain",
      motivation: "drop the unread check id",
      expectedFailureClass: "tool-misuse",
      changes: { "tools.check.id": "fmt", checker: "none", "tools.enabled": ["read", "write"] },
    });
    expect(check.config.parts.toolchain).toEqual({ checker: "none", tools: { enabled: ["read", "write"] } });
    expect(check.rejected.map((item) => item.key)).toEqual(["tools.check.id"]);
    expect(CONFIG_PATHS.has("toolchain.tools.check.id")).toBe(false);
    expect(CONFIG_PATHS.has("skills.trigger")).toBe(false);
  });

  test("every whitelisted leaf is consumed by the harness patch or the dev runner", () => {
    const root = mkdtempSync(join(tmpdir(), "leaves-"));
    const source = join(here, "../harness-patch/upstream/harness.mjs");
    const dest = join(root, "harness.mjs");
    const applied = spawnSync("node", [join(here, "../harness-patch/apply.mjs"), source, dest], {
      encoding: "utf8",
    });
    expect(applied.status).toBe(0);
    const patched = readFileSync(dest, "utf8");
    const runner = readFileSync(join(here, "modules/runner.ts"), "utf8");
    const harnessLeaves = [...CONFIG_PATHS].filter((leaf) => !leaf.startsWith("search."));
    const searchLeaves = [...CONFIG_PATHS].filter((leaf) => leaf.startsWith("search."));
    expect(harnessLeaves.sort()).toEqual(Object.keys(HARNESS_LEAF_CONSUMPTION).sort());
    expect(searchLeaves.sort()).toEqual(Object.keys(SEARCH_LEAF_CONSUMPTION).sort());
    for (const leaf of harnessLeaves) {
      expect(patched.includes(leaf)).toBe(true);
    }
    expect(patched).not.toContain("toolchain.tools.check.id");
    expect(patched).not.toContain("skills.trigger");
    expect(runner).toContain("config.search.samples");
    expect(runner).toContain("config.search.selfChecks");
    expect(runner).toContain("config.search.retries");
    expect(patched).toContain("readMemoryNotes");
    expect(patched).not.toContain("writeFileSync(memoryPath");
    expect(patched).not.toContain("writeFileSync(process.env.HARNESS_MEMORY_PATH");
  });
});
