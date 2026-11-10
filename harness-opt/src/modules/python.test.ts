import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON_OVERRIDE_ENV, resolvePython } from "./python";

/**
 * A fake interpreter answering the version probe with `version`, whatever argv it gets.
 * Stubbed on purpose: CI has no 3.9 to point at, and the probe contract is the whole seam.
 */
function stub(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "python3");
  writeFileSync(file, `#!/bin/sh\necho '["${file}", "${version}"]'\n`);
  chmodSync(file, 0o755);
  return file;
}

function envWithPath(...dirs: readonly string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(":") };
}

describe("python interpreter resolution", () => {
  test("a 3.9 python3 on PATH fails fast, naming the path, the version and the override", () => {
    const dir = mkdtempSync(join(tmpdir(), "py39-"));
    const old = stub(join(dir, "bin"), "3.9.6");
    let message = "";
    try {
      resolvePython(undefined, envWithPath(join(dir, "bin")));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(old);
    expect(message).toContain("3.9.6");
    expect(message).toContain(PYTHON_OVERRIDE_ENV);
  });

  test("an older python3 earlier on PATH does not shadow a newer one later", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyscan-"));
    stub(join(dir, "old"), "3.9.6");
    const modern = stub(join(dir, "new"), "3.14.10");
    expect(resolvePython(undefined, envWithPath(join(dir, "old"), join(dir, "new")))).toBe(modern);
  });

  test("the env override wins over PATH, and a configured interpreter wins over PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyover-"));
    stub(join(dir, "old"), "3.9.6");
    const modern = stub(join(dir, "new"), "3.11.9");
    expect(resolvePython(undefined, { PATH: join(dir, "old"), [PYTHON_OVERRIDE_ENV]: modern })).toBe(modern);
    expect(resolvePython(modern, envWithPath(join(dir, "old")))).toBe(modern);
  });

  test("an explicit 3.9 interpreter is refused instead of silently falling back to PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "pystrict-"));
    const old = stub(join(dir, "old"), "3.9.6");
    stub(join(dir, "new"), "3.14.10");
    const both = envWithPath(join(dir, "old"), join(dir, "new"));
    expect(() => resolvePython(undefined, { ...both, [PYTHON_OVERRIDE_ENV]: old })).toThrow(/3\.9\.6/);
    expect(() => resolvePython(old, both)).toThrow(/3\.9\.6/);
  });

  test("no interpreter at all is an actionable error, not a bare spawn failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "pynone-"));
    expect(() => resolvePython(undefined, envWithPath(join(dir, "empty")))).toThrow(
      new RegExp(`no python3 on PATH[\\s\\S]*${PYTHON_OVERRIDE_ENV}`),
    );
  });
});
