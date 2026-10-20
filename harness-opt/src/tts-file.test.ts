import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHostFile } from "./artifacts";
import { Lineage } from "./lineage";
import { TTS_COMPARISON_FILE, readMatchedBudgetTts } from "./tts-file";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("tts comparison reads", () => {
  test("a missing comparison stays not-run and a real one is read", () => {
    const root = dir("harness-opt-tts-");
    expect(readMatchedBudgetTts(root)).toBeUndefined();
    writeHostFile(root, TTS_COMPARISON_FILE, `${JSON.stringify({ source: "matched-budget", status: "passed" })}\n`);
    expect(readMatchedBudgetTts(root)).toBe("passed");
  });

  test("a tts symlink to a comparison outside the run root is refused", () => {
    const root = dir("harness-opt-tts-");
    const outside = dir("harness-opt-outside-");
    const forged = join(outside, "tts.json");
    writeFileSync(forged, JSON.stringify({ source: "matched-budget", status: "passed" }));
    mkdirSync(join(root, "state"), { recursive: true });
    symlinkSync(forged, join(root, "state", "link2"));
    symlinkSync("link2", join(root, "state", "tts-comparison.json"));

    expect(() => readMatchedBudgetTts(root)).toThrow(/escapes the run root/);
    const events = new Lineage(join(root, "state")).events().filter((event) => event.kind === "contract");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "contract",
      role: "orchestrator",
      tool: "read",
      path: TTS_COMPARISON_FILE,
    });
    expect(JSON.stringify(events)).not.toContain("matched-budget");
  });
});
