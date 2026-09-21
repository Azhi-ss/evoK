/**
 * ET-CHORD-SPLIT-EVAL / #192 — local pilot loader for `evok-eval`.
 *
 * Declares and loads the eval / promotion / Broker Chord plugin
 * in-process. This is an experimental local path. Pi 0.86.0 / 0.86.1
 * changelogs did not advertise Chord hot-plug; this module does not claim
 * that capability.
 *
 * CLI pack owns the loader. Scoring stays in `src/competition/`.
 * Promotion / Admission / Budget / hang / T48 / Broker stay in
 * `src/evidence/`. Auto-submit remains fail-closed. Elite ≠ Promotion.
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
  EVOK_EVAL_PLUGIN_ID,
  EVOK_EVAL_SEAT,
  type EvokEvalCommand,
  type EvokEvalSeat,
  EvokEval,
  EvokEvalTui,
} from "../../plugins/evok-eval/src/contract";

export type EvokEvalFacetSet = "session" | "session+tui";

export interface EvokEvalPluginDeclaration {
  readonly pluginId: typeof EVOK_EVAL_PLUGIN_ID;
  readonly packageName: string;
  readonly packageDir: string;
  readonly seat: EvokEvalSeat["seat"];
  readonly experimental: true;
  readonly changelogOfficialHotPlug: false;
  readonly failClosed: EvokEvalSeat["failClosed"];
  readonly admissionNoWiden: EvokEvalSeat["admissionNoWiden"];
  readonly budgetNoWiden: EvokEvalSeat["budgetNoWiden"];
  readonly hangNoWiden: EvokEvalSeat["hangNoWiden"];
  readonly t48NoWiden: EvokEvalSeat["t48NoWiden"];
  readonly brokerNoWiden: EvokEvalSeat["brokerNoWiden"];
  readonly autoSubmitFailClosed: EvokEvalSeat["autoSubmitFailClosed"];
  readonly eliteIsPromotion: EvokEvalSeat["eliteIsPromotion"];
  readonly facets: {
    readonly session: string;
    readonly tui: string;
  };
  readonly surfaces: EvokEvalSeat["surfaces"];
}

export interface LoadEvokEvalPluginOptions {
  readonly repoRoot?: string;
  readonly facets?: EvokEvalFacetSet;
}

export interface LoadedEvokEvalPlugin {
  readonly declaration: EvokEvalPluginDeclaration;
  readonly seat: EvokEvalSeat;
  readonly tuiCommands: readonly EvokEvalCommand[];
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

export function declareEvokEvalPlugin(repoRoot?: string): EvokEvalPluginDeclaration {
  const packageDir = resolve(defaultRepoRoot(repoRoot), "plugins/evok-eval");
  const raw = readFileSync(join(packageDir, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as ChordFacetManifest;
  const session = pkg.chord?.facets?.session;
  const tui = pkg.chord?.facets?.tui;
  if (pkg.name !== EVOK_EVAL_PLUGIN_ID) {
    throw new Error(`evok-eval package name must be ${EVOK_EVAL_PLUGIN_ID}`);
  }
  if (typeof session !== "string" || typeof tui !== "string") {
    throw new Error("evok-eval package.json must declare chord.facets.session and chord.facets.tui");
  }
  return {
    pluginId: EVOK_EVAL_PLUGIN_ID,
    packageName: EVOK_EVAL_PLUGIN_ID,
    packageDir,
    seat: EVOK_EVAL_SEAT.seat,
    experimental: true,
    changelogOfficialHotPlug: false,
    failClosed: EVOK_EVAL_SEAT.failClosed,
    admissionNoWiden: EVOK_EVAL_SEAT.admissionNoWiden,
    budgetNoWiden: EVOK_EVAL_SEAT.budgetNoWiden,
    hangNoWiden: EVOK_EVAL_SEAT.hangNoWiden,
    t48NoWiden: EVOK_EVAL_SEAT.t48NoWiden,
    brokerNoWiden: EVOK_EVAL_SEAT.brokerNoWiden,
    autoSubmitFailClosed: EVOK_EVAL_SEAT.autoSubmitFailClosed,
    eliteIsPromotion: EVOK_EVAL_SEAT.eliteIsPromotion,
    facets: {
      session: stripDotSlash(session),
      tui: stripDotSlash(tui),
    },
    surfaces: EVOK_EVAL_SEAT.surfaces,
  };
}

async function importDeclaredFacet(packageDir: string, relativePath: string): Promise<Facet> {
  const href = pathToFileURL(resolve(packageDir, relativePath)).href;
  const mod = (await import(href)) as { default?: Facet };
  if (mod.default === undefined || typeof mod.default.setup !== "function" || typeof mod.default.id !== "string") {
    throw new Error(`evok-eval facet ${relativePath} must default-export a Chord facet`);
  }
  return mod.default;
}

async function facetsFor(declaration: EvokEvalPluginDeclaration, set: EvokEvalFacetSet): Promise<readonly Facet[]> {
  const session = await importDeclaredFacet(declaration.packageDir, declaration.facets.session);
  if (set === "session") return [session];
  return [session, await importDeclaredFacet(declaration.packageDir, declaration.facets.tui)];
}

export async function loadEvokEvalPlugin(
  options: LoadEvokEvalPluginOptions = {},
): Promise<LoadedEvokEvalPlugin> {
  const declaration = declareEvokEvalPlugin(options.repoRoot);
  const set = options.facets ?? "session+tui";
  const loader = createStaticFacetLoader(await facetsFor(declaration, set));
  const loaded = await loader.load();
  const host: FacetHost = await createFacetHost({ facets: loaded.facets });
  try {
    const evalSeat = host.services.use(EvokEval);
    const seat = await evalSeat.describeSeat(BACKGROUND_CONTEXT);
    const tuiCommands =
      set === "session+tui"
        ? await host.services.use(EvokEvalTui).listCommands(BACKGROUND_CONTEXT)
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
