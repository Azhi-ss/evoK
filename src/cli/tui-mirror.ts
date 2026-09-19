/**
 * ET-TUI-MIRROR / #148 — Pi native TUI mirrors CLI capabilities.
 *
 * TUI is an entry mirror, not a second control plane. Dispatch reuses
 * `runEvok` so missing evaluation / unauthorized / over-budget refusals
 * stay identical to CLI. Pi keeps its native shorts (`/model`, `/new`,
 * `/resume`, …). Mission resume is `/mission-resume` (or `/evok-resume`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EvokRunOptions, ParsedEvokArgs } from "./evok-cli";

/** Pi InteractiveMode builtins — evoK never registers these names. */
export const PI_OWNED_SHORT_NAMES = [
  "settings",
  "model",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
] as const;

export type PiOwnedShortName = (typeof PI_OWNED_SHORT_NAMES)[number];

const PI_OWNED = new Set<string>(PI_OWNED_SHORT_NAMES);

export type TuiMirrorAction =
  | "skills"
  | "skill"
  | "research"
  | "missions"
  | "intake"
  | "start"
  | "mission-resume";

export type TuiMirrorGate =
  | "readonly"
  | "authorize-continue"
  | "intake-draft"
  | "evaluation-authorize-budget"
  | "authorize-resume";

export interface TuiMirrorCommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly action: TuiMirrorAction;
  readonly cliEquivalent: string;
  readonly gate: TuiMirrorGate;
  readonly description: string;
}

export const EVOK_TUI_MIRROR_COMMANDS: readonly TuiMirrorCommandSpec[] = Object.freeze([
  {
    name: "skills",
    aliases: Object.freeze(["evok-skills"]),
    action: "skills",
    cliEquivalent: "evok /skills",
    gate: "readonly",
    description: "List evoK Skills directory (L0). Read-only; not authorization.",
  },
  {
    name: "skill",
    aliases: Object.freeze(["evok-skill"]),
    action: "skill",
    cliEquivalent: "evok /skill <name>",
    gate: "readonly",
    description: "Disclose L1 SKILL.md for a catalog name. Not authorization.",
  },
  {
    name: "research",
    aliases: Object.freeze([]),
    action: "research",
    cliEquivalent: "evok /research status|continue",
    gate: "authorize-continue",
    description: "Mission /research status (read-only) or one authorized continue.",
  },
  {
    name: "missions",
    aliases: Object.freeze(["evok-missions"]),
    action: "missions",
    cliEquivalent: "evok --missions",
    gate: "readonly",
    description: "List unfinished Missions. Read-only; does not resume.",
  },
  {
    name: "intake",
    aliases: Object.freeze(["mission-intake", "evok-intake"]),
    action: "intake",
    cliEquivalent: "evok --intake <request>",
    gate: "intake-draft",
    description: "Produce a Mission draft. Does not dispatch.",
  },
  {
    name: "start",
    aliases: Object.freeze(["evok-start"]),
    action: "start",
    cliEquivalent: "evok --start / evok /start",
    gate: "evaluation-authorize-budget",
    description: "Start the authorized baseline. Same evaluation / auth / budget refuse as CLI.",
  },
  {
    name: "mission-resume",
    aliases: Object.freeze(["evok-resume"]),
    action: "mission-resume",
    cliEquivalent: "evok --resume / evok /resume",
    gate: "authorize-resume",
    description: "Resume an unfinished Mission. Pi /resume stays on Pi.",
  },
]);

export function formatTuiConflictTable(): string {
  return [
    "TUI slash conflict resolution (Pi owns Pi shorts; Mission uses /mission-* or evok prefix):",
    "  /model /new /resume /settings …  → Pi InteractiveMode (evoK does not intercept)",
    "  /skills or /evok-skills          → evok /skills (read-only directory)",
    "  /skill <name>                    → evok /skill <name> (L1 disclose; catalog only)",
    "  /research status|continue        → evok /research (continue needs authorization)",
    "  /missions                        → evok --missions",
    "  /intake or /mission-intake       → evok --intake (draft only; no dispatch)",
    "  /start                           → evok --start (evaluation + authorize + budget)",
    "  /mission-resume or /evok-resume  → evok --resume (NOT Pi /resume)",
    "Gates are not diluted: missing evaluation / unauthorized / over-budget refuse as CLI.",
  ].join("\n");
}

export type TuiMirrorParseResult =
  | { readonly kind: "mirror"; readonly command: TuiMirrorCommandSpec; readonly args: string; readonly argv: string[] }
  | { readonly kind: "pi-owned"; readonly name: string };

