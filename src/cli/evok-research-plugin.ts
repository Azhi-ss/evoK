/**
 * ET-CHORD-SPLIT-RESEARCH / #191 — local pilot loader for `evok-research`.
 *
 * Declares and loads the 选点 / Harness / SelectionPolicy Chord plugin
 * in-process. This is an experimental local path. Pi 0.86.0 / 0.86.1
 * changelogs did not advertise Chord hot-plug; this module does not claim
 * that capability.
 *
 * CLI pack owns the loader. Search authority stays in `src/search/`.
 * Product default remains `fixed_uct`; `#40` Progressive stays explicit
 * opt-in only. Elite ≠ Promotion.
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
  EVOK_RESEARCH_PLUGIN_ID,
  EVOK_RESEARCH_SEAT,
  type EvokResearchCommand,
  type EvokResearchSeat,
  EvokResearch,
  EvokResearchTui,
} from "../../plugins/evok-research/src/contract";

export type EvokResearchFacetSet = "session" | "session+tui";

export interface EvokResearchPluginDeclaration {
  readonly pluginId: typeof EVOK_RESEARCH_PLUGIN_ID;
  readonly packageName: string;
  readonly packageDir: string;
  readonly seat: EvokResearchSeat["seat"];
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly defaultSelectionId: EvokResearchSeat["defaultSelectionId"];
  readonly selectionPolicy40: EvokResearchSeat["selectionPolicy40"];
  readonly progressiveDefault: EvokResearchSeat["progressiveDefault"];
  readonly eliteIsPromotion: EvokResearchSeat["eliteIsPromotion"];
  readonly facets: {
    readonly session: string;
    readonly tui: string;
  };
  readonly surfaces: EvokResearchSeat["surfaces"];
}

export interface LoadEvokResearchPluginOptions {
  readonly repoRoot?: string;
  readonly facets?: EvokResearchFacetSet;
}

export interface LoadedEvokResearchPlugin {
  readonly declaration: EvokResearchPluginDeclaration;
  readonly seat: EvokResearchSeat;
  readonly tuiCommands: readonly EvokResearchCommand[];
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

export function declareEvokResearchPlugin(repoRoot?: string): EvokResearchPluginDeclaration {
  const packageDir = resolve(defaultRepoRoot(repoRoot), "plugins/evok-research");
  const raw = readFileSync(join(packageDir, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as ChordFacetManifest;
  const session = pkg.chord?.facets?.session;
  const tui = pkg.chord?.facets?.tui;
  if (pkg.name !== EVOK_RESEARCH_PLUGIN_ID) {
    throw new Error(`evok-research package name must be ${EVOK_RESEARCH_PLUGIN_ID}`);
  }
  if (typeof session !== "string" || typeof tui !== "string") {
    throw new Error("evok-research package.json must declare chord.facets.session and chord.facets.tui");
  }
  return {
    pluginId: EVOK_RESEARCH_PLUGIN_ID,
    packageName: EVOK_RESEARCH_PLUGIN_ID,
    packageDir,
    seat: EVOK_RESEARCH_SEAT.seat,
    experimental: true,
    changelogOfficialHotPlug: false,
    defaultSelectionId: EVOK_RESEARCH_SEAT.defaultSelectionId,
    selectionPolicy40: EVOK_RESEARCH_SEAT.selectionPolicy40,
    progressiveDefault: EVOK_RESEARCH_SEAT.progressiveDefault,
    eliteIsPromotion: EVOK_RESEARCH_SEAT.eliteIsPromotion,
    facets: {
      session: stripDotSlash(session),
      tui: stripDotSlash(tui),
    },
    surfaces: EVOK_RESEARCH_SEAT.surfaces,
  };
}

async function importDeclaredFacet(packageDir: string, relativePath: string): Promise<Facet> {
  const href = pathToFileURL(resolve(packageDir, relativePath)).href;
  const mod = (await import(href)) as { default?: Facet };
  if (mod.default === undefined || typeof mod.default.setup !== "function" || typeof mod.default.id !== "string") {
    throw new Error(`evok-research facet ${relativePath} must default-export a Chord facet`);
  }
  return mod.default;
}

async function facetsFor(declaration: EvokResearchPluginDeclaration, set: EvokResearchFacetSet): Promise<readonly Facet[]> {
  const session = await importDeclaredFacet(declaration.packageDir, declaration.facets.session);
  if (set === "session") return [session];
  return [session, await importDeclaredFacet(declaration.packageDir, declaration.facets.tui)];
}

export async function loadEvokResearchPlugin(
  options: LoadEvokResearchPluginOptions = {},
): Promise<LoadedEvokResearchPlugin> {
  const declaration = declareEvokResearchPlugin(options.repoRoot);
  const set = options.facets ?? "session+tui";
  const loader = createStaticFacetLoader(await facetsFor(declaration, set));
  const loaded = await loader.load();
  const host: FacetHost = await createFacetHost({ facets: loaded.facets });
  try {
    const research = host.services.use(EvokResearch);
    const seat = await research.describeSeat(BACKGROUND_CONTEXT);
    const tuiCommands =
      set === "session+tui"
        ? await host.services.use(EvokResearchTui).listCommands(BACKGROUND_CONTEXT)
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
