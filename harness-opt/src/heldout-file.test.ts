import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lineage } from "./lineage";
import { HELD_OUT_SCORE_FILE, readHeldOutScore, writeHandFilledHeldOut } from "./heldout-file";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("held-out score reads", () => {
  test("a real held-out score file stays readable", () => {
    const root = dir("harness-opt-held-");
    writeHandFilledHeldOut(root, 0.4);
    expect(readHeldOutScore(root)).toEqual({ score: 0.4, tokens: 0 });
  });

  test("a held-out symlink to a forged score outside the run root is refused", () => {
    const root = dir("harness-opt-held-");
    const outside = dir("harness-opt-outside-");
    const forged = join(outside, "fake.json");
    writeFileSync(forged, JSON.stringify({ score: 0.99, tokens: 3 }));
    mkdirSync(join(root, "sealed"), { recursive: true });
    symlinkSync(forged, join(root, "sealed", "link2"));
    symlinkSync("link2", join(root, "sealed", "heldout-score.json"));

    expect(() => readHeldOutScore(root)).toThrow(/escapes the run root/);
    const events = new Lineage(join(root, "state")).events().filter((event) => event.kind === "contract");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "contract",
      role: "orchestrator",
      tool: "read",
      path: HELD_OUT_SCORE_FILE,
    });
    expect(JSON.stringify(events)).not.toContain("0.99");

    const redirected = dir("harness-opt-held-");
    mkdirSync(join(redirected, "tests"), { recursive: true });
    mkdirSync(join(redirected, "sealed"), { recursive: true });
    writeFileSync(join(redirected, "tests", "fake.json"), JSON.stringify({ score: 0.99, tokens: 3 }));
    symlinkSync(join(redirected, "tests", "fake.json"), join(redirected, "sealed", "heldout-score.json"));
    expect(() => readHeldOutScore(redirected)).toThrow(/requested contract|forbidden|escapes the run root/);
    const redirectedEvents = new Lineage(join(redirected, "state")).events().filter((event) => event.kind === "contract");
    expect(redirectedEvents).toHaveLength(1);
    expect(JSON.stringify(redirectedEvents)).not.toContain("0.99");
  });
});
