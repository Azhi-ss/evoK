/**
 * Scientific vs operational Run outcomes (M1-T4 / #213).
 *
 * A Run Outcome says what happened operationally (measured, failed, timed out,
 * OOM, invalid measurement). Scientific Negative Evidence is a claim about the
 * research question. An infrastructure or protocol failure may teach an
 * Operational Pitfall with its runtime/configuration conditions, but it can
 * never refute a Hypothesis: only a real measurement can.
 *
 * The classification is pure and derived from authoritative Run fields, so it
 * adds no new write authority and cannot drift from the recorded outcome.
 */
import { deepFreeze } from "../security-boundary";

export const RUN_FAILURE_KINDS = ["out-of-memory", "timeout", "invalid-measurement", "protocol-failure"] as const;

export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

export const RUN_OUTCOME_STATES = ["positive", "negative", "operational"] as const;

/** One Run as a science/operations reading: positive, refuted, or unavailable. */
export type RunOutcomeState = (typeof RUN_OUTCOME_STATES)[number];

export interface RunOutcomeInput {
  readonly ok: boolean;
  readonly score?: number;
  readonly ruleViolations?: readonly string[];
  /** A dispatch/evaluation failure message: the Run never produced a measurement. */
  readonly error?: string;
  /** The declared Task configuration that reproduced the failure, if known. */
  readonly configuration?: string;
}

export interface RunOutcomeClassification {
  readonly state: RunOutcomeState;
  /** Set only for an operational failure. */
  readonly failure?: RunFailureKind;
  /** True only for a real measured refutation; the authoritative marker. */
  readonly scientificNegativeEvidence: boolean;
  /** Reproducing conditions: failure kind, runtime/configuration, observation. */
  readonly conditions: readonly string[];
}

const OUT_OF_MEMORY = /\bout of memory\b|\boom\b|ENOMEM|memory exhausted|heap limit|bad_alloc/i;
const TIMEOUT = /\btimed?\s?out\b|\btimeout\b|ETIMEDOUT|deadline exceeded/i;
const MAX_CONDITION_LENGTH = 240;

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_CONDITION_LENGTH ? trimmed : `${trimmed.slice(0, MAX_CONDITION_LENGTH - 1)}…`;
}

/** Classifies one authoritative Run Outcome; never guesses a measurement. */
export function classifyRunOutcome(input: RunOutcomeInput): RunOutcomeClassification {
  const measured = typeof input.score === "number" || (input.ruleViolations?.length ?? 0) > 0;
  if (typeof input.error === "string" && input.error.trim() !== "") {
    return operational(input, OUT_OF_MEMORY.test(input.error)
      ? "out-of-memory"
      : TIMEOUT.test(input.error)
        ? "timeout"
        : "protocol-failure", input.error);
  }
  if (input.ok) {
    return deepFreeze({ state: "positive" as const, scientificNegativeEvidence: false, conditions: [] });
  }
  if (!measured) {
    // Nothing measurable was produced: an invalid measurement, not a refutation.
    return operational(input, "invalid-measurement", "no score and no rule violations");
  }
  return deepFreeze({
    state: "negative" as const,
    scientificNegativeEvidence: true,
    conditions: (input.ruleViolations ?? []).map(bounded),
  });
}

function operational(input: RunOutcomeInput, failure: RunFailureKind, observed: string): RunOutcomeClassification {
  return deepFreeze({
    state: "operational" as const,
    failure,
    scientificNegativeEvidence: false,
    conditions: [
      `failure:${failure}`,
      ...(input.configuration ? [`configuration:${input.configuration}`] : []),
      `observed:${observed}`,
    ].map(bounded),
  });
}
