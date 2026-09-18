/**
 * W1 method Admission + writeback shape (ET-M1-EXP / #142).
 *
 * Gate authority lives here. Skills routing may hook accepted Skill State
 * through evaluateMethodAdmission; it does not own the predicate.
 *
 * Minimal set: official samples + adversarial-labeled subset + protected
 * holdout. Missing holdout refuses Admission. Elite / score / Fan-Out
 * are not Admission keys. Writeback is propose → regression → admit/rollback,
 * one slice at a time.
 *
 * Does not change Kill-test / T48 / Broker predicates, thaw true submit,
 * open BUD, or weld #40 / default fixed_uct.
 */
import { deepFreeze } from "../security-boundary";
import {
  experimentValidityIsPass,
  type ExperimentValidityDecision,
  type ExperimentValidityOutcome,
} from "./experiment-validity";

export type MethodAssetState = "candidate" | "accepted" | "demoted";
export type MethodWritebackPhase =
  | "propose"
  | "regression"
  | "admitted"
  | "rolled_back";
export type MethodWritebackKind = "skill" | "harness";

export interface AdmissionMinimalSet {
  readonly officialSamples: boolean;
  readonly adversarialLabeled: boolean;
  readonly protectedHoldout: boolean;
}

export interface MethodAdmissionInput {
  readonly validity: ExperimentValidityDecision;
  readonly slices: AdmissionMinimalSet;
  readonly protocolVersion?: string;
  readonly evidenceDigest?: string;
  /** Never an Admission key. Accepted only so tests can prove they do not pass. */
  readonly elite?: boolean;
  readonly teamFanOut?: boolean;
  readonly score?: number;
}

export interface MethodAdmissionDecision {
  readonly ok: boolean;
  readonly outcome: ExperimentValidityOutcome;
  readonly admitted: boolean;
  readonly hang: boolean;
  readonly objections: readonly string[];
  readonly protocolVersion?: string;
  readonly evidenceDigest?: string;
}

export interface MethodWritebackSlice {
  readonly sliceId: string;
  readonly kind: MethodWritebackKind;
  readonly targetName: string;
}

export interface MethodWritebackState {
  readonly phase: MethodWritebackPhase;
  readonly slice: MethodWritebackSlice;
  readonly previousState: MethodAssetState;
  readonly currentState: MethodAssetState;
  readonly admitted: boolean;
  readonly hang: boolean;
  readonly objections: readonly string[];
  readonly admission?: MethodAdmissionDecision;
}

export class MethodWritebackIsolationError extends Error {
  readonly kind = "method-writeback-isolation" as const;
  constructor(message = "writeback isolation: one slice at a time") {
    super(message);
    this.name = "MethodWritebackIsolationError";
  }
}

export class MethodWritebackPhaseError extends Error {
  readonly kind = "method-writeback-phase" as const;
  constructor(message: string) {
    super(message);
    this.name = "MethodWritebackPhaseError";
  }
}

function admissionDecision(input: {
  readonly outcome: ExperimentValidityOutcome;
  readonly hang?: boolean;
  readonly objections?: readonly string[];
  readonly protocolVersion?: string;
  readonly evidenceDigest?: string;
}): MethodAdmissionDecision {
  const objections = Object.freeze([...(input.objections ?? [])]);
  const ok = objections.length === 0 && experimentValidityIsPass(input.outcome) && input.hang !== true;
  return deepFreeze({
    ok,
    outcome: input.outcome,
    admitted: ok,
    hang: input.hang === true,
    objections,
    ...(input.protocolVersion === undefined ? {} : { protocolVersion: input.protocolVersion }),
    ...(input.evidenceDigest === undefined ? {} : { evidenceDigest: input.evidenceDigest }),
  });
}

/**
 * Method / Skill Admission. Completeness of the minimal set is required.
 * Validity hang is an explicit hang point. Elite / score / Fan-Out are ignored.
 */
