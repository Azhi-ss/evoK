import { DEFAULT_MODEL_ALLOWLIST } from "../types";

/**
 * Submission gate (PRD §9). Fail closed.
 *
 * Held-out is read here and nowhere in the proposer. A missing held-out
 * score, a missing trace pack, or a TTS comparison that was not run all
 * refuse submission. Live submit stays off unless the caller opts in,
 * and even then the gate only *authorizes* it; the submitter performs it.
 *
 * evoK's contest auto-submit gates are a separate consult. Pass them in
 * via `consultEvok` when the caller wants that extra fail-closed check.
 * This module does not import evoK.
 */

export type TtsStatus = "passed" | "not-run" | "failed";

export interface EvidenceGateInput {
  readonly modelId: string;
  readonly allowlist?: readonly string[];
  readonly heldOutScore: number | null;
  readonly heldOutFloor: number;
  readonly tracePackComplete: boolean;
  readonly changeNotePresent: boolean;
  readonly tts: TtsStatus;
  readonly submitCountToday: number;
  readonly maxSubmitsPerDay: number;
  readonly tokensSpent: number;
  readonly tokenBudget: number;
  readonly consultEvok?: () => { readonly ok: boolean; readonly refusedGateIds: readonly string[] };
}

export interface EvidenceCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface EvidenceGateResult {
  readonly ok: boolean;
  readonly checks: readonly EvidenceCheck[];
}

const TRAINING_MODEL = /sft|grpo|rlhf|finetune|fine-tune|\blora\b/i;

export function modelAllowed(modelId: string, allowlist: readonly string[] = DEFAULT_MODEL_ALLOWLIST): boolean {
  if (TRAINING_MODEL.test(modelId)) return false;
  const normalized = modelId.toLowerCase();
  return allowlist.some((entry) => {
    const prefix = entry.toLowerCase();
    return normalized === prefix || normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix}/`);
  });
}

export function evaluateEvidenceGate(input: EvidenceGateInput): EvidenceGateResult {
  const allowlist = input.allowlist ?? DEFAULT_MODEL_ALLOWLIST;
  const checks: EvidenceCheck[] = [
    check(
      "model",
      modelAllowed(input.modelId, allowlist),
      modelAllowed(input.modelId, allowlist)
        ? `model ${input.modelId} is on the allowlist`
        : `model ${input.modelId} is missing from the allowlist or is a training id`,
    ),
    check(
      "held-out",
      input.heldOutScore !== null && Number.isFinite(input.heldOutScore) && input.heldOutScore >= input.heldOutFloor,
      input.heldOutScore === null
        ? "held-out score is missing; it is only read at this gate"
        : `held-out ${input.heldOutScore} vs floor ${input.heldOutFloor}`,
    ),
    check("trace-pack", input.tracePackComplete, input.tracePackComplete ? "trace pack present" : "trace pack incomplete"),
    check("change-note", input.changeNotePresent, input.changeNotePresent ? "change note present" : "change note missing"),
    check(
      "tts",
      input.tts === "passed",
      input.tts === "not-run"
        ? "matched-budget TTS comparison was not run; automatic submit is forbidden"
        : `TTS comparison ${input.tts}`,
    ),
    check(
      "quota",
      input.submitCountToday < input.maxSubmitsPerDay,
      `submits today ${input.submitCountToday} / ${input.maxSubmitsPerDay}`,
    ),
    check(
      "budget",
      input.tokensSpent <= input.tokenBudget,
      `tokens ${input.tokensSpent} / budget ${input.tokenBudget}`,
    ),
  ];
  if (input.consultEvok) {
    const consulted = input.consultEvok();
    checks.push(check(
      "evok-contest-gates",
      consulted.ok,
      consulted.ok
        ? "evoK contest gates are green"
        : `evoK contest gates refused: ${consulted.refusedGateIds.join(",")}`,
    ));
  }
  return { ok: checks.every((item) => item.ok), checks };
}

function check(id: string, ok: boolean, detail: string): EvidenceCheck {
  return { id, ok, detail };
}
