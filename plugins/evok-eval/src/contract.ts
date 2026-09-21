/**
 * Shared Chord contract for the evok-eval pilot plugin.
 *
 * Session and TUI facets load independently through this token. The plugin
 * is a seat declaration for eval / promotion / Broker. It is not a second
 * control plane, does not widen Admission / Budget / hang / T48 / Broker
 * predicates, and does not thaw fail-closed auto-submit. Elite ≠ Promotion.
 */
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

export const EVOK_EVAL_PLUGIN_ID = "evok-eval" as const;
export const EVOK_EVAL_SEAT_ID = "eval-promotion-broker" as const;

export interface EvokEvalSurface {
  readonly id: "eval" | "promotion" | "broker";
  readonly pack: string;
  readonly role: string;
}

export interface EvokEvalSeat {
  readonly pluginId: typeof EVOK_EVAL_PLUGIN_ID;
  readonly seat: typeof EVOK_EVAL_SEAT_ID;
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly failClosed: true;
  readonly admissionNoWiden: true;
  readonly budgetNoWiden: true;
  readonly hangNoWiden: true;
  readonly t48NoWiden: true;
  readonly brokerNoWiden: true;
  readonly autoSubmitFailClosed: true;
  readonly eliteIsPromotion: false;
  readonly surfaces: readonly EvokEvalSurface[];
}

export const EVOK_EVAL_SURFACES: readonly EvokEvalSurface[] = Object.freeze([
  { id: "eval", pack: "src/competition", role: "scoring-suite-metric" },
  // Evidence pack owns both; Promotion ≠ Admission (CONTEXT.md).
  { id: "promotion", pack: "src/evidence", role: "promotion-admission-gates" },
  { id: "broker", pack: "src/evidence", role: "submission-broker" },
]);

export const EVOK_EVAL_SEAT: EvokEvalSeat = Object.freeze({
  pluginId: EVOK_EVAL_PLUGIN_ID,
  seat: EVOK_EVAL_SEAT_ID,
  experimental: true,
  changelogOfficialHotPlug: false,
  failClosed: true,
  admissionNoWiden: true,
  budgetNoWiden: true,
  hangNoWiden: true,
  t48NoWiden: true,
  brokerNoWiden: true,
  autoSubmitFailClosed: true,
  eliteIsPromotion: false,
  surfaces: EVOK_EVAL_SURFACES,
});

export interface EvokEval {
  readonly seat: ReplicatedState<EvokEvalSeat>;
  describeSeat(context: Context): Promise<EvokEvalSeat>;
}

export const EvokEval = defineService<EvokEval>("evok.eval");

export interface EvokEvalCommand {
  readonly name: string;
  readonly description: string;
}

export interface EvokEvalTui {
  listCommands(context: Context): Promise<readonly EvokEvalCommand[]>;
}

/** TUI·CLI smoke registry. Not Pi InteractiveMode authority. */
export const EvokEvalTui = defineService<EvokEvalTui>("evok.eval.tui");

export const EVOK_EVAL_TUI_COMMANDS: readonly EvokEvalCommand[] = Object.freeze([
  {
    name: "evok-eval",
    description:
      "Describe the evok-eval eval / promotion / Broker seat (pilot; fail-closed; not changelog-official Chord hot-plug).",
  },
]);