function tokenizeSlash(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

function findMirrorCommand(name: string): TuiMirrorCommandSpec | undefined {
  const key = name.toLowerCase();
  return EVOK_TUI_MIRROR_COMMANDS.find((entry) => entry.name === key || entry.aliases.includes(key));
}

export function parseTuiMirrorInput(text: string): TuiMirrorParseResult | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const argv = tokenizeSlash(trimmed);
  const raw = argv[0];
  if (!raw || !raw.startsWith("/")) return undefined;
  const name = raw.slice(1).toLowerCase();
  if (PI_OWNED.has(name)) return { kind: "pi-owned", name };
  const command = findMirrorCommand(name);
  if (!command) return undefined;
  return { kind: "mirror", command, args: argv.slice(1).join(" "), argv };
}

export interface TuiMirrorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecuteTuiMirrorOptions {
  readonly input: string;
  readonly projectRoot: string;
  readonly tier?: string;
  readonly createResolver?: EvokRunOptions["createResolver"];
  readonly startRunner?: EvokRunOptions["startRunner"];
  readonly resumeRunner?: EvokRunOptions["resumeRunner"];
  readonly intakeRunner?: EvokRunOptions["intakeRunner"];
  readonly evaluator?: EvokRunOptions["evaluator"];
  readonly director?: EvokRunOptions["director"];
  readonly signal?: AbortSignal;
}

class CollectStream {
  private chunks: string[] = [];
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

export async function executeTuiMirrorCommand(options: ExecuteTuiMirrorOptions): Promise<TuiMirrorResult> {
  const { EVOK_EXIT, parseEvokArgs, runEvok } = await import("./evok-cli");
  const parsed = parseTuiMirrorInput(options.input);
  if (parsed?.kind === "pi-owned") {
    const stderr = `evok: /${parsed.name} is a Pi native slash; Mission resume is /mission-resume (or /evok-resume). Pi owns Pi shorts.\n`;
    return { exitCode: EVOK_EXIT.usage, stdout: "", stderr };
  }
  if (!parsed) {
    return {
      exitCode: EVOK_EXIT.usage,
      stdout: "",
      stderr: `evok: unknown TUI mirror command: ${options.input}\n`,
    };
  }
  const args: ParsedEvokArgs = {
    ...parseEvokArgs(parsed.argv),
    project: options.projectRoot,
    ...(options.tier ? { tier: options.tier } : {}),
  };
  const stdout = new CollectStream();
  const stderr = new CollectStream();
  const exitCode = await runEvok({
    args,
    createResolver: options.createResolver ?? (async () => {
      throw new Error("TUI mirror has no model resolver bound");
    }),
    isTty: () => true,
    launchNativeTui: async () => {
      throw new Error("TUI mirror dispatch must not nest InteractiveMode");
    },
    stdout,
    stderr,
    ...(options.startRunner ? { startRunner: options.startRunner } : {}),
    ...(options.resumeRunner ? { resumeRunner: options.resumeRunner } : {}),
    ...(options.intakeRunner ? { intakeRunner: options.intakeRunner } : {}),
    ...(options.evaluator ? { evaluator: options.evaluator } : {}),
    ...(options.director ? { director: options.director } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

export interface TuiMirrorExtensionOptions {
  readonly projectRoot: string;
  readonly tier?: string;
  readonly dispatch?: (input: string) => Promise<TuiMirrorResult>;
}

export function createEvokTuiMirrorExtension(options: TuiMirrorExtensionOptions): (pi: Pick<ExtensionAPI, "registerCommand">) => void {
  const dispatch = options.dispatch ?? ((input: string) => executeTuiMirrorCommand({
    input,
    projectRoot: options.projectRoot,
    ...(options.tier ? { tier: options.tier } : {}),
  }));
  const names = new Set<string>();
  for (const entry of EVOK_TUI_MIRROR_COMMANDS) {
    names.add(entry.name);
    for (const alias of entry.aliases) names.add(alias);
  }
  return (pi) => {
    for (const name of names) {
      if (PI_OWNED.has(name)) continue;
      const spec = findMirrorCommand(name);
      pi.registerCommand(name, {
        description: spec?.description ?? `evoK ${name}`,
        handler: async (args, ctx) => {
          const input = args.trim() ? `/${name} ${args}` : `/${name}`;
          const result = await dispatch(input);
          const body = (result.exitCode === 0 ? result.stdout : result.stderr).trim();
          ctx.ui.notify(body || `(exit ${result.exitCode})`, result.exitCode === 0 ? "info" : "error");
        },
      });
    }
  };
}
