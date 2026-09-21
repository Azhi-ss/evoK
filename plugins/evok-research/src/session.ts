/**
 * Session-worker facet: 选点 / Harness / SelectionPolicy seat.
 *
 * Thin declaration only. Parent-selection math stays in `src/search/`.
 * This facet does not mount Progressive, does not flip `fixed_uct`,
 * and is not Promotion / Admission / Broker authority.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_RESEARCH_SEAT, EvokResearch } from "./contract";

export default defineFacet({
  id: "evok-research/session",
  setup(env) {
    const seat = env.replicatedState(EVOK_RESEARCH_SEAT);
    env.provide(EvokResearch, {
      seat,
      async describeSeat(_context: Context) {
        return seat.value;
      },
    });
  },
});
