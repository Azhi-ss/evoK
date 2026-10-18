import { describe, expect, test } from "bun:test";
import { evaluateEvidenceGate, modelAllowed } from "./evidence-gate";

const open = {
  modelId: "deepseek-v4.1-flash",
  heldOutScore: 80,
  heldOutFloor: 50,
  tracePackComplete: true,
  changeNotePresent: true,
  tts: "passed" as const,
  submitCountToday: 0,
  maxSubmitsPerDay: 1,
  tokensSpent: 10,
  tokenBudget: 100,
};

describe("evidence gate", () => {
  test("refuses when TTS was not run, even if dev would look good", () => {
    const result = evaluateEvidenceGate({ ...open, tts: "not-run", heldOutScore: null });
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(["held-out", "tts"]);
  });

  test("opens only when every submit check is green", () => {
    expect(evaluateEvidenceGate(open).ok).toBe(true);
  });

  test("training ids and off-list models fail closed", () => {
    expect(modelAllowed("deepseek-v4.1-flash")).toBe(true);
    expect(modelAllowed("grpo-deepseek")).toBe(false);
    expect(evaluateEvidenceGate({ ...open, modelId: "gpt-private" }).ok).toBe(false);
  });

  test("an injected evoK consult can keep the gate shut", () => {
    const result = evaluateEvidenceGate({
      ...open,
      consultEvok: () => ({ ok: false, refusedGateIds: ["budget"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "evok-contest-gates")?.ok).toBe(false);
  });

  test("daily quota blocks a second submit", () => {
    expect(evaluateEvidenceGate({ ...open, submitCountToday: 1 }).ok).toBe(false);
  });
});
