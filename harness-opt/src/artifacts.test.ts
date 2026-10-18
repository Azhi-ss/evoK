import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRoleJson } from "./artifacts";
import { Lineage } from "./lineage";
import { writeStageReport } from "./reports";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("host writes stay inside the run root", () => {
  test("writeRoleJson refuses a patch.json symlink that leaves the run root", () => {
    const root = dir("harness-opt-host-");
    const outside = dir("harness-opt-outside-");
    const leaked = join(outside, "patch.json");
    symlinkSync(leaked, join(root, "patch.json"));
    expect(() => writeRoleJson(root, "innovator", "patch.json", { summary: "must-not-land" })).toThrow(/escapes the run root/);
    expect(existsSync(leaked)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    const events = new Lineage(join(root, "state")).events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "contract", role: "innovator", tool: "write", path: "patch.json" });
    expect(JSON.stringify(events)).not.toContain("must-not-land");
  });

  test("a candidates symlink cannot receive a child config outside the run", () => {
    const root = dir("harness-opt-host-");
    const outside = dir("harness-opt-outside-");
    symlinkSync(outside, join(root, "candidates"));
    expect(() => writeRoleJson(root, "innovator", "candidates/c1/config.json", { id: "c1" })).toThrow(/escapes the run root/);
    expect(readdirSync(outside)).toEqual([]);
    expect(new Lineage(join(root, "state")).events().some((event) => event.kind === "contract")).toBe(true);
  });

  test("innovator cannot write candidates/base and the orchestrator can seed it", () => {
    const root = dir("harness-opt-host-");
    expect(() => writeRoleJson(root, "innovator", "candidates/base/config.json", { id: "pwn" })).toThrow(/baseline/);
    expect(existsSync(join(root, "candidates", "base", "config.json"))).toBe(false);
    writeRoleJson(root, "orchestrator", "candidates/base/config.json", { id: "base" });
    expect(readFileSync(join(root, "candidates", "base", "config.json"), "utf8")).toContain("\"id\": \"base\"");
    expect(new Lineage(join(root, "state")).events().filter((event) => event.kind === "contract")).toHaveLength(1);
  });

  test("a reports directory symlink cannot receive a stage report", () => {
    const root = dir("harness-opt-host-");
    const outside = dir("harness-opt-outside-");
    mkdirSync(join(root, "reports"));
    symlinkSync(outside, join(root, "reports", "round-1"));
    expect(() => writeStageReport(root, {
      round: 1,
      stage: "gap",
      output: { gaps: [] },
      explanation: "no",
    })).toThrow(/escapes the run root/);
    expect(readdirSync(outside)).toEqual([]);
    expect(new Lineage(join(root, "state")).events().some((event) => event.kind === "contract" && event.role === "orchestrator")).toBe(true);
  });
});
