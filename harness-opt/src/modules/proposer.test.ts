import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyParts, type HarnessConfig } from "../types";
import { applyPatch, buildInnovatorInput } from "./proposer";
import { loadTaskBank, splitBank } from "./probe";

const base: HarnessConfig = {
  id: "base",
  modelId: "qwen-test",
  parts: emptyParts(),
  search: { samples: 1, selfChecks: 0, retries: 0 },
};

describe("proposer boundary", () => {
  test("held-out cannot be passed into innovator input", () => {
    expect(() => buildInnovatorInput({
      config: base,
      gaps: { gaps: [] },
      history: [],
      traces: [],
      heldOut: { score: 1 },
    })).toThrow(/held-out/);
  });

  test("a patch may change TTS genes and may not drop the fixed model", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "trigger the format skill before answering",
      expectedFailureClass: "format-invalid",
      changes: { trigger: "format" },
      search: { samples: 3, selfChecks: 1, retries: 2 },
    });
    expect(next.modelId).toBe(base.modelId);
    expect(next.search).toEqual({ samples: 3, selfChecks: 1, retries: 2 });
    expect(next.parts.skills).toEqual({ trigger: "format" });
  });

  test("an unmotivated patch is rejected", () => {
    expect(() => applyPatch(base, {
      part: "memory",
      motivation: "  ",
      expectedFailureClass: "timeout",
      changes: {},
    })).toThrow(/motivation/);
  });

  test("the task bank keeps held-out out of the dev list", () => {
    const dir = mkdtempSync(join(tmpdir(), "bank-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a", split: "dev", path: "dev/a.txt" }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "b", split: "held-out", path: "hold/b.txt" }));
    const bank = loadTaskBank(dir);
    expect(bank.dev.map((task) => task.id)).toEqual(["a"]);
    expect(bank.heldOut.size).toBe(1);
    expect(splitBank(bank.dev).heldOut.size).toBe(0);
    expect(JSON.stringify(bank.dev)).not.toContain("held-out");
  });
});
