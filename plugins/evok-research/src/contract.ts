/**
 * Shared Chord contract for the evok-research pilot plugin.
 *
 * Session and TUI facets load independently through this token. The plugin
 * is a seat declaration for 选点 / Harness / SelectionPolicy. It is not
 * Promotion authority, not a second control plane, and does not flip the
 * product default (`fixed_uct` / `#40` off).
 */
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

export const EVOK_RESEARCH_PLUGIN_ID = "evok-research" as const;
export const EVOK_RESEARCH_SEAT_ID = "selection-harness-selection-policy" as const;

export interface EvokResearchSurface {
  readonly id: "selection" | "harness" | "selection-policy";
  readonly pack: string;
  readonly role: string;
}

export interface EvokResearchSeat {
  readonly pluginId: typeof EVOK_RESEARCH_PLUGIN_ID;
  readonly seat: typeof EVOK_RESEARCH_SEAT_ID;
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly defaultSelectionId: "fixed_uct";
  readonly selectionPolicy40: "off";
  readonly progressiveDefault: "off";
  readonly eliteIsPromotion: false;
  readonly surfaces: readonly EvokResearchSurface[];
}

export const EVOK_RESEARCH_SURFACES: readonly EvokResearchSurface[] = Object.freeze([
  { id: "selection", pack: "src/search", role: "parent-selection" },
  { id: "harness", pack: "src/search", role: "search-host" },
  { id: "selection-policy", pack: "src/search", role: "policy-default" },
]);

export const EVOK_RESEARCH_SEAT: EvokResearchSeat = Object.freeze({
  pluginId: EVOK_RESEARCH_PLUGIN_ID,
  seat: EVOK_RESEARCH_SEAT_ID,
  experimental: true,
  changelogOfficialHotPlug: false,
  defaultSelectionId: "fixed_uct",
  selectionPolicy40: "off",
  progressiveDefault: "off",
  eliteIsPromotion: false,
  surfaces: EVOK_RESEARCH_SURFACES,
});

export interface EvokResearch {
  readonly seat: ReplicatedState<EvokResearchSeat>;
  describeSeat(context: Context): Promise<EvokResearchSeat>;
}

export const EvokResearch = defineService<EvokResearch>("evok.research");

export interface EvokResearchCommand {
  readonly name: string;
  readonly description: string;
}

export interface EvokResearchTui {
  listCommands(context: Context): Promise<readonly EvokResearchCommand[]>;
}

/** TUI·CLI smoke registry. Not Pi InteractiveMode authority. */
export const EvokResearchTui = defineService<EvokResearchTui>("evok.research.tui");

export const EVOK_RESEARCH_TUI_COMMANDS: readonly EvokResearchCommand[] = Object.freeze([
  {
    name: "evok-research",
    description:
      "Describe the evok-research 选点 / Harness / SelectionPolicy seat (pilot; default fixed_uct; Progressive opt-in only; not changelog-official Chord hot-plug).",
  },
]);
