import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EFFECTIVE_KNOBS, harnessEffectiveKeys } from "./effective-knobs";

/** Signed baseline the loop is allowed to tune. Bytes, not a rebuilt patch. */
const DEPLOYED_HARNESS = fileURLToPath(new URL("../../fixtures/harness.4d4e12e5.mjs", import.meta.url));
const DEPLOYED_HARNESS_SHA = "4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c";

/** Unique `effective["..."]` keys in that file, first-seen order. */
const DEPLOYED_KEYS = [
  "context.maxTokens",
  "context.window",
  "agent-loop.maxSteps",
  "agent-loop.noProgressTurns",
  "toolchain.subagents",
  "skills.maxChars",
  "skills.selector.weight",
  "skills.selector.bias",
  "skills.pack",
  "toolchain.bashTimeoutSec",
  "memory.enabled",
  "memory.scope",
  "memory.recall",
  "memory.maxItems",
  "toolchain.tools.enabled",
  "context.compaction.enabled",
  "context.compaction.reserveTokens",
  "context.compaction.keepRecentTokens",
  "toolchain.checker",
  "agent-loop.maxNudges",
  "agent-loop.requireWrite",
] as const;

describe("effective knobs", () => {
  test("the whitelist is exactly the keys the deployed 4d4e12e5 harness reads", () => {
    const bytes = readFileSync(DEPLOYED_HARNESS);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DEPLOYED_HARNESS_SHA);
    const text = bytes.toString("utf8");
    expect([...new Set(harnessEffectiveKeys(text))]).toEqual([...DEPLOYED_KEYS]);
    expect([...EFFECTIVE_KNOBS].sort()).toEqual([...DEPLOYED_KEYS].sort());
    expect(EFFECTIVE_KNOBS).not.toContain("goal.maxContinuationTurns");
  });
});
