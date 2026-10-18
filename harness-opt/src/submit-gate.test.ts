import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_MODEL_ID } from "./fixed-model";
import { Lineage, Node } from "./lineage";
import { handleSubmitGate } from "./submit-gate";

describe("harnessopt_submit_gate", () => {
  test("the command runs the full checklist and fails closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-gate-"));
    const state = join(root, "state");
    const lineage = new Lineage(state);
    lineage.put(new Node({
      id: "best",
      parentId: null,
      configPath: "candidates/best/config.json",
      status: "evaluated",
      devScores: [0.8],
      stage: "full",
    }));
    mkdirSync(join(root, "candidates", "best"), { recursive: true });
    writeFileSync(join(root, "candidates", "best", "config.json"), JSON.stringify({ modelId: "qwen-max" }));
    const result = await handleSubmitGate(`--root ${root}`);
    expect(result.submit).toBe(false);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    expect(failed).toEqual(expect.arrayContaining([
      "model",
      "held-out",
      "trace-pack",
      "change-note",
      "playground-submit-dry-run",
    ]));
    const dry = result.checks.find((check) => check.id === "playground-submit-dry-run");
    expect(dry?.detail).toContain("not-run");
    const saved = JSON.parse(readFileSync(join(state, "run_state.json"), "utf8")) as { submit: boolean };
    expect(saved.submit).toBe(false);
    expect(FIXED_MODEL_ID).toBe("deepseek-v4.1-flash");
  });

  test("the three agents pin the same model id", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pinned = JSON.parse(readFileSync(join(root, "fixed-model.json"), "utf8")) as { modelId: string };
    expect(pinned.modelId).toBe(FIXED_MODEL_ID);
    for (const name of ["gap-finder.md", "innovator.md", "reviewer-gate.md"]) {
      const text = readFileSync(join(root, "agents", name), "utf8");
      const model = text.match(/^model:\s*(\S+)/m)?.[1];
      expect(model).toBe(pinned.modelId);
    }
  });
});