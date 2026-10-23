import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Budget } from "./budget";
import { FIXED_MODEL_ID, LOCAL_MODEL_ID } from "./fixed-model";
import { ATTRIBUTION_LABELS, HARNESS_PARTS } from "./types";
import { GAP_FINDER_TASK, INNOVATOR_TASK_PREFIX, REVIEWER_TASK_PREFIX, stageWriter } from "./live-round";
import { Lineage, Node } from "./lineage";
import { GreedySelector } from "./modules/selector";
import { Orchestrator } from "./orchestrator";
import { reviewRoundE2E } from "./reports";
import { buildDirectoryGateRequest, handleSubmitGate } from "./submit-gate";

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
    expect(result.checks.find((check) => check.id === "held-out")?.detail).toContain("sigma");
    const dry = result.checks.find((check) => check.id === "playground-submit-dry-run");
    expect(dry?.detail).toContain("not-run");
    const saved = JSON.parse(readFileSync(join(state, "run_state.json"), "utf8")) as { submit: boolean };
    expect(saved.submit).toBe(false);
    expect(saved).not.toHaveProperty("heldout");
    expect(readFileSync(join(state, "lineage.jsonl"), "utf8")).not.toContain("heldout");
    expect(readFileSync(join(state, "gate.jsonl"), "utf8")).toContain("\"heldout\":null");
    expect(FIXED_MODEL_ID).toBe("deepseek-v4.1-flash");
    expect(buildDirectoryGateRequest(root).modelId).toBe("qwen-max");
  });

  test("a candidate modelId outside the contest families is not adopted", () => {
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
    writeFileSync(join(root, "candidates", "best", "config.json"), JSON.stringify({ modelId: "gpt-4o" }));
    const request = buildDirectoryGateRequest(root);
    expect(request.modelId).toBe("");
    expect(request.modelId).not.toBe("gpt-4o");
    const pinned = mkdtempSync(join(tmpdir(), "harness-opt-gate-"));
    const pinnedState = join(pinned, "state");
    new Lineage(pinnedState).put(new Node({
      id: "best",
      parentId: null,
      configPath: "candidates/best/config.json",
      status: "evaluated",
      devScores: [0.8],
      stage: "full",
    }));
    mkdirSync(join(pinned, "candidates", "best"), { recursive: true });
    writeFileSync(join(pinned, "candidates", "best", "config.json"), JSON.stringify({ modelId: "  GLM-4.6  " }));
    expect(buildDirectoryGateRequest(pinned).modelId).toBe("GLM-4.6");
    writeFileSync(join(pinned, "candidates", "best", "config.json"), JSON.stringify({ modelId: FIXED_MODEL_ID }));
    expect(buildDirectoryGateRequest(pinned).modelId).toBe(FIXED_MODEL_ID);
  });

  test("a refused tts symlink marks tts red and still writes gate.json and e2e.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opt-gate-"));
    const outside = mkdtempSync(join(tmpdir(), "harness-opt-outside-"));
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
    writeFileSync(join(outside, "tts.json"), JSON.stringify({ source: "matched-budget", status: "passed" }));
    symlinkSync(join(outside, "tts.json"), join(state, "link2"));
    symlinkSync("link2", join(state, "tts-comparison.json"));
    const refuse = () => {
      throw new Error("unused");
    };
    const orchestrator = new Orchestrator(lineage, {
      gapFinder: refuse,
      innovator: refuse,
      runner: refuse,
      reviewer: refuse,
    }, new GreedySelector(), new Budget(), { onStage: stageWriter(root, 1) });
    const result = await orchestrator.submitGate(buildDirectoryGateRequest(root));
    const e2e = reviewRoundE2E(root, 1);
    const tts = result.checks.find((check) => check.id === "tts");
    expect(tts?.ok).toBe(false);
    expect(tts?.detail).toContain("escapes the run root");
    expect(result.submit).toBe(false);
    const gate = JSON.parse(readFileSync(join(root, "reports", "round-1", "gate.json"), "utf8")) as {
      output: { ok: boolean; failed: string[] };
    };
    expect(gate.output.ok).toBe(false);
    expect(gate.output.failed).toContain("tts");
    expect(existsSync(join(root, "reports", "round-1", "e2e.json"))).toBe(true);
    expect(e2e.ok).toBe(false);
    expect(JSON.stringify(gate)).not.toContain("matched-budget");
  });

  test("the three agents pin the same model id", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pinned = JSON.parse(readFileSync(join(root, "fixed-model.json"), "utf8")) as {
      modelId: string;
      localModelId: string;
      contestModelId: string;
      testModelId: string;
    };
    expect(pinned.modelId).toBe(FIXED_MODEL_ID);
    expect(pinned.contestModelId).toBe(FIXED_MODEL_ID);
    expect(pinned.localModelId).toBe(LOCAL_MODEL_ID);
    expect(pinned.testModelId).toBe("deepseek-v4-1-flash-261017");
    for (const name of ["gap-finder.md", "innovator.md", "reviewer-gate.md"]) {
      const text = readFileSync(join(root, "agents", name), "utf8");
      const model = text.match(/^model:\s*(\S+)/m)?.[1];
      expect(model).toBe(pinned.localModelId);
      for (const label of ATTRIBUTION_LABELS) expect(text).toContain(label);
    }
    const innovator = readFileSync(join(root, "agents", "innovator.md"), "utf8");
    for (const part of HARNESS_PARTS) expect(innovator).toContain(part);
    const reviewer = readFileSync(join(root, "agents", "reviewer-gate.md"), "utf8");
    expect(reviewer).toContain("reason");
    expect(reviewer).toContain("字符串");
    expect(reviewer).not.toContain("held-out");
    expect(reviewer).not.toContain("布尔");
    for (const label of ATTRIBUTION_LABELS) {
      expect(GAP_FINDER_TASK).toContain(label);
      expect(INNOVATOR_TASK_PREFIX).toContain(label);
    }
    for (const part of HARNESS_PARTS) expect(INNOVATOR_TASK_PREFIX).toContain(part);
    for (const phrase of ["selector.weight", "skills.skills.selector.weight", "search.samples", "candidateId", "__proto__"]) {
      expect(innovator).toContain(phrase);
      expect(INNOVATOR_TASK_PREFIX).toContain(phrase);
    }
    expect(REVIEWER_TASK_PREFIX).toContain("boolean");
    expect(REVIEWER_TASK_PREFIX).toContain("string");
  });
});