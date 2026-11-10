/**
 * Per-host pi-subagents protocol probe. Physical home: `src/execution/`.
 *
 * The native transports here speak pi-subagents' foreground delegation
 * protocol, which changed at 0.84: the child's response echoes the model with
 * its effective thinking level appended. Assuming one release's semantics and
 * one install layout turns every host skew into an unexplained registration or
 * identity failure, so the install Pi actually loads is negotiated once per
 * host and an unsupported host fails closed before anything is registered or
 * started.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Lowest pi-subagents release whose delegation protocol this host speaks. */
export const REQUIRED_PI_SUBAGENTS_VERSION = "0.84";

export class PiSubagentsProtocolError extends Error {
  readonly kind = "pi-subagents-protocol" as const;
  readonly required = REQUIRED_PI_SUBAGENTS_VERSION;
  constructor(readonly detected: string | undefined) {
    super(
      "pi-subagents protocol unsupported: detected " +
        (detected ?? "none (pi-subagents is not installed)") +
        ", required >= " +
        REQUIRED_PI_SUBAGENTS_VERSION,
    );
    this.name = "PiSubagentsProtocolError";
  }
}

export interface PiSubagentsProtocol {
  readonly version: string;
  /** 0.84+ reports a child as `<model>:<thinking>`. */
  modelIdentity(model: string, thinking: string): string;
}

/** A host probe: the detected version, or undefined when pi-subagents is absent. */
export type PiSubagentsVersionProbe = () => string | undefined;

const PACKAGE = "pi-subagents";
const require = createRequire(import.meta.url);

function nearestPackageDir(entry: string): string | undefined {
  let dir = dirname(entry);
  for (let up = 0; up < 4; up++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The pi-subagents package this host runs: the copy Pi itself loads first,
 * because that is the plugin whose event bus receives the registration, then a
 * repo-resolved copy when Pi's agent home has none.
 */
export function piSubagentsDir(): string | undefined {
  const agentHome = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
  let resolved: string | undefined;
  try {
    resolved = nearestPackageDir(require.resolve(PACKAGE));
  } catch {
    resolved = undefined;
  }
  return [join(agentHome, "npm", "node_modules", PACKAGE), resolved].find(
    (dir) => dir !== undefined && existsSync(join(dir, "package.json")),
  );
}

interface Manifest {
  readonly version?: unknown;
  readonly pi?: { readonly extensions?: unknown };
}

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/** Version of the install at `dir` (default: this host's), or undefined when absent. */
export function probePiSubagentsVersion(dir: string | undefined = piSubagentsDir()): string | undefined {
  const { version } = (dir === undefined ? undefined : readManifest(dir)) ?? {};
  return typeof version === "string" && version.trim() !== "" ? version : undefined;
}

/** Extension entry the install declares for itself; never a hard-coded layout. */
export function resolvePiSubagentsExtension(dir: string | undefined = piSubagentsDir()): string | undefined {
  const declared = dir === undefined ? undefined : readManifest(dir)?.pi?.extensions;
  const entry = Array.isArray(declared) ? declared[0] : undefined;
  return dir !== undefined && typeof entry === "string" ? join(dir, entry) : undefined;
}

/** Negotiates the host's protocol, or throws the distinct unsupported error. */
export function probePiSubagentsProtocol(
  detect: PiSubagentsVersionProbe = probePiSubagentsVersion,
): PiSubagentsProtocol {
  const detected = detect();
  if (detected === undefined || !isSupported(detected)) throw new PiSubagentsProtocolError(detected);
  return { version: detected, modelIdentity: (model, thinking) => model + ":" + thinking };
}

/** Protocol of an install a caller launches explicitly by its extension entry. */
export function probePiSubagentsEntryProtocol(entry: string): PiSubagentsProtocol {
  return probePiSubagentsProtocol(() => probePiSubagentsVersion(nearestPackageDir(entry)));
}

function isSupported(detected: string): boolean {
  const have = detected.split(".").map((part) => Number.parseInt(part, 10));
  const need = REQUIRED_PI_SUBAGENTS_VERSION.split(".").map(Number);
  if (have.length < 2 || have.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < need.length; index++) {
    const part = have[index] ?? 0;
    if (part !== need[index]) return part > need[index];
  }
  return true;
}
