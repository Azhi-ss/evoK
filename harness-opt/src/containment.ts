import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Path relative to the real run root. Every existing component is resolved
 * through symlinks, including links in the middle of a link target and a
 * chain of links. A hop whose real path lands outside the root throws.
 */
export function runRelative(root: string, rawPath: string): string {
  const rootReal = realpathSync(resolve(root));
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed === ".") return ".";
  const landed = isAbsolute(trimmed)
    ? walkTarget(resolve(sep), trimmed, rootReal, rawPath, new Set())
    : walkTarget(rootReal, trimmed, rootReal, rawPath, new Set());
  return finish(rootReal, landed, rawPath);
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

/**
 * Follow one symlink, then walk every segment of its target.
 * An intermediate link is resolved before the next segment, so link1 -> link2/file
 * cannot hide a hop to /etc, sealed/, or another directory outside the run.
 */
function resolveLink(linkPath: string, rootReal: string, rawPath: string, seen: Set<string>): string {
  if (seen.has(linkPath) || seen.size >= 32) throw new Error(`path escapes the run root: ${rawPath}`);
  seen.add(linkPath);
  const from = realpathOrEscape(dirname(linkPath), rawPath);
  if (!isInside(rootReal, from)) throw new Error(`path escapes the run root: ${rawPath}`);
  const target = readlinkSync(linkPath);
  return walkTarget(from, target, rootReal, rawPath, seen);
}

/**
 * Walk `target` one segment at a time from a real directory.
 * `..` is applied after a symlink hop, and a missing tail cannot climb back out.
 * An absolute target may pass through directories outside the run; the landed
 * path still has to finish inside it.
 */
function walkTarget(fromReal: string, target: string, rootReal: string, rawPath: string, seen: Set<string>): string {
  const parts = target.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  let base = isAbsolute(target) ? resolve(sep) : fromReal;
  let inside = isInside(rootReal, base);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (part === "..") {
      base = dirname(base);
    } else {
      const next = join(base, part);
      let info;
      try {
        info = lstatSync(next);
      } catch (error) {
        if (!isEnoent(error)) throw error;
        const rest = parts.slice(index);
        if (rest.includes("..")) throw new Error(`path escapes the run root: ${rawPath}`);
        base = join(base, ...rest);
        break;
      }
      if (info.isSymbolicLink()) {
        base = resolveLink(next, rootReal, rawPath, seen);
        inside = true;
        continue;
      }
      base = realpathOrEscape(next, rawPath);
    }
    if (isInside(rootReal, base)) inside = true;
    else if (inside) throw new Error(`path escapes the run root: ${rawPath}`);
  }
  if (!isInside(rootReal, base)) throw new Error(`path escapes the run root: ${rawPath}`);
  return base;
}

function realpathOrEscape(abs: string, rawPath: string): string {
  try {
    return realpathSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`path escapes the run root: ${rawPath}`);
    throw error;
  }
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
