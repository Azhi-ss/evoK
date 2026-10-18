import { acceptedModelIds, modelIdMatchesFixed } from "../fixed-model";
import type { DryRunStatus } from "../playground-dry-run";

/**
 * Submission checklist (PRD §9). Fail closed.
 *
 * Every item below has to pass together: exact fixed model id, held-out
 * floor, complete trace pack, change note, TTS matched-budget, token budget,
 * daily submit quota, and `playground submit --dry-run`. An unsupported
 * dry-run is marked not-run and fails closed. This function does not submit.
 *
 * evoK's contest auto-submit gates are a separate consult. Pass them in
 * via `consultEvok` when the caller wants that extra fail-closed check.
 * This module does not import evoK.
 */

export type TtsStatus = "passed" | "not-run" | "failed";

export interface EvidenceGateInput {
  readonly modelId: string;
  /** Exact id from `fixed-model.json`. Prefix families are not accepted. */
  readonly fixedModelId?: string;
  readonly heldOutScore: number | null;
  readonly heldOutFloor: number;
  /** When set, the held-out check fails closed with this detail. */
  readonly heldOutRefusal?: string;
  readonly tracePackComplete: boolean;
  readonly changeNotePresent: boolean;
  readonly tts: TtsStatus;
  readonly submitCountToday: number;
  readonly maxSubmitsPerDay: number;
  readonly tokensSpent: number;
  readonly tokenBudget: number;
  /** `unsupported` is an explicit not-run and does not pass. */
  readonly dryRun: DryRunStatus;
  /** Probe text. When set, the dry-run check shows this instead of a generic line. */
  readonly dryRunDetail?: string;
  readonly consultEvok?: () => { readonly ok: boolean; readonly refusedGateIds: readonly string[] };
  /** Named inputs the caller did not supply. Fail closed, and say which ones. */
  readonly missingInputs?: readonly string[];
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

export function modelAllowed(modelId: string, fixedModelId?: string): boolean {
  if (TRAINING_MODEL.test(modelId)) return false;
  return modelIdMatchesFixed(modelId, fixedModelId);
}

export function evaluateEvidenceGate(input: EvidenceGateInput): EvidenceGateResult {
  const modelOk = input.fixedModelId === undefined
    ? modelAllowed(input.modelId)
    : modelAllowed(input.modelId, input.fixedModelId);
  const expected = input.fixedModelId ?? acceptedModelIds().join(" | ");
  const checks: EvidenceCheck[] = [
    check(
      "model",
      modelOk,
      modelOk
        ? `model ${input.modelId} matches the pinned map`
        : `model ${input.modelId} is not in ${expected}`,
    ),
    check(
      "held-out",
      input.heldOutRefusal === undefined
        && input.heldOutScore !== null
        && Number.isFinite(input.heldOutScore)
        && Number.isFinite(input.heldOutFloor)
        && input.heldOutScore >= input.heldOutFloor,
      input.heldOutRefusal
        ?? (input.heldOutScore === null
          ? "held-out score is missing; it is only read at this gate"
          : `held-out ${input.heldOutScore} vs floor ${input.heldOutFloor}`),
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
    check(
      "playground-submit-dry-run",
      input.dryRun === "passed",
      input.dryRunDetail
        ?? (input.dryRun === "passed"
          ? "playground submit --dry-run succeeded"
          : input.dryRun === "unsupported"
            ? "not-run: playground submit --dry-run is unsupported; fail-closed"
            : "playground submit --dry-run failed"),
    ),
  ];
  if (input.missingInputs && input.missingInputs.length > 0) {
    checks.push(check("inputs", false, `missing explicit input: ${input.missingInputs.join(", ")}`));
  }
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
