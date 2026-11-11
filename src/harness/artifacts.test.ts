/**
 * B2: the harness collects, validates, content-addresses and issues a receipt.
 * Adoption (whether the artifact belongs to a Run and enters the Ledger) is the
 * Mission's, so nothing here writes history or decides an artifact is evidence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArtifactReceipt, collectArtifactCollection, collectArtifacts, digestArtifacts } from "./artifacts";

const roots: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evok-harness-artifacts-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("artifact collection and content addressing (B2)", () => {
  test("collects a workspace as path -> bytes, in lexical walk order", async () => {
    const root = await workspace({ "b.txt": "hello\n", "a/deep.txt": "world" });
    expect(await collectArtifacts(root)).toEqual({ "a/deep.txt": "world", "b.txt": "hello\n" });
  });

  test("content addressing is a pinned, order-independent digest", async () => {
    const root = await workspace({ "b.txt": "hello\n", "a/deep.txt": "world" });
    const files = await collectArtifacts(root);
    // Pinned: a changed recipe changes every stored snapshot digest.
    expect(digestArtifacts(files)).toBe("4005247197028b31006493cf0dd000db571560351d8c0aa26c9afd176ec11110");
    expect(digestArtifacts({ "b.txt": "hello\n", "a/deep.txt": "world" })).toBe(digestArtifacts(files));
    expect(digestArtifacts({})).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digestArtifacts({ "a": "1" })).not.toBe(digestArtifacts({ "a": "2" }));
    // The name is part of the address: a renamed file is a different artifact.
    expect(digestArtifacts({ "a": "1" })).not.toBe(digestArtifacts({ "b": "1" }));
  });

  test("issues a receipt naming the execution that produced it", async () => {
    const root = await workspace({ "out.json": "{}" });
    const collection = await collectArtifactCollection(root, "run-1");
    expect(collection.files).toEqual({ "out.json": "{}" });
    expect(collection.receipt).toEqual({ producer: "run-1", digest: digestArtifacts(collection.files) });
    expect((await collectArtifactCollection(root, "child-1", "run-1")).receipt).toEqual({
      producer: "child-1",
      parentExecutionId: "run-1",
      digest: collection.receipt.digest,
    });
    // Collecting twice is the same artifact: content addressing is not identity of time.
    expect((await collectArtifactCollection(root, "run-1")).receipt.digest).toBe(collection.receipt.digest);
  });

  test("a receipt is refused when it cannot name what it addresses", () => {
    expect(() => assertArtifactReceipt({ producer: "", digest: "a".repeat(64) })).toThrow(/producer/);
    expect(() => assertArtifactReceipt({ producer: "run-1", digest: "" })).toThrow(/digest/);
    expect(() => assertArtifactReceipt({ producer: "run-1", digest: "not-a-digest" })).toThrow(/digest/);
    expect(() => assertArtifactReceipt({ producer: "run-1", digest: "a".repeat(64), parentExecutionId: "" })).toThrow(
      /parent/,
    );
    expect(assertArtifactReceipt({ producer: "run-1", digest: "a".repeat(64) })).toEqual({
      producer: "run-1",
      digest: "a".repeat(64),
    });
  });

  test("an empty workspace is a real, empty artifact rather than an error", async () => {
    const root = await workspace({});
    const collection = await collectArtifactCollection(root, "run-1");
    expect(collection.files).toEqual({});
    expect(collection.receipt.digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("skips what is not an artifact: symlinks are not followed", async () => {
    const root = await workspace({ "real.txt": "content" });
    await symlink(join(root, "real.txt"), join(root, "link.txt"));
    expect(await collectArtifacts(root)).toEqual({ "real.txt": "content" });
    // A collection names its producer; nothing anonymous is addressable.
    await expect(collectArtifactCollection(root, "")).rejects.toThrow(/producer/);
  });

  test("a missing workspace is refused, not silently empty", async () => {
    await expect(collectArtifacts(join(tmpdir(), "evok-harness-missing-" + crypto.randomUUID()))).rejects.toThrow();
  });
});
