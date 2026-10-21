import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EFFECTIVE_KNOBS, formatKnobLine, harnessEffectiveKeys, knobCatalog, noopKeys } from "./effective-knobs";

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

  test("current effective values follow the 4d4e12e5 defaults merged with control", () => {
    const facts = knobCatalog({ parts: { "agent-loop": { maxSteps: 25 } } });
    expect(facts.map((fact) => fact.key)).toEqual([...EFFECTIVE_KNOBS]);
    const idle = facts.find((fact) => fact.key === "agent-loop.noProgressTurns");
    expect(idle).toEqual({
      key: "agent-loop.noProgressTurns",
      current: 3,
      type: "positiveInt",
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (!idle) throw new Error("missing noProgressTurns");
    expect(formatKnobLine(idle)).toBe("agent-loop.noProgressTurns current=3 type=positiveInt min=1 max=9007199254740991");
    expect(facts.find((fact) => fact.key === "agent-loop.maxSteps")?.current).toBe(25);
    expect(facts.find((fact) => fact.key === "toolchain.bashTimeoutSec")).toEqual({
      key: "toolchain.bashTimeoutSec",
      current: 300,
      type: "positiveInt",
      min: 1,
      max: 1800,
    });
    expect(facts.find((fact) => fact.key === "context.window")?.current).toBe(131072);
    expect(facts.find((fact) => fact.key === "context.maxTokens")?.current).toBe(8192);
    expect(facts.find((fact) => fact.key === "memory.enabled")?.current).toBe(false);
    expect(facts.find((fact) => fact.key === "toolchain.checker")).toEqual({
      key: "toolchain.checker",
      current: "contract",
      type: "enum",
      values: ["none", "contract"],
    });
    expect(facts.find((fact) => fact.key === "toolchain.tools.enabled")?.current).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(facts.find((fact) => fact.key === "agent-loop.requireWrite")).toEqual({
      key: "agent-loop.requireWrite",
      current: true,
      type: "boolean",
    });
  });

  test("a leaf equal to the current effective value is a no-op and one no-op leaf names only that key", () => {
    const control = { parts: { "agent-loop": { maxSteps: 25 } } };
    expect(noopKeys({ "agent-loop": { noProgressTurns: 3 } }, control)).toEqual(["agent-loop.noProgressTurns"]);
    expect(noopKeys({ "agent-loop": { maxSteps: 20, noProgressTurns: 3 } }, control)).toEqual(["agent-loop.noProgressTurns"]);
    expect(noopKeys({ "agent-loop": { noProgressTurns: 4 } }, control)).toEqual([]);
    expect(noopKeys({ "agent-loop": { noProgressTurns: 0 } }, control)).toEqual([]);
    expect(noopKeys({ "agent-loop": { maxSteps: 25 } }, control)).toEqual(["agent-loop.maxSteps"]);
    expect(noopKeys({ context: { compression: 1 } }, control)).toEqual([]);
  });

  test("control overrides the harness default and the written value is compared as written", () => {
    const overridden = { parts: { "agent-loop": { maxSteps: 25, noProgressTurns: 4 } } };
    expect(knobCatalog(overridden).find((fact) => fact.key === "agent-loop.noProgressTurns")?.current).toBe(4);
    expect(noopKeys({ "agent-loop": { noProgressTurns: 4 } }, overridden)).toEqual(["agent-loop.noProgressTurns"]);
    expect(noopKeys({ "agent-loop": { noProgressTurns: 3 } }, overridden)).toEqual([]);
    const invalidIdle = { parts: { "agent-loop": { maxSteps: 25, noProgressTurns: 0 } } };
    expect(knobCatalog(invalidIdle).find((fact) => fact.key === "agent-loop.noProgressTurns")?.current).toBe(3);
    const wideBash = { parts: { "agent-loop": { maxSteps: 25 }, toolchain: { bashTimeoutSec: 3000 } } };
    expect(knobCatalog(wideBash).find((fact) => fact.key === "toolchain.bashTimeoutSec")?.current).toBe(300);
    expect(noopKeys({ toolchain: { bashTimeoutSec: 3000 } }, wideBash)).toEqual([]);
    expect(noopKeys({ toolchain: { bashTimeoutSec: 300 } }, wideBash)).toEqual(["toolchain.bashTimeoutSec"]);
    const packed = { parts: { "agent-loop": { maxSteps: 25 }, skills: { pack: "alpha" } } };
    expect(knobCatalog(packed).find((fact) => fact.key === "skills.pack")?.current).toEqual(["alpha"]);
    expect(noopKeys({ skills: { pack: "alpha" } }, packed)).toEqual([]);
    expect(noopKeys({ skills: { pack: ["alpha"] } }, packed)).toEqual(["skills.pack"]);
  });

  test("preflight8 noProgressTurns=3 matches harness.4d4e12e5.mjs line 154", () => {
    const bytes = readFileSync(DEPLOYED_HARNESS);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DEPLOYED_HARNESS_SHA);
    const line = bytes.toString("utf8").split("\n")[153] ?? "";
    expect(line).toContain('positiveInt(candidateValue("agent-loop", "noProgressTurns"), 3)');
    const control = { parts: { "agent-loop": { maxSteps: 25 } } };
    expect(noopKeys({ "agent-loop": { noProgressTurns: 3 } }, control)).toEqual(["agent-loop.noProgressTurns"]);
  });
});
