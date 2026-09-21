/**
 * TUI·CLI presentation facet for the evok-research seat.
 *
 * Registers a smoke command list. Does not own Pi shorts, does not
 * dispatch parent selection, and does not claim changelog-official
 * Chord hot-plug. Progressive remains explicit opt-in only.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_RESEARCH_TUI_COMMANDS, EvokResearch, EvokResearchTui } from "./contract";

export default defineFacet({
  id: "evok-research/tui",
  setup(env) {
    env.use(EvokResearch);
    env.provide(EvokResearchTui, {
      async listCommands(_context: Context) {
        return EVOK_RESEARCH_TUI_COMMANDS;
      },
    });
  },
});
