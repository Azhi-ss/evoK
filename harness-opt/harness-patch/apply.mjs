#!/usr/bin/env node
/**
 * Copy a harness.mjs, refuse it unless its sha256 is the preregistered source,
 * apply harness.mjs.patch, then syntax-check both copies.
 *
 *   node harness-opt/harness-patch/apply.mjs <source harness.mjs> <dest harness.mjs>
 *
 * The deployable box file is that dest. From the repo root:
 *
 *   node harness-opt/harness-patch/apply.mjs \
 *     harness-opt/harness-patch/upstream/harness.mjs \
 *     /workspace/harness-opt-runs/config/harness.pr202.mjs
 *
 * stdout ends with `sha256 <hex>` of the bytes just written.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_SOURCE_SHA256 = "fb343bd5579de61a05c4b928a7c8c54b1da9acae1e8fc6e32c4e074336840219";

const here = path.dirname(fileURLToPath(import.meta.url));

function checkSyntax(file) {
  const result = spawnSync("node", ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    process.exit(result.status === null ? 1 : result.status);
  }
}

function applyPatch(source, dest) {
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== HARNESS_SOURCE_SHA256) {
    console.error(`source sha256 ${hash} != ${HARNESS_SOURCE_SHA256}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  const applied = spawnSync("patch", ["--forward", "--batch", dest, path.join(here, "harness.mjs.patch")], {
    encoding: "utf8",
  });
  if (applied.status !== 0) {
    process.stderr.write(applied.stdout || "");
    process.stderr.write(applied.stderr || "");
    process.exit(applied.status === null ? 1 : applied.status);
  }
  checkSyntax(source);
  checkSyntax(dest);
  return dest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  const dest = process.argv[3];
  if (!source || !dest) {
    console.error("usage: node apply.mjs <source harness.mjs> <dest harness.mjs>");
    process.exit(2);
  }
  applyPatch(source, dest);
  const digest = createHash("sha256").update(readFileSync(dest)).digest("hex");
  console.log(`patched ${dest}`);
  console.log(`sha256 ${digest}`);
}
