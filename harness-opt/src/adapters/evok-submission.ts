import {
  evaluateContestAutoSubmitGates,
  type ContestAutoSubmitInput,
} from "../../../src/evidence/contest-auto-submit";

/**
 * Optional consult of evoK's contest auto-submit gates
 * (`evaluateContestAutoSubmitGates` in `src/evidence/contest-auto-submit.ts`,
 * described in `docs/contest-auto-submit.md`).
 *
 * Missing promotion / hang / T48 / admission / budget inputs fail closed.
 * This adapter does not loosen those predicates and does not call a live
 * destination. The harness-opt evidence gate treats a red consult as a
 * refused check; it never turns a red evoK gate into a submit.
 */
export function consultEvokContestGates(input: ContestAutoSubmitInput = {}): {
  readonly ok: boolean;
  readonly refusedGateIds: readonly string[];
} {
  const decision = evaluateContestAutoSubmitGates(input);
  return {
    ok: decision.ok,
    refusedGateIds: decision.refusedGates.map((gate) => gate.id),
  };
}
