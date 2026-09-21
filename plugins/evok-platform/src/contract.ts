/**
 * Shared Chord contract for the evok-platform pilot plugin.
 *
 * Session and TUI facets load independently through this token. The plugin
 * is a seat declaration, not Mission authority and not a second control plane.
 */
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";

export const EVOK_PLATFORM_PLUGIN_ID = "evok-platform" as const;
export const EVOK_PLATFORM_SEAT_ID = "mission-orchestration-tui-cli" as const;

export interface EvokPlatformSurface {
  readonly id: "mission" | "orchestration" | "tui-cli";
  readonly pack: string;
  readonly role: string;
}

export interface EvokPlatformSeat {
  readonly pluginId: typeof EVOK_PLATFORM_PLUGIN_ID;
  readonly seat: typeof EVOK_PLATFORM_SEAT_ID;
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly surfaces: readonly EvokPlatformSurface[];
}

export const EVOK_PLATFORM_SURFACES: readonly EvokPlatformSurface[] = Object.freeze([
  { id: "mission", pack: "src/mission", role: "control-plane" },
  { id: "orchestration", pack: "src/mission", role: "thin-glue" },
  { id: "tui-cli", pack: "src/cli", role: "entry-mirror" },
]);

export const EVOK_PLATFORM_SEAT: EvokPlatformSeat = Object.freeze({
  pluginId: EVOK_PLATFORM_PLUGIN_ID,
  seat: EVOK_PLATFORM_SEAT_ID,
  experimental: true,
  changelogOfficialHotPlug: false,
  surfaces: EVOK_PLATFORM_SURFACES,
});

export interface EvokPlatform {
  readonly seat: ReplicatedState<EvokPlatformSeat>;
  describeSeat(context: Context): Promise<EvokPlatformSeat>;
}

export const EvokPlatform = defineService<EvokPlatform>("evok.platform");

export interface EvokPlatformCommand {
  readonly name: string;
  readonly description: string;
}

export interface EvokPlatformTui {
  listCommands(context: Context): Promise<readonly EvokPlatformCommand[]>;
}

/** TUI·CLI smoke registry. Not Pi InteractiveMode authority. */
export const EvokPlatformTui = defineService<EvokPlatformTui>("evok.platform.tui");

export const EVOK_PLATFORM_TUI_COMMANDS: readonly EvokPlatformCommand[] = Object.freeze([
  {
    name: "evok-platform",
    description:
      "Describe the evok-platform Mission / orchestration / TUI·CLI seat (pilot; not changelog-official Chord hot-plug).",
  },
]);
