import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Path relative to the real run root. Every existing component is resolved
 * through symlinks, including links in the middle of the path. A link or
 * lexical step that lands outside the root throws.
 */
export function runRelative(root: string, rawPath: string): string {
  const rootReal = realpathSync(resolve(root));
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed === ".") return ".";
  const lexical = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootReal, trimmed);
  if (!isInside(rootReal, lexical)) throw new Error(`path escapes the run root: ${rawPath}`);
  const segments = relative(rootReal, lexical).split(sep).filter(Boolean);
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "..") throw new Error(`path escapes the run root: ${rawPath}`);
    const next = join(current, segment);
    let linked = false;
    try {
      const info = lstatSync(next);
      if (info.isSymbolicLink()) {
        linked = true;
        current = resolveLink(next, rootReal, rawPath);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const rest = segments.slice(index);
      if (rest.some((part) => part === "..")) throw new Error(`path escapes the run root: ${rawPath}`);
      return finish(rootReal, join(current, ...rest), rawPath);
    }
    if (!linked) current = next;
  }
  return finish(rootReal, current, rawPath);
}

/** Open a real directory. A symlink at this path is refused. */
export function openRealDirectory(root: string): string {
  const absolute = resolve(root);
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`path escapes the run root: ${root}`);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    mkdirSync(absolute, { recursive: true });
  }
  return realpathSync(absolute);
}

/**
 * Relative path whose resolved location is the requested location.
 * A symlink that retargets the path, including one that stays inside the root, throws.
 */
export function assertContainedRelative(root: string, relativeName: string): string {
  const requested = normalizeRelative(relativeName);
  const resolved = runRelative(root, requested);
  if (resolved !== requested) {
    throw new Error(`resolved path is outside the requested contract: ${requested} -> ${resolved}`);
  }
  return requested;
}

/** Create a real directory inside `root`. A symlink at or above the relative path throws. */
export function ensureRealDir(root: string, relativeDir: string): string {
  const rootReal = openRealDirectory(root);
  const rel = assertContainedRelative(rootReal, relativeDir);
  mkdirReal(rootReal, rel);
  return join(rootReal, ...rel.split("/"));
}

/** Read a file that must stay at `relativeName` inside `root`. The final open uses O_NOFOLLOW. */
export function readContained(root: string, relativeName: string): string {
  const target = containedAbsolute(root, relativeName);
  const fd = openNoFollow(target, constants.O_RDONLY, relativeName);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Write a file that must stay at `relativeName` inside `root`. The final open uses O_NOFOLLOW. */
export function writeContained(root: string, relativeName: string, body: string): string {
  const rootReal = openRealDirectory(root);
  const rel = assertContainedRelative(rootReal, relativeName);
  const parent = parentRelative(rel);
  if (parent) mkdirReal(rootReal, parent);
  const target = join(rootReal, ...rel.split("/"));
  const fd = openNoFollow(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, relativeName);
  try {
    writeAll(fd, body);
  } finally {
    closeSync(fd);
  }
  return target;
}

/** Append to a file that must stay at `relativeName` inside `root`. */
export function appendContained(root: string, relativeName: string, body: string): void {
  const rootReal = openRealDirectory(root);
  const rel = assertContainedRelative(rootReal, relativeName);
  const parent = parentRelative(rel);
  if (parent) mkdirReal(rootReal, parent);
  const target = join(rootReal, ...rel.split("/"));
  const fd = openNoFollow(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, relativeName);
  try {
    writeAll(fd, body);
  } finally {
    closeSync(fd);
  }
}

/** Rename two paths that both stay inside `root`. */
export function renameContained(root: string, fromRel: string, toRel: string): void {
  const rootReal = openRealDirectory(root);
  const from = containedAbsolute(rootReal, fromRel);
  const rel = assertContainedRelative(rootReal, toRel);
  const parent = parentRelative(rel);
  if (parent) mkdirReal(rootReal, parent);
  renameSync(from, join(rootReal, ...rel.split("/")));
}

function containedAbsolute(root: string, relativeName: string): string {
  const rootReal = openRealDirectory(root);
  const rel = assertContainedRelative(rootReal, relativeName);
  return join(rootReal, ...rel.split("/"));
}

function normalizeRelative(relativeName: string): string {
  const rel = relativeName.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (rel === "" || rel === "." || rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new Error(`path escapes the run root: ${relativeName}`);
  }
  return rel;
}

function parentRelative(relativeName: string): string {
  const slash = relativeName.lastIndexOf("/");
  return slash === -1 ? "" : relativeName.slice(0, slash);
}

function mkdirReal(rootReal: string, relativeDir: string): void {
  let current = rootReal;
  for (const part of relativeDir.split("/")) {
    if (part === "" || part === "." || part === "..") throw new Error(`path escapes the run root: ${relativeDir}`);
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`path escapes the run root: ${relativeDir}`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      mkdirSync(current);
    }
  }
}

function openNoFollow(target: string, flags: number, relativeName: string): number {
  try {
    return openSync(target, flags | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`path escapes the run root: ${relativeName}`);
    throw error;
  }
}

function writeAll(fd: number, body: string): void {
  const buffer = Buffer.from(body);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function resolveLink(linkPath: string, rootReal: string, rawPath: string): string {
  const seen = new Set<string>();
  let current = linkPath;
  for (let hop = 0; hop < 32; hop += 1) {
    if (seen.has(current)) throw new Error(`path escapes the run root: ${rawPath}`);
    seen.add(current);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (isEnoent(error)) return finishAbsolute(rootReal, current, rawPath);
      throw error;
    }
    if (!info.isSymbolicLink()) return finishAbsolute(rootReal, current, rawPath);
    const target = readlinkSync(current);
    const next = isAbsolute(target) ? resolve(target) : resolve(dirname(current), target);
    if (!isInside(rootReal, next)) throw new Error(`path escapes the run root: ${rawPath}`);
    current = next;
  }
  throw new Error(`path escapes the run root: ${rawPath}`);
}

function finish(rootReal: string, abs: string, rawPath: string): string {
  const real = finishAbsolute(rootReal, abs, rawPath);
  const rel = relative(rootReal, real);
  return rel.split(sep).join("/") || ".";
}

function finishAbsolute(rootReal: string, abs: string, rawPath: string): string {
  if (!isInside(rootReal, abs)) throw new Error(`path escapes the run root: ${rawPath}`);
  return abs;
}

function isInside(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
