/**
 * Thin Pi native TUI launcher (ET-TUI1).
 *
 * Interactive tty foreground starts the SDK `InteractiveMode` so native slash
 * commands (`/model`, `/new`, …) stay on Pi. This module is session assembly
 * only: project cwd + Pi `~/.pi/agent` credentials. It is not a Mission
 * control plane and must not grow an evoK slash-command table.
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
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

export interface NativeTuiLaunch {
  readonly projectRoot: string;
  readonly tier: string;
  readonly modelRuntime?: ModelRuntime;
  readonly model?: Model<Api>;
}

/**
 * Build the SDK runtime factory used by InteractiveMode (and `/new` / `/resume`
 * session replacement). No Mission decisions, no evoK command intercept.
 */
export function createPiNativeTuiRuntimeFactory(launch: NativeTuiLaunch): CreateAgentSessionRuntimeFactory {
  const agentDir = getAgentDir();
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(launch.modelRuntime ? { modelRuntime: launch.modelRuntime } : {}),
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
