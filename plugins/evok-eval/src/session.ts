/**
 * Session-worker facet: eval / promotion / Broker seat.
 *
 * Thin declaration only. Scoring stays in `src/competition/`. Promotion,
 * Admission, Budget, hang, T48, and SubmissionBroker stay in `src/evidence/`.
 * This facet does not widen predicates, does not thaw auto-submit, and
 * is not Elite / Fan-Out Promotion authority.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_EVAL_SEAT, EvokEval } from "./contract";

export default defineFacet({
  id: "evok-eval/session",
  setup(env) {
    const seat = env.replicatedState(EVOK_EVAL_SEAT);
    env.provide(EvokEval, {
      seat,
      async describeSeat(_context: Context) {
        return seat.value;
      },
    });
  },
});
