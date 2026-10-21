import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFECTIVE_KNOBS, harnessEffectiveKeys } from "./effective-knobs";

const upstream = fileURLToPath(new URL("../../harness-patch/upstream/harness.mjs", import.meta.url));
const applyScript = fileURLToPath(new URL("../../harness-patch/apply.mjs", import.meta.url));

describe("effective knobs", () => {
  test("the whitelist is exactly the keys the patched harness reads", () => {
    const root = mkdtempSync(join(tmpdir(), "effective-knobs-"));
    const patched = join(root, "harness.mjs");
    const applied = spawnSync("node", [applyScript, upstream, patched], { encoding: "utf8" });
    expect(applied.status).toBe(0);
    const text = readFileSync(patched, "utf8");
    const digest = createHash("sha256").update(readFileSync(patched)).digest("hex");
    expect(applied.stdout).toContain(`sha256 ${digest}`);
    expect([...new Set(harnessEffectiveKeys(text))].sort()).toEqual([...EFFECTIVE_KNOBS].sort());
  });
});
