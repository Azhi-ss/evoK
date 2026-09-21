/**
 * Session-worker facet: Mission / orchestration seat.
 *
 * Thin declaration only. Authorize / continue / repair / stop stay in
 * `src/mission/`. This facet does not open a second control plane.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_PLATFORM_SEAT, EvokPlatform } from "./contract";

export default defineFacet({
  id: "evok-platform/session",
  setup(env) {
    const seat = env.replicatedState(EVOK_PLATFORM_SEAT);
    env.provide(EvokPlatform, {
      seat,
      async describeSeat(_context: Context) {
        return seat.value;
      },
    });
  },
});
