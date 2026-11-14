/**
 * Unified evoK Pi plugin entry.
 *
 * Exposes the single `evok` extension surface to Pi while preserving the three
 * internal domain seat descriptors (platform, research, eval) and their
 * fail-closed ownership locks without separate pseudo-package directories or
 * dynamic FacetHost loaders.
 */
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
} from "../search/search-selection-port";

export const EVOK_PLUGIN_ID = "evok" as const;

export interface EvokSeatSurface {
  readonly id: string;
  readonly pack: string;
  readonly role: string;
}

export interface EvokPluginCommand {
  readonly name: string;
  readonly description: string;
}

export interface EvokPlatformSeat {
  readonly pluginId: "evok-platform";
  readonly seat: "mission-orchestration-tui-cli";
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly surfaces: readonly EvokSeatSurface[];
}

export interface EvokResearchSeat {
  readonly pluginId: "evok-research";
  readonly seat: "selection-harness-selection-policy";
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly defaultSelectionId: typeof DEFAULT_SEARCH_SELECTION_ID;
  readonly selectionPolicy40: typeof SELECTION_POLICY_40;
  readonly progressiveDefault: "off";
  readonly eliteIsPromotion: false;
  readonly surfaces: readonly EvokSeatSurface[];
}

export interface EvokEvalSeat {
  readonly pluginId: "evok-eval";
  readonly seat: "eval-promotion-broker";
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
  readonly surfaces: readonly EvokSeatSurface[];
}

export interface LoadedEvokSeat<TSeat> {
  readonly seat: TSeat;
  readonly tuiCommands: readonly EvokPluginCommand[];
  dispose(): Promise<void>;
}

export interface LoadEvokPluginOptions {
  readonly repoRoot?: string;
  readonly facets?: "session" | "session+tui";
}

export interface EvokPluginDeclaration {
  readonly pluginId: typeof EVOK_PLUGIN_ID;
  readonly packageName: typeof EVOK_PLUGIN_ID;
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly modules: readonly ["platform", "research", "eval"];
}

export interface LoadedEvokPlugin {
  readonly declaration: EvokPluginDeclaration;
  readonly modules: {
    readonly platform: LoadedEvokSeat<EvokPlatformSeat>;
    readonly research: LoadedEvokSeat<EvokResearchSeat>;
    readonly eval: LoadedEvokSeat<EvokEvalSeat>;
  };
  readonly tuiCommands: readonly EvokPluginCommand[];
  dispose(): Promise<void>;
}

const EVOK_PLATFORM_SEAT: EvokPlatformSeat = Object.freeze({
  pluginId: "evok-platform",
  seat: "mission-orchestration-tui-cli",
  experimental: true,
  changelogOfficialHotPlug: false,
  surfaces: Object.freeze([
    { id: "mission", pack: "src/mission", role: "control-plane" },
    { id: "orchestration", pack: "src/mission", role: "thin-glue" },
    { id: "tui-cli", pack: "src/cli", role: "entry-mirror" },
  ]),
});

const EVOK_RESEARCH_SEAT: EvokResearchSeat = Object.freeze({
  pluginId: "evok-research",
  seat: "selection-harness-selection-policy",
  experimental: true,
  changelogOfficialHotPlug: false,
  defaultSelectionId: DEFAULT_SEARCH_SELECTION_ID,
  selectionPolicy40: SELECTION_POLICY_40,
  progressiveDefault: "off",
  eliteIsPromotion: false,
  surfaces: Object.freeze([
    { id: "selection", pack: "src/search", role: "parent-selection" },
    { id: "harness", pack: "src/search", role: "search-host" },
    { id: "selection-policy", pack: "src/search", role: "policy-default" },
  ]),
});

const EVOK_EVAL_SEAT: EvokEvalSeat = Object.freeze({
  pluginId: "evok-eval",
  seat: "eval-promotion-broker",
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
  surfaces: Object.freeze([
    { id: "eval", pack: "src/competition", role: "scoring-suite-metric" },
    { id: "promotion", pack: "src/evidence", role: "promotion-admission-gates" },
    { id: "broker", pack: "src/evidence", role: "submission-broker" },
  ]),
});

const SEAT_COMMANDS = Object.freeze({
  platform: Object.freeze<readonly EvokPluginCommand[]>([
    {
      name: "evok-platform",
      description:
        "Describe the evok-platform Mission / orchestration / TUI·CLI seat (pilot; not changelog-official Chord hot-plug).",
    },
  ]),
  research: Object.freeze<readonly EvokPluginCommand[]>([
    {
      name: "evok-research",
      description:
        "Describe the evok-research 选点 / Harness / SelectionPolicy seat (pilot; default fixed_uct; Progressive opt-in only; not changelog-official Chord hot-plug).",
    },
  ]),
  eval: Object.freeze<readonly EvokPluginCommand[]>([
    {
      name: "evok-eval",
      description:
        "Describe the evok-eval eval / promotion / Broker seat (pilot; fail-closed; not changelog-official Chord hot-plug).",
    },
  ]),
});

export function declareEvokPlugin(): EvokPluginDeclaration {
  return {
    pluginId: EVOK_PLUGIN_ID,
    packageName: EVOK_PLUGIN_ID,
    experimental: true,
    changelogOfficialHotPlug: false,
    modules: ["platform", "research", "eval"],
  };
}

export async function loadEvokPlugin(options: LoadEvokPluginOptions = {}): Promise<LoadedEvokPlugin> {
  const includeTui = (options.facets ?? "session+tui") === "session+tui";
  const noopDispose = async () => {};
  const platform: LoadedEvokSeat<EvokPlatformSeat> = {
    seat: EVOK_PLATFORM_SEAT,
    tuiCommands: includeTui ? SEAT_COMMANDS.platform : [],
    dispose: noopDispose,
  };
  const research: LoadedEvokSeat<EvokResearchSeat> = {
    seat: EVOK_RESEARCH_SEAT,
    tuiCommands: includeTui ? SEAT_COMMANDS.research : [],
    dispose: noopDispose,
  };
  const evalPlugin: LoadedEvokSeat<EvokEvalSeat> = {
    seat: EVOK_EVAL_SEAT,
    tuiCommands: includeTui ? SEAT_COMMANDS.eval : [],
    dispose: noopDispose,
  };
  return {
    declaration: declareEvokPlugin(),
    modules: { platform, research, eval: evalPlugin },
    tuiCommands: [...platform.tuiCommands, ...research.tuiCommands, ...evalPlugin.tuiCommands],
    dispose: noopDispose,
  };
}

export function formatEvokPluginStatus(plugin: LoadedEvokPlugin): string {
  const { platform, research, eval: evalPlugin } = plugin.modules;
  return [
    "evok plugin loaded",
    `  platform: ${platform.seat.seat}`,
    `  research: ${research.seat.seat} (selection=${research.seat.defaultSelectionId})`,
    `  eval: ${evalPlugin.seat.seat} (failClosed=${evalPlugin.seat.failClosed})`,
  ].join("\n");
}
