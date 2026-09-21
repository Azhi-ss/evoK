/**
 * TUI·CLI presentation facet for the evok-platform seat.
 *
 * Registers a smoke command list. Does not own Pi shorts, does not dispatch
 * Mission decisions, and does not claim changelog-official Chord hot-plug.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_PLATFORM_TUI_COMMANDS, EvokPlatform, EvokPlatformTui } from "./contract";

export default defineFacet({
  id: "evok-platform/tui",
  setup(env) {
    env.use(EvokPlatform);
    env.provide(EvokPlatformTui, {
      async listCommands(_context: Context) {
        return EVOK_PLATFORM_TUI_COMMANDS;
      },
    });
  },
});
