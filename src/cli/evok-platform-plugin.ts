/**
 * ET-CHORD-SPLIT-PLATFORM / #190 — local pilot loader for `evok-platform`.
 *
 * Declares and loads the Mission / orchestration / TUI·CLI Chord plugin
 * in-process. This is an experimental local path. Pi 0.86.0 / 0.86.1
 * changelogs did not advertise Chord hot-plug; this module does not claim
 * that capability.
 *
 * CLI pack owns the loader. Mission authority stays in `src/mission/`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createFacetHost,
  createStaticFacetLoader,
  type Facet,
  type FacetHost,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  EVOK_PLATFORM_PLUGIN_ID,
  EVOK_PLATFORM_SEAT,
  type EvokPlatformCommand,
  type EvokPlatformSeat,
  EvokPlatform,
  EvokPlatformTui,
} from "../../plugins/evok-platform/src/contract";

export type EvokPlatformFacetSet = "session" | "session+tui";

export interface EvokPlatformPluginDeclaration {
  readonly pluginId: typeof EVOK_PLATFORM_PLUGIN_ID;
  readonly packageName: string;
  readonly packageDir: string;
  readonly seat: EvokPlatformSeat["seat"];
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly facets: {
    readonly session: string;
    readonly tui: string;
  };
  readonly surfaces: EvokPlatformSeat["surfaces"];
}

export interface LoadEvokPlatformPluginOptions {
  readonly repoRoot?: string;
  readonly facets?: EvokPlatformFacetSet;
}

export interface LoadedEvokPlatformPlugin {
  readonly declaration: EvokPlatformPluginDeclaration;
  readonly seat: EvokPlatformSeat;
  readonly tuiCommands: readonly EvokPlatformCommand[];
  dispose(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface ChordFacetManifest {
  readonly name?: unknown;
  readonly chord?: {
    readonly facets?: {
      readonly session?: unknown;
      readonly tui?: unknown;
    };
  };
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function defaultRepoRoot(repoRoot?: string): string {
  return repoRoot ? resolve(repoRoot) : REPO_ROOT;
}

export function declareEvokPlatformPlugin(repoRoot?: string): EvokPlatformPluginDeclaration {
  const packageDir = resolve(defaultRepoRoot(repoRoot), "plugins/evok-platform");
  const raw = readFileSync(join(packageDir, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as ChordFacetManifest;
  const session = pkg.chord?.facets?.session;
  const tui = pkg.chord?.facets?.tui;
  if (pkg.name !== EVOK_PLATFORM_PLUGIN_ID) {
    throw new Error(`evok-platform package name must be ${EVOK_PLATFORM_PLUGIN_ID}`);
  }
  if (typeof session !== "string" || typeof tui !== "string") {
    throw new Error("evok-platform package.json must declare chord.facets.session and chord.facets.tui");
  }
  return {
    pluginId: EVOK_PLATFORM_PLUGIN_ID,
    packageName: EVOK_PLATFORM_PLUGIN_ID,
    packageDir,
    seat: EVOK_PLATFORM_SEAT.seat,
    experimental: true,
    changelogOfficialHotPlug: false,
    facets: {
      session: stripDotSlash(session),
      tui: stripDotSlash(tui),
    },
    surfaces: EVOK_PLATFORM_SEAT.surfaces,
  };
}

async function importDeclaredFacet(packageDir: string, relativePath: string): Promise<Facet> {
  const href = pathToFileURL(resolve(packageDir, relativePath)).href;
  const mod = (await import(href)) as { default?: Facet };
  if (mod.default === undefined || typeof mod.default.setup !== "function" || typeof mod.default.id !== "string") {
    throw new Error(`evok-platform facet ${relativePath} must default-export a Chord facet`);
  }
  return mod.default;
}

async function facetsFor(declaration: EvokPlatformPluginDeclaration, set: EvokPlatformFacetSet): Promise<readonly Facet[]> {
  const session = await importDeclaredFacet(declaration.packageDir, declaration.facets.session);
  if (set === "session") return [session];
  return [session, await importDeclaredFacet(declaration.packageDir, declaration.facets.tui)];
}

export async function loadEvokPlatformPlugin(
  options: LoadEvokPlatformPluginOptions = {},
): Promise<LoadedEvokPlatformPlugin> {
  const declaration = declareEvokPlatformPlugin(options.repoRoot);
  const set = options.facets ?? "session+tui";
  const loader = createStaticFacetLoader(await facetsFor(declaration, set));
  const loaded = await loader.load();
  const host: FacetHost = await createFacetHost({ facets: loaded.facets });
  try {
    const platform = host.services.use(EvokPlatform);
    const seat = await platform.describeSeat(BACKGROUND_CONTEXT);
    const tuiCommands =
      set === "session+tui"
        ? await host.services.use(EvokPlatformTui).listCommands(BACKGROUND_CONTEXT)
        : [];
    return {
      declaration,
      seat,
      tuiCommands,
      async dispose() {
        await host.dispose();
        await loaded.dispose();
      },
    };
  } catch (error) {
    await host.dispose();
    await loaded.dispose();
    throw error;
  }
}
