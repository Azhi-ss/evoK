import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/**
 * File inside the installed `pi-subagents` package.
 * `require.resolve` walks up from this file, so a root `bun install` that
 * hoists the package to the repo `node_modules` still resolves.
 */
export function piSubagentsFile(relativePath: string): URL {
  const entry = require.resolve("pi-subagents");
  return pathToFileURL(join(dirname(entry), relativePath));
}
