/**
 * TUI·CLI presentation facet for the evok-eval seat.
 *
 * Registers a smoke command list. Does not own Pi shorts, does not
 * dispatch scoring / Promotion / Broker, and does not claim
 * changelog-official Chord hot-plug. Auto-submit stays fail-closed.
 */
import { type Context, defineFacet } from "@earendil-works/chord";
import { EVOK_EVAL_TUI_COMMANDS, EvokEval, EvokEvalTui } from "./contract";

export default defineFacet({
  id: "evok-eval/tui",
  setup(env) {
    env.use(EvokEval);
    env.provide(EvokEvalTui, {
      async listCommands(_context: Context) {
        return EVOK_EVAL_TUI_COMMANDS;
      },
    });
  },
});
