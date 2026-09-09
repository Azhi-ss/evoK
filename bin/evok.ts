#!/usr/bin/env bun
/**
 * `evok` executable (#109, T1). Thin wrapper: parse argv, build the Pi-backed
 * model resolver from Pi's SDK-resolved stores, run the foreground entry.
 *
 * Models and credentials come from Pi (~/.pi/agent models.json/auth.json);
 * evok copies no credentials and adds no login system.
 */
import { readFile } from "node:fs/promises";
import {
  parseEvokArgs,
  runEvok,
  type ParsedEvokArgs,
} from "../src/evok-cli";
import { createEvokModelResolver, type OrchestraConfig } from "../src/evok-model";

async function readOrchestra(path: string | undefined): Promise<OrchestraConfig | null> {
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read --orchestra file ${path}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--orchestra file ${path} must be a JSON object with optional fast/deep/mid model refs`);
  }
  for (const key of ["fast", "deep", "mid"] as const) {
    const ref = (parsed as Record<string, unknown>)[key];
    if (ref !== undefined && (typeof ref !== "string" || ref.trim() === "")) {
      throw new Error(`--orchestra file ${path}: "${key}" must be a Pi catalog model ref string`);
    }
  }
  return parsed as OrchestraConfig;
}

const args: ParsedEvokArgs = parseEvokArgs(process.argv.slice(2));
const code = await runEvok({
  args,
  createResolver: async (parsed) =>
    createEvokModelResolver({ orchestra: await readOrchestra(parsed.orchestra) }),
});
process.exitCode = code;
