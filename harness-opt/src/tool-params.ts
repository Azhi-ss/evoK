import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Argument names taken from the installed pi-coding-agent tool schemas.
 * Grep includes ignoreCase, literal, and context because those properties
 * are on grepSchema, not because a hand list named them.
 */
function propertyNames(parameters: { readonly properties?: Readonly<Record<string, unknown>> }): ReadonlySet<string> {
  return new Set(Object.keys(parameters.properties ?? {}));
}

function loadToolParameters(): ReadonlyMap<string, ReadonlySet<string>> {
  const cwd = ".";
  const defs = {
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    powershell: createPowerShellToolDefinition(cwd),
  };
  const out = new Map<string, ReadonlySet<string>>();
  for (const [name, def] of Object.entries(defs)) {
    out.set(name, propertyNames(def.parameters));
  }
  return out;
}

export const TOOL_PARAMETERS: ReadonlyMap<string, ReadonlySet<string>> = loadToolParameters();

/**
 * Path-bearing argument names, including case aliases such as Path and FilePath.
 * `command` stays with the shell check. A name that normalizes to one of these
 * has its value resolved; if that exact name is not on the tool schema, the
 * call is still refused after the value check.
 */
const PATH_ALIAS_NAMES = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "fulloutputpath",
  "directory",
  "dir",
  "cwd",
  "target",
  "location",
  "locations",
]);

export function isPathAlias(key: string): boolean {
  if (key === "command") return false;
  return PATH_ALIAS_NAMES.has(key.toLowerCase().replace(/[_-]/g, ""));
}
