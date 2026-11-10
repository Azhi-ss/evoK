import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, sep } from "node:path";

/** Explicit interpreter for hosts whose PATH does not offer an acceptable python3. */
export const PYTHON_OVERRIDE_ENV = "HARNESS_OPT_PYTHON";

/** `harness-opt/relay` uses `str | None` in annotations, so 3.9 is not supported. */
const MIN_PYTHON: readonly [number, number] = [3, 10];

const MIN_PYTHON_LABEL = MIN_PYTHON.join(".");

const PROBE = "import json, sys; print(json.dumps([sys.executable, '%d.%d.%d' % sys.version_info[:3]]))";

/** Per PATH entry: the plain name first, then versioned ones, so one old entry cannot shadow a newer one later. */
const NAMES = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];

interface Probe {
  readonly file: string;
  readonly version: string;
  readonly major: number;
  readonly minor: number;
}

interface Candidate {
  readonly file: string;
  /** An override or configured path: it must work, never fall through to PATH. */
  readonly explicit: boolean;
}

const probed = new Map<string, Probe>();
const chosen = new Map<string, string>();

function probe(file: string): Probe | null {
  const proc = spawnSync(file, ["-c", PROBE], { encoding: "utf8", timeout: 15_000 });
  if (proc.error || proc.status !== 0) return null;
  try {
    const [executable, version] = JSON.parse(proc.stdout.trim()) as [unknown, unknown];
    if (typeof executable !== "string" || typeof version !== "string") return null;
    const [major, minor] = version.split(".").map(Number);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
    return { file: executable, version, major, minor };
  } catch {
    return null;
  }
}

function cachedProbe(file: string): Probe | null {
  const hit = probed.get(file);
  if (hit !== undefined) return hit;
  const found = probe(file);
  if (found !== null) probed.set(file, found);
  return found;
}

function supports(found: Probe): boolean {
  return found.major > MIN_PYTHON[0] || (found.major === MIN_PYTHON[0] && found.minor >= MIN_PYTHON[1]);
}

function pathDirs(env: NodeJS.ProcessEnv): readonly string[] {
  return (env.PATH ?? "").split(delimiter).filter((dir) => dir.trim() !== "");
}

function explicitChoice(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  return (env[PYTHON_OVERRIDE_ENV] ?? "").trim() || (configured ?? "").trim();
}

function candidates(explicit: string, env: NodeJS.ProcessEnv): readonly Candidate[] {
  const out: Candidate[] = [];
  if (explicit !== "") {
    if (explicit.includes(sep)) {
      out.push({ file: explicit, explicit: true });
    } else {
      const found = pathDirs(env).map((dir) => join(dir, explicit)).filter((file) => existsSync(file));
      // A bare name with no match stays in the list so the error names what was asked for.
      for (const file of found.length > 0 ? found : [explicit]) out.push({ file, explicit: true });
    }
  }
  for (const dir of pathDirs(env)) {
    for (const name of NAMES) {
      const file = join(dir, name);
      if (existsSync(file)) out.push({ file, explicit: false });
    }
  }
  return out;
}

function refusal(what: string): Error {
  return new Error(
    `harness-opt needs Python >= ${MIN_PYTHON_LABEL}: ${what}. `
      + `Set ${PYTHON_OVERRIDE_ENV} to a >= ${MIN_PYTHON_LABEL} interpreter.`,
  );
}

/**
 * One rule for every python spawn: `HARNESS_OPT_PYTHON`, then the configured
 * interpreter, then the first >= 3.10 python on PATH. An explicit choice that is
 * missing or too old is an error, never a silent fallback.
 */
export function resolvePython(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = explicitChoice(configured, env);
  // Every spawn site calls this; after the first answer the walk is one Map lookup.
  const key = `${explicit}\u0000${env.PATH ?? ""}`;
  const hit = chosen.get(key);
  if (hit !== undefined) return hit;
  let stale: Probe | null = null;
  for (const candidate of candidates(explicit, env)) {
    const found = cachedProbe(candidate.file);
    if (found === null) {
      if (candidate.explicit) throw refusal(`${candidate.file} is not a runnable interpreter`);
      continue;
    }
    if (supports(found)) {
      chosen.set(key, found.file);
      return found.file;
    }
    if (candidate.explicit) throw refusal(`${found.file} is ${found.version}`);
    stale ??= found;
  }
  if (stale !== null) throw refusal(`${stale.file} is ${stale.version}`);
  throw refusal("no python3 on PATH");
}
