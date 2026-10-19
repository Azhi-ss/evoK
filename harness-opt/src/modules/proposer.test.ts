import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyParts, type HarnessConfig } from "../types";
import { parsePatchFile } from "../schemas";
import { applyPatch, assertNoHeldOutLeak, buildInnovatorInput, stripHeldOutFields } from "./proposer";
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

  test("role input drops nested held-out fields and still rejects a leftover key", () => {
    const stripped = stripHeldOutFields({
      events: [{ kind: "gate", held_out: 0.2, nested: { hiddenScore: 1, ok: true } }],
      parent: { id: "base" },
    }) as { events: Record<string, unknown>[] };
    expect(stripped.events[0]).toEqual({ kind: "gate", nested: { ok: true } });
    expect(() => assertNoHeldOutLeak({ parent: { heldOut: 0.2 } }, "gap finder input")).toThrow(/gap finder input/);
  });

  test("a patch may change TTS genes and may not drop the fixed model", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "trigger the format skill before answering",
      expectedFailureClass: "format-invalid",
      changes: { trigger: "format" },
      search: { samples: 3, selfChecks: 1, retries: 2 },
    });
    expect(next.rejected).toEqual([]);
    expect(next.config.modelId).toBe(base.modelId);
    expect(next.config.search).toEqual({ samples: 3, selfChecks: 1, retries: 2 });
    expect(next.config.parts.skills).toEqual({ trigger: "format" });
  });

  test("a dotted patch key expands into a nested path", () => {
    const parent: HarnessConfig = {
      ...base,
      parts: {
        ...emptyParts(),
        toolchain: { tools: { check: { name: "keep" } }, checker: "stay" },
      },
    };
    const next = applyPatch(parent, {
      part: "toolchain",
      motivation: "set the nested checker",
      expectedFailureClass: "tool-misuse",
      changes: { "tools.check.id": "fmt" },
    });
    expect(next.rejected).toEqual([]);
    expect(next.config.parts.toolchain).toEqual({
      checker: "stay",
      tools: { check: { name: "keep", id: "fmt" } },
    });
  });

  test("an illegal change key is recorded and the other keys still apply", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "add the search skill file",
      expectedFailureClass: "skill-not-triggered",
      changes: {
        "skills/search.md": { content: "body", metadata: { name: "search" } },
        metadata: { name: "search" },
        trigger: "format",
      },
    });
    const file = next.rejected.find((item) => item.key === "skills/search.md");
    expect(file?.reason).toContain("skills/search.md");
    expect(next.rejected.find((item) => item.key === "metadata")?.reason).toContain("不在白名单");
    expect(next.config.parts.skills).toEqual({ trigger: "format" });
    expect(JSON.stringify(next.config)).not.toContain("search.md");
    const dottedFile = applyPatch(base, {
      part: "skills",
      motivation: "add the search skill file",
      expectedFailureClass: "skill-not-triggered",
      changes: { "search.md": "body", trigger: "format" },
    });
    expect(dottedFile.rejected.map((item) => item.key)).toEqual(["search.md"]);
    expect(dottedFile.rejected[0]?.reason).toContain("search.md");
    expect(dottedFile.config.parts.skills).toEqual({ trigger: "format" });
  });

  test("a repeated part prefix is stripped once", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "weight the skill selector",
      expectedFailureClass: "skill-not-triggered",
      changes: {
        "skills.selector.weight": 0.2,
        "skills.skills.selector.bias": 0.1,
      },
    });
    expect(next.config.parts.skills).toEqual({ selector: { weight: 0.2 } });
    expect(next.config.parts["agent-loop"]).toEqual({});
    expect(next.rejected.map((item) => item.key)).toEqual(["skills.skills.selector.bias"]);
    expect(next.rejected[0]?.reason).toContain("不在白名单");
    expect(next.config.parts.skills).not.toHaveProperty("skills");
  });

  test("a change cannot write into another part", () => {
    const parent: HarnessConfig = {
      ...base,
      parts: {
        ...emptyParts(),
        skills: { pack: "base" },
        toolchain: { checker: "keep" },
      },
    };
    const next = applyPatch(parent, {
      part: "skills",
      motivation: "keep the checker on its own part",
      expectedFailureClass: "tool-misuse",
      changes: {
        trigger: "format",
        "toolchain.checker": "strict",
        "agent-loop": { maxSteps: 1 },
      },
    });
    expect(next.config.parts.skills).toEqual({ pack: "base", trigger: "format" });
    expect(next.config.parts.toolchain).toEqual({ checker: "keep" });
    expect(next.config.parts["agent-loop"]).toEqual({});
    expect(next.rejected.map((item) => item.key)).toEqual(["toolchain.checker", "agent-loop"]);
    expect(next.rejected.every((item) => item.reason.includes("跨 part"))).toBe(true);
  });

  test("search parameters land on the top-level search genes", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "sample the search more than once",
      expectedFailureClass: "timeout",
      changes: {
        "search.samples": 4,
        search: { retries: 3, selfChecks: 1 },
        "skills.search.temperature": 0.2,
        skills: { trigger: "format", search: { samples: 5 } },
      },
    });
    expect(next.config.search).toEqual({ samples: 5, selfChecks: 1, retries: 3 });
    expect(next.config.parts.skills).toEqual({ trigger: "format" });
    expect(next.config.parts.skills).not.toHaveProperty("search");
    expect(next.rejected.map((item) => item.key)).toEqual(["skills.search.temperature"]);
    expect(next.rejected[0]?.reason).toContain("temperature");
  });

  test("metadata keys are refused at the head, the middle, and inside a value", () => {
    const next = applyPatch(base, {
      part: "skills",
      motivation: "keep the candidate id out of the config",
      expectedFailureClass: "format-invalid",
      changes: {
        candidateId: "c9",
        modelId: "other-model",
        "selector.modelId.weight": 0.4,
        selector: { weight: 0.2, id: "hidden" },
        trigger: "format",
      },
    });
    expect(next.config.modelId).toBe(base.modelId);
    expect(next.config.id).toBe("base+skills");
    expect(next.config.parts.skills).toEqual({ trigger: "format", selector: { weight: 0.2 } });
    expect(JSON.stringify(next.config)).not.toContain("c9");
    expect(JSON.stringify(next.config)).not.toContain("other-model");
    expect(JSON.stringify(next.config)).not.toContain("hidden");
    expect(next.rejected.map((item) => item.reason)).toEqual([
      "配置路径 candidateId 不在白名单",
      "配置路径 modelId 不在白名单",
      "配置路径 selector.modelId.weight 不在白名单",
      "配置路径 selector.id 不在白名单",
    ]);
  });

  test("foo.bar and top-level notes are rejected and tools.check.id is kept", () => {
    const parsed = parsePatchFile({
      part: "toolchain",
      motivation: "name the check and drop the scratch keys",
      expectedFailureClass: "tool-misuse",
      summary: "set the check id",
      notes: "scratch",
      changes: { "foo.bar": 1, "tools.check.id": "fmt", id: "hidden" },
    });
    const next = applyPatch(base, parsed);
    expect(next.config.parts.toolchain).toEqual({ tools: { check: { id: "fmt" } } });
    expect(next.rejected.map((item) => item.key).sort()).toEqual(["foo.bar", "id", "notes"]);
    expect(next.rejected.every((item) => item.reason.includes("不在白名单"))).toBe(true);
    const stored = JSON.stringify(next.config);
    expect(stored).not.toContain("scratch");
    expect(stored).not.toContain("foo");
    expect(stored).not.toContain("hidden");
    expect(stored).toContain("fmt");
  });

  test("notes and candidateId inside an object value are rejected and a legal nested key stays", () => {
    const next = applyPatch(base, {
      part: "toolchain",
      motivation: "keep the check id and drop the nested scratch keys",
      expectedFailureClass: "tool-misuse",
      changes: {
        tools: { check: { id: "fmt", notes: "scratch", candidateId: "c9" } },
        checker: { notes: "also", candidateId: "c8" },
        "tools.check.id": { notes: "deeper", candidateId: "c7" },
      },
    });
    expect(next.config.parts.toolchain).toEqual({ tools: { check: { id: "fmt" } } });
    expect(next.rejected.map((item) => item.key)).toEqual([
      "tools.check.notes",
      "tools.check.candidateId",
      "checker.notes",
      "checker.candidateId",
      "tools.check.id.notes",
      "tools.check.id.candidateId",
    ]);
    expect(next.rejected.every((item) => item.reason.includes("不在白名单"))).toBe(true);
    const stored = JSON.stringify(next.config);
    expect(stored).not.toContain("scratch");
    expect(stored).not.toContain("also");
    expect(stored).not.toContain("deeper");
    expect(stored).not.toContain("c9");
    expect(stored).not.toContain("c8");
    expect(stored).not.toContain("c7");
    expect(stored).toContain("fmt");
  });

  test("parse keeps a top-level search object and dotted search genes", () => {
    const raw = {
      part: "skills",
      motivation: "sample more than once",
      expectedFailureClass: "timeout",
      summary: "raise samples",
      search: { samples: 4, selfChecks: 1 },
      "search.retries": 2,
      "selector.weight": 0.3,
      changes: { trigger: "format" },
      rejected: [{ key: "old", reason: "stale" }],
    };
    const parsed = parsePatchFile(raw);
    expect(parsed.search).toEqual({ samples: 4, selfChecks: 1, retries: 2 });
    expect(parsed.changes).toEqual({ trigger: "format", "selector.weight": 0.3 });
    const again = parsePatchFile(JSON.parse(JSON.stringify(parsed)));
    expect(again.search).toEqual(parsed.search);
    expect(again.changes).toEqual(parsed.changes);
    const applied = applyPatch(base, parsed);
    expect(applied.rejected).toEqual([]);
    expect(applied.config.search).toEqual({ samples: 4, selfChecks: 1, retries: 2 });
    expect(applied.config.parts.skills).toEqual({ trigger: "format", selector: { weight: 0.3 } });

    const invalid = parsePatchFile({
      part: "skills",
      motivation: "sample more than once",
      expectedFailureClass: "timeout",
      summary: "raise samples",
      search: { samples: 0, retries: 2 },
      changes: { trigger: "format" },
    });
    const refused = applyPatch(base, invalid);
    expect(invalid.search).toEqual({ retries: 2 });
    expect(refused.config.search).toEqual({ samples: 1, selfChecks: 0, retries: 2 });
    expect(refused.config.parts.skills).toEqual({ trigger: "format" });
    expect(refused.rejected.map((item) => item.key)).toEqual(["search.samples"]);
  });

  test("a top-level __proto__ key is an explicit rejection", () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"constructor":{"x":1},"trigger":"format"}') as Record<string, unknown>;
    const next = applyPatch(base, {
      part: "skills",
      motivation: "refuse a prototype key",
      expectedFailureClass: "format-invalid",
      changes: parsed,
    });
    expect(next.rejected.map((item) => item.key)).toEqual(["__proto__", "constructor"]);
    expect(next.rejected[0]?.reason).toBe("危险键 __proto__ 被拒绝");
    expect(next.rejected[1]?.reason).toBe("危险键 constructor 被拒绝");
    expect(next.config.parts.skills).toEqual({ trigger: "format" });
    expect(JSON.stringify(next.config)).not.toContain("admin");
    expect(Object.getPrototypeOf(next.config.parts.skills)).toBe(Object.prototype);

    const literal = { __proto__: { admin: true }, trigger: "format" } as Record<string, unknown>;
    const viaProto = applyPatch(base, {
      part: "skills",
      motivation: "refuse a prototype key",
      expectedFailureClass: "format-invalid",
      changes: literal,
    });
    expect(viaProto.rejected).toEqual([{ key: "__proto__", reason: "危险键 __proto__ 被拒绝" }]);
    expect(viaProto.config.parts.skills).toEqual({ trigger: "format" });
    expect(JSON.stringify(viaProto.config)).not.toContain("admin");
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
