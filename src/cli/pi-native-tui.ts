/**
 * Thin Pi native TUI launcher (ET-TUI1 + ET-TUI-MIRROR).
 *
 * Interactive tty foreground starts the SDK `InteractiveMode` so native slash
 * commands (`/model`, `/new`, `/resume`, …) stay on Pi. evoK mirror commands
 * are registered via an inline extension factory; they dispatch through the
 * same CLI `runEvok` path. This module is session assembly, not a second
 * Mission control plane.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
  type InlineExtension,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

export interface NativeTuiLaunch {
  readonly projectRoot: string;
  readonly tier: string;
  readonly modelRuntime?: ModelRuntime;
  readonly model?: Model<Api>;
  /** Inline evoK mirror extension (Pi shorts are never registered). */
  readonly mirrorExtension?: InlineExtension;
}

/**
 * Build the SDK runtime factory used by InteractiveMode (and `/new` / `/resume`
 * session replacement). No Mission decisions, no evoK command intercept.
 */
function createPiNativeTuiRuntimeFactory(launch: NativeTuiLaunch): CreateAgentSessionRuntimeFactory {
  const agentDir = getAgentDir();
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(launch.modelRuntime ? { modelRuntime: launch.modelRuntime } : {}),
      ...(launch.mirrorExtension
        ? { resourceLoaderOptions: { extensionFactories: [launch.mirrorExtension] } }
        : {}),
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        ...(launch.model ? { model: launch.model } : {}),
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}

export async function launchPiNativeTui(launch: NativeTuiLaunch): Promise<void> {
  const agentDir = getAgentDir();
  const runtime = await createAgentSessionRuntime(createPiNativeTuiRuntimeFactory(launch), {
    cwd: launch.projectRoot,
    agentDir,
    sessionManager: SessionManager.create(launch.projectRoot),
  });
  try {
    const mode = new InteractiveMode(runtime, {
      migratedProviders: [],
      modelFallbackMessage: undefined,
      initialImages: [],
      initialMessages: [],
    });
    await mode.run();
  } finally {
    await runtime.dispose();
  }
}
