/**
 * The single user-facing Pi extension for evoK.
 *
 * Domain modules remain in src/cli/evok-plugin.ts and are loaded together
 * behind this entry. The extension exposes one `/evok` command; the domain
 * seats do not become separate Pi extensions or slash-command namespaces.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatEvokPluginStatus, loadEvokPlugin, type LoadedEvokPlugin } from "../src/cli/evok-plugin";

import { registerCampaignDirector, type PiCampaignHost } from "../src/cli/pi-campaign-director";

export async function registerEvokExtension(
  pi: ExtensionAPI, campaign?: PiCampaignHost,
  renderStatus: (state: unknown) => string = state => JSON.stringify(state, null, 2),
): Promise<void> {
  if (campaign) registerCampaignDirector(pi, campaign);
  let plugin: LoadedEvokPlugin | undefined;
  let loadError: unknown;

  try {
    plugin = await loadEvokPlugin({ facets: "session+tui" });
  } catch (error) {
    loadError = error;
  }

  pi.registerCommand("evok", {
    description: "Show evoK status and internal platform/research/eval modules",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (campaign && (command === "" || command === "status")) {
        ctx.ui.notify(renderStatus(await campaign.status()), "info");
        return;
      }
      if (loadError !== undefined) {
        ctx.ui.notify(`evoK plugin failed to load: ${loadError instanceof Error ? loadError.message : String(loadError)}`, "error");
        return;
      }
      if (!plugin) {
        ctx.ui.notify("evoK plugin is not loaded", "error");
        return;
      }
      if (command !== "" && command !== "status") {
        ctx.ui.notify("Usage: /evok [status]", "warning");
        return;
      }
      ctx.ui.notify(formatEvokPluginStatus(plugin), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    if (!plugin) return;
    await plugin.dispose();
    plugin = undefined;
  });
}

export default (pi: ExtensionAPI) => registerEvokExtension(pi);
