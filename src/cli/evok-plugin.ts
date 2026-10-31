/**
 * Unified evoK Pi plugin entry.
 *
 * The product exposes one `evok` plugin to Pi. Its domain seats stay split
 * internally so Mission/orchestration, search/research, and evaluation/broker
 * keep their existing ownership and fail-closed contracts.
 */
import {
  loadEvokEvalPlugin,
  type LoadEvokEvalPluginOptions,
  type LoadedEvokEvalPlugin,
} from "./evok-eval-plugin";
import {
  loadEvokPlatformPlugin,
  type LoadEvokPlatformPluginOptions,
  type LoadedEvokPlatformPlugin,
} from "./evok-platform-plugin";
import {
  loadEvokResearchPlugin,
  type LoadEvokResearchPluginOptions,
  type LoadedEvokResearchPlugin,
} from "./evok-research-plugin";

export const EVOK_PLUGIN_ID = "evok" as const;

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
    readonly platform: LoadedEvokPlatformPlugin;
    readonly research: LoadedEvokResearchPlugin;
    readonly eval: LoadedEvokEvalPlugin;
  };
  readonly tuiCommands: readonly (
    | LoadedEvokPlatformPlugin["tuiCommands"][number]
    | LoadedEvokResearchPlugin["tuiCommands"][number]
    | LoadedEvokEvalPlugin["tuiCommands"][number]
  )[];
  dispose(): Promise<void>;
}

export function declareEvokPlugin(): EvokPluginDeclaration {
  return {
    pluginId: EVOK_PLUGIN_ID,
    packageName: EVOK_PLUGIN_ID,
    experimental: true,
    changelogOfficialHotPlug: false,
    modules: ["platform", "research", "eval"],
  };
}

function childOptions(options: LoadEvokPluginOptions): {
  repoRoot?: string;
  facets?: "session" | "session+tui";
} {
  return {
    repoRoot: options.repoRoot,
    facets: options.facets,
  };
}

export async function loadEvokPlugin(options: LoadEvokPluginOptions = {}): Promise<LoadedEvokPlugin> {
  const common = childOptions(options);
  const loaded: Array<{ dispose(): Promise<void> }> = [];
  try {
    const platform = await loadEvokPlatformPlugin(common satisfies LoadEvokPlatformPluginOptions);
    loaded.push(platform);
    const research = await loadEvokResearchPlugin(common satisfies LoadEvokResearchPluginOptions);
    loaded.push(research);
    const evalPlugin = await loadEvokEvalPlugin(common satisfies LoadEvokEvalPluginOptions);
    loaded.push(evalPlugin);

    return {
      declaration: declareEvokPlugin(),
      modules: { platform, research, eval: evalPlugin },
      tuiCommands: [
        ...platform.tuiCommands,
        ...research.tuiCommands,
        ...evalPlugin.tuiCommands,
      ],
      async dispose() {
        let firstError: unknown;
        for (const child of [...loaded].reverse()) {
          try {
            await child.dispose();
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError !== undefined) throw firstError;
      },
    };
  } catch (error) {
    for (const child of [...loaded].reverse()) {
      try {
        await child.dispose();
      } catch {
        // Preserve the original load failure.
      }
    }
    throw error;
  }
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
