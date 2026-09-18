/**
 * W1 experiment-validity gate (ET-M1-EXP / #142).
 *
 * Authority lives in evidence/. These predicates decide whether an Experiment
 * produced usable gate evidence. They do not decide Candidate Promotion,
 * do not copy Kill-test / AtCoder hang rules, and do not thaw Broker submit.
 *
 * Pins: effective ≠ optimal; inconclusive ≠ pass; hang is not a silent pass.
 */
import { deepFreeze } from "../security-boundary";

export type ExperimentValidityOutcome = "pass" | "fail" | "inconclusive";

export type ExperimentSliceKind =
  | "official_samples"
  | "adversarial_labeled"
  | "protected_holdout";

export type ExperimentClaim = "effective" | "optimal" | "unspecified";

export interface ExperimentSliceObservation {
  readonly kind: ExperimentSliceKind;
  readonly present: boolean;
  readonly outcome?: ExperimentValidityOutcome;
}

export interface ExperimentValidityInput {
  readonly slices: readonly ExperimentSliceObservation[];
  readonly claimed?: ExperimentClaim;
  readonly hang?: boolean;
}

export interface ExperimentSlicePresence {
  readonly officialSamples: boolean;
  readonly adversarialLabeled: boolean;
  readonly protectedHoldout: boolean;
}

export interface ExperimentValidityDecision {
  readonly ok: boolean;
  readonly outcome: ExperimentValidityOutcome;
  readonly effective: boolean;
  readonly optimal: boolean;
  readonly hang: boolean;
  readonly blocksAdmission: boolean;
  readonly slices: ExperimentSlicePresence;
  readonly objections: readonly string[];
}

const OUTCOMES = new Set<ExperimentValidityOutcome>(["pass", "fail", "inconclusive"]);

export function experimentValidityIsPass(outcome: ExperimentValidityOutcome): boolean {
  return outcome === "pass";
}

function isOutcome(value: unknown): value is ExperimentValidityOutcome {
  return typeof value === "string" && OUTCOMES.has(value as ExperimentValidityOutcome);
}

function presenceOf(slices: readonly ExperimentSliceObservation[]): ExperimentSlicePresence {
  const present = (kind: ExperimentSliceKind): boolean =>
    slices.some((slice) => slice.kind === kind && slice.present);
  return {
    officialSamples: present("official_samples"),
    adversarialLabeled: present("adversarial_labeled"),
    protectedHoldout: present("protected_holdout"),
  };
}

function emptyPresence(): ExperimentSlicePresence {
  return { officialSamples: false, adversarialLabeled: false, protectedHoldout: false };
}

function decision(input: {
  readonly outcome: ExperimentValidityOutcome;
  readonly effective?: boolean;
  readonly hang?: boolean;
  readonly slices?: ExperimentSlicePresence;
  readonly objections?: readonly string[];
}): ExperimentValidityDecision {
  const objections = Object.freeze([...(input.objections ?? [])]);
  const ok = objections.length === 0 && experimentValidityIsPass(input.outcome);
  const slices = input.slices ?? emptyPresence();
  return deepFreeze({
    ok,
    outcome: input.outcome,
    effective: input.effective === true,
    optimal: false,
    hang: input.hang === true,
    blocksAdmission: !ok || !slices.protectedHoldout,
    slices,
    objections,
  });
}

function sliceOutcome(slice: ExperimentSliceObservation): ExperimentValidityOutcome | undefined {
  if (!slice.present) return undefined;
  return isOutcome(slice.outcome) ? slice.outcome : undefined;
}

/**
 * Whether the Experiment produced usable evidence. A pass here is not
 * optimality and is not Admission. Official-sample effectiveness never
 * becomes optimal.
 */
export function evaluateExperimentValidity(input: ExperimentValidityInput): ExperimentValidityDecision {
  const slices = presenceOf(input.slices);
  if (input.hang === true) {
    return decision({
      outcome: "inconclusive",
      hang: true,
      slices,
      objections: ["explicit hang point: experiment validity is inconclusive, not pass"],
    });
  }

  const present = input.slices.filter((slice) => slice.present);
  if (present.length === 0) {
    return decision({
      outcome: "inconclusive",
      slices,
      objections: ["no measured experiment slices; inconclusive is not pass"],
    });
  }

  const official = present.find((slice) => slice.kind === "official_samples");
  const holdout = present.find((slice) => slice.kind === "protected_holdout");
  const officialOutcome = official ? sliceOutcome(official) : undefined;
  const effective = officialOutcome === "pass";

  if (input.claimed === "optimal" && holdout === undefined) {
    return decision({
      outcome: "fail",
      effective,
      slices,
      objections: ["effective is not optimal; official samples alone cannot claim optimality"],
    });
  }

  const failed = present.find((slice) => sliceOutcome(slice) === "fail");
  if (failed) {
    return decision({
      outcome: "fail",
      effective,
      slices,
      objections: [`experiment slice ${failed.kind} failed; fail is not pass`],
    });
  }

  const inconclusive = present.find((slice) => sliceOutcome(slice) === "inconclusive" || sliceOutcome(slice) === undefined);
  if (inconclusive) {
    return decision({
      outcome: "inconclusive",
      effective,
      slices,
      objections: ["inconclusive experiment slice is not pass"],
    });
  }

  return decision({ outcome: "pass", effective, slices });
}