export function evaluateMethodAdmission(input: MethodAdmissionInput): MethodAdmissionDecision {
  const extra = input.protocolVersion === undefined && input.evidenceDigest === undefined
    ? {}
    : {
      ...(input.protocolVersion === undefined ? {} : { protocolVersion: input.protocolVersion }),
      ...(input.evidenceDigest === undefined ? {} : { evidenceDigest: input.evidenceDigest }),
    };

  if (input.validity.hang) {
    return admissionDecision({
      outcome: "inconclusive",
      hang: true,
      objections: input.validity.objections.length > 0
        ? input.validity.objections
        : ["explicit hang point: Admission is inconclusive, not pass"],
      ...extra,
    });
  }

  if (input.validity.outcome === "inconclusive") {
    return admissionDecision({
      outcome: "inconclusive",
      hang: false,
      objections: input.validity.objections.length > 0
        ? input.validity.objections
        : ["inconclusive experiment validity is not Admission pass"],
      ...extra,
    });
  }

  if (!input.validity.ok || !experimentValidityIsPass(input.validity.outcome)) {
    return admissionDecision({
      outcome: "fail",
      objections: input.validity.objections.length > 0
        ? input.validity.objections
        : ["experiment validity did not pass; Admission refused"],
      ...extra,
    });
  }

  const officialSamples = input.slices.officialSamples && input.validity.slices.officialSamples;
  const adversarialLabeled = input.slices.adversarialLabeled && input.validity.slices.adversarialLabeled;
  const protectedHoldout = input.slices.protectedHoldout && input.validity.slices.protectedHoldout;

  if (!protectedHoldout) {
    return admissionDecision({
      outcome: "fail",
      objections: ["protected holdout is required; missing holdout refuses Admission"],
      ...extra,
    });
  }
  if (!officialSamples) {
    return admissionDecision({
      outcome: "fail",
      objections: ["official samples are required for the Admission minimal set"],
      ...extra,
    });
  }
  if (!adversarialLabeled) {
    return admissionDecision({
      outcome: "fail",
      objections: ["adversarial-labeled subset is required for the Admission minimal set"],
      ...extra,
    });
  }

  return admissionDecision({
    outcome: "pass",
    ...extra,
  });
}

function snapshot(state: MethodWritebackState): MethodWritebackState {
  return deepFreeze({
    ...state,
    objections: Object.freeze([...state.objections]),
  });
}

function isOpenPhase(phase: MethodWritebackPhase): boolean {
  return phase === "propose" || phase === "regression";
}

/**
 * In-memory one-slice writeback session. File-body Skills writeback stays
 * unopened on the mission routing shell; this is the method/skill lifecycle
 * slice (propose → regression → admit / rollback).
 */
export class MethodWritebackSession {
  private open: MethodWritebackState | undefined;

  propose(slice: MethodWritebackSlice, previousState: MethodAssetState = "candidate"): MethodWritebackState {
    if (this.open && isOpenPhase(this.open.phase)) {
      throw new MethodWritebackIsolationError("writeback isolation: one slice at a time");
    }
    this.open = snapshot({
      phase: "propose",
      slice,
      previousState,
      currentState: previousState === "accepted" ? "candidate" : previousState,
      admitted: false,
      hang: false,
      objections: [],
    });
    return this.open;
  }

  regress(outcome: ExperimentValidityOutcome): MethodWritebackState {
    if (!this.open || this.open.phase !== "propose") {
      throw new MethodWritebackPhaseError("regression requires an open propose slice");
    }
    if (outcome !== "pass") {
      return this.finishRollback(
        outcome === "inconclusive"
          ? "regression inconclusive is not pass; slice rolled back"
          : "regression fail; slice rolled back",
      );
    }
    this.open = snapshot({ ...this.open, phase: "regression" });
    return this.open;
  }

  admit(admission: MethodAdmissionDecision): MethodWritebackState {
    if (!this.open || this.open.phase !== "regression") {
      throw new MethodWritebackPhaseError("admit requires a regression-pass slice");
    }
    if (admission.hang || admission.outcome === "inconclusive") {
      this.open = snapshot({
        ...this.open,
        phase: "rolled_back",
        currentState: this.open.previousState === "accepted" ? "demoted" : this.open.previousState,
        admitted: false,
        hang: true,
        admission,
        objections: [...admission.objections],
      });
      return this.open;
    }
    if (!admission.ok || !admission.admitted) {
      return this.finishRollback(
        admission.objections[0] ?? "Admission refused; slice rolled back",
        admission,
      );
    }
    this.open = snapshot({
      ...this.open,
      phase: "admitted",
      currentState: "accepted",
      admitted: true,
      hang: false,
      admission,
      objections: [],
    });
    return this.open;
  }

  rollback(): MethodWritebackState {
    if (!this.open) {
      throw new MethodWritebackPhaseError("rollback requires an open slice");
    }
    return this.finishRollback("writeback rollback");
  }

  private finishRollback(reason: string, admission?: MethodAdmissionDecision): MethodWritebackState {
    const previous = this.open?.previousState ?? "candidate";
    const current: MethodAssetState = this.open?.phase === "admitted" ? "demoted" : previous;
    this.open = snapshot({
      phase: "rolled_back",
      slice: this.open!.slice,
      previousState: previous,
      currentState: current,
      admitted: false,
      hang: admission?.hang === true,
      objections: Object.freeze([reason]),
      ...(admission === undefined ? {} : { admission }),
    });
    return this.open;
  }
}
